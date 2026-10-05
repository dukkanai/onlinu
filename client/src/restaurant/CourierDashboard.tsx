import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { CheckCircle2, MapPin, Phone, RefreshCw, Truck } from "lucide-react";
import { LanguagePicker, useLocale } from "./i18n";
import type { Courier, Order } from "./types";
import { RestaurantAPIError } from "./api";
import {
  courierNextStatus,
  mapURL,
  paymentStatusKey,
} from "./customer/operations";
import "./customer/storefront.css";
import { CourierLocation } from "./customer/CourierLocation";

async function courierRequest<T>(
  path: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  if (
    !/^\/[a-zA-Z0-9/_-]*$/.test(path) ||
    path.includes("..") ||
    path.startsWith("//")
  )
    throw new RestaurantAPIError("invalid_request", 400);
  const response = await fetch(`/courier-api${path}`, {
    method: body === undefined ? "GET" : method,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw new RestaurantAPIError(
      typeof value.error === "string" ? value.error : "server_error",
      response.status,
    );
  }
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>);
}

export function CourierDashboard() {
  const { t, dir, money, date } = useLocale();
  const [courier, setCourier] = useState<Courier | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [collected, setCollected] = useState<Record<string, boolean>>({});
  const [sharingOrder, setSharingOrder] = useState("");
  const identity = useRef(0);
  const mutation = useRef(false);
  const readBusy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    // Reassignment/removal ends consent; assigning this number back later
    // must never silently restart a previous location watch.
    if (sharingOrder && !orders.some(order => order.number === sharingOrder)) setSharingOrder("");
  }, [orders, sharingOrder]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      identity.current++;
    };
  }, []);
  const fail = useCallback((value: unknown) => {
    if (!mounted.current) return;
    if (value instanceof RestaurantAPIError) {
      setError(`errors.${value.code}`);
      if (value.status === 401) {
        identity.current++;
        setCourier(null);
        setSharingOrder("");
        setOrders([]);
        setCollected({});
        setPassword("");
      }
    } else setError("common.error");
  }, []);
  useEffect(() => {
    let active = true;
    void courierRequest<{ courier: Courier | null }>("/account")
      .then((result) => {
        if (active) setCourier(result.courier);
      })
      .catch((error) => {
        if (active) fail(error);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [fail]);
  const refresh = useCallback(async () => {
    if (!courier || readBusy.current) return;
    readBusy.current = true;
    const current = identity.current;
    try {
      const result = await courierRequest<{ orders: Order[] }>("/orders");
      if (mounted.current && current === identity.current) {
        setOrders(result.orders);
      }
    } catch (error) {
      if (current === identity.current) fail(error);
    } finally {
      readBusy.current = false;
    }
  }, [courier?.id, fail]);
  useEffect(() => {
    setOrders([]);
    setCollected({});
    if (!courier) return;
    void refresh();
    const interval = setInterval(() => {
      if (!document.hidden && !mutation.current) void refresh();
    }, 12000);
    return () => clearInterval(interval);
  }, [courier?.id, refresh]);
  const login = async (event: FormEvent) => {
    event.preventDefault();
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await courierRequest<{ courier: Courier }>("/login", {
        username,
        password,
      });
      identity.current++;
      setCourier(result.courier);
      setPassword("");
    } catch (error) {
      fail(error);
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  };
  const logout = async () => {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setSharingOrder("");
    try {
      await courierRequest<void>("/logout", {});
      identity.current++;
      setCourier(null);
      setOrders([]);
      setCollected({});
      setUsername("");
      setPassword("");
    } catch (error) {
      fail(error);
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  };
  const changeAvailability = async (availability: Courier["availability"]) => {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError("");
    const current = identity.current;
    try {
      const result = await courierRequest<{ courier: Courier }>(
        "/account",
        { availability },
        "PATCH",
      );
      if (current === identity.current) setCourier(result.courier);
    } catch (error) {
      if (current === identity.current) fail(error);
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  };
  const advance = async (order: Order) => {
    const status = courierNextStatus(order.deliveryStatus);
    if (mutation.current || !status || order.cancellation?.status === "requested") return;
    const needsCash =
      status === "delivered" &&
      order.payment?.method === "cash_on_delivery" &&
      order.payment.status !== "paid";
    if (needsCash && !collected[order.number]) {
      setError("courier.collectRequired");
      return;
    }
    mutation.current = true;
    setBusy(true);
    setError("");
    const current = identity.current;
    try {
      const updated = await courierRequest<Order>(
        `/orders/${encodeURIComponent(order.number)}`,
        {
          status,
          version: order.version,
          collectCash: needsCash && !!collected[order.number],
        },
        "PATCH",
      );
      if (current === identity.current) {
        setOrders((old) =>
          old.flatMap((entry) =>
            entry.number !== order.number
              ? [entry]
              : updated.status === "completed" || updated.status === "cancelled"
                ? []
                : [updated],
          ),
        );
        setCollected((old) => ({ ...old, [order.number]: false }));
      }
    } catch (error) {
      if (current === identity.current) {
        fail(error);
        await refresh();
      }
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="restaurant-storefront rs-courier" dir={dir}>
      <header className="rs-header">
        <div className="rs-header-inner">
          <h1 className="rs-brand">
            <Truck size={27} />
            {t("courier.title")}
          </h1>
          <div className="rs-header-actions">
            <LanguagePicker />
            {courier && (
              <button
                className="rs-link-button"
                disabled={busy}
                onClick={logout}
              >
                {t("account.logout")}
              </button>
            )}
          </div>
        </div>
      </header>
      <main className="rs-main rs-narrow">
        {error && (
          <div className="rs-notice rs-notice-error" role="alert">
            {t(error)}
          </div>
        )}
        {loading ? (
          <p role="status">{t("common.loading")}</p>
        ) : !courier ? (
          <form className="rs-panel rs-form-stack" onSubmit={login}>
            <h2>{t("account.login")}</h2>
            <p className="rs-muted">{t("courier.loginHint")}</p>
            <label className="rs-field">
              <span>{t("account.username")}</span>
              <input
                autoComplete="username"
                dir="ltr"
                required
                maxLength={40}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                disabled={busy}
              />
            </label>
            <label className="rs-field">
              <span>{t("account.password")}</span>
              <input
                type="password"
                autoComplete="current-password"
                required
                maxLength={128}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy}
              />
            </label>
            <button className="rs-button" disabled={busy}>
              {busy ? t("common.loading") : t("account.login")}
            </button>
            <a className="rs-link-button" href="/">
              {t("store.menu")}
            </a>
          </form>
        ) : (
          <>
            <section className="rs-panel">
              <div className="rs-section-head">
                <h2>{courier.name}</h2>
                <span className="rs-status">
                  {t(`courier.availability.${courier.availability}`)}
                </span>
              </div>
              <p className="rs-muted">{t("courier.availability")}</p>
              <div className="rs-courier-availability">
                {(["available", "busy", "offline"] as const).map((status) => (
                  <button
                    className={`rs-button ${courier.availability === status ? "" : "rs-button-outline"}`}
                    type="button"
                    key={status}
                    aria-pressed={courier.availability === status}
                    disabled={busy}
                    onClick={() => changeAvailability(status)}
                  >
                    {t(`courier.availability.${status}`)}
                  </button>
                ))}
              </div>
            </section>
            <div className="rs-section-head rs-spaced">
              <h2>{t("courier.orders")}</h2>
              <button
                className="rs-button rs-button-soft rs-small-button"
                disabled={busy}
                onClick={refresh}
              >
                <RefreshCw size={16} />
                {t("common.refresh")}
              </button>
            </div>
            {!orders.length ? (
              <section className="rs-panel rs-empty">
                <CheckCircle2 size={36} />
                <p>{t("courier.empty")}</p>
              </section>
            ) : (
              <div className="rs-form-stack">
                {orders.map((order) => {
                  const next = courierNextStatus(order.deliveryStatus),
                    position = mapURL(order.address);
                  const needsCash =
                    next === "delivered" &&
                    order.payment?.method === "cash_on_delivery" &&
                    order.payment.status !== "paid";
                  const unready =
                    next === "picked_up" &&
                    !["ready", "out_for_delivery"].includes(order.status);
                  const cardUnpaid =
                    next === "delivered" &&
                    order.payment?.method === "card" &&
                    order.payment.status !== "paid";
                  const cancellationPending = order.cancellation?.status === "requested";
                  return (
                    <section className="rs-panel" key={order.number}>
                      <div className="rs-section-head">
                        <h2>
                          <bdi>{order.number}</bdi>
                        </h2>
                        <span className="rs-status">
                          {t(
                            `delivery.status.${order.deliveryStatus ?? "assigned"}`,
                          )}
                        </span>
                      </div>
                      <p>
                        <strong>{order.customerName}</strong>
                      </p>
                      <p className="rs-muted">
                        {[
                          order.address.city,
                          order.address.district,
                          order.address.street,
                          order.address.building,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      {(!order.address.country ||
                        order.address.country === "SA") &&
                        order.address.nationalAddress && (
                          <p>{order.address.nationalAddress}</p>
                        )}
                      <p>{order.address.addressLine}</p>
                      {order.notes && (
                        <p className="rs-spaced">
                          {t("order.notes")}: {order.notes}
                        </p>
                      )}
                      <div className="rs-courier-links">
                        {order.phone && (
                          <a
                            className="rs-button rs-button-soft"
                            href={`tel:${order.phone.replace(/[^+\d]/g, "")}`}
                          >
                            <Phone size={16} />
                            {t("courier.callCustomer")}
                          </a>
                        )}
                        {position && (
                          <a
                            className="rs-button rs-button-soft"
                            href={position}
                            target="_blank"
                            rel="noopener noreferrer"
                            referrerPolicy="no-referrer"
                          >
                            <MapPin size={16} />
                            {t("courier.openMap")}
                          </a>
                        )}
                      </div>
                      <div className="rs-totals">
                        <div>
                          <span>{t("store.total")}</span>
                          <strong>
                            {money(order.totalMinor, order.currency)}
                          </strong>
                        </div>
                        <div>
                          <span>
                            {order.payment?.method
                              ? t(`payment.method.${order.payment.method}`)
                              : t("payment.title")}
                          </span>
                          <span>
                            {t(paymentStatusKey(order.payment?.status))}
                          </span>
                        </div>
                      </div>
                      <details className="rs-spaced">
                        <summary>{t("order.details")}</summary>
                        {order.items.map((line, index) => (
                          <p key={`${line.itemId}-${index}`}>
                            {line.quantity} × {line.name}
                            {line.options.length
                              ? ` · ${line.options.map((option) => option.name).join(" · ")}`
                              : ""}
                          </p>
                        ))}
                      </details>
                      {unready && (
                        <p className="rs-notice rs-spaced">
                          {t("courier.readyRequired")}
                        </p>
                      )}
                      {cardUnpaid && (
                        <p className="rs-notice rs-spaced">
                          {t("courier.cardAwaiting")}
                        </p>
                      )}
                      {needsCash && (
                        <label className="rs-cash-confirm">
                          <input
                            type="checkbox"
                            checked={!!collected[order.number]}
                            disabled={busy || cancellationPending}
                            onChange={(event) =>
                              setCollected((old) => ({
                                ...old,
                                [order.number]: event.target.checked,
                              }))
                            }
                          />
                          <span>
                            {t("courier.collectCash", {
                              amount: money(order.totalMinor, order.currency),
                            })}
                          </span>
                        </label>
                      )}
                      {next && (
                        <button
                          className="rs-button rs-full rs-spaced"
                          disabled={
                            busy ||
                            cancellationPending ||
                            unready ||
                            cardUnpaid ||
                            (needsCash && !collected[order.number])
                          }
                          onClick={() => advance(order)}
                        >
                          {busy
                            ? t("common.loading")
                            : `${t("courier.update")} · ${t(`delivery.status.${next}`)}`}
                        </button>
                      )}
                      {cancellationPending && <p className="rs-notice rs-spaced">{t("support.pending")}</p>}
                      <CourierLocation order={order} enabled={sharingOrder === order.number} activate={() => setSharingOrder(order.number)} deactivate={() => setSharingOrder(current => current === order.number ? "" : current)}/>
                      <small className="rs-muted">
                        {t("order.updated")}: {date(order.updatedAt)}
                      </small>
                    </section>
                  );
                })}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
