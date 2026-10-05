import test from "node:test";
import assert from "node:assert/strict";
import { parseReopenRequest, reopenBlockReason, reopenRequest } from "../src/restaurant/admin/ReopenOrderPanel";
import type { Order } from "../src/restaurant/types";

test("uncertain reopen retries keep the original reason, request identity and order version", () => {
  const id = "d13c7ec1-6167-4f06-b67b-42f20a7267f1";
  const first = reopenRequest(null, { number: "R42", version: 3 }, "  Correct cancellation  ", () => id);
  assert.deepEqual(first, { number: "R42", version: 3, reason: "Correct cancellation", requestId: id });
  assert.equal(reopenRequest(first, { number: "R42", version: 7 }, "different", () => { throw Error("new identity"); }), first);
  assert.deepEqual(parseReopenRequest(JSON.stringify(first), "R42"), first);
  assert.equal(parseReopenRequest(JSON.stringify(first), "R43"), null);
  for (const patch of [{ version: 0 }, { version: 1.5 }, { requestId: "invalid" }, { reason: " " }, { reason: "x".repeat(1001) }]) {
    assert.equal(parseReopenRequest(JSON.stringify({ ...first, ...patch }), "R42"), null);
  }
});

test("reopen UI never offers known prepared, paid or active orders for reopening", () => {
  const order = { status: "cancelled", payment: { method: "cash_after", status: "unpaid" } } as Order;
  assert.equal(reopenBlockReason(order), null);
  assert.equal(reopenBlockReason({ ...order, status: "new" }), "reopen_unavailable");
  assert.equal(reopenBlockReason({ ...order, preparationStartedAt: "2026-01-01T00:00:00Z" }), "reopen_prepared");
  assert.equal(reopenBlockReason({ ...order, deliveryStatus: "delivered" }), "reopen_prepared");
  assert.equal(reopenBlockReason({ ...order, payment: { ...order.payment!, status: "paid" } }), "reopen_payment");
});
