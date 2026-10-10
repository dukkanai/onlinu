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

## Current signed-webhook wiring increment

This working-tree increment is **locally verified source-only preparation**;
exact-commit CI and connected acceptance remain separate gates. Parent-side account
setup is a separate workflow; it does not prove this source has been deployed or exercised against a
connected sandbox. No account identity or credential is hardcoded into source.

### Closed configuration and transport

- Stripe is available for new checkout only with explicit sandbox opt-in,
  enabled configuration, test mode, a syntactically valid restricted/secret test
  key, a separate encrypted endpoint signing secret, US account identity, and a
  server-generated immutable endpoint/account generation. Legacy/incomplete
  configurations cannot start new Stripe attempts.
- The account, country, endpoint signing secret, and API/event version are frozen
  once the generation is created. Endpoint/account replacement and secret
  rotation require a separately reviewed migration; no fallback to unsigned
  notifications or guessing an account is permitted. Key rotation leaves old
  attempt snapshots unchanged. Disabling checkout keeps signed notifications
  available for existing attempts while the complete endpoint config remains.
- Pin requests and snapshot events to `2026-09-30.endive`, the stable version
  reported by Stripe's official versioning documentation on 10 October 2026.
  Before each create/fetch, query `/v1/account` with the snapshotted test key and
  require the exact configured account ID and US country. This additional
  read permission needs later restricted-key acceptance; no permission has
  been granted or inferred by these source changes.
- Request `allowed_payment_method_types[0]=card`, the documented dynamic
  eligible-method filter. Do not send the legacy static `payment_method_types`
  parameter. The initially proposed mandatory payment-method configuration was
  removed after primary documentation established this narrower, non-mutating
  filter. Both create and fetch require returned methods to be exactly `card`.
  A broader/missing list never exposes a Checkout URL or settles payment.
- Persist a server-generated `integration_identifier` with each new attempt:
  `onlinu_sandbox_` followed by eight random lowercase letters. Send that same
  identifier with the immutable creation timestamp/idempotency key. Old attempts
  are not backfilled or re-created. No automatic create retry was introduced.
- Existing integer SAR totals/reference/currency, explicit test session/intent/
  charge mode, successful captured charge, amount, refunds, and dispute checks
  remain required. A rejected or uncertain create preserves the unique attempt
  and review state, so another Start cannot create a replacement session.
- Automatic Stripe refund dispatch and its shared advertised capability are
  disabled for this checkout-only pilot. Existing bookkeeping/manual review
  stays intact. Paylink and courier behavior are outside this increment.

### Signed HTTP route and durable bounded inbox

- `POST /payment-hooks/stripe` reads at most 256 KiB exactly once. Verify the
  raw-body HMAC, canonical signature timestamp, five-minute past/future tolerance,
  explicit test snapshot envelope/object, supported object type, and exact API
  version before routing. Reject Connect/organization context. Configuration
  loading is the only database read needed before signature verification.
- `POST /payment-hooks/stripe/{attempt}` fails closed unconditionally. Browser
  return remains status-free; authorized order refresh remains available.
- A transaction stores one receipt per `(generation,event_id)` plus its account,
  event/object IDs, optional attempt hint, SHA-256 body hash, timestamps, and
  processing state. It stores no raw payload or customer details. Duplicate
  receipt IDs with identical bytes are no-ops, including freshly signed replay;
  a changed body under the same ID is rejected.
- Receipt insertion and `needs_refresh=true`/`refresh_version+1` commit atomically.
  HTTP performs no provider calls and acknowledges only after commit. Local
  processing has a three-second deadline; ordinary hook transport rate limits
  and concurrency limits still apply.
- Checkout Session events route only to the persisted created session ID; signed
  metadata is a conflict-detecting hint. A webhook arriving before create returns
  remains unresolved until the actual create result establishes the binding.
  Unknown session IDs never become attempt remote IDs.
- PaymentIntent/charge events require object identities previously learned from
  authoritative retrieval of the persisted Checkout Session. Metadata alone
  never schedules a guessed attempt. A charge is frozen only after successful
  capture, so a declined charge does not block a later successful card retry.
  Immutable identity conflicts force review, including known partial refunds.
