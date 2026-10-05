import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { openAdaptiveCall as openCall } from "@/lib/webrtc";
import { pickupCall, resumeCall, endCall } from "@/services/calls";
import { checkTranslation, translationPreference } from "@/stores/translation";
import { registerOwnConnection, clearTransferOffer } from "@/stores/calls";
import { useSessions } from "@/stores/sessions";
import { getSessionProvider, isSessionReady, supportsSessionCapability } from "@/lib/session-provider";
import { getTransport } from "@/lib/transport";

// Assume uma chamada transferida: fixa o novo dono no backend (sem re-aceitar no
// WhatsApp), abre a ponte WebRTC (que troca automaticamente a ponte do dono anterior)
// e tira da espera. Diferente do accept: NÃO chama acceptCall.
export const usePickupCall = (micId: string | null) =>
  useMutation({
    mutationFn: async (vars: { sid: string; callId: string }) => {
      const session = useSessions.getState().sessions.find((item) => item.id === vars.sid);
      if (!session || !isSessionReady(session)) {
        throw new Error("Conecte a sessão antes de atender uma chamada.");
      }
      if (!supportsSessionCapability(session, "audio") || !supportsSessionCapability(session, "transfer")) {
        throw new Error("Esta sessão não permite receber chamadas transferidas.");
      }
      if (getSessionProvider(session) === "meta" && getTransport() !== "webrtc") {
        throw new Error("Chamadas Meta exigem WebRTC. Abra esta página com ?transport=webrtc e tente novamente.");
      }
      const translation = { ...translationPreference(vars.sid) };
      await checkTranslation(translation);
      const res = await pickupCall(vars.sid, vars.callId);
      const id = res.call.callId;
      try {
        const conn = await openCall(vars.sid, id, micId, { video: false, translation });
        registerOwnConnection(id, conn);
        await resumeCall(vars.sid, id); // sai da espera só depois que a ponte assumiu
      } catch (error) {
        await endCall(vars.sid, id).catch(() => {});
        throw error;
      }
      clearTransferOffer();
      return id;
    },
    onError: (e: Error) => {
      clearTransferOffer();
      toast.error(e.message);
    },
  });
