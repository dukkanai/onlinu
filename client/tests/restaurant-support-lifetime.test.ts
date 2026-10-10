import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { RestaurantAPIError } from "../src/restaurant/api";
import { mergePaymentOrder } from "../src/restaurant/customer/paymentLifetime";
import type { Order } from "../src/restaurant/types";

const source = readFileSync(new URL("../src/restaurant/customer/OrderSupportPanel.tsx", import.meta.url), "utf8");
const storefrontSource = readFileSync(new URL("../src/restaurant/Storefront.tsx", import.meta.url), "utf8");
const callback = source.slice(source.indexOf("  const send="), source.indexOf("  const canCancel="));
const order = { number: "R00000001", version: 1, status: "new" } as Order;
const newer = { ...order, version: 3, status: "completed" } as Order;
const older = { ...order, version: 2, status: "preparing" } as Order;
type Update = Order | null | ((current: Order | null) => Order | null);
function deferred() {
  let resolve!: (value: Order) => void, reject!: (value: unknown) => void;
  const promise = new Promise<Order>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  const hold = deferred(), reload = deferred(), queue: Update[] = [], effects: string[] = [];
  let current: Order | null = order;
  const setOrder = (update: Update) => queue.push(update);
  // Execute the actual parent callback and support handler, without a browser,
  // transport, or provider. Hold the state queue until both responses finish to
  // model React batching before latestOrder receives another rendered snapshot.
  const parentCallback = storefrontSource.match(/<OrderSupportPanel[^\n]*onUpdated=\{(.+)\}\s*\/>/)?.[1];
  assert.ok(parentCallback);
  const onUpdated = new Function("setOrder", "mergePaymentOrder", `return (${parentCallback});`)(setOrder, mergePaymentOrder);
  const env = {
    gate: { current: false }, mounted: { current: true }, identity: { current: "order-A\nreceipt-A" },
    latestOrder: { current: order }, order, token: "synthetic-token", scope: "receipt:synthetic-token",
    pending: null, kind: "complaints", reason: "synthetic complaint", RestaurantAPIError,
    crypto: { randomUUID: () => "11111111-1111-4111-8111-111111111111" },
    setBusy: (value: boolean) => effects.push(`busy:${value}`), setError: (value: string) => effects.push(`error:${value}`),
    setSuccess: (value: boolean) => effects.push(`success:${value}`), setReason: () => effects.push("reason"),
    remember: (value: unknown) => effects.push(value ? "remember" : "clear"), onUpdated,
    storefront: (_path: string, options: { method?: string }) => options.method === "POST" ? hold.promise : reload.promise,
  };
  const js = ts.transpileModule(`${callback}\nreturn send;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const send = new Function(...Object.keys(env), js)(...Object.values(env)) as (event: { preventDefault(): void }) => Promise<void>;
  return {
    env, hold, reload, queue, effects, run: () => send({ preventDefault() {} }),
    poll(result: Order) { setOrder(current => current?.number === result.number && current.version > result.version ? current : result); },
    flush() { for (const update of queue.splice(0)) current = typeof update === "function" ? update(current) : update; return current; },
  };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

for (const recovery of [false, true]) {
  test(`support ${recovery ? "409 recovery" : "success"} cannot roll back a newer poll queued in the same batch`, async () => {
    const h = harness(), running = h.run();
    if (recovery) { h.hold.reject(new RestaurantAPIError("conflict", 409)); await tick(); }
    h.poll(newer);
    (recovery ? h.reload : h.hold).resolve(older);
    await running;
    assert.equal(h.flush(), newer);
  });
}
test("current legitimate support result updates the selected order", async () => {
  const h = harness(), running = h.run(); h.hold.resolve(older); await running;
  assert.equal(h.flush(), older); assert.ok(h.effects.includes("success:true"));
});
test("support result older than the rendered snapshot is discarded", async () => {
  const h = harness(), running = h.run(); h.env.latestOrder.current = newer;
  h.hold.resolve(older); await running; assert.equal(h.queue.length, 0);
});
for (const transition of ["navigation", "order", "customer", "token"]) {
  test(`support response is discarded after ${transition} changes`, async () => {
    const h = harness(), running = h.run();
    // Storefront's navigation key remounts TrackPage; its order/customer key
    // remounts support. Token changes are fenced by the panel's scope identity.
    if (transition === "token") h.env.identity.current = "order-A\nreceipt-B";
    else h.env.mounted.current = false;
    h.effects.length = 0; h.hold.resolve(older); await running;
    assert.equal(h.queue.length, 0); assert.deepEqual(h.effects, []);
  });
}
test("Storefront retains navigation and order/customer remount boundaries", () => {
  assert.match(storefrontSource, /key=\{`track-\$\{locationKey\}`\}/);
  assert.match(storefrontSource, /<OrderSupportPanel key=\{`\$\{order.number\}-\$\{customerId\}`\}/);
});
