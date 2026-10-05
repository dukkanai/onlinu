# Reviewed management of existing refund intents

Status: implementation in progress. The financial snapshot is already verified at
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

Browser and Flutter review forms are the next increment. The current visible
financial views remain read-only until that increment is independently tested.
Remote CI for this backend checkpoint must be recorded separately; previous
commit results do not cover these changes.
