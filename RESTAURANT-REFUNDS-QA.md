# Refund completion implementation (development, 2026-09-27)

No real provider calls, merchant credentials, production data, or portable release
artifacts were used by this implementation's tests.

## Supported scope

- Durable full/partial refund intents, per-order row serialization, UUID request
  idempotency with payload matching before optimistic version checks, and gross
  amount reservations that include pending, uncertain and manually reported
  amounts. Only failed authoritative refunds release their reservation.
- Verified captured payment metadata is persisted independently from fulfilment.
  Existing orders are not retroactively assumed verified and require an
  authenticated payment lookup before refund authority is established.
- Cancellation creates an intent only. It does not authorize a financial POST.
  An administrator explicitly authorizes a cancellation intent using execute.
  Administrative creation is itself explicit authorization, with a UI warning.
- Stripe, Tap, PayTabs and MyFatoorah: documented create/query adapters. Every
  dispatch first rechecks the original amount, currency, merchant reference,
  mode and known refunded balance. Unknown partial/external/refund/dispute state
  blocks dispatch for review. POST responses never establish success; an
  independent authenticated query does.
- Moyasar, HyperPay and Geidea: automatic refund initiation remains unsupported
  and is exposed as manual-review capability. Do not infer support from their
  charge/hosted-checkout integration. HyperPay remains test-only for payments.
- Manual reports require a reference and explanation and are labelled
  `manual_reported`, never provider-confirmed. They retain the amount reservation
  and never mark the order payment refunded. Manual reporting is blocked after
  an ambiguous financial POST to avoid encouraging duplicate reimbursement.
- Original order prices, payment gross, inclusive tax and tax registration
  snapshots stay unchanged. Refund adjustments allocate original inclusive tax
  cumulatively with integer rounding. They are **not certified ZATCA credit notes**.
- A successfully confirmed partial refund leaves the original payment paid for
  the agreed remainder; a fully confirmed ledger total marks payment refunded.
  Cancellation remains cancelled regardless of delayed payment/refund results.
- Public ledger access requires the existing receipt token/customer ownership.
  Operator reasons, external manual references, request keys and dispatch flags
  are omitted from the customer response.

## Failure and operational boundaries

- A claim is committed before dispatch. No financial POST is automatically
  retried, even when the provider has idempotency. A process crash or unknown
  transport result without a remote ID goes to review and stays reserved.
- A provable read-only preflight failure is distinguished from an ambiguous
  financial POST. It stays reserved but unsubmitted and requires explicit
  administrator reauthorization after the issue is fixed; it is never retried
  automatically. Unsupported/manual gateways allow audited partial reports.
- Refund reconciliation can query known remote IDs only. An unknown remote ID
  after a crash requires operator/provider investigation. The administrator can
  attach an existing dashboard refund reference using `verify-reference`; an
  authenticated lookup verifies payment, amount, currency and request bindings
  before recording it. A unique per-order reference prevents double counting.
  This never sends money. It must not be replaced by a new refund request or a
  blanket "retry" action. The front-end retry of an
  unknown *local create request* retains its original UUID/body and is distinct
  from retrying a provider POST.
- The original encrypted payment credential snapshot is used for the original
  merchant account. Current provider enablement/mode is also checked before a
  mutation. Provider settlement/bank credit time is not promised.
- PayTabs cart queries cannot discover out-of-band refunds created with a
  different cart ID; such workflows require provider investigation and must not
  be advertised as complete external reconciliation. Provider-side amount caps
  are a final safety boundary, not a substitute for the local ledger.
- Merchant-specific permissions and real sandbox/live acceptance remain to be
  tested only after the owner configures and approves the selected provider.

## Routes and wiring

Root mounts `registerRestaurantRefundRoutes(pub, admin)` behind existing guards.

- `GET/POST /api/restaurant/orders/{number}/refunds`
- `POST /api/restaurant/orders/{number}/refunds/{id}/execute` `{version}`
- `POST /api/restaurant/orders/{number}/refunds/{id}/refresh` `{}`
- `POST /api/restaurant/orders/{number}/refunds/{id}/manual`
  `{version, reference, reason}`
- `POST /api/restaurant/orders/{number}/refunds/{id}/verify-reference`
  `{version, reference, reason}` (read-only provider recovery, not another refund)
- `GET /storefront-api/orders/{number}/refunds` (private owner/token access)

Create input: `{requestId: UUID, amountMinor, reason, version: orderVersion}`.
Statuses: requested, processing, succeeded, failed, review, manual_reported.
Only `succeeded` with `confirmation: provider` is provider-confirmed.

## Verification

`bash scripts/restaurant-completion-go-test.sh ./cmd/server -run
'TestRestaurantRefund|TestRestaurantPayments|TestRestaurantPayment' -count=1
-timeout=5m` passed using Go 1.26.4, PostgreSQL isolated random schemas and race
detection. Coverage includes concurrent idempotent creation and dispatch,
reservation bounds, immutable tax/payment snapshots, manual distinction,
cancellation authorization, ambiguous transport non-retry, private ledger
authorization, four gateway create/query bindings, and external partial/dispute
preflight refusal. All provider HTTP exchanges use fake transports.

Primary adapter references are listed next to the implementation in
`cmd/server/restaurant_refund_gateways.go`.
