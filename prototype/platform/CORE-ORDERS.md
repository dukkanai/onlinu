# Owned checkout into the original restaurant

Implemented development flow:

1. Public MCP cart preview uses original pricing without collecting contacts.
2. `prepare_checkout` requires an authenticated customer's `orders:write` grant
   and creates a durable, owner-bound, 15-minute website handoff. No order,
   inventory reservation or payment is created at this step.
3. The website requires that customer's verified browser session and CSRF token.
   Contact/address and payment choice are entered there, not in model arguments.
4. Explicit confirmation calls the original Go order engine using the stored
   cart/total and a stable UUID. Original tax, stock, coverage, payment-availability
   and idempotency rules remain authoritative.
5. MCP status uses `orders:read` and original-core ownership, returning no contact,
   address, receipt capability or payment secret.

## Service boundary

The core exposes `/platform-api/orders`, owned lookup and idempotency recovery
only when all three settings are configured:

- `WACALLS_PLATFORM_ISSUER`: exact HTTPS platform origin, without trailing slash.
- `WACALLS_PLATFORM_TENANT_ID`: this restaurant's fixed ID.
- `WACALLS_PLATFORM_PUBLIC_KEY`: base64 Ed25519 public-key bytes.

The platform's private signing key stays outside Git, images and restaurant
services. The Go core needs only its public key. Do not generate/install a real
deployment key or change live credentials without the required authorization.
Tests generate temporary keys in memory and never contact a real payment provider.

The internal `Platform` authorization envelope is signed over exact payload
bytes and binds issuer, restaurant audience, verified subject, operation scope,
HTTP method/URI, body SHA-256, idempotency key and a maximum 60-second lifetime.
Browser cookies/Origin are rejected on that service boundary. The platform
rechecks live identity and tenant state before new submissions. Already minted
in-flight requests can remain valid for their short lifetime; this is not a
claim of instantaneous service-key revocation.

Platform order ownership is domain-separated from native account UUIDs using
issuer + restaurant + verified subject. It is not linked by names, email or
telephone. Changing the configured issuer/tenant identity needs an explicit
ownership migration plan; do not treat that as a harmless configuration edit.

## Interrupted confirmations

The central checkout table contains cart/quote, ownership and request hashes,
not the submitted contact details. A dispatch marker is committed before the
core call. An ambiguous response leaves it pending recovery; no automatic second
POST is attempted. An explicit retry first reads the original order by the same
owner and stable idempotency UUID. A changed payload cannot replace an unresolved
attempt. Recovery of an already accepted order works after handoff expiry.
Failure to save the final central result remains recoverable from the core.

## Tested boundary

- Go signature tampering/expiry/audience/scope/body/key bindings.
- Owned create, repeat, status and idempotency recovery with actual PostgreSQL.
- Node signature verified by Go with in-memory test keys.
- Actual MCP -> control-plane handoff -> CSRF-protected HTTP confirmation ->
  original Go order -> private MCP status, including foreign-owner rejection
  and duplicate confirmation producing one order.
- Central DB tests for concurrency, expiry, lost replies, failed final saves,
  changed retries, suspension and disabled identities.

`TEST_CORE_ADAPTER=1` plus disposable restaurant and identity database URLs
enables cross-language tests. Node dependencies must be installed first.

## Still incomplete

Owned checkout 996fa81 passed CI run 37282467824. Provider redirect handoff and
durable original-core events are implemented in the next increment, documented
in `CORE-PAYMENTS-EVENTS.md`; real provider and ChatGPT account acceptance remain
separate. Complete staff interfaces/Flutter parity, provisioning, external account
acceptance and production rollout remain in the completion ledger. No production
server, live account, real customer or real payment was used for these checks.
