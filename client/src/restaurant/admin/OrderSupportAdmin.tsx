import { useState } from "react";
import { useLocale } from "../i18n";
import type { Order, OrderComplaint } from "../types";
import { Field } from "./Fields";

export type SupportMutation = (suffix: string, body: object, message: string) => Promise<Order | null>;
export const supportReason = (value: string) => value.trim().length > 0 && value.trim().length <= 1000;

function Complaint({ complaint, busy, mutate }: { complaint: OrderComplaint; busy: boolean; mutate: SupportMutation }) {
  const { t, date } = useLocale();
  const [reason, setReason] = useState("");
  async function resolve() {
    if (busy || !supportReason(reason) || !window.confirm(t("adminSupport.resolveConfirm"))) return;
    if (await mutate(`/complaints/${encodeURIComponent(complaint.id)}/resolve`, { reason: reason.trim() }, "adminSupport.resolvedNotice")) setReason("");
  }
  return <article className="ra-support-record"><div className="ra-section-title"><span className="ra-status">{t(`adminSupport.${complaint.status}`)}</span><time dateTime={complaint.requestedAt}>{date(complaint.requestedAt)}</time></div><p className="ra-preserve-text">{complaint.reason}</p>
    {complaint.status === "resolved" ? <><h4>{t("adminSupport.resolution")}</h4><p className="ra-preserve-text">{complaint.resolution}</p>{complaint.resolvedAt && <time dateTime={complaint.resolvedAt}>{date(complaint.resolvedAt)}</time>}</> : <form onSubmit={event => { event.preventDefault(); void resolve(); }}><fieldset className="ra-editor-fields ra-spaced" disabled={busy}><Field label={t("adminSupport.resolution")}><textarea required maxLength={1000} rows={3} value={reason} onChange={event => setReason(event.target.value)} /></Field><button type="submit" className="ra-secondary" disabled={!supportReason(reason)}>{t("adminSupport.resolve")}</button></fieldset></form>}
  </article>;
}

export function OrderSupportAdmin({ order, busy, mutate }: { order: Order; busy: boolean; mutate: SupportMutation }) {
  const { t, date } = useLocale();
  const [reason, setReason] = useState("");
  const cancellation = order.cancellation;
  async function decide(approve: boolean) {
    if (busy || !supportReason(reason) || !window.confirm(t(approve ? "adminSupport.approveConfirm" : "adminSupport.rejectConfirm", { number: order.number }))) return;
    if (await mutate("/cancel-decision", { approve, reason: reason.trim() }, "adminSupport.cancellationSaved")) setReason("");
  }
  if (!cancellation && !order.cancellationHistory?.length && !order.complaints?.length && !order.preparationStartedAt && !order.stockExpiresAt) return null;
  return <section><h3>{t("adminSupport.title")}</h3><dl className="ra-details">{order.preparationStartedAt && <div><dt>{t("adminSupport.preparationStarted")}</dt><dd>{date(order.preparationStartedAt)}</dd></div>}{order.stockExpiresAt && <div><dt>{t("adminSupport.stockExpires")}</dt><dd>{date(order.stockExpiresAt)}</dd></div>}</dl>
    {cancellation && <article className="ra-support-record"><h4>{t("adminSupport.cancellation")}</h4><div className="ra-section-title"><span className="ra-status">{t(`adminSupport.${cancellation.status}`)}</span><time dateTime={cancellation.requestedAt}>{date(cancellation.requestedAt)}</time></div><p className="ra-preserve-text">{cancellation.reason}</p>{cancellation.requestedBeforePreparation && <p className="ra-muted">{t("adminSupport.beforePreparation")}</p>}
      {cancellation.status === "requested" ? <form onSubmit={event => { event.preventDefault(); void decide(true); }}><fieldset disabled={busy} className="ra-editor-fields ra-spaced"><Field label={t("adminSupport.decisionReason")}><textarea rows={3} required maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></Field><div className="ra-row"><button type="submit" className="ra-primary" disabled={!supportReason(reason)}>{t("adminSupport.approve")}</button><button type="button" className="ra-secondary" disabled={!supportReason(reason)} onClick={() => void decide(false)}>{t("adminSupport.reject")}</button></div></fieldset></form> : <><h4>{t("adminSupport.decisionReason")}</h4><p className="ra-preserve-text">{cancellation.decisionReason === "before_preparation" ? t("adminSupport.beforePreparation") : cancellation.decisionReason === "restaurant_cancelled" ? t("order.status.cancelled") : cancellation.decisionReason || "—"}</p>{cancellation.decidedAt && <time dateTime={cancellation.decidedAt}>{date(cancellation.decidedAt)}</time>}</>}
    </article>}
    {Boolean(order.cancellationHistory?.length) && <details className="ra-spaced"><summary>{t("adminReopen.cancellationHistory")}</summary>{order.cancellationHistory!.map(entry => <article className="ra-support-record" key={entry.id}><div className="ra-section-title"><span className="ra-status">{t(`adminSupport.${entry.status}`)}</span><time dateTime={entry.requestedAt}>{date(entry.requestedAt)}</time></div><p className="ra-preserve-text">{entry.reason}</p>{entry.decisionReason && <p className="ra-preserve-text">{entry.decisionReason === "before_preparation" ? t("adminSupport.beforePreparation") : entry.decisionReason === "restaurant_cancelled" ? t("order.status.cancelled") : entry.decisionReason}</p>}</article>)}</details>}
    {Boolean(order.complaints?.length) && <div className="ra-spaced"><h4>{t("adminSupport.complaints")}</h4>{order.complaints!.map(complaint => <Complaint key={complaint.id} complaint={complaint} busy={busy} mutate={mutate} />)}</div>}
  </section>;
}
