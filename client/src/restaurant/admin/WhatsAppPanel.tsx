import { useEffect, useState } from "react";
import { Cloud, Plus, Power, QrCode, RefreshCw, Save } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { createSession, getMetaSettings, logoutSession, pairSession, updateMetaSettings, verifyMetaSettings } from "../../services/sessions";
import { ensureSessionsWired, refreshSessions, setActiveSession, useSessions } from "../../stores/sessions";
import { getSessionProvider, isPairingState, isSessionReady } from "../../lib/session-provider";
import type { MetaSessionInput, MetaSessionSettings, SessionInfo } from "../../types/session";
import { emptyMetaInput } from "../../components/domain/session/MetaConfigFields";
import { useLocale } from "../i18n";
import { Field } from "./Fields";

const metaFields: { key: keyof MetaSessionInput; secret?: keyof Pick<MetaSessionSettings, "hasAccessToken" | "hasAppSecret" | "hasVerifyToken"> }[] = [
  { key: "phoneNumberId" }, { key: "wabaId" }, { key: "apiVersion" },
  { key: "accessToken", secret: "hasAccessToken" }, { key: "appSecret", secret: "hasAppSecret" }, { key: "verifyToken", secret: "hasVerifyToken" },
];

function MetaFields({ value, onChange, saved }: { value: MetaSessionInput; onChange: (value: MetaSessionInput) => void; saved?: MetaSessionSettings }) {
  const { t } = useLocale();
  return <><div className="ra-form-grid">{metaFields.map(({ key, secret }) => <Field key={key} label={t(`adminNext.${key}`)}><input dir="ltr" name={`restaurant-meta-${key}`} type={secret ? "password" : "text"} value={value[key]} maxLength={8192} autoComplete={secret ? "new-password" : "off"} spellCheck={false} required={!secret || !saved?.[secret]} placeholder={secret && saved?.[secret] ? t("adminNext.secretSaved") : ""} pattern={key === "apiVersion" ? "v[0-9]+\\.[0-9]+" : key === "wabaId" || key === "phoneNumberId" ? "[0-9]+" : undefined} onChange={event => onChange({ ...value, [key]: event.target.value })} /></Field>)}</div><p className="ra-muted">{t("adminNext.metaSecretHint")}</p></>;
}

