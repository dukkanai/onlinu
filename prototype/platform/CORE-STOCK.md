# Staff inventory bridge

The persistent staff interface reads and recounts the original restaurant stock
ledger; it does not maintain a competing central quantity. `stock:read` and
`stock:update` are checked against current identity/membership for every request.
Customer OAuth grants cannot use these routes. Signed tenant service scopes are
separate `staff:stock:read` and `staff:stock:update` values.

`GET /api/restaurants/{tenant}/staff/stock` and
`POST /api/restaurants/{tenant}/staff/stock/{itemId}` expose bounded, validated
results. The `/manage/{tenant}/stock` page uses same-origin browser CSRF, explicit
tracking choice, non-negative quantities and the current version. Read-only staff
get no edit forms. Suspended tenants cannot manage new stock through this surface.

## Accounting semantics

- Available means sellable quantity **outside** existing reservations and sales.
  A physical recount does not overwrite held quantities.
- Untracked is not zero stock. Version-zero/untracked rows are shown explicitly
  as not configured, not as a claim that the restaurant has no portions.
- Original locking, optimistic versions, catalogue existence and accounting-mode
  restrictions remain authoritative. Stale writes or unsafe mode changes fail.
- A stock write is never retried automatically after an ambiguous response.
  Reload the actual ledger/version before deciding on another recount.

## Audit and migration

Two additive fields on `restaurant_stock_events` attribute new recounts:
`actor_id` and `actor_scope`. The signed actor is the existing tenant/issuer/subject
pseudonym; native master-key recounts use `local-admin` rather than inventing an
individual identity. Prior events retain empty attribution fields. No historical
quantities, orders or identities are rewritten.

The stock update and attributed recount event use the same database transaction.
Failure to write the event rolls back the recount. Automated stock movements keep
their existing order/event correlation. This does not claim a complete audit UI.

## Verification limits

Isolated PostgreSQL tests cover active-hold preservation, failed-audit rollback,
and adding the fields to an existing pre-change event table without changing its
history. Cross-language tests cover read-only kitchen access, denied writes,
rejection of caller-provided holds, stale versions and untracked response parsing.
Chromium CI exercises the actual recount form and verifies holds are unchanged.
No live stock, merchant credentials or production databases were modified.

Native Flutter now consumes the same stock API with its own staff bearer.
Stock responses include an optional `name` from the current original catalogue,
including unconfigured items and recount responses. This is an additive display
field, not another inventory database, and stock-only staff need no menu scope.
The native form preserves holds, validates integer quantities/versions, makes
untracked explicit and does not replay uncertain writes. See the Flutter README
for local versus actual Windows verification evidence.
