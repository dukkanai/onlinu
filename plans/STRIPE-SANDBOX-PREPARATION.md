# Stripe sandbox preparation — 10 October 2026

## Status and scope

Source preparation only. **Not ready for a connected sandbox pilot.** No Stripe
account, key, endpoint, provider setting, deployment, network rule, or real payment
was created or changed. Paylink remains outside this increment. The existing
Stripe provider is disabled until explicitly configured; this work does not enable
it. A US Stripe account does not establish eligibility for a Saudi live merchant
rollout. That is outside this sandbox work.

The owner prefers a dedicated Stripe sandbox. Use synthetic orders and contact
details only. All future account access, secret provisioning, endpoint creation,
and execution must use the separately authorized secure setup flow. Never put keys,
signing secrets, real customer data, or payment details in chat, source, fixtures,
logs, or this document.

## What already exists

- `cmd/server/restaurant_payments_gateways.go`: Stripe-hosted Checkout Session
  creation; one-time card payment; integer amount and currency taken from the
  server-priced order; fixed Stripe API and Checkout hosts; request timeout,
  bounded responses, no redirects followed, and redacted errors.
- `cmd/server/restaurant_payments.go`: a committed attempt before external create,
  unique order-to-attempt binding, original encrypted configuration snapshot,
  stable `restaurant-<attempt UUID>` idempotency key, and row-locked settlement.
  Ambiguous create outcomes become review and cannot start a second attempt.
- `fetchStripe`: retrieve the persisted Checkout Session with
  `expand[]=payment_intent.latest_charge`; verify environment, reference, exact
  currency/amount, successful captured charge, refunds, and disputes before
  settlement. Creation never marks an order paid.
- `restaurant_payments_http.go`: browser return discards supplied status and only
  redirects to a local page. Order-authorized refresh and the bounded durable
  reconciliation queue obtain authoritative provider status.
- The current account webhook accepts unsigned JSON only as a lookup/refresh
  hint. It cannot mark an order paid from the event payload. Its real weakness is
  unauthenticated refresh/queue triggering and missing event-ID deduplication,
  not a demonstrated forged-payment exploit.

## This source increment

1. Persist the attempt creation timestamp using PostgreSQL `clock_timestamp()`
   and return that exact value to the adapter. Using transaction-start `now()`
   could be stale after an order-lock wait.
2. Derive `expires_at` from that timestamp, not a fresh clock at each adapter
   invocation. It is fixed at creation +31 minutes, a one-minute submission margin
   above Stripe's 30-minute minimum. The existing request deadline is 10 seconds.
   A delayed first submission can still be rejected by Stripe; never change the
   expiry under the same idempotency key. No create retry was added.
   Existing attempt rows and their encrypted snapshots are not migrated or
   rewritten. Repeated Start on an old attempt still returns that durable result
   without creating again. A caller lacking the new request timestamp fails
   closed before transport; it does not invent a replacement timestamp.
3. Add an **unwired** sandbox configuration guard accepting only Stripe/test and
   server-side `rk_test_` or `sk_test_` keys. Prefer the restricted key. The existing
   administrator validation still rejects restricted keys until the next reviewed
   wiring change. The helper does not prove account ownership or key permissions.
4. Add an **unwired** raw-body webhook verifier: bounded bytes/header, HMAC-SHA256,
   constant-time digest comparison, v1 signatures only, multiple-signature
   rotation, canonical timestamp, five-minute past/future delivery tolerance,
   strict single JSON envelope, explicit `livemode=false`, and no Connect or
   organization context. It returns only event identity and lookup hints. It does
   not settle, call a provider, store a receipt, or deduplicate events.
5. Add synthetic transport, signature, configuration, and PostgreSQL restart/
   uncertainty tests. Signature validity alone is deliberately not a uniqueness
   or payment assertion.

The immutable timestamp is necessary but not a complete retry implementation.
Before ever introducing one, also persist the full canonical create request
(including return URL and expiry), request/API version, account identity, and hash.
Rebuilding a request from a changed public URL/configuration after restart would
not be safe. Never reuse an expired/pruned provider idempotency key to create again.

