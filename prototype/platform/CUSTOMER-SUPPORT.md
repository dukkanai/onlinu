# Customer-owned cancellation and complaint handoff

## Scope and authority

A confirmed central checkout links to `/checkout/{id}/support`. The browser must
have the verified owning customer session; an order number, staff membership or
OAuth bearer token cannot substitute for that session. Reads and writes resolve
the active customer identity and require their separate order scopes. Review is
nonmutating; execution additionally requires same-origin CSRF and checked review.

The signed original-core routes use distinct `customer:support:read` and
`customer:support:write` envelopes. Exact issuer, tenant, subject, method, URI,
body and idempotency key are bound; the Go core derives the owner reference and
checks original order ownership. Staff decision scopes do not grant this access.
No customer contact, receipt capability, provider secret or refund authority is
added. Free-text support detail is kept out of the MCP order-status projection.

## Original business rules

The routes call the existing `RequestCancellation` and `ReportComplaint` methods.
Before preparation, cancellation can be approved immediately. After preparation,
it awaits restaurant review. Complaint resolution and refund operations remain
separate staff actions. Cancellation is never proof of provider-confirmed refund.
The original row lock, version checks, stock, refund-intent and event transaction
remain authoritative. There is no duplicate order or money engine.

The detail shows current cancellation, up to 10 complaints and the last 20
historical cancellations with an explicit truncation label. The response budget
is 512 KB. Current support status and historical request acceptance are separate:
reopening an order must not make an accepted earlier request appear missing.

## Unknown outcomes and persistence

`platform_core_support_intents` is an additive central table keyed by checkout
and stable UUID v4. It stores kind, state and the reviewed input hash, not reason
text. A partial unique index permits only one unresolved dispatch per checkout.
The request is claimed durably before contacting the restaurant. Concurrent or
repeated requests recover using the original support ledger; they never replay a
POST automatically. A different key cannot bypass an unresolved outcome.

The original ledger and current owned order are read in a repeatable-read snapshot.
A recorded earlier request stays recorded after a later complaint or order reopen.
Confirmed original rejections release the pending claim. Ambiguous transport or
final central persistence failures retain it for read-only recovery. If the
original request never arrived, it remains unresolved: this increment does not
pretend that absence proves safety to send another request. The page explains
verification and contacting the restaurant. Operator reconciliation tooling and
its production runbook remain an explicit follow-on requirement.

Confirmed historical checkout access follows the existing customer order/payment
access model, including suspended-tenant settlement and expired checkout links.
New orders still require an active tenant. This does not complete the separate
closed-tenant retention, operational settlement and deprovisioning policy.

## Verification checkpoint — 2026-10-06 00:44 UTC

- 226 platform tests with actual PostgreSQL, no skips; private hash-only intent,
  owner/scope denial, concurrent first dispatch, lost reply, ambiguous absence,
  failed claim/final persistence and same-key recovery are covered.
- Original Go race cancellation/complaint/staff-support regressions pass. New
  signed HTTP tests verify customer ownership, review, scope separation, original
  cancellation, duplicate/conflicting requests and recovery after real reopening.
- Actual Node → Go → PostgreSQL plus central browser-session HTTP checkout,
  cancellation, complaint and suspension tests pass. All data is synthetic.
- React 80 tests/build and Go vet pass. No Flutter code changed; the last verified
  native baseline has 130 tests. Remote CI reruns native regression/build too.
- Actual Chromium review, inert cancel, unchecked confirmation and checked
  cancellation are included in the remote integration test; a synthetic review
  screenshot is retained. All jobs in [CI37394646960](https://github.com/dukkanai/onlinu/actions/runs/37394646960)
  passed on `f1046f5ed6a8d8ec81a529cf560a0056b4ba3a8f`, including Chromium
  and Windows regressions/build. The Arabic browser review screenshot was inspected:
  tenant/order/version, amount, checked review and refund warning are readable.
  The central browser pages still use basic functional styling; this is not final
  customer visual-design acceptance.

Initial local fixture used pickup with cash-on-delivery, which the original core
correctly rejected. The fixture now uses delivery and its original cash method;
no production payment rule was changed to make the test pass.

No production migration, real customer communication, account or payout occurred.
POS remains deferred.
