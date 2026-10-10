# Stripe sandbox rollout proposal for 10 October 2026

## Decision and execution gate

Use a **fresh Stripe-only synthetic store**. This is a proposal, not deployment
authorization or a record of connected acceptance. No server configuration,
DNS, Stripe resource, credential, payment or key-maintenance action was changed
by this investigation.

Execute only the **latest accepted security-reviewed commit**, pinned to a
verified image digest, after its exact-commit CI and recovery gates pass. The
dependency audit has reported Go 1.26.4 public-advisory matches and npm
development/build dependency advisories; minimal fixes are under investigation.
File-containment hardening is also ongoing. Their resolution, independent review
and final verification are rollout gates. Earlier test passes or the earlier
Stripe source commit do not authorize deploying a superseded build.

## Dated observations to preserve

Read-only owner-server checks on `ostath` (`148.113.184.67`), 10 October 2026,
17:15–17:20 UTC, found:

- Main core image `onlinu-core:4ab7d34740f2` and control image
  `onlinu-control:612be07b42a3` are separate from the Paylink project. Preserve
  these services, their data and configuration.
- Paylink project `onlinu-185308ab93f58c58d5dba674b16e3ca9` runs source
  `45c08314520f03301c3e612442b70ff200b5bd42`. App and PostgreSQL are healthy,
  with `restart=no`; public `/healthz` returns 200.
- Its catalogue is demo/SAR with 8 items. It has 2 demo orders and 2 Paylink test
  attempts: 1 failed and 1 review. Only Paylink has provider configuration.
  Customer accounts/sessions, refunds, couriers/links and stock reservations
  each count zero. Aggregate counts do not prove free-text fields contain no
  personal data; no customer records or secret values were read.
- External crypto remains `external-v1`, store `paylink-sandbox`, database
  `onlinu_paylink_sandbox_main`, schema `public`. Both legacy-key tables are
  empty with `CHECK(false)` fences. Existing secret files are mode `0400`.
- Paylink's internal network is `172.30.252.0/29`. Its app and database have
  namespace-only default-deny egress, blocked DNS and IPv6 rejection; the app
  can reach its database on TCP 5432. The old proxy setting points to
  `172.30.252.1:28182`, but no listener exists and its old pilot service is failed.
  **Do not reopen or repurpose that proxy.**
- Caddy forwards through `127.0.0.1:28081` and systemd-socket-proxyd to the
  Paylink app. The app's actual socket peer was observed as IPv4-mapped
  `172.30.252.1`; no trusted-proxy environment setting was present.
- Host NTP is synchronized. Approximately 9.8 GB disk space was free; recheck
  build capacity without pruning unrelated images or data.

Existing Paylink Compose files are in
`/home/chatbot/charant/onlinu/deployment/paylink-sandbox-20261009`:
`compose.yml`, `compose.pilot-window.yml`, and
`compose.image-45c08314520f.yml`. Its secret root is
`/srv/onlinu/onlinu-185308ab93f58c58d5dba674b16e3ca9`. Preserve both.

Reusing this store would save new DNS and key setup, but would upgrade its schema
and share a runtime with the review attempt. It would have to preserve the
existing domain, store/database identity, keys, sealed configuration and original
attempts; new Stripe tests would need new orders. Fresh isolation avoids that
migration and gives the least disruptive stopping boundary.

## Proposed fresh resources

- Project: `onlinu-stripe-sandbox-20261010`
- Crypto store: `stripe-sandbox`; namespace: `onlinu_stripe_sandbox`
- Database: `onlinu_stripe_sandbox_main`, schema `public`
- Deployment directory:
  `/home/chatbot/charant/onlinu/deployment/stripe-sandbox-20261010`
- Secret root: `/srv/onlinu/onlinu-stripe-sandbox-20261010`
- Dedicated secret filenames: `administrator-key`, `core-database-url`,
  `core-bootstrap-password`, `core-runtime-password`,
  `stripe-sandbox-crypto-keyring.json`
- Dedicated PostgreSQL and media volumes using the new project prefix
- Internal network: `onlinu-stripe-sandbox-20261010-database`, bridge
  `oni-st-sbx`, subnet `172.30.253.0/29`; gateway `.1`, database `.2`, app `.3`,
  separately gated maintenance `.4`
- Loopback ingress: `127.0.0.1:28082`
- Dedicated CONNECT proxy: `172.30.253.1:28183`, only `api.stripe.com:443`
- Hostname: `stripe-sandbox.almujeeb.info`
- Webhook: `https://stripe-sandbox.almujeeb.info/payment-hooks/stripe`

At 17:19 UTC both directories were absent, no container/volume prefix collision
existed, both proposed ports had no listeners, and the subnet overlapped no
current Docker network or route. Recheck all candidates immediately before use.

Both authoritative nameservers (`dns1.registrar-servers.com` and
`dns2.registrar-servers.com`) returned NXDOMAIN for the proposed hostname and a
random sibling. There is **no verified wildcard**. Minimum DNS work is one A
record, `stripe-sandbox.almujeeb.info` to `148.113.184.67`. Add no AAAA record
without a verified IPv6 path. Existing records remain unchanged.

