import { useState, type FormEvent } from "react";
import { Cloud, Loader2, QrCode } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createSession } from "@/services/sessions";
import { refreshSessions, setActiveSession } from "@/stores/sessions";
import { cn } from "@/lib/utils";
import { emptyMetaInput, MetaConfigFields } from "./MetaConfigFields";

export const NewSessionDialog = ({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) => {
  const [provider, setProvider] = useState<"qr" | "meta">("qr");
  const [name, setName] = useState("WhatsApp");
  const [meta, setMeta] = useState(emptyMetaInput);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const { id } = await createSession(name.trim() || "WhatsApp", provider === "meta" ? meta : undefined);
      setMeta(emptyMetaInput());
      await refreshSessions().catch(() => {});
      setActiveSession(id);
      onCreated();
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Nova conta WhatsApp</DialogTitle>
          <DialogDescription>Escolha como conectar esta conta.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <div role="group" aria-label="Provedor da conta" className="grid grid-cols-2 gap-2">
            {([
              { id: "qr", title: "QR / aparelho conectado", text: "Conecte pelo WhatsApp do celular.", Icon: QrCode },
              { id: "meta", title: "API oficial Meta", text: "WhatsApp Business Calling com credenciais.", Icon: Cloud },
            ] as const).map(({ id, title, text, Icon }) => (
              <button key={id} type="button" aria-pressed={provider === id} disabled={busy}
                onClick={() => { setProvider(id); if (id === "qr") setMeta(emptyMetaInput()); }}
                className={cn("space-y-2 rounded-xl border p-3 text-left text-sm transition-colors", provider === id ? "border-primary bg-primary/5" : "hover:bg-muted")}>
                <Icon className="h-5 w-5" />
                <span className="block font-medium">{title}</span>
                <span className="block text-xs text-muted-foreground">{text}</span>
              </button>
            ))}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-account-name">Nome da conta</Label>
            <Input id="new-account-name" value={name} onChange={(event) => setName(event.target.value)} disabled={busy} required />
          </div>
          {provider === "meta" && (
            <>
              <p className="text-sm text-muted-foreground">
                Configure um número Business com Calling habilitado. Depois de salvar, verifique as credenciais e conecte o webhook para liberar chamadas de áudio.
              </p>
              <MetaConfigFields value={meta} onChange={setMeta} disabled={busy} />
            </>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancelar</Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {provider === "meta" ? "Salvar conta oficial" : "Conectar por QR"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
