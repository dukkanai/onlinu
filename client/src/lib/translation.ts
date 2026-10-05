import { toast } from "sonner";
import { apiDelete, apiPost } from "./api";
import { eventStream } from "./event-stream";
import { getClientId } from "./client-id";
import type { OpenCall, OpenCallOptions } from "./webrtc";

type Direction = "outgoing" | "incoming";

// A dedicated interpreter session per direction keeps original and translated
// audio separate. Generated audio must never be fed back into its own input.
export class TranslationLeg {
  readonly pc = new RTCPeerConnection();
  readonly output = new MediaStream();
  private readonly sender: RTCRtpSender;
  private readonly abort = new AbortController();
  private closed = false;
  private rejectReady: ((error: Error) => void) | undefined;

  constructor(private readonly onFailure: (error: Error) => void) {
    this.sender = this.pc.addTransceiver("audio", {
      direction: "sendrecv",
    }).sender;
  }

  async setInput(stream: MediaStream): Promise<void> {
    if (this.closed) throw new Error("Translation closed");
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error("Translation requires an audio track");
    await this.sender.replaceTrack(track);
  }

  async connect(
    sid: string,
    callId: string,
    direction: Direction,
    language: string,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout>;
    const events = this.pc.createDataChannel("oai-events");
    const ready = new Promise<void>((resolve, reject) => {
      this.rejectReady = reject;
      const check = () => {
        if (
          this.pc.connectionState === "connected" &&
          events.readyState === "open" &&
          this.output.getAudioTracks().length
        ) {
          this.rejectReady = undefined;
          resolve();
        }
      };
      this.pc.ontrack = ({ track }) => {
        this.output.addTrack(track);
        check();
      };
      events.onopen = check;
      events.onmessage = ({ data }) => {
        try {
          const event = JSON.parse(data);
          if (event.type === "error" || event.type === "session.closed") {
            this.fail(
              new Error(
                "توقفت خدمة الترجمة. أُغلقت المكالمة؛ تحقق من اتصال OpenAI والرصيد.",
              ),
            );
          }
        } catch {
          /* Ignore non-JSON control messages. */
        }
      };
      events.onclose = () => this.fail(new Error("انقطع اتصال خدمة الترجمة."));
      this.pc.onconnectionstatechange = () => {
        if (
          ["failed", "closed", "disconnected"].includes(this.pc.connectionState)
        ) {
          this.fail(new Error("انقطع اتصال الترجمة الصوتية. أُغلقت المكالمة."));
        } else check();
      };
      timer = setTimeout(
        () => this.fail(new Error("انتهت مهلة الاتصال بمترجم OpenAI.")),
        30_000,
      );
    });
    // Attach immediately: ICE/control errors may reject before HTTP completes.
    void ready.catch(() => {});
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      const { sdp_answer } = await apiPost<{ sdp_answer: string }>(
        `/api/sessions/${sid}/calls/${callId}/translation`,
        { sdp_offer: offer.sdp, direction, language },
        this.abort.signal,
      );
      if (this.closed) throw new Error("Translation closed");
      await this.pc.setRemoteDescription({ type: "answer", sdp: sdp_answer });
      await ready;
    } catch (error) {
      this.close();
      throw error;
    } finally {
      clearTimeout(timer!);
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.rejectReady?.(error);
    this.onFailure(error);
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.rejectReady?.(new Error("Translation closed"));
    this.rejectReady = undefined;
    this.pc.close();
    this.output.getTracks().forEach((track) => track.stop());
  }
}

type OpenRawCall = (
  sid: string,
  id: string,
  micId: string | null,
  opts: OpenCallOptions,
) => Promise<OpenCall>;

export async function openTranslatedCall(
  sid: string,
  callId: string,
  micDeviceId: string | null,
  opts: OpenCallOptions,
  openRaw: OpenRawCall,
): Promise<OpenCall> {
  let mic: MediaStream | undefined;
  let raw: OpenCall | undefined;
  let closed = false;
  let established = false;
  let failure: Error | undefined;
  let offEvents = () => {};
  const mediaAbort = new AbortController();
  const close = () => {
    if (closed) return;
    closed = true;
    offEvents();
    mediaAbort.abort();
    outgoing.close();
    incoming.close();
    raw?.close();
    mic?.getTracks().forEach((t) => t.stop());
  };
  const fail = (error: Error) => {
    if (closed) return;
    failure = error;
    close();
    if (established) toast.error(error.message);
    void apiDelete(`/api/sessions/${sid}/calls/${callId}`).catch(() => {
      toast.error(
        "تعذر تأكيد إنهاء المكالمة على الخادم. أعد المحاولة من زر الإنهاء.",
      );
    });
  };
  const outgoing = new TranslationLeg(fail);
  const incoming = new TranslationLeg(fail);
  offEvents = eventStream.on((event) => {
    if (
      event.type === "call-ended" &&
      event.sessionId === sid &&
      event.id === callId
    )
      close();
    if (
      event.type === "call-status" &&
      event.sessionId === sid &&
      event.id === callId
    ) {
      if (event.owner !== getClientId()) {
        close();
        return;
      }
      const enabled = !event.held;
      for (const stream of [mic, outgoing.output, incoming.output]) {
        stream?.getAudioTracks().forEach((track) => {
          track.enabled = enabled;
        });
      }
    }
  });
  const assertOpen = () => {
    if (closed)
      throw failure ?? new Error("انتهت المكالمة أثناء إعداد الترجمة.");
  };

  try {
    mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: micDeviceId ? { exact: micDeviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
      },
    });
    if (closed) mic.getTracks().forEach((track) => track.stop());
    assertOpen();
    await outgoing.setInput(mic);
    await Promise.all([
      outgoing.connect(sid, callId, "outgoing", opts.translation!.language),
      incoming.connect(sid, callId, "incoming", "ar"),
    ]);
    assertOpen();
    raw = await openRaw(sid, callId, micDeviceId, {
      ...opts,
      inputStream: outgoing.output,
      signal: mediaAbort.signal,
      onRemoteStream: (stream) => {
        void incoming.setInput(stream).catch(fail);
      },
    });
    if (closed) raw.close();
    assertOpen();
    established = true;
    return {
      pc: raw.pc,
      micStream: mic,
      remoteStream: incoming.output,
      get localVideoStream() {
        return raw!.localVideoStream;
      },
      get remoteVideoStream() {
        return raw!.remoteVideoStream;
      },
      setLocalVideo: raw.setLocalVideo,
      translationLanguage: opts.translation!.language,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
