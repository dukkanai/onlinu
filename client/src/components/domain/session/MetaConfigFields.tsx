import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { MetaSessionInput, MetaSessionSettings } from "@/types/session";

export const emptyMetaInput = (): MetaSessionInput => ({
  phoneNumberId: "", wabaId: "", apiVersion: "v24.0", accessToken: "", appSecret: "", verifyToken: "",
});

export const MetaConfigFields = ({ value, onChange, saved, disabled = false }: {
  value: MetaSessionInput;
  onChange: (value: MetaSessionInput) => void;
  saved?: MetaSessionSettings;
  disabled?: boolean;
}) => {
  const prefix = useId();
  const fields: { name: keyof MetaSessionInput; label: string; secret?: boolean; stored?: boolean; placeholder?: string }[] = [
    { name: "phoneNumberId", label: "ID do número de telefone", placeholder: "Phone Number ID" },
    { name: "wabaId", label: "ID da conta WhatsApp Business", placeholder: "WABA ID" },
    { name: "apiVersion", label: "Versão da Graph API", placeholder: "v24.0" },
    { name: "accessToken", label: "Token de acesso", secret: true, stored: saved?.hasAccessToken },
    { name: "appSecret", label: "Segredo do aplicativo", secret: true, stored: saved?.hasAppSecret },
    { name: "verifyToken", label: "Token de verificação do webhook", secret: true, stored: saved?.hasVerifyToken },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.map(({ name, label, secret, stored, placeholder }) => (
        <div key={name} className="space-y-1.5">
          <Label htmlFor={`${prefix}-${name}`}>{label}</Label>
          <Input
            id={`${prefix}-${name}`}
            name={`meta-${name}`}
            type={secret ? "password" : "text"}
            autoComplete={secret ? "new-password" : "off"}
            spellCheck={false}
            value={value[name]}
            onChange={(event) => onChange({ ...value, [name]: event.target.value })}
            placeholder={stored ? "Salvo — deixe vazio para manter" : placeholder}
            required={!saved || !secret || !stored}
            disabled={disabled}
            pattern={name === "apiVersion" ? "v[0-9]+\\.[0-9]+" : name === "phoneNumberId" || name === "wabaId" ? "[0-9]+" : undefined}
            inputMode={name === "phoneNumberId" || name === "wabaId" ? "numeric" : undefined}
          />
        </div>
      ))}
      <p className="text-xs text-muted-foreground sm:col-span-2">
        As credenciais são enviadas ao servidor e não são guardadas no navegador.
        {saved && " Campos secretos vazios mantêm os valores já salvos."}
      </p>
    </div>
  );
};
