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

The first browser view is intentionally limited to summaries, status and cash.
It does not replace the complete React management app or claim Flutter parity.
Item details, delivery assignments, menu/brand/stock/settings, refunds, channel
management, audit UI, pagination and native staff login still require integration.
Existing original interfaces and their authorization remain unchanged.

Tests cover customer-token exclusion, foreign membership, kitchen cash denial,
membership revocation, suspended-tenant settlement, stale versions, redaction,
scope isolation and audit-failure rollback. Browser payment navigation is a
separate active CI investigation; do not infer its acceptance from staff HTTP
tests. No real staff accounts, merchant credentials or production were changed.
