import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PaymentPanel } from "../src/restaurant/customer/PaymentPanel";
import { LocaleProvider, translate } from "../src/restaurant/i18n";
import { paymentStatusKey } from "../src/restaurant/customer/operations";
import type { Order } from "../src/restaurant/types";

test("terminal card attempts show their status and refresh without another payment button", () => {
  for (const status of ["failed", "review", "paid", "refunded"] as const) {
    const order = {
      number: "R12345678",
      status: "new",
      demo: true,
      payment: { method: "card", provider: "paylink", status },
    } as Order;
    const html = renderToStaticMarkup(
      createElement(LocaleProvider, {
        defaultLocale: "en",
        children: createElement(PaymentPanel, {
          order,
          token: "synthetic-token",
          onUpdated: () => assert.fail("rendering must not mutate the order"),
        }),
      }),
    );
    assert.ok(html.includes(translate("en", paymentStatusKey(status))));
    assert.ok(html.includes(translate("en", "payment.refresh")));
    assert.ok(!html.includes(translate("en", "payment.payNow")));
    assert.ok(!html.includes("<iframe"));
  }
});
