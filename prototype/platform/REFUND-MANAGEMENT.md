# Reviewed management of existing refund intents

Status: backend `3662cae` verified by all jobs in CI37383212394; UI remote acceptance pending. The financial snapshot is already verified at
`35eb297`; this increment is separate and is not production or provider acceptance.

## Scope

Add narrowly signed manager detail/commands for existing original-core refund IDs:
explicit authorization of a cancellation-created intent, reporting an already
performed manual refund, verifying an existing provider reference, and read-only
provider reconciliation. Creating a new refund intent remains in the original
administration interface in this increment. No second money engine or automatic
retry of a provider POST is introduced.

## Boundaries

- Current `orders:read`, `payments:read` and `refunds:manage` grants are required.
- Every command binds the reviewed refund ID/version, amount, currency, provider
  and test/live order flag. The existing engine retains row locks, captured-fund
  checks, status transitions, provider-reference uniqueness and at-most-once
  dispatch. Original refund amount/currency/provider are immutable.
- Cancellation never becomes automatic payout authority. Authorization is an
  explicit financial confirmation; the durable original worker sends the intent.
- Manual reporting records an operator assertion, not provider-confirmed success.
  Verifying a reference and refreshing use the provider's read API, not a new payout.
- Actor attribution is stored in the same transaction as each refund ledger
  mutation. Audit failure rolls the mutation back. Legacy administration remains
  intact; worker events retain their existing original ledger history.
- A lost command reply is recovered by reading the same existing refund ID. No
  blind POST retry, automatic new intent, or replacement provider request is allowed.
- Manager detail can show operational reason/reference fields, but never provider
  credentials, receipt capabilities or customer contact data. Public financial
  summaries continue to omit these private manager fields.
- Real merchant/provider credentials, real money and production rollout remain
  separate approvals and acceptance gates. All implementation tests use synthetic
  identities, disposable databases and mocked provider adapters.

## Backend checkpoint

The narrow original-core routes and shared browser/native staff API are
implemented. Reads require all three grants too; a payment-only reader cannot
retrieve private operational reasons/references. Writes recheck grants after
reading the bounded request body. Signed envelopes bind the exact action and
review tuple; omitted provider/test flags are rejected, including an explicitly
empty cash-provider value. Replies are validated against the same order/refund
identity and immutable money/provider/test tuple. No transport retries a POST.

The additive `platform_staff_refund_audit` table attributes ledger mutations in
the same SQL transaction. Existing legacy/worker flows continue using their
original events. Authorize/manual/verify use the original engine's version and
state rules; refreshing is read-only provider reconciliation and may reconcile
newer state rather than treating a prior review version as a new payment request.

Synthetic PostgreSQL tests cover signed routes, wrong scopes, Cookie/Origin
replay rejection, omitted/mismatched review facts, stale versions, idempotent
existing-intent recovery, audit-failure rollback, manual-not-confirmed accounting
and private-field separation. An actual Node-to-Go test exercises signing,
authorization and recovery without dispatching a provider payout.

Backend checkpoint `3662cae` passed all CI37383212394 jobs. Browser and Flutter
review forms are the following increment described below and need their own
remote acceptance; the backend checkpoint alone does not verify those forms.

## Reviewed browser/native UI increment

The financial summary links to manager-only existing-refund details. Native
Windows forms explicitly display tenant, order, refund ID/version, amount,
provider and demo/live warning before a separate review and checked confirmation.
Manual/reference verification requires the reference and explanation. Busy,
stale, revoked, dismissed and backgrounded views cannot submit or resurrect a
private late response. Unknown replies read the same ID and never retry the POST.

The central browser has CSRF-protected `/review` and `/execute` stages. Review
performs no mutation; unchecked execution and mismatched money are rejected.
Successful/unknown writes use 303 redirects to a GET of the existing ID, avoiding
POST resubmission on page refresh. Browser/native reads require all three grants.

Local validation includes 115 Flutter tests, actual Dart TLS/PKCE through Node
and original Go, actual browser-session HTTP/CSRF routes, and original refund
regressions. Actual Chromium review/cancellation and Windows rendering/build are
remote CI acceptance checks and must be recorded against the new UI commit.
New intent creation, real provider acceptance and deployment remain out of scope.