## Next reviewed wiring increment

### 1. Closed sandbox boundary and secure configuration

- Decide and test the explicit pilot enablement boundary, default disabled. Enforce
  Stripe test-only checks at configure, availability/start, and create/fetch
  boundaries. Require demo catalogue **and** demo order; reject live keys and live
  responses. A key prefix alone must never activate a provider.
- Add a separate encrypted endpoint signing secret with sanitized `secretSet`
  output only. Keep original attempt account/key snapshots. Endpoint-secret
  rotation and replacement by a different sandbox/account need an explicit
  migration policy; do not guess which account an event belongs to.
- After authorization, verify the intended dedicated sandbox and SAR card support
  for this account. Keep the existing SAR-priced order contract; do not silently
  switch to USD, convert totals, add Stripe tax, enable coupons, or add adaptive
  pricing. No customer/phone/address needs to be forwarded in create parameters.
- Select and pin the API/event version tested by the implementation. The current
  handwritten adapter does not send `Stripe-Version`; default account versions
  are not a stable compatibility contract. No SDK dependency was added here.

### 2. Signed raw-body route and a durable inbox

- Use an own-account **snapshot event** endpoint in the dedicated sandbox. This
  verifier expects the snapshot `event` / `data.object` envelope; thin events,
  Connect-account events, and organization endpoints are not supported here.
- For `POST /payment-hooks/stripe`, read the bounded body exactly once and verify
  `Stripe-Signature` with the configured sandbox endpoint secret before JSON
  fields can trigger database work. Fail closed on missing secret/signature,
  wrong mode/account, stale/future timestamp, or malformed envelope. Keep the
  separate hook guard/rate limits and no secret-bearing diagnostics.
- Disable the generic `POST /payment-hooks/stripe/{attempt}` notification path
  for this pilot so it cannot bypass the signed account route. The authenticated
  order refresh and status-only browser return remain available.
- Introduce a dedicated receipt table keyed by `(sandbox/account generation,
  event_id)`, containing only minimal routing/receipt metadata and a body hash,
  not raw Stripe customer payloads. Store an event ID once with a database unique
  constraint. Do not acknowledge durable work until its transaction commits.
- Atomically insert the receipt and set `needs_refresh=true` with incremented
  `refresh_version` on the bound attempt. A duplicate receipt is a no-op. If the
  stored session is not yet bound because its create response is still in flight,
  retain an unresolved receipt for a bounded worker to retry local lookup. Never
  acknowledge-and-forget that race or bind an unknown provider transaction.
- Session events can locate a persisted remote ID; allow the signed
  `restaurant_attempt` metadata only as a lookup hint. Check both where present.
  Charge/payment-intent metadata is likewise only a hint. Unknown/unrelated
  objects must never create an order or attempt.
- Acknowledge quickly after durable enqueueing; do not perform Stripe calls in
  the HTTP webhook transaction. Reuse the worker's bounded refresh lease and
  generation-checked completion. Provider failures/crashes preserve pending work.
