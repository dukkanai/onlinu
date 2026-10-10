import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { clearSubmittedCart, createCheckoutLifetime } from "../src/restaurant/customer/checkoutLifetime";
import {
  parsePendingSubmission, readPendingSubmission, rememberSubmissionReceipt,
  sameSubmission, savePendingSubmission, type PendingSubmission,
} from "../src/restaurant/customer/pending";
import { emptyAddress, type OrderLineInput, type Quote, type Receipt } from "../src/restaurant/types";

const quote: Quote = { items: [{ itemId: "ordered-A", name: "A", quantity: 1, unitPriceMinor: 100, totalMinor: 100, options: [] }],
  totalMinor: 100, subtotalMinor: 100, deliveryFeeMinor: 0, currency: "SAR", demo: true };
const input = { mode: "pickup" as const, customerName: "Synthetic guest", phone: "+966500000000", address: emptyAddress(),
  tableCode: "", notes: "", items: [{ itemId: "ordered-A", quantity: 1, optionIds: [] }], expectedTotalMinor: 100, expectedQuoteHash: "a".repeat(64) };
const receipt = { order: { ...quote, number: "R00000001", version: 1 }, trackingToken: "synthetic-token-A", accessCode: "synthetic-code-A" } as Receipt;
const source = readFileSync(new URL("../src/restaurant/Storefront.tsx", import.meta.url), "utf8");
const checkout = source.slice(source.indexOf("function CheckoutPage("), source.indexOf("function OrderDetails("));
const confirmSource = checkout.slice(checkout.indexOf("  const confirm ="), checkout.indexOf("  const locate ="));

