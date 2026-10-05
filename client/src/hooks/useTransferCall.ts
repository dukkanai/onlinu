import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { transferCall } from "@/services/calls";
import { useSessions } from "@/stores/sessions";
import { supportsSessionCapability } from "@/lib/session-provider";

// Transferência cega: põe a chamada em espera com música e re-oferece a outro
// atendente. to opcional = clientId do atendente alvo; sem ele vai para a fila da conta.
export const useTransferCall = () =>
  useMutation({
    mutationFn: async (vars: { sid: string; callId: string; to?: string }) => {
      const session = useSessions.getState().sessions.find((item) => item.id === vars.sid);
      if (!session || !supportsSessionCapability(session, "transfer")) {
        throw new Error("Esta sessão não permite transferir chamadas.");
      }
      await transferCall(vars.sid, vars.callId, vars.to);
    },
    onSuccess: () => toast.success("Chamada transferida"),
    onError: (e: Error) => toast.error(e.message),
  });
