import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, RotateCcw } from "lucide-react";
import { adminRestaurant, RestaurantAPIError } from "../api";
import { useLocale } from "../i18n";
import type { Order } from "../types";
import type { Refund, RefundCapability, RefundRequest, RefundSummary } from "../refundTypes";
import { Field, MoneyInput } from "./Fields";

// Preserve uncertain request identity across admin-tab navigation in this page.
const pendingRequests = new Map<string, RefundRequest>();
type RefundOperation = "refresh" | "manual" | "execute" | "verify-reference";
export function refundRequest(previous: RefundRequest | undefined, amountMinor: number, reason: string, version: number, id: () => string): RefundRequest {
  const cleanReason = reason.trim();
  return previous && previous.amountMinor === amountMinor && previous.reason === cleanReason ? previous : { requestId: id(), amountMinor, reason: cleanReason, version };
}
export function validRefundAmount(summary: RefundSummary, amount: number): boolean {
  return Number.isSafeInteger(amount) && amount > 0 && amount <= summary.availableMinor && (summary.capability.partial || amount === summary.availableMinor);
}
export const pendingRefundMinor = (summary: RefundSummary) => Math.max(0, summary.reservedMinor - summary.refundedMinor);
export function refundActions(refund: Refund, capability: RefundCapability, capturedMinor: number) {
  return {
    execute: capability.automatic && !refund.submitted && ((refund.status === "requested" && !refund.authorized) || refund.status === "review") && capturedMinor >= refund.amountMinor,
    manual: capability.manual && refund.status === "review" && !refund.submitted && capturedMinor >= refund.amountMinor,
    refresh: Boolean(refund.providerReference) && ["processing", "review"].includes(refund.status),
    "verify-reference": refund.status === "review" && refund.submitted && !refund.providerReference,
  };
}

function RefundRecord({ refund, capability, capturedMinor, busy, action }: { refund: Refund; capability: RefundCapability; capturedMinor: number; busy: boolean; action: (refund: Refund, operation: RefundOperation, body: object) => Promise<boolean> }) {
  const { t, date, money } = useLocale();
  const [resolution, setResolution] = useState<"manual" | "verify-reference" | null>(null);
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const allowed = refundActions(refund, capability, capturedMinor);
  async function report() {
    if (busy || !resolution || !allowed[resolution] || reference.trim().length < 3 || reason.trim().length < 3) return;
    if (resolution === "manual" && !window.confirm(t("adminRefund.manualConfirm", { amount: money(refund.amountMinor, refund.currency) }))) return;
    if (await action(refund, resolution, { reference: reference.trim(), reason: reason.trim(), version: refund.version })) { setResolution(null); setReference(""); setReason(""); }
  }
  return <article className="ra-support-record"><div className="ra-section-title"><strong>{money(refund.amountMinor, refund.currency)}</strong><span className={`ra-status ${refund.status === "succeeded" && refund.confirmation === "provider" ? "ra-status-completed" : "ra-status-new"}`}>{t(`adminRefund.status.${refund.status}`)}</span></div>
    <p className="ra-muted">{t(`adminRefund.confirmation.${refund.confirmation}`)} · <time dateTime={refund.createdAt}>{date(refund.createdAt)}</time></p><p className="ra-preserve-text ra-spaced">{refund.reason === "restaurant_cancelled" ? t("order.status.cancelled") : refund.reason === "late_verified_payment" ? t("adminRefund.latePayment") : refund.reason}</p>
    {(refund.providerReference || refund.manualReference) && <p className="ra-preserve-text" dir="ltr">{refund.providerReference || refund.manualReference}</p>}{refund.resolutionReason && <p className="ra-preserve-text">{refund.resolutionReason === "refund_preflight_required" ? t("adminRefund.status.review") : refund.resolutionReason}</p>}
    <div className="ra-row ra-spaced">{allowed.execute && <button type="button" className="ra-primary" disabled={busy} onClick={() => { if (window.confirm(t("adminRefund.confirm", { amount: money(refund.amountMinor, refund.currency), number: refund.number }))) void action(refund, "execute", { version: refund.version }); }}>{t("adminRefund.execute")}</button>}
      {allowed.refresh && <button type="button" className="ra-secondary" disabled={busy} title={t("adminRefund.refreshHint")} onClick={() => void action(refund, "refresh", {})}><RefreshCw size={16} />{t("common.refresh")}</button>}
      {allowed.manual && <button type="button" className="ra-secondary" disabled={busy} onClick={() => setResolution(value => value === "manual" ? null : "manual")}>{t("adminRefund.manual")}</button>}
      {allowed["verify-reference"] && <button type="button" className="ra-secondary" disabled={busy} onClick={() => setResolution(value => value === "verify-reference" ? null : "verify-reference")}>{t("adminRefund.verifyReference")}</button>}
    </div>
    {resolution && allowed[resolution] && <form className="ra-spaced" onSubmit={event => { event.preventDefault(); void report(); }}><p className="ra-warning">{t(resolution === "manual" ? "adminRefund.manualWarning" : "adminRefund.verifyReferenceHint")}</p><fieldset className="ra-editor-fields ra-spaced" disabled={busy}><Field label={t("adminRefund.reference")}><input required minLength={3} maxLength={200} value={reference} onChange={event => setReference(event.target.value)} /></Field><Field label={t("adminSupport.reason")}><textarea required minLength={3} maxLength={1000} rows={3} value={reason} onChange={event => setReason(event.target.value)} /></Field><button type="submit" className="ra-primary" disabled={reference.trim().length < 3 || reason.trim().length < 3}>{t(resolution === "manual" ? "adminRefund.manual" : "adminRefund.verifyReference")}</button></fieldset></form>}
  </article>;
}

