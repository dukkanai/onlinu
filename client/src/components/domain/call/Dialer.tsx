import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Phone, Video } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { DeviceSelector } from "@/components/form/DeviceSelector";
import { useStartCall } from "@/hooks/useStartCall";
import { useDevices } from "@/stores/devices";
import { useSessions } from "@/stores/sessions";
import { getSessionProvider, isSessionReady, supportsSessionCapability } from "@/lib/session-provider";
import { getMetaPermission, requestMetaPermission } from "@/services/sessions";
import { TranslationSettings } from "./TranslationSettings";

const permissionLabels: Record<string, string> = {
  granted: "Permissão concedida",
  approved: "Permissão concedida",
  accepted: "Permissão concedida",
  pending: "Aguardando autorização do cliente",
  requested: "Aguardando autorização do cliente",
  denied: "Permissão recusada",
  rejected: "Permissão recusada",
  expired: "Permissão expirada",
  revoked: "Permissão revogada",
  unknown: "Permissão ainda não confirmada",
  none: "Sem permissão para ligar",
};

export const Dialer = ({ sid }: { sid: string }) => {
  const [phone, setPhone] = useState("");
  const [video, setVideo] = useState(false);
  const [permissionPhone, setPermissionPhone] = useState("");
  const session = useSessions((s) => s.sessions.find((item) => item.id === sid));
  const micId = useDevices((s) => s.micId);
  const startCall = useStartCall(sid, micId);
  const queryClient = useQueryClient();
  const isMeta = getSessionProvider(session) === "meta";
  const ready = isSessionReady(session);
  const audioSupported = supportsSessionCapability(session, "audio");
  const videoSupported = supportsSessionCapability(session, "video");
  const normalizedPhone = phone.replace(/\D/g, "");
  const permissionKey = ["meta-permission", sid, permissionPhone];
  const permission = useQuery({
    queryKey: permissionKey,
    queryFn: () => getMetaPermission(sid, permissionPhone),
    enabled: isMeta && ready && permissionPhone.length >= 6 && permissionPhone === normalizedPhone,
    staleTime: 10_000,
    retry: false,
    refetchInterval: (query) => {
      const status = (query.state.data?.status ?? "").toLowerCase();
      return ["pending", "requested"].includes(status) ? 15_000 : false;
    },
  });
  const requestPermission = useMutation({
    mutationFn: (target: { sid: string; phone: string }) => requestMetaPermission(target.sid, target.phone),
    onSuccess: (result, target) => {
      queryClient.setQueryData(["meta-permission", target.sid, target.phone], result);
      toast.success("Solicitação de permissão enviada ao cliente.");
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const permissionStatus = (permission.data?.status ?? "unknown").toLowerCase();
  const permissionPending = ["pending", "requested"].includes(permissionStatus);
  const permissionGranted = permission.data?.canCall === true;
  const currentPermission = permissionPhone === normalizedPhone;
  const canCall = ready && audioSupported && !startCall.isPending && !!phone.trim()
    && (!isMeta || (currentPermission && !permission.isError && permissionGranted));

  useEffect(() => {
    const timer = setTimeout(() => setPermissionPhone(normalizedPhone), 500);
    return () => clearTimeout(timer);
  }, [normalizedPhone, sid]);

  useEffect(() => {
    setVideo(false);
    setPhone("");
    setPermissionPhone("");
  }, [sid]);

  const submit = () => {
    if (!canCall) return;
    startCall.mutate({ phone: phone.trim(), record: false, video: video && videoSupported }, { onSuccess: () => setPhone("") });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Discador</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <DeviceSelector />
        <TranslationSettings sid={sid} disabled={startCall.isPending} />
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder="+55 11 99999 9999"
            inputMode="tel"
            className="min-w-0 flex-1"
          />
          {videoSupported && <Button
            type="button"
            variant={video ? "default" : "outline"}
            size="sm"
            disabled={!ready || startCall.isPending}
            onClick={() => setVideo((v) => !v)}
            aria-pressed={video}
          >
            <Video className="h-4 w-4" />
            Vídeo
          </Button>}
          <Button onClick={submit} disabled={!canCall}>
            <Phone className="h-4 w-4" />
            {startCall.isPending ? "Ligando…" : "Ligar"}
          </Button>
        </div>
        {!ready && <p className="text-sm text-muted-foreground">Conecte e verifique a sessão para habilitar chamadas.</p>}
        {ready && !audioSupported && <p className="text-sm text-muted-foreground">Esta sessão não oferece chamadas de áudio.</p>}
        {isMeta && <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">Permissão para chamadas Meta</p>
          <p className="text-xs text-muted-foreground">
            O cliente precisa autorizar chamadas de saída. A solicitação envia uma mensagem de permissão no WhatsApp.
          </p>
          {normalizedPhone.length >= 6 && <p role="status" className="text-sm">
            {!currentPermission || permission.isFetching
              ? "Consultando permissão…"
              : permission.isError
                ? "Não foi possível consultar a permissão. Tente atualizar."
                : permissionGranted ? "Permissão concedida" : permissionLabels[permissionStatus] ?? `Permissão: ${permissionStatus}`}
          </p>}
          {currentPermission && permission.data?.expiresAt && <p className="text-xs text-muted-foreground">
            Validade: {new Date(permission.data.expiresAt * 1000).toLocaleString()}
          </p>}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!ready || normalizedPhone.length < 6 || requestPermission.isPending || (currentPermission && (permissionPending || permissionGranted))}
              onClick={() => requestPermission.mutate({ sid, phone: normalizedPhone })}
            >
              {requestPermission.isPending ? "Enviando…" : "Solicitar permissão"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!ready || permissionPhone.length < 6 || !currentPermission || permission.isFetching || requestPermission.isPending}
              onClick={() => void permission.refetch()}
            >
              Atualizar permissão
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Esta integração Meta oferece chamadas de áudio via WebRTC.</p>
        </div>}
        {!isMeta && <p className="text-xs text-muted-foreground">
          Você pode fazer várias ligações ao mesmo tempo — disque outro número e uma nova chamada aparece abaixo.
        </p>}
      </CardContent>
    </Card>
  );
};
