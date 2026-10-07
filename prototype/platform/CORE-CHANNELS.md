# Original-core order channel policy

The original restaurant now owns a versioned `newOrdersEnabled` policy for
`web`, `chatgpt`, `whatsapp_qr` and `whatsapp_cloud`. This is a new-order gate,
not an account/session disconnect switch. It does not stop calls, log WhatsApp
out, remove data, cancel existing orders or stop financial reconciliation.

## Authority and transaction boundary

- The native storefront always selects `web` in trusted server code. Signed
  platform creation selects `chatgpt`. Browser/model input cannot select a source.
- The existing create transaction first recovers an owned durable submission.
  Only a genuinely new order locks its channel policy `FOR SHARE`, after the
  catalog/idempotency recheck and before pricing, stock reservation and insertion.
- A policy update needs the current version and takes the conflicting row lock.
  When disabling returns, new transactions cannot use a stale enabled snapshot.
  Already accepted requests keep their original receipt and price snapshot.
- Configuration and its actor audit commit together. A failed audit rolls back
  the policy change. Order stock/price/state rules remain in the original core.
- New order documents carry trusted channel provenance. Existing documents are
  not rewritten or assigned fabricated historical sources.

Fresh policies preserve existing web/platform behavior: web and ChatGPT are
enabled by policy; WhatsApp shopping policies start disabled. ChatGPT still
requires the explicitly configured signed service and persistent identity flow.
An enabled flag is not evidence of deployment, an open restaurant, subscription
entitlement or a connected account. Global catalog and tenant lifecycle checks
still apply.

WhatsApp shopping adapters are not implemented yet. Their policy views explicitly
report `adapterImplemented: false`, and attempted order creation is rejected
even if an administrator saves an enabled intent. Existing WhatsApp calling and
messaging functionality is unchanged. This avoids mistaking connection readiness
for a working shopping adapter.

## Management paths

The native master-authenticated API adds `GET /api/restaurant/order-channels`
and `PUT /api/restaurant/order-channels/{channel}`. The persistent staff API and
`/manage/{tenant}/channels` page recheck `channels:manage`, enforce CSRF and use
separate signed `staff:channels:manage` requests. Kitchen/customer OAuth access
is rejected. Suspended tenants cannot enable new channel work; existing order
read/update/settlement stays available through the original staff paths.

Updates require an explicit boolean and `expectedVersion`. The interface shows
operational adapters separately and offers form controls only for implemented
web/ChatGPT order paths. It does not replace full original channel administration.

## Expiry and evidence

An unresolved checkout dispatch may recover an accepted original order after
its handoff expires, but must never send a fresh create request after expiry.
This also covers a channel-disabled attempt when the channel is enabled later.

Local tests cover independent channels, unchanged stock on rejection, accepted
retries and settlement, stale versions, missing/forged input, actor audit rollback
and real PostgreSQL lock contention. Cross-language HTTP tests cover staff scope,
browser ownership and expired retry after reopening. Chromium CI adds form
disable/enable round trips. These are synthetic isolated tests, not live-account
or production acceptance. No database cleanup or outbox retention is automatic.

The native Windows client now offers the same versioned new-order policy controls
under `channels:manage`, with explicit confirmation and unsupported-adapter labels.
It does not expose WhatsApp account/device login controls or change existing calls.
Suspended restaurant permissions continue to allow existing-order settlement,
matching the authoritative identity directory; channel/inventory edits remain denied.

A private confirmed-review dispatcher now has a narrow internal exception to the
WhatsApp new-order rejection, with a nil-by-default transaction-scoped authority
callback and current channel-policy version binding. There is no public permit
field, route or connected transport; ordinary direct WhatsApp creation remains
unavailable, and `adapterImplemented` stays false. This preparation does not
activate account messaging or change existing calls. The original core still
owns all money, stock and idempotency rules. Hosted dispatch acceptance is pending;
see `WHATSAPP-CONVERSATION-DESIGN.md`.
