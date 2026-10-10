import assert from "node:assert/strict";
import test from "node:test";
import { createTrackingReadGuard } from "../src/restaurant/customer/trackingRead";

test("a successful lookup cannot be overwritten by an older order poll", async () => {
  const reads = createTrackingReadGuard();
  let displayed = "", error = "";
  let resolveOld!: (value: string) => void;
  const old = reads.begin()!;
  const oldResponse = new Promise<string>(resolve => { resolveOld = resolve; });
  const oldCompletion = oldResponse.then(result => {
    if (old.current()) { displayed = result; error = "old poll error"; }
  }).finally(old.finish);
  // Lookup starts while the order-A poll is delayed. Even a transport ignoring
  // abort must not make its stale response current again.
  reads.invalidate();
  const lookup = reads.begin()!;
  assert.equal(old.signal.aborted, true);
  if (lookup.current()) displayed = "order-B";
  resolveOld("order-A");
  await oldCompletion;
  assert.equal(displayed, "order-B");
  assert.equal(error, "");
  assert.equal(lookup.current(), true);
  assert.equal(reads.begin(), null, "old cleanup cannot unlock the current lookup");
  lookup.finish();
  assert.ok(reads.begin());
});

test("navigation invalidates pending lookup state and URL changes", async () => {
  const reads = createTrackingReadGuard();
  const lookup = reads.begin()!;
  let changedURL = false;
  reads.invalidate();
  await Promise.resolve();
  if (lookup.current()) changedURL = true;
  assert.equal(changedURL, false);
  assert.equal(lookup.signal.aborted, true);
  assert.ok(reads.begin(), "a new tracking scope can read normally");
});

test("polling is single-flight, resumes after completion and isolates late failures", () => {
  const reads = createTrackingReadGuard();
  const first = reads.begin()!;
  assert.equal(reads.begin(), null);
  first.finish();
  assert.equal(first.current(), false);
  const second = reads.begin()!;
  reads.invalidate();
  const third = reads.begin()!;
  second.finish();
  assert.equal(second.current(), false);
  assert.equal(third.current(), true);
  third.finish();
  assert.ok(reads.begin());
});
