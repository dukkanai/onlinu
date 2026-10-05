# Product completion ledger

Owner-authorized direction, 2026-10-05: complete the existing restaurant SaaS
scope and decide implementation details autonomously. Work is performed directly
by the user's dot in its cloud computer, with no coding-agent delegation.
Existing production/security and external-account approval boundaries remain.

## Acceptance order

1. Repeatable isolated database tests, CI coverage and baseline fixes.
2. Connect the existing restaurant core to the platform/MCP without duplicating
   money, stock, delivery, tax or order state rules.
3. Owned checkout and order status, durable event integration and identity binding.
4. Restaurant registry/lifecycle, staff identity/roles, channel entitlements and
   isolation across API, database, files, jobs and events.
5. Complete Flutter management parity while retaining React management and all
   five customer templates. Windows validation precedes mobile distribution.
6. Provider-specific payment/refund and WhatsApp order integration; external
   account acceptance must be recorded separately from simulated test results.
7. Production readiness, transfer/rollback and release acceptance. No production
   deployment is implied by local progress or a pushed feature branch.

## Completed baseline

- Full authenticated Git checkout and private branch pushes verified.
- Exact pinned Saudi geography data restored with license/provenance and
  narrow packaging allowlists; focused test and 37 Python tests pass.
- Nine pre-existing Go formatting errors corrected (57d6677).
- Local PostgreSQL 17 installed in the cloud workspace, loopback-only synthetic
  cluster. First DB-enabled run: Go 549 passed/5 network-limited failures/1 native
  codec skip; tenant 8 passed; platform 108 passed without skips. Counts include
  nested tests and must not be presented as independent feature coverage.
- CI definition now prepares PostgreSQL 16, exercises DB cases and client tests.
  Local PostgreSQL 17 success is not proof of CI's PostgreSQL 16 outcome.

## Current increment

Original core adapter, contact-free cart preview and read-only core MCP mode
are pushed in e8af8cc. Cross-language parity uses real Go HTTP/PostgreSQL and
SDK MCP for two restaurants, five templates and three modes. CI coverage update
ae47673 passed GitHub Actions run 37277857214, server and client, including the
WebRTC tests blocked locally. Local DB-enabled baseline is 568 Go passes,
five environment-specific media failures and one native codec skip; platform
115 passes, tenant eight, client 80 and Python 37. Counts include subtests.

Subject-based identity, granular tenant memberships and control-plane HTTP are
the next increment. They reuse verified OIDC and OAuth/PKCE while excluding
fixture identities in persistent mode. See `prototype/platform/IDENTITY-CONTROL.md`.
Identity increment a1f6647 passed CI run 37279746306 with 134 platform tests.
Owned original-core checkout and signed requests are pushed in 996fa81 and passed
CI run 37282467824. See `prototype/platform/CORE-ORDERS.md`.

The current increment adds owned provider redirects, independently verified
payment refresh, transactional original-core outbox and durable central Events
delivery, plus the explicit control-plane runtime/image. Local full regression:
583 Go passes, the same five sandbox netlink/media failures and one native codec
skip; tenant eight, platform 149, client 80, Python 37. Go vet/build and client
type-check/build pass. Counts include subtests. Cross-language tests use real
Go HTTP/PostgreSQL/MCP with simulated provider/callback transports, not live
merchant or ChatGPT acceptance. CI now separately builds and checks the non-root
control image. See the subsequent publication and browser outcome below.
See `prototype/platform/CORE-PAYMENTS-EVENTS.md` for scope and limitations.
Payment/Events commit 76d2828 passed CI 37286386290, including the control image.
The subsequent Chromium navigation regression in ed5f59a failed CI 37286898595
at the provider redirect; diagnosis remains active. HTTP success is not browser
acceptance. The initial staff order bridge and `/manage` view are being added
with separate membership/CSRF/scopes and transactional audit; see `CORE-STAFF.md`
in `prototype/platform/`. Full management and Flutter parity remain open.
Staff increment local checks retain 583 Go passes/five known local restrictions/
one codec skip, with 150 platform tests passing, including staff page escaping.
Browser diagnostics were expanded and CI now runs the focused browser test
before the full suite, so a failure cannot be hidden among unrelated checks.
CI 37288011980 identified the HTML form's `Origin: null`/referrer-policy conflict.
The correction preserves strict Origin/CSRF checks while using `same-origin`
referrer policy only on HTML. Local focused Go and all 150 platform tests pass;
Chromium acceptance must still be confirmed on the new remote run.

Commit 2b24ccd passed all CI jobs in run 37289872901, including actual Chromium
payment redirect/Back, staff navigation, OAuth consent/registered callback/PKCE,
full server race tests and the non-root control image. The browser transport is
now explicitly isolated with CDP redirect interception and a dead loopback proxy;
no real account/payment acceptance is implied.

Current uncommitted increment: original-core atomic channel-ordering policy,
staff/native management and browser forms, plus expired-unresolved-checkout
recovery protection. See `prototype/platform/CORE-CHANNELS.md`. Full regression
and publication of this increment remain pending.
Its local full regression has 585 Go passes/five known network restrictions/one
codec skip and 152 platform passes, with the final additional HTTP policy test
covered by a subsequent focused race run. Vet/build and 37 packaging tests pass.

## External acceptance still required

- Actual ChatGPT account/Extensions/Events flows on an approved HTTPS origin.
- Merchant sandbox/provider agreements/credentials when integrating payments.
- Windows environment and signing/distribution credentials at packaging time.
- Production server access and explicit rollout confirmation. Existing product
  plans report historical staging at almujeeb.info; current live state has not
  been reverified or changed by this cloud-development work.
- Security/licensing and geographic-data gates in SAAS-LAUNCH-GATES.ar.md remain
  distinct from a successful source-data restoration.
