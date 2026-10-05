import { useMutation } from "@tanstack/react-query";
import { holdCall, resumeCall } from "@/services/calls";
import { toast } from "sonner";
import { useSessions } from "@/stores/sessions";
import { supportsSessionCapability } from "@/lib/session-provider";

// useCallHold expõe colocar em espera / retomar uma chamada. O backend mantém o leg
// vivo e toca música de espera para o interlocutor enquanto held=true.
export const useCallHold = () =>
  useMutation({
    mutationFn: async (vars: { sid: string; callId: string; hold: boolean }) => {
      const session = useSessions.getState().sessions.find((item) => item.id === vars.sid);
      if (!session || !supportsSessionCapability(session, "hold")) {
        throw new Error("Esta sessão não permite colocar chamadas em espera.");
      }
      if (vars.hold) await holdCall(vars.sid, vars.callId);
      else await resumeCall(vars.sid, vars.callId);
    },
    onError: (e: Error) => toast.error(e.message),
  });
