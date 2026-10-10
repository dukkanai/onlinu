import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import { quoteBinding } from "../src/restaurant/customer/quoteBinding";
import type { Quote } from "../src/restaurant/types";

const quote: Quote = {
  currency: "SAR", subtotalMinor: 100, deliveryFeeMinor: 0, totalMinor: 100, demo: true,
  paymentMethods: ["cash_on_delivery"],
  tax: { enabled: false, rateBps: 0, number: "", netMinor: 100, taxMinor: 0, grossMinor: 100 },
  items: [{ itemId: "rice", name: "<Rice>&\u2028🍚", quantity: 1, unitPriceMinor: 100, totalMinor: 100,
    options: [{ id: "extra", name: "Free\u2029Sauce", priceMinor: 0, available: true }] }],
};

test("web reviewed quote matches the Go and Node golden binding byte for byte", async () => {
  const hash = await quoteBinding(quote);
  assert.equal(hash, "896ee9e55665b5ed69b6a17f4f72898438f91eb334e68a6bc22b820d4f32f542");
  const goGolden = readFileSync(new URL("../../cmd/server/restaurant_quote_binding_test.go", import.meta.url), "utf8");
  assert.ok(goGolden.includes(`hash != "${hash}"`), "web must match the actual Go core's pinned golden vector");
  assert.equal(await quoteBinding({ ...quote, tableName: "" }), hash);
  assert.equal(await quoteBinding(structuredClone(quote)), hash);
});

test("web encoder matches the actual control-plane implementation without adding runtime dependencies", async () => {
  // The browser test suite does not install the platform's separate dependency
  // tree. Evaluate its pure encoder with its existing schema seam and Node hash;
  // schema validation itself remains covered by that implementation's tests.
  const source = readFileSync(new URL("../../prototype/platform/quote-binding.mjs", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace("export function quoteBinding", "function quoteBinding");
  const nodeBinding = new Function("createHash", "coreQuoteSchema", `${source}\nreturn quoteBinding;`)(
    createHash, { parse: (value: Quote) => value },
  ) as (value: Quote) => string;
  for (const candidate of [quote, { ...quote, tableName: "طاولة <أ>&🍚\u2028" }, { ...quote, paymentMethods: [] }])
    assert.equal(await quoteBinding(candidate), nodeBinding(candidate));
});

test("unchanged totals cannot hide changed names, options, tax, fulfilment or payment policy", async () => {
  const original = await quoteBinding(quote);
  const changed: Quote[] = [
    { ...quote, items: [{ ...quote.items[0], name: "Different rice" }] },
    { ...quote, items: [{ ...quote.items[0], options: [{ ...quote.items[0].options[0], name: "Different sauce" }] }] },
    { ...quote, tax: { ...quote.tax!, enabled: true, rateBps: 1500, number: "TEST-TAX", netMinor: 87, taxMinor: 13 } },
    { ...quote, subtotalMinor: 90, deliveryFeeMinor: 10 },
    { ...quote, tableName: "Table A" },
    { ...quote, demo: false },
    { ...quote, paymentMethods: ["card"] },
    { ...quote, currency: "USD" },
  ];
  for (const candidate of changed) {
    assert.equal(candidate.totalMinor, quote.totalMinor);
    assert.notEqual(await quoteBinding(candidate), original);
  }
});

test("review binding fails closed for incomplete, unsafe and contradictory quote values", async () => {
  const invalid = [
    { ...quote, tax: undefined }, { ...quote, paymentMethods: undefined },
    { ...quote, totalMinor: Number.MAX_SAFE_INTEGER + 1 },
    { ...quote, subtotalMinor: 100.5 }, { ...quote, deliveryFeeMinor: -1 },
    { ...quote, tax: { ...quote.tax, rateBps: 10001 } },
    { ...quote, tax: { ...quote.tax, netMinor: 50 } },
    { ...quote, items: [{ ...quote.items[0], unitPriceMinor: Number.NaN }] },
    { ...quote, items: [{ ...quote.items[0], quantity: 1.5 }] },
    { ...quote, items: [{ ...quote.items[0], options: [{ ...quote.items[0].options[0], priceMinor: Infinity }] }] },
  ];
  for (const candidate of invalid) await assert.rejects(quoteBinding(candidate as Quote));
});

test("a digest failure never falls back to a total-only confirmation", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: {
    subtle: { digest: async () => { throw new Error("digest unavailable"); } },
  } });
  try { await assert.rejects(quoteBinding(quote), /digest unavailable/); }
  finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
});
