import { useEffect, useRef, useState } from "react";
import { adminRestaurant, RestaurantAPIError } from "../api";
import { useLocale } from "../i18n";
import type { Order } from "../types";
import { Field } from "./Fields";
import { supportReason } from "./OrderSupportAdmin";

export interface ReopenRequest { number: string; requestId: string; version: number; reason: string }
const pendingRequests = new Map<string, ReopenRequest>();
const storageKey = (number: string) => `restaurant-admin-reopen-v1:${encodeURIComponent(number)}`;

export function parseReopenRequest(raw: string | null, number: string): ReopenRequest | null {
  if (!raw || raw.length > 8000) return null;
  try {
    const value = JSON.parse(raw);
    if (value?.number !== number || typeof value.reason !== "string" || !supportReason(value.reason) ||
      value.reason !== value.reason.trim() || !Number.isSafeInteger(value.version) || value.version < 1 ||
      typeof value.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.requestId)) return null;
    return { number, requestId: value.requestId, version: value.version, reason: value.reason };
  } catch { return null; }
}

export function reopenRequest(previous: ReopenRequest | null, order: Pick<Order, "number" | "version">, reason: string, id: () => string): ReopenRequest {
  // Unknown outcomes must retain the exact original body even after polling has
  // fetched a newer order version. The server binds this identity durably.
  if (previous?.number === order.number) return previous;
  return { number: order.number, requestId: id(), version: order.version, reason: reason.trim() };
}

function readPending(number: string): ReopenRequest | null {
  const memory = pendingRequests.get(number);
  if (memory) return memory;
  try { return parseReopenRequest(sessionStorage.getItem(storageKey(number)), number); } catch { return null; }
}
function remember(number: string, value: ReopenRequest | null) {
  if (value) pendingRequests.set(number, value); else pendingRequests.delete(number);
  try {
    if (value) sessionStorage.setItem(storageKey(number), JSON.stringify(value));
    else sessionStorage.removeItem(storageKey(number));
  } catch { /* The in-memory copy still supports retry and tab navigation. */ }
}

export function reopenBlockReason(order: Order): string | null {
  if (order.status !== "cancelled" || order.cancellation?.status === "requested") return "reopen_unavailable";
  if (order.preparationStartedAt || order.deliveryStatus && !["assigned", "unassigned"].includes(order.deliveryStatus)) return "reopen_prepared";
  if (order.payment?.paidAt || order.payment?.status && order.payment.status !== "unpaid") return "reopen_payment";
  return null;
}

export function ReopenOrderPanel({ order, disabled, onBusyChange, onChanged }: {
  order: Order; disabled: boolean; onBusyChange: (busy: boolean) => void; onChanged: (order: Order) => void;
}) {
  const { t } = useLocale();
  const [pending, setPending] = useState<ReopenRequest | null>(() => readPending(order.number));
  const [reason, setReason] = useState(() => readPending(order.number)?.reason ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);
  const blocked = reopenBlockReason(order);
  async function submit() {
    if (running.current || disabled || !pending && (blocked || !supportReason(reason))) return;
    if (!pending && !window.confirm(t("adminReopen.confirm", { number: order.number }))) return;
    const request = reopenRequest(pending, order, reason, () => crypto.randomUUID());
    remember(order.number, request); setPending(request);
    running.current = true; setBusy(true); onBusyChange(true); setError("");
    try {
      const updated = await adminRestaurant<Order>(`/orders/${encodeURIComponent(order.number)}/reopen`, {
        method: "POST", body: JSON.stringify({ requestId: request.requestId, version: request.version, reason: request.reason }),
      });
      remember(order.number, null);
      if (mounted.current) { setPending(null); setReason(""); onChanged(updated); }
    } catch (problem) {
      const definitive = problem instanceof RestaurantAPIError && problem.status >= 400 && problem.status < 500 && problem.status !== 408;
      if (definitive) remember(order.number, null);
      if (mounted.current) {
        if (definitive) setPending(null);
        setError(definitive ? problem.code : "adminReopen.retry");
      }
    } finally {
      running.current = false;
      if (mounted.current) { setBusy(false); onBusyChange(false); }
    }
  }
  if (order.status !== "cancelled" && !pending) return null;
  return <section className="ra-reopen-panel"><h3>{t("adminReopen.title")}</h3><p className="ra-muted">{t("adminReopen.hint")}</p>
    {error && <p className="ra-alert ra-spaced" role="alert">{t(error === "adminReopen.retry" ? error : `errors.${error}`)}</p>}
    {pending && <p className="ra-warning ra-spaced" role="status">{t("adminReopen.retry")}</p>}
    {blocked && !pending ? <p className="ra-warning ra-spaced">{t(`errors.${blocked}`)}</p> : <form className="ra-spaced" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <fieldset className="ra-editor-fields" disabled={busy || disabled}>
        <Field label={t("adminReopen.reason")}><textarea required rows={3} maxLength={1000} value={reason} readOnly={Boolean(pending)} onChange={event => setReason(event.target.value)} /></Field>
        <button type="submit" className="ra-primary" disabled={!pending && !supportReason(reason)}>{t(pending ? "common.retry" : "adminReopen.action")}</button>
      </fieldset>
    </form>}
  </section>;
}