function storage(blocked: boolean | { write?: boolean; remove?: boolean } = false) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { if (blocked === true || typeof blocked === "object" && blocked.write) throw Error("quota"); values.set(key, value); },
    removeItem: (key: string) => { if (typeof blocked === "object" && blocked.remove) throw Error("denied"); values.delete(key); },
  } });
  savePendingSubmission(null);
  return () => {
    savePendingSubmission(null);
    if (descriptor) Object.defineProperty(globalThis, "sessionStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  };
}

function harness(owner = "customer-A", recovery = readPendingSubmission()) {
  const lifetime = createCheckoutLifetime();
  let dispose = lifetime.mount();
  let cart: OrderLineInput[] = structuredClone(input.items), path = "/order";
  let resolve!: (value: unknown) => void, reject!: (reason: unknown) => void;
  const response = new Promise((yes, no) => { resolve = yes; reject = no; });
  const requests: { path: string; options: RequestInit }[] = [], changes: string[] = [];
  const env = {
    mutation: { current: false }, quote, quoteHash: input.expectedQuoteHash,
    submission: { current: recovery }, customer: { id: owner }, uncertain: !!recovery,
    setQuote: () => { changes.push("quote"); }, setError: (value: string) => { if (value) changes.push(value); },
    setBusy: () => { changes.push("busy"); }, setUncertain: () => { changes.push("uncertain"); }, crypto, Date,
    lifetime, buildInput: () => structuredClone(input), readPendingSubmission, savePendingSubmission,
    sameSubmission, rememberSubmissionReceipt, clearSubmittedCart,
    storefront: async (requestPath: string, options: RequestInit) => { requests.push({ path: requestPath, options }); return response; },
    json: (body: unknown, method: string, headers: unknown) => ({ body: JSON.stringify(body), method, headers }),
    setCart: (next: OrderLineInput[] | ((value: OrderLineInput[]) => OrderLineInput[])) => { cart = typeof next === "function" ? next(cart) : next; },
    onReceipt: (value: Receipt) => { path = `/track?order=${value.order.number}`; },
    fail: () => { changes.push("error"); }, onSessionExpired: () => { changes.push("sessionExpired"); },
    refreshCatalog: async () => { changes.push("catalog"); }, errorKey: () => "errors.price_changed",
  };
  // Execute the real confirmation callback with deterministic dependencies;
  // this covers its wiring without claiming browser or React-renderer testing.
  const js = ts.transpileModule(`${confirmSource}\nreturn confirm;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const confirm = new Function(...Object.keys(env), js)(...Object.values(env)) as () => Promise<void>;
  return { confirm, dispose: () => dispose(), resolve, reject, requests, changes,
    leave() { dispose(); path = "/"; cart = [...cart, { itemId: "new-B", quantity: 2, optionIds: [] }]; changes.length = 0; },
    changeOwner() { dispose(); dispose = lifetime.mount(); env.customer.id = "customer-B"; changes.length = 0; },
    get cart() { return cart; }, get path() { return path; },
  };
}

test("late checkout success preserves newer cart/navigation and recovers a known receipt with GET only", async () => {
  const restore = storage();
  try {
    const first = harness(), pending = first.confirm(), original = readPendingSubmission()!;
    first.leave(); first.resolve(receipt); await pending;
    assert.equal(first.requests.length, 1);
    assert.equal(first.requests[0].options.method, "POST");
    assert.equal(first.requests[0].options.signal, undefined, "leaving must not abort or pretend to cancel the order");
    assert.equal(first.path, "/");
    assert.deepEqual(first.cart.map(line => line.itemId), ["ordered-A", "new-B"]);
    assert.deepEqual(first.changes, []);
    const known = readPendingSubmission()!;
    assert.equal(known.key, original.key);
    assert.deepEqual(known.input, original.input);
    assert.deepEqual(known.receipt, { number: receipt.order.number, trackingToken: receipt.trackingToken, accessCode: receipt.accessCode });
    const recovered = harness(), read = recovered.confirm();
    assert.equal(recovered.requests.length, 1);
    assert.equal(recovered.requests[0].path, `/orders/${receipt.order.number}`);
    assert.equal(recovered.requests[0].options.method, undefined);
    recovered.resolve(receipt.order); await read;
    assert.equal(recovered.path, `/track?order=${receipt.order.number}`);
    assert.equal(readPendingSubmission(), null);
  } finally { restore(); }
});

test("late failure cannot clear a newer session and unknown recovery reuses exact key and body", async () => {
  const restore = storage();
  try {
    const first = harness(), pending = first.confirm(), original = readPendingSubmission()!;
    first.leave(); first.reject({ status: 401 }); await pending;
    assert.deepEqual(first.changes, []);
    assert.deepEqual(readPendingSubmission(), original);
    const retry = harness(), retried = retry.confirm();
    assert.deepEqual(retry.requests[0].options, first.requests[0].options);
    retry.resolve(receipt); await retried;
  } finally { restore(); }
});

test("known receipts remain owner-bound and cannot overwrite newer or cleared recovery records", async () => {
  const restore = storage();
  try {
    const first = harness(), pending = first.confirm(), original = readPendingSubmission()!;
    const newer = { ...original, key: "91612392-7d09-48b6-819d-f3894c82ae21", customerId: "customer-B" };
    first.leave(); savePendingSubmission(newer); first.resolve(receipt); await pending;
    assert.deepEqual(readPendingSubmission(), newer);
    savePendingSubmission(original); rememberSubmissionReceipt(original, receipt);
    const other = harness("customer-B"); await other.confirm();
    assert.equal(other.requests.length, 0);
    assert.ok(other.changes.includes("account.sessionExpired"));
    savePendingSubmission(null); rememberSubmissionReceipt(original, receipt);
    assert.equal(readPendingSubmission(), null);
  } finally { restore(); }
});

test("confirmed receipt read failures retain known success and never fall back to order POST", async () => {
  const restore = storage();
  try {
    const first = harness(), pending = first.confirm(); first.leave(); first.resolve(receipt); await pending;
    const known = readPendingSubmission()!;
    const recovery = harness(), reading = recovery.confirm(); recovery.reject({ status: 404 }); await reading;
    assert.deepEqual(readPendingSubmission(), known);
    assert.equal(recovery.requests.length, 1);
    assert.equal(recovery.requests[0].options.method, undefined);
  } finally { restore(); }
});

test("changing customer identity invalidates a still-mounted checkout response", async () => {
  const restore = storage();
  try {
    assert.match(checkout, /\[lifetime, customer\?\.id\]/, "the lifecycle must follow the current customer identity");
    const first = harness(), pending = first.confirm(), original = readPendingSubmission()!;
    first.changeOwner(); first.resolve(receipt); await pending;
    assert.equal(first.path, "/order");
    assert.deepEqual(first.cart, input.items);
    assert.deepEqual(first.changes, []);
    assert.equal(readPendingSubmission()!.customerId, original.customerId);
    assert.ok(readPendingSubmission()!.receipt);
  } finally { restore(); }
});

test("receipt references are bounded and disabled storage retains navigation recovery in memory", async () => {
  const restore = storage(true);
  try {
    const first = harness(), pending = first.confirm(), original = readPendingSubmission()!;
    assert.ok(original);
    first.leave(); first.resolve(receipt); await pending;
    assert.ok(readPendingSubmission()?.receipt);
    for (const invalid of [{ ...receipt, trackingToken: "x".repeat(129) }, { ...receipt, accessCode: "" },
      { ...receipt, order: { ...receipt.order, number: "../other" } }])
      assert.throws(() => rememberSubmissionReceipt(original, invalid));
    const malformed = parsePendingSubmission(JSON.stringify({ ...original, receipt: { number: {}, trackingToken: "x", accessCode: "x" } }))!;
    assert.equal(malformed.receipt, undefined);
    assert.deepEqual(malformed.input, original.input, "invalid optional metadata must not discard the retry identity");
  } finally { restore(); }
});

test("cart completion clears only an unchanged submitted cart", () => {
  assert.deepEqual(clearSubmittedCart(structuredClone(input.items), input.items), []);
  for (const changed of [[...input.items, { itemId: "new-B", quantity: 1, optionIds: [] }],
    [{ ...input.items[0], quantity: 2 }], [{ ...input.items[0], optionIds: ["extra"] }]])
    assert.equal(clearSubmittedCart(changed, input.items), changed);
});

test("a failed storage removal cannot revive a cleared recovery in the current tab", async () => {
  const failures: { remove?: boolean } = {}, restore = storage(failures);
  try {
    const first = harness(), pending = first.confirm();
    failures.remove = true;
    first.resolve(receipt); await pending;
    assert.equal(readPendingSubmission(), null);
    assert.equal(first.path, `/track?order=${receipt.order.number}`);
  } finally { failures.remove = false; restore(); }
});
