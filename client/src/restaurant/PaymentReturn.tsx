import { useEffect, useState } from "react";
import { storefront, RestaurantAPIError } from "./api";
import { LanguagePicker, useLocale } from "./i18n";
import type { Order } from "./types";
import { mergePaymentOrder } from "./customer/paymentLifetime";
import { PaymentPanel } from "./customer/PaymentPanel";
import {
  recoverPaymentReceipt,
  type PaymentAttempt,
} from "./customer/paymentSafety";
import { privateTrackingURL } from "./customer/cart";
import "./customer/storefront.css";

export function PaymentReturn() {
  const { t, dir } = useLocale();
  const [reference] = useState(() =>
    recoverPaymentReceipt(
      new URLSearchParams(window.location.search).get("attempt") ?? "",
    ),
  );
  const [order, setOrder] = useState<Order | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(!!reference);
  const [referenceAllowed, setReferenceAllowed] = useState(false);
  useEffect(() => {
    let active = true;
    if (!reference) return;
    const headers = reference.token
      ? { "X-Order-Token": reference.token }
      : undefined;
    const base = `/orders/${encodeURIComponent(reference.number)}`;
    // No success/status/amount query value is consulted. Only the retained
    // private receipt authorizes a server-side status check.
    void (async () => {
      try {
        const account = await storefront<{ customer: { id: string } | null }>(
          "/account",
        );
        if ((account.customer?.id ?? "") !== reference.customerId)
          throw new RestaurantAPIError("unauthorized", 401);
        if (active) setReferenceAllowed(true);
        await storefront<PaymentAttempt>(`${base}/payment/refresh`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: "{}",
        });
        const current = await storefront<Order>(base, { headers });
        if (active) setOrder(current);
      } catch (value) {
        if (active)
          setError(
            value instanceof RestaurantAPIError
              ? `errors.${value.code}`
              : "common.error",
          );
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [reference]);
  return (
    <div className="restaurant-storefront" dir={dir}>
      <main className="rs-main rs-narrow">
        <LanguagePicker />
        <div className="rs-page-heading">
          <h1>{t("payment.returnTitle")}</h1>
          <p>{t("payment.noRedirectTrust")}</p>
        </div>
        {error && (
          <p className="rs-notice rs-notice-error" role="alert">
            {t(error)}
          </p>
        )}
        {loading && <p role="status">{t("common.loading")}</p>}
        {order && reference && referenceAllowed ? (
          <>
            <PaymentPanel
              order={order}
              token={reference.token}
              customerId={reference.customerId}
              onUpdated={updated => setOrder(current => mergePaymentOrder(current, updated))}
            />
            <a
              className="rs-button rs-spaced"
              href={privateTrackingURL(
                window.location.origin,
                order.number,
                reference.token,
              )}
            >
              {t("order.tracking")}
            </a>
          </>
        ) : (
          !loading && (
            <section className="rs-panel">
              <p>
                {t(
                  reference && referenceAllowed
                    ? "payment.returnHint"
                    : "payment.returnMissing",
                )}
              </p>
              <a
                className="rs-button rs-spaced"
                href={
                  reference && referenceAllowed
                    ? privateTrackingURL(
                        window.location.origin,
                        reference.number,
                        reference.token,
                      )
                    : "/track"
                }
              >
                {t("order.tracking")}
              </a>
            </section>
          )
        )}
      </main>
    </div>
  );
}
