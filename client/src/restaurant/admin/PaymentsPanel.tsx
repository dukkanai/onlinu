import { useCallback, useEffect, useState } from "react";
import { CreditCard, RefreshCw, Save } from "lucide-react";
import { adminRestaurant, RestaurantAPIError } from "../api";
import { useLocale } from "../i18n";
import { Check, Field } from "./Fields";

export interface PaymentProviderConfig {
  id: string; name: string; enabled: boolean; mode: "test" | "live"; configured: boolean;
  fields: { key: string; label: string; secret: boolean; required: boolean }[];
  values: Record<string, string>; secretSet: Record<string, boolean>; webhookUrl?: string;
  limitation?: "paylink_sandbox_only" | "hyperpay_test_only" | "merchant_mode_credentials" | "stripe_merchant_eligibility" | "merchant_sar_currency";
}

export function paymentConfigPayload(config: PaymentProviderConfig, enabled: boolean, mode: "test" | "live", values: Record<string, string>, secrets: Record<string, string>, clear: string[]) {
  const fields = new Map(config.fields.map(field => [field.key, field]));
  return {
    enabled, mode,
    values: Object.fromEntries(Object.entries(values).filter(([key]) => fields.has(key) && !fields.get(key)!.secret)),
    secrets: Object.fromEntries(Object.entries(secrets).filter(([key, value]) => fields.get(key)?.secret && Boolean(value.trim()) && !clear.includes(key))),
    clearSecrets: [...new Set(clear)].filter(key => fields.get(key)?.secret),
  };
}

export function PaymentProviderEditor({ config, onSaved, country }: { config: PaymentProviderConfig; onSaved: (value: PaymentProviderConfig) => void; country: string }) {
  const { t } = useLocale();
  const [enabled, setEnabled] = useState(config.enabled);
  const [mode, setMode] = useState<"test" | "live">(config.mode);
  const [values, setValues] = useState(config.values ?? {});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [clear, setClear] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(false);
  useEffect(() => { setEnabled(config.enabled); setMode(config.mode); setValues(config.values ?? {}); setSecrets({}); setClear([]); }, [config]);
  async function save() {
    if (busy) return;
    if (enabled && mode === "live" && (!config.enabled || config.mode !== "live") && !window.confirm(t("adminNext.liveConfirm"))) return;
    setBusy(true); setError(""); setNotice(false);
    try {
      const value = await adminRestaurant<PaymentProviderConfig>(`/payments/${encodeURIComponent(config.id)}`, { method: "PUT", body: JSON.stringify(paymentConfigPayload(config, enabled, mode, values, secrets, clear)) });
      setSecrets({}); setClear([]); onSaved(value); setNotice(true);
    } catch (problem) { setError(problem instanceof RestaurantAPIError ? problem.code : "server_error"); }
    finally { setBusy(false); }
  }
  return <form className="ra-card ra-provider-card" onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className="ra-section-title"><h2><CreditCard size={18} /> {config.name}</h2><span className={`ra-status ${config.configured ? "ra-status-completed" : "ra-status-new"}`}>{t(config.configured ? "adminNext.configured" : "adminNext.notConfigured")}</span></div>
    {error && <p className="ra-alert" role="alert">{t(`errors.${error}`)}</p>}{notice && <p className="ra-notice" role="status">{t("adminNext.gatewaySaved")}</p>}
    <fieldset disabled={busy} className="ra-editor-fields">
      <Check label={t("adminNext.gatewayEnabled")} checked={enabled} onChange={setEnabled} />
      <Field label={t("adminNext.mode")}><select value={mode} onChange={event => setMode(event.target.value as "test" | "live")}><option value="test">{t("adminNext.testMode")}</option><option value="live" disabled={config.limitation === "hyperpay_test_only" || config.limitation === "paylink_sandbox_only"}>{t("adminNext.liveMode")}</option></select></Field>
      {config.limitation && config.limitation !== "stripe_merchant_eligibility" && <p className="ra-warning ra-spaced">{t(`adminNext.providerLimit.${config.limitation}`)}</p>}
      {config.fields.map(field => {
        const stored = Boolean(config.secretSet?.[field.key]) && !clear.includes(field.key);
        return <div key={field.key}>
          <Field label={t(`payments.field.${field.key}`)}><input name={`payment-${config.id}-${field.key}`} dir="ltr" type={field.secret ? "password" : "text"} autoComplete={field.secret ? "new-password" : "off"} spellCheck={false} maxLength={8192}
            value={field.secret ? secrets[field.key] ?? "" : values[field.key] ?? ""} placeholder={field.secret && stored ? t("adminNext.secretSaved") : ""}
            required={enabled && field.required && (!field.secret || !stored)} onChange={event => {
              if (field.secret) { setSecrets(current => ({ ...current, [field.key]: event.target.value })); setClear(current => current.filter(key => key !== field.key)); }
              else setValues(current => ({ ...current, [field.key]: event.target.value }));
            }} /></Field>
          {field.secret && config.secretSet?.[field.key] && <Check label={`${t("adminNext.clearSecret")}: ${t(`payments.field.${field.key}`)}`} checked={clear.includes(field.key)} onChange={checked => { setClear(current => checked ? [...new Set([...current, field.key])] : current.filter(key => key !== field.key)); if (checked) setSecrets(current => ({ ...current, [field.key]: "" })); }} />}
        </div>;
      })}
      <p className="ra-muted">{t("adminNext.secretHint")}</p>
      {config.webhookUrl && <Field label={t("adminNext.webhook")}><input value={config.webhookUrl} readOnly dir="ltr" onFocus={event => event.target.select()} /></Field>}
      {config.id === "stripe" && country === "SA" && <p className="ra-warning">{t("adminNext.stripeSaudi")}</p>}
      <p className="ra-muted ra-spaced">{t("adminNext.providerNotTested")}</p>
      <button type="submit" className="ra-primary"><Save size={16} />{t(busy ? "common.loading" : "common.save")}</button>
    </fieldset>
  </form>;
}

export function PaymentsPanel({ country = "SA" }: { country?: string }) {
  const { t } = useLocale();
  const [providers, setProviders] = useState<PaymentProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError("");
    try { const result = await adminRestaurant<{ providers: PaymentProviderConfig[] }>("/payments", { signal }); if (!signal?.aborted) setProviders(result.providers ?? []); }
    catch (problem) { if (!signal?.aborted) setError(problem instanceof RestaurantAPIError ? problem.code : "server_error"); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  return <section><div className="ra-section-title"><div><p className="ra-muted">{t("adminNext.paymentGatewayHint")}</p><p className="ra-muted">{t("adminNext.sarOnly")}</p></div><button type="button" className="ra-secondary" disabled={loading} onClick={() => void load()}><RefreshCw size={16} />{t("common.refresh")}</button></div>
    <p className="ra-warning ra-spaced">{t("adminNext.demoModeRule")}</p>
    {error && <p className="ra-alert" role="alert">{t(`errors.${error}`)}</p>}{loading && !providers.length && <p role="status">{t("common.loading")}</p>}
    <div className="ra-provider-grid">{providers.map(provider => <PaymentProviderEditor key={provider.id} config={provider} country={country} onSaved={saved => setProviders(current => current.map(entry => entry.id === saved.id ? saved : entry))} />)}</div>
  </section>;
}
