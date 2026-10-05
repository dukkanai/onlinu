# Control-plane request limits and trusted proxies

The control plane has a per-process, per-client-IP fixed-window budget of 240
requests per 60 seconds, with at most 10,000 live address keys. This is an abuse
backstop, not a scale/availability guarantee or an identity/authorization check.
The default configuration trusts **no proxy headers**, including from loopback.

## Explicit deployment option

`CORE_TRUSTED_PROXY_CIDRS` is an optional JSON array of at most 32 concrete proxy
IP ranges, for example `["127.0.0.1/32","::1/128"]` **only when these really are
the controlled proxy peers**. Do not copy the example onto an unverified topology.
Hostnames, malformed networks, zone IDs and trust-everything `/0` are rejected.
Invalid configuration prevents startup. No production configuration, firewall,
DNS or proxy settings were changed by this implementation.

When the socket peer belongs to an explicitly trusted range, the application
walks `X-Forwarded-For` from right to left through trusted hops and stops at the
first untrusted address. Any purported addresses further left are ignored.
Untrusted direct peers cannot select a rate-limit key with this header.
`Forwarded`, `X-Real-IP`, host names and user IDs from headers are never trusted.
The proxy must correctly append the observed peer or replace untrusted incoming
headers. Every hop and alternate ingress needs review before enabling this option;
never trust a broad shared network merely because it is private.

Headers are bounded to 2 KiB / 16 hops. Missing forwarded headers use the socket peer;
malformed headers from a trusted peer fail 400. IPv6 textual aliases and IPv4-mapped
addresses normalize to the same key. No IP is promoted to a login identity.
Keys expire after 60 seconds, cleanup runs at most once/second, and a full live map
fails closed. 429 responses include bounded `Retry-After`; callers must not replay
an uncertain payment/order mutation automatically.

## Verification and limits

Tests cover untrusted spoofing, multiple proxy hops, IPv4/IPv6, malformed/bounded
headers, independent clients behind the same trusted proxy, window expiry and
10,000-key capacity. Real HTTP integration uses synthetic proxy headers from an
explicitly trusted loopback test peer and confirms 429 / Retry-After and independence.
This is neither a real reverse-proxy deployment test nor a 100,000-user load test.

Clients sharing a NAT still share an IP budget. Multiple processes each have their
own map; restart clears it. IPv6 address rotation, distributed enforcement,
per-principal/tenant budgets, fair workload scheduling and real load testing remain
release gates before large-scale operation. Do not simply raise/disable the limit
to claim those gates passed. Native polling is 10 seconds and will need SSE or an
appropriate event delivery design at scale.

Implementation uses built-in Node `net.BlockList.addSubnet/check` (available in
the supported Node 22 runtime), no new IP-parsing dependency. Reference:
https://nodejs.org/docs/latest-v22.x/api/net.html#class-netblocklist
