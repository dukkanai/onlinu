import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { openAdaptiveCall as openCall } from "@/lib/webrtc";
import { startCall, endCall } from "@/services/calls";
import { checkTranslation, translationPreference } from "@/stores/translation";
import { registerOwnConnection } from "@/stores/calls";
import { useSessions } from "@/stores/sessions";
import { getSessionProvider, isSessionReady, supportsSessionCapability } from "@/lib/session-provider";
import { getTransport } from "@/lib/transport";

export const useStartCall = (sid: string, micId: string | null) =>
  useMutation({
    mutationFn: async (vars: { phone: string; record: boolean; video: boolean }) => {
      const session = useSessions.getState().sessions.find((item) => item.id === sid);
      if (!session || !isSessionReady(session)) {
        throw new Error("Conecte a sessão antes de iniciar uma chamada.");
      }
      if (!supportsSessionCapability(session, "audio")) {
        throw new Error("Esta sessão não oferece chamadas de áudio.");
      }
      if (vars.video && !supportsSessionCapability(session, "video")) {
        throw new Error("Esta sessão não oferece chamadas de vídeo.");
      }
      if (vars.record && !supportsSessionCapability(session, "recording")) {
        throw new Error("Esta sessão não oferece gravação de chamadas.");
      }
      if (getSessionProvider(session) === "meta" && getTransport() !== "webrtc") {
        throw new Error("Chamadas Meta exigem WebRTC. Abra esta página com ?transport=webrtc e tente novamente.");
      }
      const translation = { ...translationPreference(sid) };
      await checkTranslation(translation);
      const { call } = await startCall(sid, vars.phone, vars.record, vars.video);
      try {
        const conn = await openCall(sid, call.callId, micId, { video: vars.video, translation });
        registerOwnConnection(call.callId, conn, vars.video);
      } catch (error) {
        await endCall(sid, call.callId).catch(() => {});
        throw error;
      }
      return call.callId;
    },
    onError: (e: Error) => {
      const m = e.message;
      if (m.includes("429")) toast.error("Limit reached: max concurrent calls.");
      else if (m.includes("503")) toast.error("WhatsApp not paired.");
      else toast.error(m);
    },
  });
