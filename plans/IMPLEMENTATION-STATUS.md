# Product completion ledger

Owner-authorized direction, 2026-10-05: complete the existing restaurant SaaS
scope and decide implementation details autonomously. Work is performed directly
by the user's dot in its cloud computer, with no coding-agent delegation.
Existing production/security and external-account approval boundaries remain.

## Latest verified position — 2026-10-05 11:28 UTC

- Active development branch: `feat/saas-core-integration`; no production deployment or merge to main.
- Latest published and fully verified commit: `96684ba2ad48272048dac6224bdaef64eb41b2b7`, CI [37302577893](https://github.com/dukkanai/onlinu/actions/runs/37302577893), all jobs successful.
- Integrated: original core pricing/stock/order/payment/event logic; persistent subject identity and memberships; owned MCP/browser checkout; staff orders/cash/channels/stock/basic menu; reviewed quote binding and owned financial summary.
- Current unpublished increment: category/item creation with staff browser forms, disabled initial items, version/audit checks and tests.
- Still incomplete: broader management and Flutter parity, category editing/options/media UI, WhatsApp ordering, isolated tenant provisioning and subscription billing, actual external-account acceptance, deployment/rollback rehearsal and release approval.
- Historical verification entries below describe their exact commits; they are not a claim that the entire SaaS is complete.

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

## First core integration milestone

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

Channel-policy commit 958d518 passed all CI jobs in run 37292236715, including
browser disable/enable forms, full race tests and translated customer errors.
The browser assertion correctly waits for hidden version fields to be attached,
not visible. Client tests scan backend error codes: rerun them when Go errors
change even if no TypeScript implementation changed.

Current increment adds kitchen-facing order detail without structured contact or
receipt capabilities. Focused real Go/PostgreSQL/Node HTTP tests, all 154 platform
tests, Go vet/build and client 80 tests/type-check/build pass locally. Browser
detail navigation is added to CI and remains pending publication/remote evidence.

Kitchen detail commit 4000bfc was pushed and passed all CI jobs in run 37293304675,
including real Chromium detail navigation. Current uncommitted work adds the
original-stock read/recount bridge and staff form with attributed transactional
audit; see `prototype/platform/CORE-STOCK.md`. It preserves active holds and
does not invent historical actor attribution. Regression/publication are pending.
Stock local regression: 588 Go passes, the same five local netlink restrictions
and one native codec skip; 155 platform, eight tenant, 80 client and 37 packaging
tests pass. Go vet/build and client type-check/build pass. Chromium stock recount
is included in the next remote CI run rather than claimed from local HTTP tests.

Stock commit 49a0159 passed all CI jobs in run 37295426884, including the Chromium
recount form and preserved active holds. Current menu item-edit increment has
589 local Go passes/five known netlink restrictions/one codec skip, 157 platform,
eight tenant, 80 client and 37 packaging tests passing. Focused Go/PostgreSQL
proof covers private settings/table preservation, immutable historical order
prices, optimistic conflicts and transactional audit failure. Remote browser
menu editing remains to be validated after publication. See `CORE-MENU.md`.

Near-term gaps remain explicit: owned customer receipt/detail and option/tax
review, full menu CRUD/media and brand/settings/delivery/refund parity, native
staff authentication/Flutter, real WhatsApp order ingress and controlled tenant
provisioning. Successful increments do not close these release gates.

## External acceptance still required

- Actual ChatGPT account/Extensions/Events flows on an approved HTTPS origin.
- Merchant sandbox/provider agreements/credentials when integrating payments.
- Windows environment and signing/distribution credentials at packaging time.
- Production server access and explicit rollout confirmation. Existing product
  plans report historical staging at almujeeb.info; current live state has not
  been reverified or changed by this cloud-development work.
- Security/licensing and geographic-data gates in SAAS-LAUNCH-GATES.ar.md remain
  distinct from a successful source-data restoration.

### Customer review and immutable financial summary (verified, 2026-10-05)

- Menu increment e501fd2 verified: CI 37299568106 succeeded in server, client and control-image, including actual Chromium browser flow.
- Added option/subtotal/delivery/inclusive-tax review and owned original-order financial detail. Minimal MCP/event DTOs remain unchanged; contacts and receipt capabilities remain excluded.
- Added optional backward-compatible core quote binding. Central confirmations always bind the reviewed snapshot; Go rechecks inside Create transaction to reject same-total detail/tax changes. Accepted idempotent recovery remains first.
- Added cross-language golden vectors, changed-tax regression, owner-isolation/detail tests and escaped-summary tests. Local verification: 591 Go passes, five known sandbox netlink failures and one codec skip; 162 platform, eight tenant, 80 client and 37 deployment tests pass. Go vet/build and client TypeScript/build pass. Final focused Go ownership/quote/real Node-control integration rerun passes. Published as 96684ba; CI37302577893 passed all server, client and control-image jobs, including actual Chromium checkout/staff/OAuth regression.
- Full project remains open: menu/category creation and options/media UI, remaining management/Flutter parity, WhatsApp ordering, provisioning/billing, external provider/OIDC/ChatGPT acceptance and production gates are not complete.

### Scoped category/item creation (in progress, 2026-10-05)

- Added narrow versioned original-core category/item creation, same-transaction actor audit and catalog validation. No entire-settings write or historical-order mutation is exposed.
- Added staff-only APIs and browser forms with stable generated IDs and CSRF. Browser-created items begin disabled for explicit review/activation; kitchen/customer OAuth cannot create them.
- Added atomic-audit/duplicate/stale/unchanged-settings tests and actual control-plane/browser creation coverage. Local aggregate: 592 Go passes, five known sandbox netlink failures and one codec skip; 164 platform, eight tenant, 80 client and 37 deployment tests pass. Go vet/build and client type-check/build pass. Remote Chromium acceptance pending for this increment.
