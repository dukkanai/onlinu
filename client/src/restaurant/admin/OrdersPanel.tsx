import { useCallback, useEffect, useRef, useState } from "react";
import { MapPin, RefreshCw, Search } from "lucide-react";
import { adminRestaurant, RestaurantAPIError } from "../api";
import { useLocale } from "../i18n";
import type { Address, Courier, Order, OrderStatus } from "../types";
import { Field } from "./Fields";
import { canCollectCash, nextStatuses, ORDER_STATUSES, paymentAllowsStatus, safeMapUrl } from "./helpers";
import { restaurantCountryName } from "../countries";
import { OrderSupportAdmin } from "./OrderSupportAdmin";
import { RefundsPanel } from "./RefundsPanel";
import { OrderLocation } from "../customer/OrderLocation";
import { ReopenOrderPanel } from "./ReopenOrderPanel";

export function OrdersPanel({ onBusyChange }: { onBusyChange?: (busy: boolean) => void } = {}) {
  const { t, money, date, locale } = useLocale();
  const [orders, setOrders] = useState<Order[]>([]);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refundBusy, setRefundBusy] = useState(false);
  const [reopenBusy, setReopenBusy] = useState(false);
  const busy = saving || refundBusy || reopenBusy;
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [couriers, setCouriers] = useState<Courier[]>([]);
  const [courierError, setCourierError] = useState("");
  const [assignment, setAssignment] = useState("");
  const request = useRef(0);
  const alive = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const mutation = useRef(false);
  const refundMutation = useRef(false);
  const reopenMutation = useRef(false);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => { const timer = window.setTimeout(() => setQuery(search), 300); return () => window.clearTimeout(timer); }, [search]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current++; controller.current?.abort(); }; }, []);
  const refreshCouriers = useCallback(async (signal?: AbortSignal) => {
    try { const result = await adminRestaurant<{ couriers: Courier[] }>("/couriers", { signal }); if (alive.current && !signal?.aborted) { setCouriers(result.couriers ?? []); setCourierError(""); } }
    catch (problem) { if (alive.current && !signal?.aborted) setCourierError(problem instanceof RestaurantAPIError ? problem.code : "server_error"); }
  }, []);
  useEffect(() => { const abort = new AbortController(); void refreshCouriers(abort.signal); const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refreshCouriers(abort.signal); }, 15000); return () => { abort.abort(); window.clearInterval(timer); }; }, [refreshCouriers]);
  const refresh = useCallback(async () => {
    if (mutation.current || refundMutation.current || reopenMutation.current) return;
    const sequence = ++request.current;
    controller.current?.abort();
    const active = new AbortController(); controller.current = active;
    try {
      const filters = new URLSearchParams();
      if (status) filters.set("status", status);
      if (query.trim()) filters.set("search", query.trim());
      const result = await adminRestaurant<{ orders: Order[] }>(`/orders?${filters}`, { signal: active.signal });
      if (!alive.current || sequence !== request.current) return;
      setOrders(result.orders ?? []); setError("");
      setSelected(current => result.orders?.some(order => order.number === current) ? current : result.orders?.[0]?.number ?? "");
    } catch (problem) {
      if (alive.current && sequence === request.current && !active.signal.aborted) setError(problem instanceof RestaurantAPIError ? problem.code : "server_error");
    } finally { if (alive.current && sequence === request.current) setLoading(false); }
  }, [status, query]);
  useEffect(() => { setLoading(true); void refresh(); const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 5000); return () => { window.clearInterval(timer); controller.current?.abort(); }; }, [refresh]);
  const order = orders.find(entry => entry.number === selected);
  useEffect(() => { setAssignment(order?.courierId ?? ""); }, [order?.number, order?.courierId]);
  async function mutateOrder(order: Order, suffix: string, method: "POST" | "PATCH", body: object, message: string): Promise<Order | null> {
    if (mutation.current || refundMutation.current || reopenMutation.current) return null;
    mutation.current = true; request.current++; controller.current?.abort(); setSaving(true); setError(""); setNotice("");
    try {
      const updated = await adminRestaurant<Order>(`/orders/${encodeURIComponent(order.number)}${suffix}`, { method, body: JSON.stringify({ ...body, version: order.version }) });
      if (!alive.current) return null;
      setOrders(current => current.map(entry => entry.number === updated.number ? updated : entry)); setNotice(message);
      return updated;
    } catch (problem) {
      if (alive.current) setError(problem instanceof RestaurantAPIError ? problem.code : "server_error");
      return null;
    } finally { mutation.current = false; if (alive.current) { setSaving(false); setLoading(false); } }
  }
  async function changeStatus(order: Order, next: OrderStatus) {
    if (!paymentAllowsStatus(order, next) || order.cancellation?.status === "requested") return;
    if (next === "cancelled" && !window.confirm(t("admin.cancelOrderConfirm"))) return;
    await mutateOrder(order, "", "PATCH", { status: next }, "admin.statusSuccess");
  }
  const addressFields: (keyof Address)[] = ["city", "district", "street", "building", "postalCode", "additionalNumber", "nationalAddress", "addressLine", "area"];
  const map = order ? safeMapUrl(order.address?.latitude, order.address?.longitude) : null;
  return <section>
    <div className="ra-section-title"><div><h2>{t("admin.orders")}</h2><p className="ra-live"><span />{t("admin.live")}</p></div><button type="button" className="ra-secondary" disabled={busy} onClick={() => void refresh()}><RefreshCw size={16} />{t("common.refresh")}</button></div>
    <div className="ra-order-filters"><Field label={t("admin.searchOrders")}><div className="ra-search"><Search size={18} /><input type="search" disabled={busy} maxLength={100} value={search} onChange={event => setSearch(event.target.value)} /></div></Field><Field label={t("admin.nextStatus")}><select value={status} disabled={busy} onChange={event => setStatus(event.target.value)}><option value="">{t("admin.allStatuses")}</option>{ORDER_STATUSES.map(value => <option key={value} value={value}>{t(`order.status.${value}`)}</option>)}</select></Field></div>
    {error && <div className="ra-alert" role="alert">{t(`errors.${error}`)} <button type="button" onClick={() => void refresh()}>{t("common.retry")}</button></div>}
    {notice && <p className="ra-notice" role="status">{t(notice)}</p>}
    {loading && !orders.length && <p className="ra-empty" role="status">{t("common.loading")}</p>}
    <div className="ra-orders-layout">
      <div className="ra-order-list">{orders.map(entry => <button type="button" key={entry.number} className={`ra-card ra-order-pick ${entry.number === selected ? "ra-selected" : ""}`} disabled={busy} aria-pressed={entry.number === selected} onClick={() => { setSelected(entry.number); setNotice(""); }}>
        <div><strong dir="ltr">#{entry.number}</strong><span className={`ra-status ra-status-${entry.status}`}>{t(`order.status.${entry.status}`)}</span></div>
        <h3>{entry.customerName || entry.tableName || t("admin.customer")}</h3>
        <p>{t(`order.${entry.mode}`)}{entry.tableName ? ` · ${entry.tableName}` : ""}</p><footer><time dateTime={entry.createdAt}>{date(entry.createdAt)}</time><strong>{money(entry.totalMinor, entry.currency)}</strong></footer>
      </button>)}
        {!loading && !orders.length && <p className="ra-card ra-empty">{t("admin.noOrders")}</p>}
      </div>
      {order ? <article className="ra-card ra-order-detail" aria-busy={busy}>
        <div className="ra-section-title"><h2><span dir="ltr">#{order.number}</span></h2><span className={`ra-status ra-status-${order.status}`}>{t(`order.status.${order.status}`)}</span></div>
        {order.demo && <p className="ra-demo">{t("store.demo")}</p>}
        <dl className="ra-details"><div><dt>{t("admin.customer")}</dt><dd>{order.customerName || "—"}</dd></div><div><dt>{t("order.phone")}</dt><dd dir="ltr">{order.phone || "—"}</dd></div><div><dt>{t("admin.orderMode")}</dt><dd>{t(`order.${order.mode}`)}{order.tableName ? ` · ${order.tableName}` : ""}</dd></div><div><dt>{t("order.created")}</dt><dd>{date(order.createdAt)}</dd></div></dl>
        <div className="ra-order-lines">{order.items.map((item, index) => <div key={`${item.itemId}-${index}`}><span><strong>{item.quantity} × {item.name}</strong>{item.options?.length > 0 && <small>{item.options.map(option => `${option.name} (${money(option.priceMinor, order.currency)})`).join(" · ")}</small>}</span><strong>{money(item.totalMinor, order.currency)}</strong></div>)}</div>
        <dl className="ra-totals"><div><dt>{t("store.subtotal")}</dt><dd>{money(order.subtotalMinor, order.currency)}</dd></div><div><dt>{t("store.deliveryFee")}</dt><dd>{money(order.deliveryFeeMinor, order.currency)}</dd></div>{order.tax?.enabled && <><div><dt>{t("adminNext.taxNet")}</dt><dd>{money(order.tax.netMinor, order.currency)}</dd></div><div><dt>{t("adminNext.taxIncluded")} ({new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(order.tax.rateBps / 10000)})</dt><dd>{money(order.tax.taxMinor, order.currency)}</dd></div></>}<div><dt>{t("store.total")}</dt><dd>{money(order.totalMinor, order.currency)}</dd></div></dl>
        <section><h3>{t("adminNext.payment")}</h3><div className="ra-row"><span>{order.payment?.method ? t(`payment.method.${order.payment.method}`) : t("payment.status.legacy")}</span><span className={`ra-status ${order.payment?.status === "paid" ? "ra-status-completed" : "ra-status-new"}`}>{t(`payment.status.${order.payment?.method ? order.payment.status : "legacy"}`)}</span></div>
          {canCollectCash(order) && <button type="button" className="ra-primary ra-spaced" disabled={busy} onClick={() => { if (window.confirm(t("adminNext.cashConfirmPrompt", { amount: money(order.totalMinor, order.currency) }))) void mutateOrder(order, "/cash", "POST", {}, "adminNext.cashSuccess"); }}>{t("adminNext.cashConfirm")}</button>}
        </section>
        {order.mode === "delivery" && <section className="ra-order-address"><h3>{t("address.title")}</h3><dl className="ra-details">{order.address?.country && <div><dt>{t("address.country")}</dt><dd>{restaurantCountryName(order.address.country, locale)}</dd></div>}{addressFields.filter(key => order.address?.[key]).map(key => <div key={key}><dt>{t(`address.${key}`)}</dt><dd>{String(order.address[key])}</dd></div>)}</dl>{map && <a className="ra-secondary" href={map} target="_blank" rel="noopener noreferrer"><MapPin size={16} />{t("admin.openMap")}</a>}</section>}
        {order.mode === "delivery" && <section><h3>{t("adminNext.courier")}</h3><p>{order.courierName || t("adminNext.unassigned")}</p>{order.deliveryStatus && <p className="ra-muted">{t("adminNext.deliveryStatus")}: {t(order.deliveryStatus === "unassigned" ? "adminNext.unassigned" : `delivery.status.${order.deliveryStatus}`)}</p>}
          {!["completed", "cancelled"].includes(order.status) && <div className="ra-spaced">{courierError ? <p className="ra-alert" role="alert">{t(`errors.${courierError}`)}<button type="button" onClick={() => void refreshCouriers()}>{t("common.retry")}</button></p> : <><Field label={t("adminNext.courier")} hint={t("adminNext.assignmentHint")}><select value={assignment} disabled={busy} onChange={event => setAssignment(event.target.value)}><option value="">{t("adminNext.unassigned")}</option>{couriers.filter(courier => courier.active || courier.id === order.courierId).map(courier => <option value={courier.id} key={courier.id} disabled={!courier.active}>{courier.name} — {t(`courier.availability.${courier.availability}`)}</option>)}</select></Field><button type="button" className="ra-secondary" disabled={busy || assignment === (order.courierId ?? "")} onClick={() => void mutateOrder(order, "/courier", "POST", { courierId: assignment }, "adminNext.assignmentSuccess")}>{t("adminNext.assignCourier")}</button></>}</div>}
          {(order.deliveryEvents ?? []).length > 0 && <details className="ra-spaced"><summary>{t("adminNext.deliveryHistory")}</summary><ul className="ra-table-history">{order.deliveryEvents!.map((event, index) => <li key={index}><span>{t(event.status === "unassigned" ? "adminNext.unassigned" : `delivery.status.${event.status}`)}{event.courierName ? ` · ${event.courierName}` : ""}</span><time dateTime={event.at}>{date(event.at)}</time></li>)}</ul></details>}
        </section>}
        {order.mode === "delivery" && <OrderLocation key={order.number} order={order} admin />}
        <OrderSupportAdmin key={`support-${order.number}`} order={order} busy={busy} mutate={(suffix, body, message) => mutateOrder(order, suffix, "POST", body, message)} />
        <ReopenOrderPanel key={`reopen-${order.number}`} order={order} disabled={saving || refundBusy} onBusyChange={value => { reopenMutation.current = value; if (value) { request.current++; controller.current?.abort(); } setReopenBusy(value); }} onChanged={updated => { setOrders(current => current.map(entry => entry.number === updated.number ? updated : entry)); setNotice(updated.status === "new" ? "adminReopen.success" : ""); setError(""); }} />
        <RefundsPanel key={`refunds-${order.number}`} order={order} disabled={saving || reopenBusy} onBusyChange={value => { refundMutation.current = value; if (value) { request.current++; controller.current?.abort(); } setRefundBusy(value); }} onChanged={() => void refresh()} />
        {order.notes && <section className="ra-order-notes"><h3>{t("order.notes")}</h3><p>{order.notes}</p></section>}
        {order.tableChanges?.length > 0 && <section><h3>{t("order.tableHistory")}</h3><ul className="ra-table-history">{order.tableChanges.map((change, index) => <li key={index}><span>{change.from} → {change.to}</span><time dateTime={change.at}>{date(change.at)}</time></li>)}</ul></section>}
        {nextStatuses(order.mode, order.status).length > 0 && <section className="ra-status-actions"><h3>{t("admin.updateStatus")}</h3><div className="ra-row">{nextStatuses(order.mode, order.status).map(next => <button type="button" key={next} disabled={busy || !paymentAllowsStatus(order, next) || order.cancellation?.status === "requested"} className={next === "cancelled" ? "ra-secondary ra-danger" : "ra-primary"} onClick={() => void changeStatus(order, next)}>{t(`order.status.${next}`)}</button>)}</div>{order.cancellation?.status === "requested" && <p className="ra-warning ra-spaced">{t("adminSupport.requested")}</p>}{nextStatuses(order.mode, order.status).some(next => !paymentAllowsStatus(order, next)) && <p className="ra-warning ra-spaced">{t("adminNext.paymentBlocked")}</p>}</section>}
      </article> : <div className="ra-card ra-empty">{t("admin.selectOrder")}</div>}
    </div>
  </section>;
}