- The local resolver claims at most 32 due receipts per transaction with row
  locking, retries unresolved lookup after 30 seconds, and backs off to hourly
  after one hour. Transaction aborts retain all work. Cross-batch attempt-lock
  contention can still cause a rollback and later retry.
- Never delete unresolved receipts. This increment retains completed/rejected
  tombstones too: admission caps each generation at 100,000 receipts and 1,024
  unresolved receipts. At capacity, duplicates remain acknowledgeable; new
  events receive retryable 503 rather than silent acknowledgement. Explicit
  archival/rotation is a future operational gate. Admin summary exposes unresolved,
  rejected, and remaining-capacity counts without payloads.
- Reuse the existing durable refresh lease and generation-checked completion.
  Reload the attempt after claiming the lease so a stale pre-create snapshot
  cannot clear newer bound work. Provider outage, restart, new events during
  retrieval, and out-of-order payloads cannot silently erase pending refresh.
  Settlement always reads current provider state; event timestamps/statuses
  never drive payment transitions.

### External-key maintenance and downgrade boundary

The external-v1 envelope format, original data keys, encrypted attempt snapshots,
and persisted credential bytes are unchanged. The new attempt columns require a
narrow schema-recognition update for offline key migration, rotation, and
verification: recognize the exact historical shape or the exact complete reviewed
Stripe suffix, with its original order, text types, NOT NULL flags, and empty-text
defaults. Partial/interrupted additions, reordered/unknown columns, wrong types,
or changed/missing defaults fail closed. Rejection must not regenerate keys,
rewrite ciphertext, or repair the schema automatically.

An older maintenance binary recognizes only the historical attempt shape and will
refuse the upgraded shape. Do not treat an older application binary as a safe
rollback: it may omit the signed-inbox and sandbox gates even if it can read the
same external-v1 envelopes. A downgrade needs a separately reviewed offline plan
that preserves pending receipts, original attempt snapshots, and retained keys.
Do not delete the new columns, receipts, key state, or fences to force a downgrade.
No actual key maintenance or deployment is part of this source increment.

### Remaining gates before any connected pilot

1. Complete exact-commit CI, including the dedicated external-key actual-runtime,
   historical/current archive recovery, and media recovery fixtures. Local
   source-only tests and independent reviews are recorded below.
2. Securely provision the separately approved sandbox key and own-account snapshot
   endpoint signing secret, pin the endpoint to the same version, and verify
   minimal read/write permissions (including the account identity read).
3. Verify account-specific SAR Checkout support and the card-only returned method
   list using synthetic identity only. Execute documented success, decline,
   retry-after-decline, 3DS, expired session, provider failure, duplicate/reordered
   webhook, and refund-observation scenarios after explicit authorization.
4. Verify the actual administrator/customer UI and public webhook deployment.
   No source-only test proves public HTTPS, delivery, restricted-key permission,
   merchant eligibility, live activation, refund dispatch, or production readiness.

## Historical baseline before signed wiring (`96b6d9c`)

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
- At that baseline, the account webhook accepted unsigned JSON only as a lookup/refresh
  hint. It cannot mark an order paid from the event payload. Its real weakness is
  unauthenticated refresh/queue triggering and missing event-ID deduplication,
  not a demonstrated forged-payment exploit.

## First source increment (commit `96b6d9c`)

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

## Original wiring checklist (implementation status summarized above)

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
| Verify account identity | `GET /v1/account` | Account identity read; exact restricted-key resource permission still needs sandbox acceptance |
| Create hosted checkout | `POST /v1/checkout/sessions` | Checkout Sessions: Write, which includes Read |
| Authoritative lookup | `GET /v1/checkout/sessions/{id}?expand[]=payment_intent.latest_charge` | Checkout Sessions: Read; Payment Intents and Charges: Read for expanded objects |
| Verify webhook | Local HMAC only | No Stripe API permission; separate endpoint signing secret |

The resource selection for expanded objects and inline `price_data.product_data`
is an implementation-derived starting set, **not confirmed sandbox acceptance**.
Stripe's documentation says to map called resources and verify missing-permission
errors in request logs. Confirm exact required permissions with synthetic requests
after authorization; do not respond to a failure by granting all access. Do not
add Products/Prices or other permissions speculatively.

