# Existing cancellation and complaint management

Status: next parity increment in progress after verified appearance UI c5446aa.

Expose the original customer-created cancellation/complaint work to restaurant
staff without another order/refund engine. Reads require orders-read. Decisions
require orders-read plus a distinct `support:manage` grant; kitchen/cashier/courier
roles do not gain management authority from their existing order-update rights.
Existing membership rows never expand automatically. New owner/manager presets
include the grant; existing owners use the explicit reviewed permission upgrade.
Suspension may settle existing support work, while closed tenants remain denied.

A bounded queue ordered by original order creation then order number selects pending cancellation requests or open
complaints across original orders, rather than hiding them behind the newest100
normal orders. Queue entries omit reasons/contact details; selected detail exposes
support messages but no receipt capabilities, account IDs or structured contacts.
Original complaint limits and a bounded cancellation-history view are preserved.

Every decision binds order version, support request ID, explicit approval/rejection
and a reviewed explanation. Reuse `DecideCancellation` and `ResolveComplaint`,
including stock and preparation rules and original same-transaction order audit.
Paid cancellation may create an unauthorised refund intent; it does not authorise
or dispatch a payout. The original paid-card cancellation changes the order
payment status to `review`; captured money remains independently recorded in
the refund/payment ledger and must not be relabelled as confirmed refunded. Existing refund management remains a separate confirmation.
No automatic POST retry follows an unknown result; read the existing support/order
state. UI must handle stale versions, revoked grants, duplicate clicks, dismissal
and tenant/logout/lifecycle changes.

No customer message is sent by this development work, no real complaint is
resolved, and no production data/credential/permission is changed. All tests use
synthetic isolated restaurant/customer identities and fake captured funds.

## Backend checkpoint

The original-core queue/detail/decision bridge and shared staff API are implemented.
A partial pending-support index supports the bounded queue; it is additive and
must be reviewed as part of any later production migration/rollout. Local tests
cover101 open orders, queue advancement, explicit rejection/approval, request-ID
and version binding, no automatic payout, audit/refund rollback and privacy.
Current role tests prove that kitchen order-update does not grant support management,
old memberships remain unchanged on initialization, and explicit owner upgrade is
required. Browser/native support forms and their remote acceptance remain pending.

Actual Node-signed original Go queue/decision/resolution now passes locally, along
with220 platform tests, the existing121 Flutter tests, React80/build and Go vet.
This is a backend checkpoint, not native/browser support UI acceptance. The
original `review` payment status on paid-card cancellation was verified rather
than replacing it with a new payment-state rule.
