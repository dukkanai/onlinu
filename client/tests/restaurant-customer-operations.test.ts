import assert from "node:assert/strict";
import test from "node:test";
import { emptyAddress, type Settings } from "../src/restaurant/types";
import {
  availablePaymentMethods,
  brandVariables,
  contrastText,
  courierNextStatus,
  isSaudiDeliveryAddress,
  mapURL,
  withAddressCountry,
} from "../src/restaurant/customer/operations";
import {
  isolatedHyperPayDocument,
  recoverPaymentReceipt,
  retainPaymentReceipt,
  safePaymentURL,
  type PaymentAttempt,
} from "../src/restaurant/customer/paymentSafety";

test("legacy country normalization preserves an explicit foreign country", () => {
  const address = {
    ...emptyAddress(),
    nationalAddress: "ABCD1234",
    additionalNumber: "1234",
    city: "Riyadh",
  };
  assert.equal(withAddressCountry(address, "TR").nationalAddress, "");
  assert.equal(withAddressCountry(address, "TR").additionalNumber, "");
  assert.equal(withAddressCountry(address, "TR").city, "Riyadh");
  assert.equal(withAddressCountry(address, "SA").nationalAddress, "ABCD1234");
  const legacy = { ...address, country: "TR" };
  assert.equal(withAddressCountry(legacy, legacy.country).country, "TR");
});
test("only Saudi and legacy unspecified addresses are available for new delivery", () => {
  assert.equal(isSaudiDeliveryAddress(emptyAddress()), true);
  assert.equal(isSaudiDeliveryAddress({}), true);
  assert.equal(isSaudiDeliveryAddress({ country: "" }), true);
  assert.equal(isSaudiDeliveryAddress({ country: "SA" }), true);
  for (const country of ["AE", "TR", "SAU", "ZZ", "sa"]) {
    assert.equal(isSaudiDeliveryAddress({ country }), false, country);
  }
});
test("checkout mode payment policy stays restrictive", () => {
  assert.deepEqual(
    availablePaymentMethods(
      {
        paymentMethods: {
          pickup: ["cash_after", "card"],
          delivery: ["cash_on_delivery", "card"],
          table: ["cash_before"],
        },
      } as Settings,
      "pickup",
    ),
    ["card"],
  );
  assert.deepEqual(availablePaymentMethods({} as Settings, "delivery"), [
    "cash_on_delivery",
    "card",
  ]);
});
test("branding permits only literal colors and uses a high contrast button foreground", () => {
  const vars = brandVariables({
    primaryColor: "url(javascript:bad)",
    backgroundColor: "#ffffff",
    accentColor: "#abcdef",
  } as Settings) as Record<string, string>;
  assert.equal(vars["--rs-green"], "#214e40");
  assert.equal(vars["--rs-accent"], "#abcdef");
  assert.equal(contrastText("#ffffff"), "#000000");
  assert.equal(contrastText("#000000"), "#ffffff");
  assert.equal(contrastText("#888888"), "#000000");
});
test("delivery transition and external map links cannot accept arbitrary navigation", () => {
  assert.equal(courierNextStatus("assigned"), "picked_up");
  assert.equal(courierNextStatus("at_door"), "delivered");
  assert.equal(courierNextStatus("delivered"), null);
  assert.equal(courierNextStatus("forged"), null);
  assert.equal(mapURL({ ...emptyAddress(), latitude: 91, longitude: 1 }), null);
  assert.match(
    mapURL({ ...emptyAddress(), latitude: 24.7, longitude: 46.7 })!,
    /^https:\/\/www\.google\.com\/maps\/search\//,
  );
});
test("payment navigation allows only exact documented HTTPS provider hosts", () => {
  assert.equal(
    safePaymentURL("stripe", "https://checkout.stripe.com/c/pay/test"),
    "https://checkout.stripe.com/c/pay/test",
  );
  assert.equal(
    safePaymentURL("geidea", "https://merchant.geidea.net/link/test"),
    "https://merchant.geidea.net/link/test",
  );
  for (const url of [
    "https://checkout.stripe.com.evil.test/pay",
    "http://checkout.stripe.com/pay",
    "https://user:secret@checkout.stripe.com/pay",
    "https://checkout.stripe.com:444/pay",
    "javascript:alert(1)",
  ])
    assert.equal(safePaymentURL("stripe", url), null);
  assert.equal(
    safePaymentURL(
      "stripe",
      "https://checkout.stripe.com/c/pay/test#fid-provider-state",
    ),
    "https://checkout.stripe.com/c/pay/test#fid-provider-state",
  );
  assert.equal(
    safePaymentURL("unknown", "https://checkout.stripe.com/pay"),
    null,
  );
});
test("HyperPay document is strictly test-only and contains no merchant-origin script or credentials", () => {
  const attempt: PaymentAttempt = {
    attemptId: "59fd4c9d-0f07-4f22-9bca-9be816ec70bc",
    provider: "hyperpay",
    status: "pending",
    mode: "test",
    widget: {
      checkoutId: "public_checkout_1",
      scriptUrl:
        "https://eu-test.oppwa.com/v1/paymentWidgets.js?checkoutId=public_checkout_1",
      brands: ["VISA", "MADA"],
      returnUrl:
        "https://restaurant.test/payment-return?attempt=59fd4c9d-0f07-4f22-9bca-9be816ec70bc",
    },
  };
  const document = isolatedHyperPayDocument(attempt, "https://restaurant.test");
  assert.ok(document?.includes("paymentWidgets"));
  assert.ok(!document?.includes("localStorage"));
  assert.equal(
    isolatedHyperPayDocument(
      { ...attempt, mode: "live" },
      "https://restaurant.test",
    ),
    null,
  );
  assert.equal(
    isolatedHyperPayDocument(
      {
        ...attempt,
        widget: { ...attempt.widget!, brands: ['VISA" onload=alert(1)'] },
      },
      "https://restaurant.test",
    ),
    null,
  );
  assert.equal(
    isolatedHyperPayDocument(
      {
        ...attempt,
        widget: {
          ...attempt.widget!,
          scriptUrl: "https://evil.test/widget.js",
        },
      },
      "https://restaurant.test",
    ),
    null,
  );
  assert.equal(
    isolatedHyperPayDocument(
      {
        ...attempt,
        widget: {
          ...attempt.widget!,
          returnUrl: "https://evil.test/payment-return",
        },
      },
      "https://restaurant.test",
    ),
    null,
  );
  assert.ok(
    isolatedHyperPayDocument(
      {
        ...attempt,
        widget: {
          ...attempt.widget!,
          returnUrl: `https://restaurant.test/payment-hooks/return/${attempt.attemptId}`,
        },
      },
      "https://restaurant.test",
    ),
  );
});
test("payment return needs a matching retained private receipt, never a success flag", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  };
  const original = Object.getOwnPropertyDescriptor(
    globalThis,
    "sessionStorage",
  );
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: storage,
  });
  try {
    const attempt = "59fd4c9d-0f07-4f22-9bca-9be816ec70bc";
    assert.equal(recoverPaymentReceipt(attempt), null);
    retainPaymentReceipt(attempt, "R00000001", "private-receipt-token");
    assert.equal(
      recoverPaymentReceipt(attempt)?.token,
      "private-receipt-token",
    );
    assert.equal(recoverPaymentReceipt("success=true"), null);
    assert.equal(recoverPaymentReceipt(attempt, Date.now() + 86_400_001), null);
  } finally {
    if (original) Object.defineProperty(globalThis, "sessionStorage", original);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});