Pre-existing refund adapters contain `POST /v1/refunds`,
`GET /v1/refunds/{id}`, and PaymentIntent/charge reads. Stripe automatic refund
dispatch is now disabled, including its advertised capability; no refund Write, payouts, transfers, Connect, account settings,
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

## Historical first-increment verification record

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
browser payment acceptance is claimed. The current wiring increment has a separate verification record and must not
inherit these historical pass results.

## Current wiring verification record

Final local verification on 10 October 2026:

- Full `go test -race ./... -count=1`: **310 top-level tests passed, zero failed,
  12 existing opt-in tests skipped**, against a newly initialized PostgreSQL 17
  cluster and the named loopback `astracalls_restaurant_test` database. This
  includes all 12 signed-inbox integration tests and both new strict-schema
  tests, with all PostgreSQL schema variants executed.
- `go vet ./...`, `go build ./...`, and `git diff --check` passed. Go production
  source hashes stayed unchanged throughout the final run. Compiler concurrency
  was bounded to two processors and one package build at a time.
- Client tests: **121 passed, zero failed or skipped**; `npm run build` passed.
  The test CLI initially hit a sandbox IPC restriction; the supported direct
  Node loader (`node --import tsx --test --test-concurrency=1 tests/*.test.ts`)
  then executed the whole suite without elevated access.
- Combined platform checkout/adapter/auth/identity/native/staff tests: **259
  passed, zero failed or skipped**, against two freshly initialized, named
  PostgreSQL fixture databases with one Node worker. This includes four actual
  HTTP + PostgreSQL delayed-body profile/menu cases proving original-family
  revocation blocks dispatch even with another active family, and revoking only
  the other family preserves the original request. Earlier handler-level SQL
  doubles and the prior 254-test aggregate are separate evidence, not substitutes
  for those four actual database/HTTP cases.
- Independent source review found no remaining blockers after fixes for the
  unsigned legacy route, stale refresh snapshot, declined-charge identity, and
  partial-refund identity-conflict edges. A separate final compatibility review
  approved exact historical/new key-schema recognition and rejection tests.
  Owned fixture PostgreSQL servers stopped cleanly after both final suites.

Failed and interrupted runs remain part of the record:

- Concurrent clean Go builds initially stalled the executor and were canceled;
  interrupted runs are not passes.
- First full attempt: **286 passed, 22 failed, 12 skipped**. Twenty failures were
  the deliberate synthetic-password fixture guard; the other two exposed a
  mixed-provider fixture setup omission and a syntactically invalid foreign
  account test value. The fixture setup was corrected without weakening guards.
- Second full attempt: **296 passed, 12 failed, 12 skipped**. It exposed the real
  external-key schema-recognition incompatibility introduced by the new columns,
  plus the intentional missing-table fixture's new inbox foreign-key dependency.
  The narrow reviewed compatibility fix and expanded adversarial tests preceded
  the final 310-pass run. No automatic key regeneration or schema repair was added.

The 12 locally skipped gates are the existing Node/Dart bridge opt-ins,
intelligent-UI experiment, actual key/recovery/main-runtime tests, media recovery,
and actual runtime secret-file test. The unchanged CI workflow separately enables
`TEST_RUNTIME_MAIN=1`, executes `^TestRestaurant(Key|CryptoActualMainRuntime)`,
and runs `^TestRestaurantKeyRecovery` with explicit recovery opt-in in two owned
clusters. The latter selector includes historical/current key archive and media
recovery. Those gates must pass on the eventual published commit; historical CI
results do not cover this working tree. No CI changes were made here.

Dependency-security acceptance remains separate: a test/build pass is not a
vulnerability scan, and the repository dependency-alert query was unavailable.
No connected Stripe request, real secret provisioning, public webhook delivery,
actual payment acceptance, deployment, or production readiness is claimed.

Additional primary references for the wiring contract:
- [Stripe API versioning](https://docs.stripe.com/api/versioning)
- [Checkout creation, dynamic method filter, and integration identifier](https://docs.stripe.com/api/checkout/sessions/create)
- [Accounts API](https://docs.stripe.com/api/accounts)
