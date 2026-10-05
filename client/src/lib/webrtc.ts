import { apiPost } from "./api";
import { setupVideoChannel } from "./call/video-channel";
import { videoSupported } from "./call/video-codec";
import { VIDEO_FPS, VIDEO_HEIGHT, VIDEO_WIDTH } from "../constants/video";
import { getTransport } from "./transport";
import { openWSCall } from "./ws-audio";
import { openTranslatedCall } from "./translation";
import {
  translationPreference,
  type TranslationPreference,
} from "../stores/translation";

export type OpenCallOptions = {
  video?: boolean;
  camDeviceId?: string | null;
  translation?: TranslationPreference;
  inputStream?: MediaStream;
  onRemoteStream?: (stream: MediaStream) => void;
  signal?: AbortSignal;
};

export type OpenCall = {
  pc: RTCPeerConnection;
  translationLanguage?: string;
  micStream: MediaStream;
  remoteStream: MediaStream | null;
  localVideoStream: MediaStream | null;
  remoteVideoStream: MediaStream | null;
  // Liga/desliga a câmera no meio da chamada (upgrade/downgrade). Resolve para
  // true se o vídeo ficou ligado, false caso contrário (ex.: WebCodecs ausente).
  setLocalVideo: (on: boolean, camDeviceId?: string | null) => Promise<boolean>;
  close: () => void;
};

const cameraConstraints = (
  camDeviceId?: string | null,
): MediaTrackConstraints => ({
  deviceId: camDeviceId ? { exact: camDeviceId } : undefined,
  width: { ideal: VIDEO_WIDTH },
  height: { ideal: VIDEO_HEIGHT },
  frameRate: { ideal: VIDEO_FPS },
});

export const openCall = async (
  sid: string,
  callId: string,
  micDeviceId: string | null,
  opts: OpenCallOptions = {},
): Promise<OpenCall> => {
  const wantVideo = !!opts.video && videoSupported();
  if (opts.video && !wantVideo) {
    console.warn(
      "video requested but WebCodecs/insertable-streams unsupported; audio only",
    );
  }

  const localStream =
    opts.inputStream ??
    (await navigator.mediaDevices.getUserMedia({
      audio: micDeviceId ? { deviceId: { exact: micDeviceId } } : true,
      video: wantVideo ? cameraConstraints(opts.camDeviceId) : false,
    }));
  const pc = new RTCPeerConnection({ iceServers: [] });
  let cleanup = () => {
    pc.close();
    localStream.getTracks().forEach((t) => t.stop());
  };
  const onAbort = () => cleanup();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    opts.signal?.throwIfAborted();
    // Áudio: uma track RTP Opus (nosso transporte). Só a track de áudio entra no
    // peer connection; a câmera é tratada pelo canal de vídeo (WebCodecs) abaixo.
    localStream.getAudioTracks().forEach((t) => pc.addTrack(t, localStream));
    pc.addTransceiver("audio", { direction: "recvonly" });
    const remoteHolder: { stream: MediaStream | null } = { stream: null };
    pc.ontrack = (ev) => {
      if (ev.track.kind !== "audio") return;
      remoteHolder.stream = ev.streams[0] ?? new MediaStream([ev.track]);
      opts.onRemoteStream?.(remoteHolder.stream);
    };

    // Vídeo: H264 sobre datachannel out-of-order, SEMPRE aberto (mesmo em chamada
    // de áudio) para permitir upgrade mid-call sem renegociar SDP.
    const video = setupVideoChannel(pc);

    // Estado da câmera local. Começa ligada só se a chamada nasceu em vídeo.
    let camTrack: MediaStreamTrack | null = wantVideo
      ? (localStream.getVideoTracks()[0] ?? null)
      : null;
    const local: { stream: MediaStream | null } = { stream: null };
    if (camTrack) {
      local.stream = new MediaStream([camTrack]);
      video.startSender(camTrack);
    }

    const setLocalVideo = async (
      on: boolean,
      camDeviceId?: string | null,
    ): Promise<boolean> => {
      if (on) {
        if (camTrack) return true; // já ligada
        if (!videoSupported()) return false;
        const cam = await navigator.mediaDevices.getUserMedia({
          video: cameraConstraints(camDeviceId),
        });
        if (opts.signal?.aborted) {
          cam.getTracks().forEach((track) => track.stop());
          opts.signal.throwIfAborted();
        }
        camTrack = cam.getVideoTracks()[0] ?? null;
        if (!camTrack) return false;
        local.stream = new MediaStream([camTrack]);
        video.startSender(camTrack);
        return true;
      }
      video.stopSender();
      if (camTrack) {
        try {
          camTrack.stop();
        } catch {}
      }
      camTrack = null;
      local.stream = null;
      return false;
    };

    cleanup = () => {
      opts.signal?.removeEventListener("abort", onAbort);
      video.close();
      localStream.getTracks().forEach((t) => t.stop());
      camTrack?.stop();
      pc.close();
    };
    if (wantVideo && opts.inputStream)
      await setLocalVideo(true, opts.camDeviceId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error) => {
        clearTimeout(timeout);
        pc.removeEventListener("icegatheringstatechange", check);
        opts.signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve();
      };
      const check = () => { if (pc.iceGatheringState === "complete") done(); };
      const abort = () => done(new Error("Call setup cancelled"));
      const timeout = setTimeout(() => done(new Error("Call media setup timed out")), 15_000);
      pc.addEventListener("icegatheringstatechange", check);
      opts.signal?.addEventListener("abort", abort, { once: true });
      if (opts.signal?.aborted) abort(); else check();
    });
    const { sdp_answer } = await apiPost<{ sdp_answer: string }>(
      `/api/sessions/${sid}/calls/${callId}/webrtc`,
      { sdp_offer: pc.localDescription!.sdp },
      opts.signal,
    );
    await pc.setRemoteDescription({ type: "answer", sdp: sdp_answer });
    return {
      pc,
      micStream: localStream,
      get remoteStream() {
        return remoteHolder.stream;
      },
      get localVideoStream() {
        return local.stream;
      },
      remoteVideoStream: video.remoteVideoStream,
      setLocalVideo,
      close: () => {
        opts.signal?.removeEventListener("abort", onAbort);
        video.close();
        try {
          localStream.getTracks().forEach((t) => t.stop());
        } catch {}
        try {
          if (camTrack) camTrack.stop();
        } catch {}
        try {
          pc.close();
        } catch {}
      },
    } as OpenCall;
  } catch (error) {
    opts.signal?.removeEventListener("abort", onAbort);
    cleanup();
    throw error;
  }
};

