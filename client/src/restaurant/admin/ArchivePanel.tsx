import { useCallback, useEffect, useState } from "react";
import { Archive, Download, RefreshCw, Save, Shield } from "lucide-react";
import { getApiKey } from "../../lib/auth";
import { adminRestaurant, RestaurantAPIError } from "../api";
import { useLocale } from "../i18n";
import { Check, Field } from "./Fields";

interface Policy { version: number; enabled: boolean; retentionEnabled: boolean; originalHours: number; summaryDays: number; noticeAccepted: boolean; aiEnabled: boolean; aiModel: string }
interface Conversation { id: string; sessionId: string; chat: string; createdAt: string; updatedAt: string; closedAt: string | null; orderNumber: string; version: number; summary: string; summarySource: string; holdReason: string; holdUntil: string | null; originalsPurged: boolean }
interface ArchiveMessage { id: string; fromMe: boolean; timestamp: number; type: string; body: string }
interface Media { id: string; kind: string; status: string; mime: string; seconds: number; bytes: number }
interface Detail { conversation: Conversation; messages: ArchiveMessage[]; media: Media[]; audit: { action: string; createdAt: string; actor: string }[] }
const failure = (problem: unknown) => problem instanceof RestaurantAPIError ? problem.code : "server_error";

export function ArchivePanel() {
  const { t, date } = useLocale();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [summary, setSummary] = useState("");
  const [order, setOrder] = useState("");
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const [verified, setVerified] = useState(false);
  const [aiConsent, setAIConsent] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const [settings, list] = await Promise.all([adminRestaurant<Policy>("/archive/policy", { signal }), adminRestaurant<{ conversations: Conversation[] }>("/archive/conversations", { signal })]);
      if (!signal?.aborted) { setPolicy(settings); setConversations(list.conversations); setError(""); }
    } catch (problem) { if (!signal?.aborted) setError(failure(problem)); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

  async function select(id: string) {
    if (busy) return;
    setBusy(true); setError(""); setSaved(false);
    try { const next = await adminRestaurant<Detail>(`/archive/conversations/${encodeURIComponent(id)}`); setDetail(next); setSummary(next.conversation.summary); setOrder(next.conversation.orderNumber); setReason(""); setUntil(""); setVerified(false); setAIConsent(false); }
    catch (problem) { setError(failure(problem)); }
    finally { setBusy(false); }
  }
  async function savePolicy() {
    if (!policy || busy) return;
    setBusy(true); setError(""); setSaved(false);
    try { setPolicy(await adminRestaurant<Policy>("/archive/policy", { method: "PUT", body: JSON.stringify(policy) })); setSaved(true); }
    catch (problem) { setError(failure(problem)); }
    finally { setBusy(false); }
  }
  async function change(action: string) {
    if (!detail || busy) return;
    setBusy(true); setError(""); setSaved(false);
    try {
      const payload = { version: detail.conversation.version, action, summary, orderNumber: order.trim(), verified, reason: reason.trim(), until: until ? new Date(until).toISOString() : null };
      const next = await adminRestaurant<Conversation>(`/archive/conversations/${encodeURIComponent(detail.conversation.id)}`, { method: "PATCH", body: JSON.stringify(payload) });
      setDetail({ ...detail, conversation: next }); setConversations(current => current.map(value => value.id === next.id ? next : value)); setSummary(next.summary); setSaved(true); setVerified(false);
    } catch (problem) { setError(failure(problem)); }
    finally { setBusy(false); }
  }
  async function generate() {
    if (!detail || busy || !aiConsent) return;
    setBusy(true); setError(""); setSaved(false);
    try { const next = await adminRestaurant<Conversation>(`/archive/conversations/${encodeURIComponent(detail.conversation.id)}/summarize`, { method: "POST", body: JSON.stringify({ version: detail.conversation.version, consent: aiConsent }) }); setDetail({ ...detail, conversation: next }); setSummary(next.summary); setSaved(true); setAIConsent(false); }
    catch (problem) { setError(failure(problem)); }
    finally { setBusy(false); }
  }
  async function download(media: Media) {
    if (!detail || busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/restaurant/archive/conversations/${encodeURIComponent(detail.conversation.id)}/media/${encodeURIComponent(media.id)}`, { headers: { "X-API-Key": getApiKey() }, credentials: "same-origin", cache: "no-store", redirect: "error" });
      if (!response.ok) throw new RestaurantAPIError(response.status === 401 ? "unauthorized" : "server_error", response.status);
      const objectURL = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a"); anchor.href = objectURL; anchor.download = `audio-${media.id}.${media.mime.includes("mpeg") ? "mp3" : "ogg"}`; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
    } catch (problem) { setError(failure(problem)); }
    finally { setBusy(false); }
  }
  const c = detail?.conversation;
  const auditLabel = (action: string) => ({ view: "archive.open", list: "archive.tab", close: "archive.close", summary: "archive.manual", link_order: "archive.link", hold: "archive.hold", release_hold: "archive.release", audio_download: "archive.download", originals_expired: "archive.expired", ai_text_disclosure_requested: "archive.aiConsent", ai_draft_saved: "archive.draft", policy_updated: "archive.saved" }[action] || "archive.action");
  return <section>
    <div className="ra-section-title"><p className="ra-muted">{t("archive.hint")}</p><button type="button" className="ra-secondary" onClick={() => void load()} disabled={busy || loading}><RefreshCw size={16} />{t("common.refresh")}</button></div>
    {error && <p className="ra-alert" role="alert">{t(`errors.${error}`)}</p>}{saved && <p className="ra-notice" role="status">{t("archive.saved")}</p>}
    {loading && !policy && <p role="status">{t("common.loading")}</p>}
    {policy && <form className="ra-card ra-spaced" onSubmit={event => { event.preventDefault(); void savePolicy(); }}><fieldset disabled={busy} className="ra-editor-fields">
      <Check label={t("archive.capture")} checked={policy.enabled} onChange={enabled => setPolicy({ ...policy, enabled })} />
      <Check label={t("archive.retention")} checked={policy.retentionEnabled} onChange={retentionEnabled => setPolicy({ ...policy, retentionEnabled })} />
      <div className="ra-grid-two"><Field label={t("archive.hours")}><input type="number" min={1} max={2160} required value={policy.originalHours} onChange={event => setPolicy({ ...policy, originalHours: Number(event.target.value) })} /></Field><Field label={t("archive.days")}><input type="number" min={1} max={3650} required value={policy.summaryDays} onChange={event => setPolicy({ ...policy, summaryDays: Number(event.target.value) })} /></Field></div>
      <Check label={t("archive.notice")} checked={policy.noticeAccepted} onChange={noticeAccepted => setPolicy({ ...policy, noticeAccepted })} />
      <Check label={t("archive.aiEnabled")} checked={policy.aiEnabled} onChange={aiEnabled => setPolicy({ ...policy, aiEnabled })} />
      {policy.aiEnabled && <><Field label={t("archive.aiModel")}><input dir="ltr" value={policy.aiModel} maxLength={100} required onChange={event => setPolicy({ ...policy, aiModel: event.target.value })} /></Field><p className="ra-muted">{t("archive.aiNotice")}</p></>}
      <button type="submit" className="ra-primary"><Save size={16} />{t(busy ? "common.loading" : "common.save")}</button>
    </fieldset></form>}
    <div className="ra-couriers-layout ra-spaced"><div className="ra-courier-list">
      {!loading && conversations.length === 0 && <div className="ra-card ra-empty"><Archive size={30} /><p>{t("archive.empty")}</p></div>}
      {conversations.map(value => <button key={value.id} type="button" className={`ra-card ra-courier-pick ${c?.id === value.id ? "ra-selected" : ""}`} aria-pressed={c?.id === value.id} disabled={busy} onClick={() => void select(value.id)}><strong dir="ltr">{value.chat}</strong><small>{date(value.updatedAt)}</small><p>{t(value.closedAt ? "archive.closed" : "archive.open")}</p>{value.holdReason && <Shield size={16} aria-label={t("archive.hold")} />}</button>)}
    </div>{detail && c && <div className="ra-card"><h2 dir="ltr">{c.chat}</h2>{c.originalsPurged && <p className="ra-notice">{t("archive.expired")}</p>}
      <fieldset disabled={busy} className="ra-editor-fields ra-spaced">
        <Field label={t("archive.summary")}><textarea rows={6} maxLength={16000} value={summary} onChange={event => setSummary(event.target.value)} /></Field>
        {c.summarySource && <p className="ra-muted">{t("archive.summarySource")}: {t(c.summarySource === "manual" ? "archive.manual" : c.summarySource === "metadata_only" ? "archive.metadata" : "archive.draft")}</p>}
        <button type="button" className="ra-secondary" disabled={!summary.trim()} onClick={() => void change("summary")}><Save size={16} />{t("archive.manual")}</button>
        {!c.closedAt && <button type="button" className="ra-secondary" onClick={() => void change("close")}>{t("archive.close")}</button>}
        <Field label={t("archive.order")}><input value={order} dir="ltr" maxLength={80} onChange={event => setOrder(event.target.value)} /></Field>
        <Check label={t("archive.verify")} checked={verified} onChange={setVerified} />
        <button type="button" className="ra-secondary" disabled={!verified || !order.trim()} onClick={() => void change("link_order")}>{t("archive.link")}</button>
        <h3>{t("archive.hold")}</h3><p className="ra-muted">{t("archive.holdHint")}</p>
        {c.holdReason && <p className="ra-notice">{c.holdReason} {c.holdUntil && date(c.holdUntil)}</p>}
        <Field label={t("archive.reason")}><textarea maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></Field>
        <Field label={t("archive.until")}><input type="datetime-local" value={until} onChange={event => setUntil(event.target.value)} /></Field>
        <div className="ra-row"><button type="button" className="ra-secondary" disabled={c.originalsPurged || !reason.trim() || !until} onClick={() => void change("hold")}>{t("archive.hold")}</button>{c.holdReason && <button type="button" className="ra-secondary" disabled={!verified || !reason.trim()} onClick={() => void change("release_hold")}>{t("archive.release")}</button>}</div>
        {policy?.aiEnabled && !c.originalsPurged && <><p className="ra-muted">{t("archive.aiNotice")}</p><Check label={t("archive.aiConsent")} checked={aiConsent} onChange={setAIConsent} /><button type="button" className="ra-secondary" disabled={!aiConsent} onClick={() => void generate()}>{t("archive.generate")}</button></>}
      </fieldset>
      <h3 className="ra-spaced">{t("archive.messages")}</h3><div>{detail.messages.map(message => <div key={message.id} className="ra-card ra-spaced"><small>{date(message.timestamp)}</small><p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{message.body || t(message.type === "audio" ? "archive.voice" : "archive.unavailable")}</p></div>)}</div>
      <h3 className="ra-spaced">{t("archive.audio")}</h3>{detail.media.map(media => <div key={media.id} className="ra-card ra-spaced"><p>{t(media.kind === "call" ? "archive.call" : "archive.voice")}</p>{media.status === "ready" ? <button type="button" className="ra-secondary" disabled={busy} onClick={() => void download(media)}><Download size={16} />{t("archive.download")}</button> : <p>{t(media.status === "pending" ? "archive.pending" : "archive.unavailable")}</p>}</div>)}
      <details className="ra-spaced"><summary>{t("archive.audit")}</summary>{detail.audit.map((item, index) => <p key={`${item.createdAt}-${index}`}>{date(item.createdAt)} — {t(auditLabel(item.action))} <small dir="ltr">{item.actor}</small></p>)}</details>
    </div>}</div>
  </section>;
}