- Subscribe only to the event types the existing mapping needs:
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`,
  `payment_intent.succeeded`, `charge.refunded`, and `charge.updated`.
  Card-only creation remains in place; async event handling is defensive.
- Different events for the same object are still safe because settlement is
  idempotent and fetches current provider state. Never deduplicate permanently on
  `(object_id, event_type)` for update events: later distinct updates can matter.
  Never use event creation timestamps to order events or overwrite paid/refunded
  state from an old payload.

### 3. Restricted-key resource and endpoint plan

Initial checkout-only pilot uses these code paths:

| Operation | Endpoint | Proposed restricted permission |
| --- | --- | --- |
| Create hosted checkout | `POST /v1/checkout/sessions` | Checkout Sessions: Write, which includes Read |
| Authoritative lookup | `GET /v1/checkout/sessions/{id}?expand[]=payment_intent.latest_charge` | Checkout Sessions: Read; Payment Intents and Charges: Read for expanded objects |
| Verify webhook | Local HMAC only | No Stripe API permission; separate endpoint signing secret |

The resource selection for expanded objects and inline `price_data.product_data`
is an implementation-derived starting set, **not confirmed sandbox acceptance**.
Stripe's documentation says to map called resources and verify missing-permission
errors in request logs. Confirm exact required permissions with synthetic requests
after authorization; do not respond to a failure by granting all access. Do not
add Products/Prices or other permissions speculatively.

Existing automatic-refund code also uses `POST /v1/refunds`,
`GET /v1/refunds/{id}`, and PaymentIntent/charge reads. Keep refund dispatch out of
the initial pilot; no refund Write, payouts, transfers, Connect, account settings,
customer-list access, webhook administration, or key-management permissions are
needed for hosted-checkout creation plus verification. If refund testing is later
requested, review its exact scope, permission, and authorization separately.

Hosted redirect Checkout needs no publishable key in this integration. An API key
and a webhook signing secret are different credentials. Secure user-side entry is
required before any persistent credential configuration; no real secrets are
needed for the tests in this increment.

### 4. Acceptance before enabling a sandbox pilot

- Actual HTTP rejects unsigned, tampered, malformed, stale/future, live-mode,
  wrong-secret, and foreign-account deliveries with zero queue/provider effects.
- PostgreSQL concurrency/restart tests prove one receipt/refresh generation for a
  duplicate event; unresolved-before-create and lost-ack races survive restart.
- Freshly signed redelivery of an old event, distinct out-of-order events, paid
  then expired, refund then completed, and provider outage remain safe.
- Repeated clicks/concurrent starts/restart after lost create reply never create
  another attempt. Expiry and complete request bytes stay unchanged. Recovery
  never uses an unknown remote ID or makes another create call.
- Exact amount, SAR currency, reference, session/charge identity, test mode,
  captured amount, refunds, and disputes remain required for settlement. Browser
  return with forged success parameters never marks paid.
- Provider disabled, missing secret, wrong prefix, wrong catalogue/order mode,
  insufficient restricted permission, and malformed hosted URL all fail closed.
- Run Go race/integration suite, vet, build, client/control payment-contract
  regressions, and independent review on the final patch. Only then run an
  explicitly authorized dedicated-sandbox checkout with synthetic identity and
  Stripe's documented test payment details, including success/decline/3DS.

## Official references

Checked 10 October 2026; product configuration and permissions still require
account-specific verification at the later secure setup step.

- [Create Checkout Session](https://docs.stripe.com/api/checkout/sessions/create)
- [Retrieve Checkout Session](https://docs.stripe.com/api/checkout/sessions/retrieve)
- [Stripe idempotency](https://docs.stripe.com/api/idempotent_requests)
- [Webhook signatures, retries, duplicates, and ordering](https://docs.stripe.com/webhooks)
- [API keys and sandbox separation](https://docs.stripe.com/keys)
- [Restricted-key permissions](https://docs.stripe.com/keys/restricted-api-keys)

## Verification record

- Full `go test -race ./... -count=1`: 288 top-level tests passed, zero failed,
  12 existing opt-in tests skipped, using a newly initialized, named disposable
  PostgreSQL 17 database on loopback. No application database URL was used.
- Final Stripe-focused race run: all six top-level tests passed, including
  committed timestamp equality, restart/uncertainty fencing, and an actual
  order-lock wait observed through the exact blocker PID. The latter test was
  strengthened after the broad run began and revalidated against a second fresh
  fixture; production-source bytes were unchanged during the broad run.
- `go vet ./...`, `go build ./...`, and `git diff --check` passed.
- Independent review found no remaining blocking issue. Owned temporary
  PostgreSQL servers were stopped after verification.
- Skipped gates were the existing Node/Dart bridge opt-ins, intelligent-UI
  experiment, actual key/recovery/main-runtime tests, media recovery, and actual
  runtime secret-file test. Client/control browser and external-provider
  acceptance were not run for this source-only increment.

No external Stripe request, connected-account acceptance, live activation, or
browser payment acceptance is claimed. Signed HTTP routing and durable webhook
deduplication remain the next implementation gates.
