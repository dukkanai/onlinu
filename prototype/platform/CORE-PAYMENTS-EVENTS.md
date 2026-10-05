# Original-core payment and event integration

## Payment path

The checkout page selects from the restaurant's configured public providers.
After a card order is confirmed, a separate CSRF-protected customer action starts
the provider handoff. The signed service uses distinct `payments:read` and
`payments:write` scopes and reuses the original payment engine, its single-attempt
record, callback verification, idempotency and reconciliation. Browser return
content or invoice creation never establishes payment success.

The browser is redirected only to a provider-bound HTTPS allowlist, also enforced
by the original core. Unknown/review outcomes do not trigger a second invoice.
Refresh independently retrieves provider status through the original engine.
No payment initiation is exposed as an MCP tool.

Redirect providers are supported in this central UI. Embedded HyperPay widget
handling remains on the original interface and needs a separately tested central
UI path. Real merchant/provider account acceptance is still outstanding.

## Durable original-core events

Original order changes write a minimal outbox event in the same transaction.
Only platform-owned orders enter this outbox. A transactional per-owner counter
preserves cursor ordering through rollback and avoids leaking other customers'
activity. Signed reads are restricted to that owner; no contact or receipt
capabilities are returned.

The central worker saves delivery before advancing the durable cursor; replay
after a crash deduplicates by stable event ID. It rotates fairly through owners,
uses bounded concurrent reads and retains the existing HTTPS callback signature,
SSRF, ownership, revocation and retry protections. No event from before a new
subscription is replayed. Clients read current order status when subscribing.

Core statuses include cancellation, delivery, unpaid/review/refunded outcomes;
they are not forced into the simplified prototype's state machine. OAuth grant
expiry/revocation and disabled identities stop callbacks. Revocation without a
refresh-token family is covered as well. Already-started delivery can finish
before the subscription cancellation transaction obtains its lock, consistent
with the documented at-least-once contract.

## Runtime entry point

`npm run start:core` starts `control-server.mjs`; ordinary `npm start` still starts
the explicitly synthetic prototype. `Dockerfile.control` packages only runtime
modules. The default listener is loopback; an approved TLS reverse proxy must
preserve the configured Host. No DNS/firewall or live deployment was changed.

Required configuration: `CORE_PUBLIC_BASE_URL` (HTTPS origin),
`CORE_RESTAURANTS_FILE` (deployment-owned JSON registry), `DATABASE_URL`,
`CSRF_KEY`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`.
Owned orders additionally require `SERVICE_SIGNING_KEY`; callbacks additionally
require `EVENTS_ENCRYPTION_KEY`. Customer OAuth redirects use an explicit
`OAUTH_REDIRECT_URIS` allowlist. Secret settings accept `_FILE` paths; simultaneous
direct/file values fail closed. Keep all real secret files outside Git/images.
Do not create/configure real persistent access without the required approval.

Workers start only through the executable/service lifecycle, not module imports.
Shutdown stops HTTP and workers; pending deliveries and outbox cursors remain
durable. Keys, database credentials and raw errors are not printed at startup.

## Evidence and limits

Cross-language tests use actual Node signatures, original Go HTTP, PostgreSQL,
MCP and owned checkout, with an injected provider adapter and callback transport.
They verify one invoice initiation on retry, independently retrieved settlement,
owner-only source events, callback signatures, failed-cursor-save recovery and
OAuth revocation. No real payment, WhatsApp account or ChatGPT callback endpoint
was contacted. Source-level Docker packaging is not a completed image build.

Production acceptance still requires actual provider/account flows, image/host
tests, operational limits and retention policy, full staff/Flutter parity,
licensing gates and approved deployment. No automatic outbox deletion is enabled.
