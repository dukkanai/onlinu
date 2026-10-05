import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

class Track {
  kind = "audio";
  enabled = true;
  stopped = false;
  stop() {
    this.stopped = true;
  }
}
class Stream {
  constructor(private tracks: Track[] = []) {}
  getAudioTracks() {
    return this.tracks;
  }
  getTracks() {
    return this.tracks;
  }
  addTrack(track: Track) {
    this.tracks.push(track);
  }
}
class Peer {
  static all: Peer[] = [];
  connectionState = "new";
  input: Track | null = null;
  generated = new Track();
  ontrack?: (event: unknown) => void;
  onconnectionstatechange?: () => void;
  channel = {
    readyState: "connecting",
    onopen: undefined as (() => void) | undefined,
    onmessage: undefined as ((event: unknown) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
  };
  constructor() {
    Peer.all.push(this);
  }
  addTransceiver() {
    return {
      sender: {
        replaceTrack: async (track: Track) => {
          this.input = track;
        },
      },
    };
  }
  createDataChannel() {
    return this.channel;
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0\r\noffer" };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {
    this.ontrack?.({ track: this.generated });
    this.connectionState = "connected";
    this.onconnectionstatechange?.();
    this.channel.readyState = "open";
    this.channel.onopen?.();
  }
  close() {
    this.connectionState = "closed";
    this.onconnectionstatechange?.();
    this.channel.onclose?.();
  }
}

const storage = new Map<string, string>();
Object.assign(globalThis, {
  MediaStream: Stream,
  RTCPeerConnection: Peer,
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  },
});

const { openTranslatedCall, TranslationLeg } =
  await import("../src/lib/translation");
const { eventStream } = await import("../src/lib/event-stream");
const { checkTranslation } = await import("../src/stores/translation");
type OpenCall = import("../src/lib/webrtc").OpenCall;
type Options = import("../src/lib/webrtc").OpenCallOptions;

let mic: Track;
let bodies: Record<string, string>[];
let deletions: number;
let listener: (event: any) => void;
let unsubscribed: boolean;

beforeEach(() => {
  Peer.all = [];
  storage.set("wacalls.clientId", "operator");
  storage.set("wacalls.apiKey", "app-key");
  mic = new Track();
  bodies = [];
  deletions = 0;
  unsubscribed = false;
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => new Stream([mic]) },
  });
  eventStream.on = (fn) => {
    listener = fn;
    return () => {
      unsubscribed = true;
    };
  };
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "DELETE") {
      deletions++;
      return new Response(null, { status: 204 });
    }
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ sdp_answer: "v=0\r\nanswer" });
  };
});

function rawConnection() {
  return {
    pc: {} as RTCPeerConnection,
    micStream: new Stream() as unknown as MediaStream,
    remoteStream: null,
    localVideoStream: null,
    remoteVideoStream: null,
    setLocalVideo: async () => false,
    close() {},
  } satisfies OpenCall;
}

const opts = { translation: { enabled: true, language: "fr" } };

test("routes only translated audio to WhatsApp and Arabic to the operator", async () => {
  const peerVoice = new Track();
  let rawOptions: Options | undefined;
  let rawClosed = false;
  const conn = await openTranslatedCall(
    "session",
    "call",
    null,
    opts,
    async (_sid, _id, _mic, options) => {
      rawOptions = options;
      options.onRemoteStream!(
        new Stream([peerVoice]) as unknown as MediaStream,
      );
      return {
        ...rawConnection(),
        close() {
          rawClosed = true;
        },
      };
    },
  );
  assert.deepEqual(
    bodies.map((b) => [b.direction, b.language]),
    [
      ["outgoing", "fr"],
      ["incoming", "ar"],
    ],
  );
  assert.equal(Peer.all[0].input, mic);
  assert.equal(Peer.all[1].input, peerVoice);
  assert.equal(
    rawOptions!.inputStream!.getAudioTracks()[0],
    Peer.all[0].generated,
  );
  assert.equal(conn.remoteStream!.getAudioTracks()[0], Peer.all[1].generated);
  assert.equal(conn.micStream.getAudioTracks()[0], mic);
  assert.equal(conn.translationLanguage, "fr");
  conn.close();
  conn.close();
  assert.equal(rawClosed, true);
  assert.equal(mic.stopped, true);
  assert.equal(unsubscribed, true);
  assert.ok(
    Peer.all.every(
      (p) => p.connectionState === "closed" && p.generated.stopped,
    ),
  );
});

