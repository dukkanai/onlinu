import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CreditCard, RefreshCw } from "lucide-react";
import { storefront, RestaurantAPIError } from "../api";
import { useLocale } from "../i18n";
import type { Order } from "../types";
import { paymentStatusKey } from "./operations";
import { createPaymentLifetime } from "./paymentLifetime";
import {
  isolatedHyperPayDocument,
  retainPaymentReceipt,
  safePaymentURL,
  type PaymentAttempt,
} from "./paymentSafety";
export interface PublicPaymentProvider {
  id: string;
  name: string;
  mode: "test" | "live";
}

interface PaymentPanelProps {
  order: Order;
  token: string;
  customerId?: string;
  onUpdated: (order: Order) => void;
}

export function PaymentPanel(props: PaymentPanelProps) {
  // A different order or access identity gets fresh attempt/error/busy state.
  // Unmounting only fences UI effects; a sent payment may still finish remotely.
  return <ScopedPaymentPanel key={JSON.stringify([props.order.number, props.token, props.customerId ?? ""])} {...props} />;
}

function ScopedPaymentPanel({ order, token, customerId = "", onUpdated }: PaymentPanelProps) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [attempt, setAttempt] = useState<PaymentAttempt | null>(null);
  const lifetime = useRef(createPaymentLifetime()).current;
  useLayoutEffect(() => lifetime.mount(), [lifetime]);
  const mutation = useRef(false);
  const readGeneration = useRef(0);
  const headers = token ? { "X-Order-Token": token } : undefined;
  const base = `/orders/${encodeURIComponent(order.number)}`;
  const fail = (value: unknown) =>
    setError(
      value instanceof RestaurantAPIError
        ? `errors.${value.code}`
        : "common.error",
    );
  useEffect(() => {
    let active = true;
    const generation = readGeneration.current;
    const current = lifetime.capture();
    if (order.payment?.method !== "card") return;
    void storefront<PaymentAttempt>(`${base}/payment`, { headers })
      .then((result) => {
        if (
          active && current() &&
          generation === readGeneration.current &&
          !mutation.current
        )
          setAttempt(result);
      })
      .catch(() => {
        /* Explicit retry remains available; private order fetch is authoritative. */
      });
    return () => {
      active = false;
    };
  }, [order.number, token, order.payment?.status]);
  const refresh = async () => {
    if (mutation.current) return;
    const current = lifetime.capture();
    if (!current()) return;
    readGeneration.current++;
    mutation.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await storefront<PaymentAttempt>(
        `${base}/payment/refresh`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: "{}",
        },
      );
      if (!current()) return;
      setAttempt(result);
      const updated = await storefront<Order>(base, { headers });
      if (current()) onUpdated(updated);
    } catch (error) {
      if (current()) fail(error);
    } finally {
      if (current()) {
        mutation.current = false;
        setBusy(false);
      }
    }
  };
  const pay = async () => {
    if (mutation.current || !order.payment?.provider) return;
    const current = lifetime.capture();
    if (!current()) return;
    readGeneration.current++;
    mutation.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await storefront<PaymentAttempt>(`${base}/payment`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ provider: order.payment.provider }),
      });
      if (!current()) return;
      if (
        result.mode !== (order.demo ? "test" : "live") ||
        result.provider !== order.payment.provider
      ) {
        setError("payment.checkoutUnavailable");
        return;
      }
      if (
        result.status === "paid" ||
        result.status === "failed" ||
        result.status === "refunded" ||
        result.status === "review"
      ) {
        setAttempt(result);
        const updated = await storefront<Order>(base, { headers });
        if (current()) onUpdated(updated);
        return;
      }
      const account = await storefront<{ customer: { id: string } | null }>(
        "/account",
      );
      if (!current()) return;
      if ((account.customer?.id ?? "") !== customerId) {
        setAttempt(null);
        setError("errors.unauthorized");
        return;
      }
      setAttempt(result);
      retainPaymentReceipt(
        result.attemptId,
        order.number,
        token,
        account.customer?.id ?? "",
      );
      if (result.widget) {
        if (!isolatedHyperPayDocument(result, window.location.origin))
          setError("payment.checkoutUnavailable");
        return;
      }
      const target = result.url
        ? safePaymentURL(result.provider, result.url)
        : null;
      if (!target) {
        setError("payment.checkoutUnavailable");
        return;
      }
      window.location.assign(target);
    } catch (error) {
      if (current()) fail(error);
    } finally {
      if (current()) {
        mutation.current = false;
        setBusy(false);
      }
    }
  };
  const payment = order.payment;
  if (!payment?.method) return null;
  const widget =
    attempt &&
    order.demo &&
    attempt.provider === payment.provider &&
    ["unpaid", "pending"].includes(payment.status) &&
    !["completed", "cancelled"].includes(order.status)
      ? isolatedHyperPayDocument(attempt, window.location.origin)
      : null;
  const payable =
    payment.method === "card" &&
    !["paid", "failed", "refunded", "review"].includes(payment.status) &&
    !["completed", "cancelled"].includes(order.status);
  return (
    <section className="rs-panel rs-payment-panel">
      <div className="rs-section-head">
        <h2>
          <CreditCard size={20} />
          {t("payment.title")}
        </h2>
        <span className="rs-status">{t(paymentStatusKey(payment.status))}</span>
      </div>
      <p>{t(`payment.method.${payment.method}`)}</p>
      {error && (
        <p className="rs-notice rs-notice-error rs-spaced" role="alert">
          {t(error)}
        </p>
      )}
      {payment.method !== "card" && payment.status !== "paid" && (
        <p className="rs-muted">{t("payment.cashAwaiting")}</p>
      )}
      {["card", "cash_before"].includes(payment.method) &&
        payment.status !== "paid" && (
          <p className="rs-muted">{t("payment.preparationHold")}</p>
        )}
      {payment.method === "card" && (
        <>
          <p className="rs-muted rs-spaced">{t("payment.noRedirectTrust")}</p>
          {attempt?.mode === "test" && (
            <p className="rs-notice rs-spaced">{t("payment.testMode")}</p>
          )}
          <div className="rs-dialog-actions">
            {payable && (
              <button
                className="rs-button"
                disabled={busy || !payment.provider}
                onClick={pay}
              >
                {busy ? t("common.loading") : t("payment.payNow")}
              </button>
            )}
            <button
              className="rs-button rs-button-outline"
              disabled={busy}
              onClick={refresh}
            >
              <RefreshCw size={16} />
              {t("payment.refresh")}
            </button>
          </div>
          {widget && (
            <>
              <p className="rs-notice rs-spaced">
                {t("payment.widgetVerification")}
              </p>
              <iframe
                className="rs-payment-widget"
                title={t("payment.title")}
                sandbox="allow-scripts allow-forms allow-popups"
                referrerPolicy="no-referrer"
                srcDoc={widget}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}
