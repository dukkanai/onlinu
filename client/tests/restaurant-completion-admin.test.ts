import test from "node:test";
import assert from "node:assert/strict";
import { stockUpdatePayload } from "../src/restaurant/admin/StockPanel";
import { supportReason } from "../src/restaurant/admin/OrderSupportAdmin";
import { pendingRefundMinor, refundActions, refundRequest, validRefundAmount } from "../src/restaurant/admin/RefundsPanel";
import type { StockItem } from "../src/restaurant/types";
import type { Refund, RefundSummary } from "../src/restaurant/refundTypes";

test("stock writes keep their own version and never add held units to sellable stock", () => {
  const stock: StockItem = { itemId: "test-dish", tracked: true, available: 4, held: 3, version: 7, updatedAt: "" };
  assert.deepEqual(stockUpdatePayload(stock, true, 5), { tracked: true, available: 5, version: 7 });
  assert.deepEqual(stockUpdatePayload(stock, false, 5), { tracked: false, available: 0, version: 7 });
  for (const amount of [-1, 1.5, Infinity, NaN, 1000001]) assert.equal(stockUpdatePayload(stock, true, amount), null);
  assert.deepEqual(stockUpdatePayload({ ...stock, version: 0 }, true, 1000000), { tracked: true, available: 1000000, version: 0 });
  assert.equal(stock.held, 3);
});

test("cancellation and complaint decisions require a bounded nonblank explanation", () => {
  assert.equal(supportReason("  valid reason  "), true);
  assert.equal(supportReason(" \n\t "), false);
  assert.equal(supportReason("x".repeat(1000)), true);
  assert.equal(supportReason("x".repeat(1001)), false);
});

test("refund amount validation uses exact minor units and the remaining refundable balance", () => {
  const summary: RefundSummary = { refunds: [], capturedMinor: 10000, reservedMinor: 5000, refundedMinor: 3000, availableMinor: 5000, capability: { automatic: true, manual: true, partial: true, reason: "provider_verified" } };
  assert.equal(pendingRefundMinor(summary), 2000, "confirmed refunds must not also be counted in the pending/manual amount");
  assert.equal(validRefundAmount(summary, 1), true);
  assert.equal(validRefundAmount(summary, 5000), true);
  for (const amount of [0, -1, 0.1, 5001, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.equal(validRefundAmount(summary, amount), false);
  summary.capability.partial = false;
  assert.equal(validRefundAmount(summary, 4999), false);
  assert.equal(validRefundAmount(summary, 5000), true);
});

test("refund action eligibility never reports uncertain submitted payments manually", () => {
  const capability = { automatic: true, manual: true, partial: true, reason: "provider_verified" } as const;
  const refund = { status: "requested", authorized: false, submitted: false, providerReference: "", amountMinor: 1000 } as Refund;
  assert.deepEqual(refundActions(refund, capability, 1000), { execute: true, manual: false, refresh: false, "verify-reference": false });
  assert.equal(refundActions(refund, capability, 0).execute, false);
  refund.authorized = true;
  assert.equal(refundActions(refund, capability, 1000).execute, false);
  refund.status = "review";
  assert.equal(refundActions(refund, capability, 1000).execute, true, "proven unsubmitted preflight failures can be explicitly reauthorized");
  assert.equal(refundActions(refund, capability, 1000).manual, true);
  assert.equal(refundActions(refund, capability, 0).manual, false, "never invite an external refund of unverified funds");
  refund.submitted = true;
  assert.equal(refundActions(refund, capability, 1000).execute, false, "unknown submitted refunds must never be dispatched again");
  assert.equal(refundActions(refund, capability, 1000).manual, false);
  assert.equal(refundActions(refund, capability, 1000)["verify-reference"], true);
  refund.providerReference = "provider-reference";
  assert.equal(refundActions(refund, capability, 1000).refresh, true);
  assert.equal(refundActions(refund, capability, 1000)["verify-reference"], false);
  for (const status of ["succeeded", "failed", "manual_reported"] as const) {
    refund.status = status;
    assert.deepEqual(refundActions(refund, capability, 1000), { execute: false, manual: false, refresh: false, "verify-reference": false });
  }
});

test("uncertain refund retries retain request identity and original optimistic version", () => {
  let sequence = 0;
  const id = () => `test-${++sequence}`;
  const original = refundRequest(undefined, 1000, "  Partial refund  ", 5, id);
  assert.deepEqual(original, { requestId: "test-1", amountMinor: 1000, reason: "Partial refund", version: 5 });
  assert.equal(refundRequest(original, 1000, "Partial refund", 9, id), original);
  assert.equal(sequence, 1);
  assert.equal(refundRequest(original, 2000, "Partial refund", 9, id).requestId, "test-2");
});