function MetaEditor({ session }: { session: SessionInfo }) {
  const { t } = useLocale();
  const [saved, setSaved] = useState<MetaSessionSettings | null>(null);
  const [draft, setDraft] = useState(emptyMetaInput);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [notice, setNotice] = useState("");
  function apply(value: MetaSessionSettings) { setSaved(value); setDraft({ ...emptyMetaInput(), phoneNumberId: value.phoneNumberId, wabaId: value.wabaId, apiVersion: value.apiVersion || "v24.0" }); }
  useEffect(() => {
    let active = true; setBusy(true); setError(false);
    getMetaSettings(session.id).then(value => { if (active) apply(value); }).catch(() => { if (active) setError(true); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [session.id]);
  async function run(action: "save" | "verify" | "load") {
    if (busy) return;
    setBusy(true); setError(false); setNotice("");
    try {
      if (action === "save") { await updateMetaSettings(session.id, draft); setDraft(current => ({ ...current, accessToken: "", appSecret: "", verifyToken: "" })); apply(await getMetaSettings(session.id)); setNotice("adminNext.connectionSaved"); }
      else if (action === "verify") { apply(await verifyMetaSettings(session.id)); setNotice("adminNext.connectionChecked"); }
      else apply(await getMetaSettings(session.id));
      await refreshSessions();
    } catch { setError(true); }
    finally { setBusy(false); }
  }
  return <section className="ra-card"><h2>{t("adminNext.metaProvider")}</h2><p className="ra-muted ra-spaced">{t("adminNext.metaHint")}</p>
    {error && <p className="ra-alert ra-spaced" role="alert">{t("common.error")}<button type="button" disabled={busy} onClick={() => void run("load")}>{t("common.retry")}</button></p>}{notice && <p className="ra-notice ra-spaced" role="status">{t(notice)}</p>}
    {saved && <><div className="ra-meta-flags ra-spaced">{([["verified", "adminNext.metaVerified"], ["webhookVerified", "adminNext.webhookVerified"], ["callingEnabled", "adminNext.callingEnabled"]] as const).map(([key, label]) => <span key={key} className={`ra-status ${saved[key] ? "ra-status-completed" : "ra-status-new"}`}>{t(label)}: {saved[key] ? "✓" : "—"}</span>)}</div>{saved.sipEnabled && <p className="ra-warning">{t("adminNext.sipWarning")}</p>}<Field label={t("adminNext.metaWebhook")}><input dir="ltr" readOnly value={saved.webhookUrl} onFocus={event => event.target.select()} /></Field></>}
    <form onSubmit={event => { event.preventDefault(); void run("save"); }}><fieldset disabled={busy || !saved} className="ra-editor-fields"><MetaFields value={draft} onChange={setDraft} saved={saved ?? undefined} /><div className="ra-row ra-spaced"><button className="ra-primary" type="submit"><Save size={16} />{t("common.save")}</button><button className="ra-secondary" type="button" onClick={() => void run("verify")}><RefreshCw size={16} />{t("adminNext.verifyMeta")}</button></div></fieldset></form>
    <p className="ra-muted ra-spaced">{t("adminNext.metaEligibility")}</p>
  </section>;
}

export function WhatsAppPanel() {
  const { t } = useLocale();
  const sessions = useSessions(state => state.sessions);
  const qrs = useSessions(state => state.qrs);
  const selectedID = useSessions(state => state.activeId);
  const selected = sessions.find(session => session.id === selectedID) ?? sessions[0];
  const [creating, setCreating] = useState(false);
  const [provider, setProvider] = useState<"qr" | "meta">("qr");
  const [name, setName] = useState("");
  const [meta, setMeta] = useState(emptyMetaInput);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true; ensureSessionsWired();
    refreshSessions().catch(() => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  async function refresh() { setError(false); try { await refreshSessions(); } catch { setError(true); } }
  async function create() {
    if (busy) return;
    setBusy(true); setError(false);
    try { const result = await createSession(name.trim(), provider === "meta" ? meta : undefined); setMeta(emptyMetaInput()); setName(""); setCreating(false); await refreshSessions(); setActiveSession(result.id); }
    catch { setError(true); }
    finally { setBusy(false); }
  }
  async function pair(id: string) { if (busy) return; setBusy(true); setError(false); try { await pairSession(id); await refreshSessions(); } catch { setError(true); } finally { setBusy(false); } }
  async function disconnect(session: SessionInfo) {
    if (busy || getSessionProvider(session) !== "qr" || !session.paired || !window.confirm(t("adminNext.disconnectQRConfirm", { name: session.name }))) return;
    setBusy(true); setError(false);
    try { await logoutSession(session.id); await refreshSessions(); }
    catch { setError(true); }
    finally { setBusy(false); }
  }
  return <section><div className="ra-section-title"><p className="ra-muted">{t("adminNext.whatsappHint")}</p><div className="ra-row"><button className="ra-secondary" type="button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={16} />{t("common.refresh")}</button><button className="ra-primary" type="button" disabled={busy} onClick={() => { setCreating(true); setMeta(emptyMetaInput()); setName(""); }}><Plus size={16} />{t("adminNext.addSession")}</button></div></div>
    {error && <p className="ra-alert" role="alert">{t("common.error")}</p>}
    {creating && <form className="ra-card ra-spaced" onSubmit={event => { event.preventDefault(); void create(); }}><h2>{t("adminNext.addSession")}</h2><fieldset disabled={busy} className="ra-editor-fields ra-spaced"><div className="ra-form-grid"><Field label={t("adminNext.connectionName")}><input value={name} required maxLength={100} onChange={event => setName(event.target.value)} /></Field><Field label={t("adminNext.provider")}><select value={provider} onChange={event => { setProvider(event.target.value as "qr" | "meta"); setMeta(emptyMetaInput()); }}><option value="qr">{t("adminNext.qrProvider")}</option><option value="meta">{t("adminNext.metaProvider")}</option></select></Field></div>{provider === "meta" ? <><p className="ra-muted ra-spaced">{t("adminNext.metaHint")}</p><MetaFields value={meta} onChange={setMeta} /></> : <p className="ra-muted">{t("adminNext.qrHint")}</p>}<div className="ra-row ra-spaced"><button type="submit" className="ra-primary">{t(busy ? "common.loading" : "adminNext.addSession")}</button><button type="button" className="ra-secondary" onClick={() => { setCreating(false); setMeta(emptyMetaInput()); }}>{t("common.cancel")}</button></div></fieldset></form>}
    {loading && <p role="status">{t("common.loading")}</p>}{!loading && !sessions.length && <div className="ra-card ra-empty ra-spaced"><QrCode size={35} /><p>{t("adminNext.noSessions")}</p></div>}
    <div className="ra-whatsapp-layout ra-spaced"><div className="ra-session-list">{sessions.map(session => <button type="button" key={session.id} className={`ra-card ra-session-pick ${session.id === selected?.id ? "ra-selected" : ""}`} aria-pressed={session.id === selected?.id} disabled={busy} onClick={() => setActiveSession(session.id)}><div>{getSessionProvider(session) === "meta" ? <Cloud size={20} /> : <QrCode size={20} />}<strong>{session.name}</strong></div><span className={`ra-status ${isSessionReady(session) ? "ra-status-completed" : "ra-status-new"}`}>{t(`adminNext.state.${session.state}`)}</span></button>)}</div>
      {selected && (getSessionProvider(selected) === "meta" ? <MetaEditor key={selected.id} session={selected} /> : <section className="ra-card"><div className="ra-section-title"><h2>{selected.name}</h2><span className={`ra-status ${isSessionReady(selected) ? "ra-status-completed" : "ra-status-new"}`}>{t(`adminNext.state.${selected.state}`)}</span></div>
        {!selected.paired && isPairingState(selected.state) && qrs[selected.id] ? <><div className="ra-qr"><QRCodeSVG value={qrs[selected.id]} size={240} marginSize={4} level="M" title={t("adminNext.qrProvider")} /></div><p className="ra-muted">{t("adminNext.qrHint")}</p></> : !selected.paired && <p className="ra-muted">{t(selected.state === "qr" || selected.state === "connecting" ? "adminNext.qrWaiting" : "adminNext.qrStartHint")}</p>}
        {!selected.paired && <button type="button" className="ra-primary ra-spaced" disabled={busy} onClick={() => void pair(selected.id)}><QrCode size={16} />{t("adminNext.showQR")}</button>}
        {selected.paired && <button type="button" className="ra-secondary ra-danger ra-spaced" disabled={busy} onClick={() => void disconnect(selected)}><Power size={16} />{t("adminNext.disconnectQR")}</button>}
        <a className="ra-secondary ra-spaced" href="/admin/calls">{t("admin.calls")}</a>
      </section>)}
    </div>
  </section>;
}