export function RefundsPanel({ order, disabled = false, onBusyChange, onChanged }: { order: Order; disabled?: boolean; onBusyChange?: (value: boolean) => void; onChanged?: () => void }) {
  const { t, money } = useLocale();
  const [summary, setSummary] = useState<RefundSummary | null>(null);
  const [amount, setAmount] = useState<number | null>(() => pendingRequests.get(order.number)?.amountMinor ?? null);
  const [reason, setReason] = useState(() => pendingRequests.get(order.number)?.reason ?? "");
  const [pending, setPending] = useState(() => pendingRequests.has(order.number));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const path = `/orders/${encodeURIComponent(order.number)}/refunds`;
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await adminRestaurant<RefundSummary>(path, { signal });
      if (signal?.aborted) return;
      setSummary(result);
      const request = pendingRequests.get(order.number);
      if (request && result.refunds.some(refund => refund.requestId === request.requestId)) { pendingRequests.delete(order.number); setPending(false); setReason(""); setAmount(null); setNotice("adminRefund.saved"); setError(""); }
    } catch (problem) { if (!signal?.aborted) setError(problem instanceof RestaurantAPIError ? problem.code : "server_error"); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [path, order.number]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load, order.version]);
  useEffect(() => {
    if (!busy && !pending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [busy, pending]);
  function start() { if (disabled || busyRef.current) return false; busyRef.current = true; setBusy(true); onBusyChange?.(true); setError(""); setNotice(""); return true; }
  function finish() { busyRef.current = false; setBusy(false); onBusyChange?.(false); onChanged?.(); }
  async function create() {
    const currentAmount = amount ?? summary?.availableMinor ?? 0;
    if (!summary || !validRefundAmount(summary, currentAmount) || reason.trim().length < 3 || reason.trim().length > 1000 || busyRef.current || disabled) return;
    if (!window.confirm(t("adminRefund.confirm", { amount: money(currentAmount, order.currency), number: order.number }))) return;
    if (!start()) return;
    const body = refundRequest(pendingRequests.get(order.number), currentAmount, reason, order.version, () => crypto.randomUUID());
    pendingRequests.set(order.number, body); setPending(true);
    try {
      await adminRestaurant<Refund>(path, { method: "POST", body: JSON.stringify(body) });
      pendingRequests.delete(order.number); setPending(false); setReason(""); setAmount(null); setNotice("adminRefund.saved"); await load();
    } catch (problem) {
      if (problem instanceof RestaurantAPIError && problem.status >= 400 && problem.status < 500) { pendingRequests.delete(order.number); setPending(false); setError(problem.code); }
      else setError("adminRefund.unknown");
      await load();
    } finally { finish(); }
  }
  async function action(refund: Refund, operation: RefundOperation, body: object) {
    if (!summary || !refundActions(refund, summary.capability, summary.capturedMinor)[operation] || !start()) return false;
    try { await adminRestaurant<Refund>(`${path}/${encodeURIComponent(refund.id)}/${operation}`, { method: "POST", body: JSON.stringify(body) }); setNotice(operation === "manual" ? "adminRefund.manualSaved" : "adminRefund.saved"); await load(); return true; }
    catch (problem) { setError(problem instanceof RestaurantAPIError ? problem.code : "server_error"); await load(); return false; }
    finally { finish(); }
  }
  const currentAmount = amount ?? summary?.availableMinor ?? 0;
  return <section><div className="ra-section-title"><h3><RotateCcw size={17} /> {t("adminRefund.title")}</h3><button type="button" className="ra-secondary" disabled={busy || disabled || loading} onClick={() => void load()}><RefreshCw size={16} />{t("common.refresh")}</button></div><p className="ra-muted">{t("adminRefund.hint")}</p>
    {error && <p className="ra-alert ra-spaced" role="alert">{t(error.startsWith("adminRefund.") ? error : `errors.${error}`)}</p>}{notice && <p className="ra-notice ra-spaced" role="status">{t(notice)}</p>}{loading && <p role="status">{t("common.loading")}</p>}
    {summary && <><dl className="ra-details ra-spaced">{([["capturedMinor", "adminRefund.captured"], ["reservedMinor", "adminRefund.reserved"], ["refundedMinor", "adminRefund.confirmed"], ["availableMinor", "adminRefund.available"]] as const).map(([key, label]) => <div key={key}><dt>{t(label)}</dt><dd>{money(key === "reservedMinor" ? pendingRefundMinor(summary) : summary[key], order.currency)}</dd></div>)}</dl>
      {!summary.capability.automatic && summary.capturedMinor > 0 && <p className="ra-warning">{t("adminRefund.manualOnly")}</p>}
      {summary.availableMinor > 0 ? <form className="ra-spaced" onSubmit={event => { event.preventDefault(); void create(); }}><fieldset className="ra-editor-fields" disabled={busy || disabled}><fieldset className="ra-editor-fields" disabled={pending}><MoneyInput label={t("adminRefund.amount")} value={currentAmount} currency={order.currency} onChange={setAmount} /><button type="button" className="ra-secondary" onClick={() => setAmount(summary.availableMinor)}>{t("adminRefund.fullRemaining")}</button>{!summary.capability.partial && <p className="ra-muted">{t("adminRefund.fullOnly")}</p>}<Field label={t("adminSupport.reason")}><textarea required minLength={3} maxLength={1000} rows={3} value={reason} onChange={event => setReason(event.target.value)} /></Field></fieldset><button type="submit" className="ra-primary" disabled={!validRefundAmount(summary, currentAmount) || reason.trim().length < 3}>{t(pending ? "common.retry" : "adminRefund.create")}</button></fieldset></form> : <p className="ra-muted ra-spaced">{t("adminRefund.unavailable")}</p>}
      {!summary.refunds.length && <p className="ra-muted ra-spaced">{t("adminRefund.empty")}</p>}{summary.refunds.map(refund => <RefundRecord key={refund.id} refund={refund} capability={summary.capability} capturedMinor={summary.capturedMinor} busy={busy || disabled} action={action} />)}
    </>}
  </section>;
}