## Controlled setup and acceptance

1. Pass final source, dependency-security, image and exact-commit CI gates,
   including actual external-key runtime and historical/current/media recovery.
2. Create only the fresh resources. Establish approved secure custody and
   recovery access for independently generated new credentials and keyring.
   Initialize external-key state only in the verified empty new database;
   never run maintenance against either existing store.
3. Start with egress closed and a fresh-image, exact-project namespace firewall
   gate. Keep a read-only app filesystem, dropped capabilities,
   `no-new-privileges` and `restart=no`. Add only the new Caddy hostname; validate
   the complete configuration before an explicitly approved graceful reload.
4. Verify HTTPS, `/healthz`, admin protection and actual proxy peer. Consider
   `172.30.253.1/32` trust only after observing it and testing forwarded-header
   handling. Other host processes sharing that gateway remain inside this
   boundary; never trust the whole subnet. Keep default no-trust until approved.
5. Use the already verified NEXTAURA LLC sandbox `acct_1RTbSpDGUtAu22aR`, US,
   with `livemode=false`. No new Stripe account, account-setting change or live
   activation is included. Require test mode, `sandboxPilot=true`, encrypted
   test API key, separate encrypted endpoint secret and API/event version
   `2026-09-30.endive`. Keep checkout disabled until acceptance is authorized.
6. Register an own-account **snapshot** endpoint for exactly
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`,
   `payment_intent.succeeded`, `charge.refunded`, and `charge.updated`.
   Thin, Connect and organization events are outside this implementation.
7. Prefer a restricted test key: Checkout Sessions write/read, Payment Intents
   read, Charges read, and account identity read for `GET /v1/account`.
   Exact resource labels and inline-product requirements need account-specific
   acceptance; do not grant all access or speculative permissions on failure.
8. For the approved test window, permit only the new app's connection to its
   dedicated proxy and only `api.stripe.com:443` upstream. Preserve blocked
   container DNS, direct internet, IPv6 and cross-project access. The test
   browser opens hosted Checkout; server egress to `checkout.stripe.com` is
   unnecessary. Do not modify Paylink egress or shared firewall chains.
9. Verify raw signed delivery and zero effects from unsigned/tampered requests;
   duplicates, reordering, restart and uncertain-create handling; exact account,
   SAR amount and test/card-only responses; then approved synthetic success,
   decline/retry, 3DS and expiry cases. Refund observation requires a separately
   approved sandbox refund action. Automatic Stripe refund dispatch stays off.

## Required approvals and secure entry

Obtain a bundled **action-time** approval when ready to execute, identifying:

- The exact fresh project, database, store, paths and volumes above, including
  independent credential creation, external-key initialization and custody.
- The single DNS record, new Caddy route and graceful shared-proxy reload.
- The exact new namespace firewall, dedicated Stripe proxy, bounded egress
  window and verified single-peer trusted-proxy configuration.
- Restricted-key creation/permissions and the exact own-account webhook URL,
  seven event types and version in `acct_1RTbSpDGUtAu22aR`.
- Synthetic-only connected acceptance and any approved safe-stop actions.

The broad development request is not a substitute for credential/access or
security-setting approval at action time. Any expanded key permission requires
a new specific approval. Real payments, live activation, account maintenance,
refund execution and changes to existing stores are outside this proposal.

Secret entry is a **separate secure user handoff**, never chat or agent copying.
Establish a supported entry route before promising setup. If key/endpoint
creation would return a secret in tool output, hand off before creation/reveal.
The user enters the API key and registered endpoint's signing secret directly
through the approved secure flow; never use a CLI-forwarded endpoint secret,
print values, save them in source, or expose them in logs/screenshots.

## Safe stop and retention

Disable new Stripe checkout while retaining complete endpoint configuration and
signed processing for existing attempts. If emergency containment requires
closing egress or stopping the new app, preserve its database, keyring, receipts,
snapshots and pending work for later reconciliation; do not claim it has drained.
Do not delete the endpoint, test data, secrets or receipts as automatic cleanup.
Existing Paylink and main services remain untouched.

If reuse is reconsidered, the Stripe upgrade adds three ordered attempt columns
and a receipt table. Older maintenance binaries reject the upgraded shape;
older apps can omit the signed-inbox and sandbox gates. Downgrade requires a
separately reviewed offline plan preserving data, receipts, keys and fences.
Never remove columns, regenerate keys or delete fences to force a rollback.

## References

- [Stripe source contract and acceptance gates](STRIPE-SANDBOX-PREPARATION.md)
- [External key operations](EXTERNAL-KEY-OPERATIONS.md)
- [Trusted proxy deployment requirements](GO-TRUSTED-PROXIES.md)
- [Stripe restricted keys](https://docs.stripe.com/keys/restricted-api-keys)
- [Stripe event setup](https://docs.stripe.com/events/set-up-events)
- [Stripe webhook delivery and signatures](https://docs.stripe.com/events/manage-webhook-endpoints)