// =============================================================================
// Transporte adaptativo — escolhe WebRTC ou WebSocket conforme transport.ts
// =============================================================================

/**
 * openAdaptiveCall — ponto de entrada das chamadas. Consulta getTransport():
 *  - "webrtc" (padrão): usa openCall() normal (áudio + vídeo).
 *  - "websocket" (opt-in, atrás de proxy que bloqueia UDP): usa openWSCall()
 *    (áudio-only; campos de vídeo retornam null).
 *
 * A interface de retorno é compatível com OpenCall em todos os campos de áudio.
 */
export const openAdaptiveCall = async (
  sid: string,
  callId: string,
  micDeviceId: string | null,
  opts: OpenCallOptions = {},
): Promise<OpenCall> => {
  const translation = opts.translation ?? translationPreference(sid);
  if (translation.enabled) {
    return openTranslatedCall(
      sid,
      callId,
      micDeviceId,
      { ...opts, translation },
      openRawCall,
    );
  }
  return openRawCall(sid, callId, micDeviceId, opts);
};

const openRawCall = async (
  sid: string,
  callId: string,
  micDeviceId: string | null,
  opts: OpenCallOptions,
): Promise<OpenCall> => {
  if (getTransport() === "webrtc") {
    return openCall(sid, callId, micDeviceId, opts);
  }

  // Modo WebSocket — vídeo indisponível
  if (opts.video) {
    console.warn(
      "[transport] modo WebSocket: vídeo indisponível, seguindo em áudio-only",
    );
  }
  const wsConn = await openWSCall(
    sid,
    callId,
    micDeviceId,
    opts.inputStream,
    opts.onRemoteStream,
    opts.signal,
  );

  return {
    pc: null as unknown as RTCPeerConnection, // não usado fora do webrtc.ts
    micStream: wsConn.micStream,
    get remoteStream() {
      return wsConn.remoteStream;
    },
    localVideoStream: null,
    remoteVideoStream: null,
    setLocalVideo: wsConn.setLocalVideo,
    close: wsConn.close,
  };
};
