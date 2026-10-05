import { useEffect, useState, type FormEvent } from "react";
import { Check, Cloud, Copy, Loader2, RefreshCw, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getMetaSettings, updateMetaSettings, verifyMetaSettings } from "@/services/sessions";
import { refreshSessions } from "@/stores/sessions";
import { isSessionReady } from "@/lib/session-provider";
import type { MetaSessionSettings, SessionInfo } from "@/types/session";
import { emptyMetaInput, MetaConfigFields } from "./MetaConfigFields";

export const MetaConfiguration = ({ session }: { session: SessionInfo }) => {
  const [settings, setSettings] = useState<MetaSessionSettings | null>(null);
  const [fields, setFields] = useState(emptyMetaInput);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"load" | "save" | "verify" | null>("load");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const ready = isSessionReady(session);

  const applySettings = (value: MetaSessionSettings) => {
    setSettings(value);
    setFields({ ...emptyMetaInput(), phoneNumberId: value.phoneNumberId, wabaId: value.wabaId, apiVersion: value.apiVersion || "v24.0" });
  };

  useEffect(() => {
    let cancelled = false;
    setBusy("load");
    setError("");
    getMetaSettings(session.id)
      .then((value) => { if (!cancelled) applySettings(value); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setBusy(null); });
    return () => { cancelled = true; };
  }, [session.id, session.paired, session.state]);

  const run = async (action: "save" | "verify") => {
    if (busy) return;
    setBusy(action);
    setError("");
    try {
      if (action === "save") {
        await updateMetaSettings(session.id, fields);
        setFields((value) => ({ ...value, accessToken: "", appSecret: "", verifyToken: "" }));
        applySettings(await getMetaSettings(session.id));
        setEditing(false);
        toast.success("Configuração salva. Verifique a conexão antes de ligar.");
      } else {
        applySettings(await verifyMetaSettings(session.id));
        toast.success("Verificação concluída. Confira os requisitos abaixo.");
      }
      await refreshSessions();
    } catch (err) {
      setError((err as Error).message);
      // A failed provider check can still update redacted readiness flags.
      if (action === "verify") {
        await getMetaSettings(session.id).then(applySettings).catch(() => {});
        await refreshSessions().catch(() => {});
      }
    } finally {
      setBusy(null);
    }
  };

  const save = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void run("save"); };
  const copyWebhook = async () => {
    if (!settings?.webhookUrl) return;
    try {
      await navigator.clipboard.writeText(settings.webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { toast.error("Não foi possível copiar o webhook"); }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2"><Cloud className="h-5 w-5" /> API oficial Meta</CardTitle>
          <Badge variant={ready ? "success" : "secondary"}>{ready ? "Áudio disponível" : "Configuração pendente"}</Badge>
        </div>
        <CardDescription>
          Chamadas de áudio pelo WhatsApp Business Calling. A tradução de voz permanece disponível durante as chamadas.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!settings ? (
          <Button variant="outline" disabled={Boolean(busy)} onClick={() => void run("verify")}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {busy ? "Carregando configuração…" : "Tentar novamente"}
          </Button>
        ) : (
          <>
            <div className="flex flex-wrap gap-2" aria-label="Requisitos de conexão Meta">
              <Badge variant={settings.verified ? "success" : "muted"}>Credenciais: {settings.verified ? "verificadas" : "pendentes"}</Badge>
              <Badge variant={settings.webhookVerified ? "success" : "muted"}>Webhook: {settings.webhookVerified ? "verificado" : "pendente"}</Badge>
              <Badge variant={settings.callingEnabled ? "success" : "muted"}>Calling: {settings.callingEnabled ? "habilitado" : "pendente"}</Badge>
              <Badge variant={settings.sipEnabled ? "destructive" : "muted"}>SIP: {settings.sipEnabled ? "desative para usar WebRTC" : "desativado"}</Badge>
            </div>
            <div className="space-y-2">
              <label htmlFor={`webhook-${session.id}`} className="text-sm font-medium">URL do webhook</label>
              <div className="flex gap-2">
                <Input id={`webhook-${session.id}`} value={settings.webhookUrl || "URL pública do servidor não configurada"} readOnly className="font-mono text-xs" />
                <Button variant="outline" size="icon" onClick={() => void copyWebhook()} disabled={!settings.webhookUrl} aria-label="Copiar URL do webhook">
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            {(!ready || editing) && (
              <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                <li>No aplicativo Meta, configure esta URL e o mesmo token de verificação salvo aqui. Assine os eventos de chamadas e mensagens para receber chamadas e permissões.</li>
                <li>Habilite Calling no número Business e mantenha SIP desativado para esta conexão WebRTC.</li>
                <li>Verifique a conexão abaixo. Antes de ligar, solicite a permissão do contato no discador e aguarde a aprovação.</li>
              </ol>
            )}
            <p className="text-xs text-muted-foreground">
              A elegibilidade do número e dos países, as permissões da Meta e a primeira chamada real ainda precisam ser validadas na sua conta. Esta integração oferece áudio via WebRTC; vídeo, gravação, espera, transferência e mensagens comuns não estão disponíveis.
            </p>
            {editing ? (
              <form onSubmit={save} className="space-y-4 rounded-xl border p-4">
                <MetaConfigFields value={fields} onChange={setFields} saved={settings} disabled={Boolean(busy)} />
                <div className="flex flex-wrap justify-end gap-2">
                  <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => { applySettings(settings); setEditing(false); }}>Cancelar</Button>
                  <Button type="submit" disabled={Boolean(busy)}>{busy === "save" && <Loader2 className="h-4 w-4 animate-spin" />}Salvar configuração</Button>
                </div>
              </form>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={Boolean(busy)} onClick={() => setEditing(true)}><Settings2 className="h-4 w-4" />Editar credenciais</Button>
                <Button disabled={Boolean(busy)} onClick={() => void run("verify")}>
                  {busy === "verify" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  Verificar conexão
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
};
