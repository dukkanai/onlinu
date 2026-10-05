# Subject-based identity and restaurant control API

`identity-directory.mjs` persists identities using a verified OIDC issuer and
subject, not email addresses, display names or development fixtures. The OIDC
adapter verifies tokens and browser state before resolving a directory identity.
Disabled identities stay disabled after repeat login. The inherited OAuth broker
supports an explicit resolver and seeds no fixture identities in that mode.

`control-plane.mjs` composes the directory, OIDC browser login, OAuth consent/PKCE,
read-only original-core MCP and restaurant membership APIs. It has no `/dev`
login or public platform-administrator bootstrap. A platform operator must be
provisioned through a separately authorized offline operational step; tests use
only an isolated synthetic DB. No such production provisioning has been done.

Browser staff routes require a verified browser session, matching Origin and
CSRF token for writes. Customer OAuth tokens cannot grant staff/control privileges,
even if the same person is also a restaurant owner. Cookies are Secure/HttpOnly,
host-only and same-site. No client role header is trusted.

Roles: owner, manager, supervisor, kitchen, cashier and courier. Permissions are
granular and server-checked. Delegated staff management cannot grant permissions
the actor lacks, promote an owner, or change an owner. Membership updates require
the expected version, serialize on the tenant and audit atomically. Concurrent
updates cannot remove the last enabled owner. Restaurant suspension retains
settlement/fulfilment permissions for existing orders while restricting new
business configuration; closed tenants are not silently reopened or deleted.

Public core discovery lists only configured active restaurants. Runtime routing
is still deployment-owned; the API cannot accept a service URL, Docker command
or database connection string. This phase does not provision containers, implement
billing, ship the full staff UI or connect real external identity accounts.

## Checks

Set `IDENTITY_TEST_DATABASE_URL` to a disposable database named exactly
`astracalls_identity_test`, then from this directory:

    node --test identity-directory.test.mjs control-plane.test.mjs

Tests use isolated random schemas and cover identity separation, concurrent
creation/update, cross-tenant rejection, delegated permission ceilings, last-owner
safety, audit rollback, suspension, OAuth/CSRF, logout and live account-disable
checks. Original synthetic authentication and OIDC tests remain separately active.

## Next integration

Bind the verified platform subject to owned restaurant-core checkouts/orders;
add signed, audience-bound service requests and durable idempotent handoff.
Expose staff UI/Flutter only through the same permission checks. Deployment
requires actual HTTPS/OIDC configuration, secret handoff, and independent external
acceptance. Code/test completion is not production activation.

## Reverse-proxy request budgets

The runtime defaults to trusting no forwarded headers. Deployments behind a
verified proxy may configure `CORE_TRUSTED_PROXY_CIDRS` explicitly; see
[REQUEST-LIMITS.md](REQUEST-LIMITS.md) for right-to-left hop validation, spoofing
protection, Retry-After and unresolved NAT/distributed/load gates. This setting
only selects an abuse-budget key, never an identity or staff permission.