test("provider setup rejection releases both peers and microphone without opening raw audio", async () => {
  globalThis.fetch = async () =>
    Response.json({ error: "quota exceeded" }, { status: 502 });
  let rawOpened = false;
  await assert.rejects(
    openTranslatedCall("session", "call", null, opts, async () => {
      rawOpened = true;
      return rawConnection();
    }),
  );
  assert.equal(rawOpened, false);
  assert.equal(mic.stopped, true);
  assert.ok(Peer.all.every((p) => p.connectionState === "closed"));
});

test("call ends while waiting for microphone permission: late stream is stopped", async () => {
  navigator.mediaDevices.getUserMedia = async () => {
    listener({ type: "call-ended", sessionId: "session", id: "call" });
    return new Stream([mic]) as unknown as MediaStream;
  };
  await assert.rejects(
    openTranslatedCall("session", "call", null, opts, async () =>
      rawConnection(),
    ),
  );
  assert.equal(mic.stopped, true);
  assert.equal(bodies.length, 0);
  assert.ok(Peer.all.every((p) => p.connectionState === "closed"));
});

test("call ends during media setup: late raw connection is closed", async () => {
  let rawClosed = false;
  await assert.rejects(
    openTranslatedCall("session", "call", null, opts, async () => {
      listener({ type: "call-ended", sessionId: "session", id: "call" });
      return {
        ...rawConnection(),
        close() {
          rawClosed = true;
        },
      };
    }),
  );
  assert.equal(rawClosed, true);
  assert.equal(mic.stopped, true);
});

test("runtime interpreter failure closes audio and requests call termination", async () => {
  let rawClosed = false;
  await openTranslatedCall("session", "call", null, opts, async () => ({
    ...rawConnection(),
    close() {
      rawClosed = true;
    },
  }));
  Peer.all[1].channel.onmessage?.({
    data: JSON.stringify({ type: "error", error: { message: "internal" } }),
  });
  assert.equal(rawClosed, true);
  assert.equal(mic.stopped, true);
  assert.equal(deletions, 1);
});

test("hold mutes all three tracks; transfer releases sessions without ending the transferred call", async () => {
  await openTranslatedCall("session", "call", null, opts, async () =>
    rawConnection(),
  );
  listener({
    type: "call-status",
    sessionId: "session",
    id: "call",
    owner: "operator",
    held: true,
  });
  assert.equal(mic.enabled, false);
  assert.ok(Peer.all.every((p) => !p.generated.enabled));
  listener({
    type: "call-status",
    sessionId: "session",
    id: "call",
    owner: "operator",
    held: false,
  });
  assert.ok(Peer.all.every((p) => p.generated.enabled));
  listener({
    type: "call-status",
    sessionId: "session",
    id: "call",
    owner: null,
    held: true,
  });
  assert.ok(Peer.all.every((p) => p.connectionState === "closed"));
  assert.equal(deletions, 0);
});

test("closing a leg aborts outstanding SDP requests", async () => {
  let aborted = false;
  let requested!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    requested = resolve;
  });
  globalThis.fetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      });
      requested();
    });
  const leg = new TranslationLeg(() => {});
  const connecting = leg.connect("session", "call", "incoming", "ar");
  await requestStarted;
  leg.close();
  await assert.rejects(connecting);
  assert.equal(aborted, true);
});

test("preflight blocks enabled translation when server is unconfigured", async () => {
  globalThis.fetch = async () => Response.json({ translationEnabled: false });
  await assert.rejects(checkTranslation({ enabled: true, language: "en" }));
  await checkTranslation({ enabled: false, language: "en" });
});
