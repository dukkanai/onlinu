import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { openAdaptiveCall as openCall } from "@/lib/webrtc";
import { acceptCall, endCall } from "@/services/calls";
import { registerOwnConnection, clearIncoming } from "@/stores/calls";
import { checkTranslation, translationPreference } from "@/stores/translation";
import { useSessions } from "@/stores/sessions";
import { getSessionProvider, isSessionReady, supportsSessionCapability } from "@/lib/session-provider";
import { getTransport } from "@/lib/transport";

export const useAcceptCall = (micId: string | null) =>
  useMutation({
    mutationFn: async (vars: { sid: string; callId: string; video: boolean }) => {
      const session = useSessions.getState().sessions.find((item) => item.id === vars.sid);
      if (!session || !isSessionReady(session)) {
        throw new Error("Conecte a sessão antes de atender uma chamada.");
      }
      if (!supportsSessionCapability(session, "audio")) {
        throw new Error("Esta sessão não oferece chamadas de áudio.");
      }
      if (getSessionProvider(session) === "meta" && getTransport() !== "webrtc") {
        throw new Error("Chamadas Meta exigem WebRTC. Abra esta página com ?transport=webrtc e tente novamente.");
      }
      const video = vars.video && supportsSessionCapability(session, "video");
      const translation = { ...translationPreference(vars.sid) };
      await checkTranslation(translation);
      const res = await acceptCall(vars.sid, vars.callId);
      try {
        const conn = await openCall(vars.sid, res.call.callId, micId, { video, translation });
        registerOwnConnection(res.call.callId, conn, video);
      } catch (wrtcErr) {
        try {
          await endCall(vars.sid, res.call.callId);
        } catch {}
        throw wrtcErr;
      }
      clearIncoming();
      return res.call.callId;
    },
    onError: (e: Error) => {
      if (e.message.includes("409")) {
        clearIncoming();
        return;
      }
      toast.error(e.message);
    },
  });
