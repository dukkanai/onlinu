# Go restaurant runtime: explicit trusted proxies

This is a source-level hardening change, not a deployed security configuration or
production-readiness acceptance. It changes how the Go restaurant HTTP guards
choose IP rate-limit buckets. IP addresses are never authentication identities.

## Startup setting

`WACALLS_TRUSTED_PROXY_CIDRS` is an optional JSON array of at most 32 IPv4/IPv6
CIDRs, with a maximum encoded length of 4096 bytes. **Unset means no trusted
proxy**, including loopback, RFC1918 networks, Docker networks and IPv6 ULA.
`[]` also means no trust. A present but empty string is invalid: omit the setting
or use `[]` deliberately.

For example, `["127.0.0.1/32","::1/128"]` would trust precisely those loopback
peers, **only if they have independently been verified as the controlled proxy
peers in that deployment**. Do not copy this example into an unverified topology.
Hostnames, zone identifiers, non-CIDR addresses, non-network host bits, malformed
JSON, invalid entries and trust-everything `/0` are rejected. IPv4-mapped IPv6
prefixes normalize to their IPv4 equivalents; mapped `/96` (all IPv4) is rejected.
No partial allowlist survives a validation failure.

Validation occurs at the beginning of `newServer`, before database opening,
service initialization, payment workers or the HTTP listener. Invalid settings
stop normal server startup with a generic error that does not echo their content.
The parsed allowlist is immutable for that server lifetime; changing this setting
requires a restart. Offline key-maintenance commands do not run the HTTP server.

## Forwarding contract

An untrusted direct socket peer cannot choose a rate-limit key with any header.
Its canonical socket IP is used even when forwarded headers are malformed,
repeated, empty or contradictory. IPv4-mapped addresses and IPv6 text aliases
normalize to stable keys. Malformed socket addresses, including zone-qualified
IPv6 socket peers, return `400 invalid_request` rather than creating raw keys.

For an explicitly trusted direct peer:

- A missing `X-Forwarded-For` uses the canonical socket peer.
- Exactly one header field is accepted, bounded to 2048 bytes and 16 comma-
  separated entries. Its final entry must be a plain valid IP address, without
  ports, brackets or a zone identifier. Other entries cannot influence the key.
- Repeated header fields, an empty value, malformed final entry or an exceeded
  bound return `400 invalid_request` before rate-limit accounting. They do not
  fall back into another rate-limit bucket.
- Only the final address is used, even if it is also an allowlisted proxy. This
  deliberately preserves the Go service's single directly-observed-client
  contract, rather than the Node control plane's multi-hop trust walk.
- `Forwarded`, `X-Real-IP` and host headers are not client-IP evidence.

The controlled proxy must overwrite an untrusted incoming header or append the
peer it actually observed to one outgoing header field. Verify this behavior
against the installed proxy and every alternate ingress before enabling trust.
A proxy that blindly passes attacker-controlled final values violates this
contract and allows rate-limit evasion despite an accurate allowlist.

## Deployment gate and compatibility risks

**Do not roll this default change into an existing proxied deployment without an
explicitly reviewed rollout plan.** With no allowlist, all customers arriving
through one proxy share that peer's existing limits. This is secure against
header-chosen buckets but may cause legitimate requests to receive 429. The
patch does not increase or disable rate limits to hide aggregation.

Before activation, verify the socket peer as observed by the application, not
merely a proxy hostname, listening address or inferred gateway. Prefer exact
`/32` or `/128` entries over shared networks. Docker networking/NAT can make a
host proxy appear as a bridge gateway; other host processes using that same
gateway then share the trust boundary. An IP allowlist cannot distinguish those
processes and does not authenticate the proxy. Review isolation and alternate
routes as part of that explicit trust decision.

An observed Docker gateway is not stable configuration. If the Compose networks
do not pin IPAM, a network recreation can change the peer. Re-observe it after
recreation and before every relevant rollout; stale trust can both aggregate
clients and trust a newly reassigned address. This document intentionally does
not prescribe a live gateway value or alter Compose, Caddy, firewall or runtime
environment settings.

The existing deployment Compose file enumerates container environment variables;
it does not currently pass through this new setting. Adding a value to a host
`.env` file alone is not activation. Any future rollout must explicitly deliver
the approved setting to the restaurant process and verify the effective value.

The inspected control-to-core read-only adapter (`prototype/platform/core-adapter.mjs`)
sends `Accept` and optional `Content-Type`, without forwarding an end-user IP.
Those public API calls already share the control connection's IP budget. Signed
platform routes separately rate-limit by verified owner and scope in
`cmd/server/platform_orders.go`. Neither is a reason to trust the whole internal
network or invent forwarded identity. Capacity planning for shared callers is
separate from this change.

Activation requires the owner's action-time approval for the actual security
configuration and restart/deployment. Verify startup, legitimate requests,
spoof-header rejection and 429 behavior afterward. Do not claim source tests
alone establish the behavior of the deployed proxy chain.

## Local verification

`cmd/server/restaurant_proxy_test.go` covers default no-trust, precise allowlist
matching and adjacent untrusted peers, IP canonicalization, malformed and bounded
configuration, fail-closed startup including an actual-main subprocess, single-
rightmost behavior, malformed/repeated headers and stable rate-limit buckets.
Its real loopback HTTP cases exercise both the public storefront and payment-hook
guards, including 400, 429, `Retry-After`, client isolation and spoofing. These
fixtures use no database, real account, external payment or deployed proxy.

The full project suite and release gates remain separate. Limits remain local
to one process; restarts clear buckets. Shared NATs, address rotation, distributed
enforcement and real load/capacity acceptance are not solved by this patch.
