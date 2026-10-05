# Initial staff operations on the original core

The persistent control plane now exposes an initial `/manage` browser view and
same-origin staff order APIs. These are separate from customer MCP/OAuth access.
Each request rechecks the enabled identity, current restaurant membership,
granular permission and tenant lifecycle before signing one bounded operation.
No restaurant master key is sent to the control plane, browser or model.

- Read latest 100 order summaries: `orders:read`.
- Change status through the original state machine: `orders:update`.
- Record cash collection through the original payment rules: `payments:collect`.
- Mutations require browser CSRF and the current order version. Stale/repeated
  requests are not silently applied and ambiguous network writes are not retried.
- Signed tenant service scopes are prefixed `staff:`. A customer `orders:read`
  signature cannot access the staff surface. Signatures bind tenant, actor,
  method, path, body and short expiry exactly as on owned customer operations.
- Each actual mutation writes a staff actor/scope audit row in the same original
  database transaction as the order and outbox. Audit failure rolls everything
  back; no private contact data or receipt capability is included in summaries.

Staff actors are recorded using the existing issuer/tenant/subject-derived
pseudonymous identifier. This is correlation, not anonymous data. Existing
orders remain operable during suspension; disabled memberships are rejected on
their next request. Already-authorized in-flight operations may finish. This is
not a distributed instantaneous revocation protocol.

The first browser view includes summaries, kitchen-facing details, status and cash.
Staff detail is a separate `orders:read` service route: historical line items,
options, quantities, prices, table name and fulfilment notes are preserved.
Structured customer contact/address fields, receipt access codes and payment
capabilities are excluded. Free-text fulfilment notes may themselves contain
customer-provided information; they are staff-only, escaped in HTML and never
added to the customer MCP status result. Existing Unicode notes are supported.
The detail response is explicitly bounded at 2 MB to cover the original core's
50-line/option limits; other signed response limits remain smaller.

It does not replace the complete React management app or claim Flutter parity.
Delivery/contact workflows, menu/brand/stock/settings, refunds, full channel
account management, audit UI, pagination and native staff login still require
integration. New-order channel policy has its separate `CORE-CHANNELS.md` guide.
Existing original interfaces and their authorization remain unchanged.

Tests cover customer-token exclusion, foreign membership, kitchen cash denial,
membership revocation, suspended-tenant settlement, stale versions, redaction,
scope isolation and audit-failure rollback. Browser payment navigation is a
separate active CI investigation; do not infer its acceptance from staff HTTP
tests. Browser payment/OAuth acceptance passed in run 37289872901; current detail
navigation has its own regression. No real staff accounts, merchant credentials
or production were changed.
