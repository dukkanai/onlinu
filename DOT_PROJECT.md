# onlinu — project reference

Updated: 2026-10-07 UTC. Initial inspected upstream: `main` at
`90b16a000c2cad908e51e78d01a07bfb4e785410`.

## Workspace and source of truth

- Working directory: `/workspace/scratch/46a62ae0b82b/onlinu`.
- Remote: `https://github.com/dukkanai/onlinu.git` (public since the owner-authorized conversion on 2026-10-06 23:38 UTC).
- Authenticated full Git clone completed after user-approved GitHub CLI device
  authorization. All 565 tracked files were reconciled byte-for-byte against
  the inspected snapshot, including the two Windows DLLs; full `.git` history
  is now present. `git pull --ff-only` reports already up to date.
- The initial baseline was clean. Development now lives on `feat/saas-core-integration`; use `git status` for current local state and `plans/IMPLEMENTATION-STATUS.md` for verified milestones and remaining scope.
- GitHub is the durable source of truth. The cloud filesystem is not the only
  copy. Credentials are outside this repository; no secrets are in this file.
- Shell credential helper uses the approved GitHub CLI connection. Global Git
  configuration is read-only, so helper configuration is repository-local.

## Working agreement

Development, analysis, edits and tests are performed directly by the user's dot
in its cloud computer. Do not create Codex/Work tasks or delegate code work unless
the user explicitly requests it. Production Ubuntu is separate and is not a
development target. Before major changes check status and safely update from the
remote; never overwrite uncommitted work. After changes run relevant tests,
type/build/lint checks and review the diff. Make clear commits and push authorized
work only after checking what is being published. Verify the remote commit.

Never commit real `.env`, credentials, passwords, API keys or production data.
Do not delete production data/databases, change firewall/DNS/passwords/API keys,
perform destructive migrations or major production changes without the required
approval. Do not delete outside project-specific paths. Do not perform real
calls, payments, messages, production migrations or deployments during tests.

## Stack and major areas

- Main backend: Go 1.26.4, module `wacalls`, HTTP/SSE; pgx/PostgreSQL;
  whatsmeow WhatsApp integration, Pion WebRTC, optional cgo MLow/Opus codec.
- Web client: React 19, TypeScript 5, Vite 7, Tailwind 4, Radix/shadcn-style
  components, Zustand and TanStack React Query. Node 22 is the CI baseline.
- `cmd/server/`: restaurant ordering/admin, sessions, messaging, Meta calls,
  translation, Chatwoot, webhooks, payments, geography, delivery and persistence.
- `cmd/migrate/`: migration utility; inspect before use. Never target production
  as part of local development.
- `internal/wa/`, `internal/voip/`: WhatsApp adapter, signaling, calls, codecs,
  media, transport and video.
- `client/src/`, `client/public/`, `client/tests/`: web UI, assets and tests.
- `native/`: platform codec binaries. Real audio requires the correct build/tag.
- `deploy/`: isolated Docker installer/runtime Compose, management and tests.
- `scripts/`: packaging, smoke tests and restaurant/browser validation.
- `prototype/`: separate synthetic SaaS implementation, NOT production parity.
  `platform/` uses Node/JavaScript ESM, MCP, OAuth/OIDC, Events, PostgreSQL and
  Moyasar test integration; `tenant/` is a separate Go module; `admin_flutter/`
  contains Dart/Flutter administration; `staging/` uses Compose/Caddy/Dex.
- `plans/` and Arabic project documents: requirements, launch gates and status.
- `passkey-extension/`: browser extension; not installed during this inspection.

External integrations are conditional: WhatsApp QR/Meta, OpenAI translation,
Chatwoot, payment/delivery services, and prototype MCP/OIDC. Code presence does
not prove a live integration is configured or accepted by its provider.

## Local run

1. Install Go 1.26.4 and Node 22+; install frontend dependencies with `npm ci`
   in `client/`, using a writable npm cache. Keep lockfiles unchanged.
2. Provision an isolated local PostgreSQL instance and set `WACALLS_PG_URL`.
   Main backend requires database connectivity and its account needs database
   creation rights. Never use production credentials or an existing production DB.
3. Start backend from root: `go run ./cmd/server -addr 127.0.0.1:3001`.
4. Start frontend in `client/`: `npm run dev -- --host 127.0.0.1` (port 5173).
   Current Vite proxy targets backend port 3001. README's 8080 quick-start is
   inconsistent with this proxy; use matching ports, not both defaults blindly.
5. Production-style static serving: build client, then run server with
   `-static client/dist`; primary routes `/`, `/admin`, `/admin/calls`.
6. Backend health endpoint: `/healthz`. Frontend HTTP 200 alone does not establish
   working database-backed operations.

For real MLow audio, use `CGO_ENABLED=1`, `-tags mlow`, and correct native library
link/runtime paths documented in README/Dockerfile. External integration secrets
are unnecessary for basic source/unit inspection and should not be requested
until that integration is being tested.

## Checks and build

- Main module: `go mod download`, `go mod verify`, `go vet ./...`,
  `gofmt -l .`, `go build ./...`, `go test -race -count=1 ./...`.
- Client: `npm test`; `npm run build` runs `tsc -b && vite build`.
  There is no separate client lint script in package.json.
- Cloud runner workaround for tsx CLI Unix-socket EPERM:
  `node --import tsx --test tests/*.test.ts` runs the same client test files.
- During API-snapshot inspection only, `GOFLAGS=-buildvcs=false` was required.
  The full Git checkout now supports ordinary VCS stamping.
- Installer: `python -m unittest discover -s deploy -p 'test_*.py'`.
- Prototype platform: `npm ci`, `npm test`; integration suite is separate
  (`npm run test:integration`) and requires the configured synthetic services.
- Prototype tenant: enter `prototype/tenant` and run `go test -v -race ./...`.
  Database cases require disposable DB `astracalls_tenant_prototype_test` via
  `TENANT_TEST_DATABASE_URL`; test schema cleanup must remain confined there.
- Other DB tests use `TEST_RESTAURANT_PG_URL`, `TEST_META_PG_URL` and platform
  `TEST_DATABASE_URL`. Review fixture safeguards before setting these variables.
- Flutter requires separate SDK, analysis/tests and platform build validation.
- Docker build: `docker build -t onlinu-local .`; Dockerfile also runs client
  tests/build and Go MLow tests. Native build fetches a pinned opus_mlow source.

## Deployment model

Read `DOCKER.ar.md`, `deploy/INSTALL.ar.md`, `TRANSLATION.ar.md`, `META.ar.md`,
`RESTAURANT-RESUMPTION.ar.md` and `prototype/staging/README.ar.md` before choosing
a deployment path. `compose.translation.yml` builds app with PostgreSQL;
`deploy/compose.yml` consumes prebuilt installer images with persistent DB and
recording volumes. Prototype Compose is a separate synthetic stack.

GitHub CI runs for main pushes/PRs. Release workflow triggers on `v*` tags,
builds platform binaries and publishes release artifacts. Do not push a release
tag as a side effect of ordinary work. No production deployment was performed.

## Initial verification results (local, 2026-10-05)

- Installed official Go 1.26.4 under sibling `.tools/go`; existing `/usr/bin/go`
  was not the Go language toolchain. Used workspace-local Go/npm caches.
- Client dependencies installed with scripts disabled; no lockfile edit.
- Client tests: **80 passed, 0 failed, 0 skipped** using direct tsx import.
- Client TypeScript/build: **passed**. Loopback Vite HTTP smoke: **200**.
- Installer: **34 passed** without deployment/Docker operations.
- Prototype platform: **66 passed, 0 failed, 5 skipped** (DB-backed cases).
- Prototype tenant: **2 passed, 6 skipped** (PostgreSQL prerequisites absent).
- Main Go module verification, vet and build: **passed**. Vet/build also passed
  again after complete Git checkout, with normal VCS stamping enabled. Root race
  suite: **failed** in `cmd/server`.
- Five WebRTC-related tests fail in this cloud sandbox because network interface
  discovery/netlink is not permitted, or dependent media offer creation fails.
  Do not interpret these alone as production defects or bypass sandbox controls.
- Geography pinned-source test fails: `data/saudi-geography/regions_lite.json`
  is absent. The recursive GitHub tree also lacks this data directory; `.gitignore`
  ignores `/data/`. Other pinned geography files/license are required too. Recover
  the intended authoritative inputs and check hashes before any fix.
- Five tested internal Go package groups pass (call, video, media, signaling,
  transport); consult logs for exact package outputs.
- Docker, local PostgreSQL and Flutter SDK were not available in the initial
  environment inspection. Full backend/database runtime, real calls, browser
  end-to-end flows, Docker image and Flutter build are **not validated**.

## Verified existing issues

1. Latest inspected CI run `37256759982` fails on formatting of nine files:
   `cmd/server/broker_scope_test.go`, `chatwoot_outbox_test.go`, `db.go`,
   `eventrsvp_test.go`, `productsend.go`, `restaurant_types.go`,
   `widgetauth_test.go`, `internal/voip/call/callmanager_video_signaling_test.go`,
   `internal/voip/call/video/pipeline.go`. Server build/tests were skipped in CI.
2. CI client job builds/type-checks but does not run `npm test`.
3. Missing pinned geography source data makes a clean checkout's relevant test
   fail; do not silently fabricate fixtures or remove the test.
4. README proxy port mismatch (8080 versus Vite 3001).
5. Full database services, network-capable media validation, Docker and Flutter
   checks remain prerequisites for complete runtime acceptance.

## Next prerequisites

Git authentication and full checkout are complete. Preserve the initial baseline:
application source has not been changed. Commit this documentation on a dedicated
branch and verify it on GitHub. Existing CI formatting and missing geography data
require fixes; local PostgreSQL is required to run the skipped integration cases.
The network-restricted cloud runner cannot currently validate all WebRTC tests.
Do not claim full runtime acceptance from the successful client build.

## Saudi geography restoration — 2026-10-05

The user authorized investigating and implementing this fix during the voice
call. The original source was already identified in project code and plans:
`homaily/Saudi-Arabia-Regions-Cities-and-Districts`, revision
`7e322945fa9f6d696a54ba3e9038e0e750e9692d`.

- Restored the three Lite JSON files plus original license and upstream README.
  All five SHA-256 checksums exactly match the existing pinned importer; no
  data/hash edits. Attribution and provenance: `data/saudi-geography/SOURCE.md`.
- Narrow allowlists retain these public inputs in Git, Docker build context
  and portable source archives; unrelated runtime/private data stays excluded.
- Docker runtime includes `/app/data/saudi-geography`. Database import stays
  opt-in through `RESTAURANT_GEOGRAPHY_DATA_DIR`; no production/DB changes made.
- Existing pinned-data race test now passes. Installer/packaging suite: 37 pass,
  including three new regression tests for allowlisting and private exclusions.
- Go vet and build pass. Full root race suite still fails only the five known
  WebRTC/media sandbox cases, with geography failure eliminated. PostgreSQL
  integration cases remain unvalidated without isolated DB services. Docker
  image build was not run (Docker unavailable).
- Earlier missing-geography blocker is resolved and no files are needed from
  the user for this dataset. Existing gofmt CI errors are a separate open issue.

## Ongoing development update — 2026-10-05

The preceding baseline is historical. Formatting and isolated PostgreSQL test
setup were subsequently fixed. Current work is on `feat/saas-core-integration`;
the original-core adapter, persistent identity and owned checkout milestones
have each passed remote CI, most recently commit `996fa81`, run `37282467824`.
No production deployment or main-branch merge has occurred.

Use `plans/IMPLEMENTATION-STATUS.md` for current test evidence and remaining
acceptance gates. Real-core runtime/identity/order/payment documentation lives
in `prototype/platform/IDENTITY-CONTROL.md`, `CORE-ORDERS.md` and
`CORE-PAYMENTS-EVENTS.md`. `npm run start:core` uses the persistent control plane;
the ordinary prototype start command still runs synthetic data intentionally.
The new Docker control runtime has a separate CI image-build/import check.
Real provider credentials, ChatGPT acceptance, complete staff/Flutter parity and
approved production rollout are separate outstanding requirements.

The payment/Events and initial staff order bridge subsequently passed full CI at
`2b24ccd`, run `37289872901`, including isolated real-Chromium navigation tests.
The next channel-policy increment is documented in `CORE-CHANNELS.md` beside the
other core integration guides; it is not a WhatsApp shopping completion claim.

Customer review changes (2026-10-05, 96684ba; CI37302577893 passed):
- Central checkout shows selected options and original gross-inclusive tax breakdown.
- Confirmed summary uses owned `/platform-api/order-details/{number}` instead of reusing the prepared quote.
- `expectedQuoteHash` binds central confirmations to reviewed details, with a second check inside original Create. Legacy native callers remain compatible when omitted. See `prototype/platform/CORE-ORDERS.md`.

Menu creation (2026-10-05, f66c9d4; CI37303346507 passed): versioned staff category/item creation reuses original SaveCatalog and audit transaction. `/manage/{tenant}/menu` has scoped creation forms; new browser items start disabled for review. See `prototype/platform/CORE-MENU.md`.

Option/category editing is verified by db9ae2b / CI37304792692: Arabic staff forms add/edit/disable options and rename/reorder categories through versioned original-core operations. No historical order is repriced.

Image bridge (3183508 / CI37306155756 verified): original tenant media storage/normalization, staff upload, versioned item assignment and bounded own-origin public delivery. See `prototype/platform/CORE-MEDIA.md` for limits, backups, orphan files and native browser-upload test boundary.

Staff membership UI is under verification at `/manage/{tenant}/members`; see `prototype/platform/CORE-MEMBERS.md` for verified-ID onboarding, roles, aliases, transactional permission audit and migration/rollback boundaries.

Flutter setup in this cloud workspace (2026-10-05): official pinned3.47.5 archive
matches SHA-256 `2132e990f236f8d22e7c6314b29a191a95b10d7cbcfec9b4e2e303d996652cbb`
from the official release manifest; SDK is outside Git at `../.tools/flutter`.
Dart3.13.4/version command verified. Set `CI=true BOT=true` to bypass the SDK's
unneeded cloud-instance autodetection (the metadata request itself is not
permitted), plus workspace-local HOME/XDG_CONFIG_HOME/XDG_CACHE_HOME/PUB_CACHE.
Analytics are disabled. Baseline Flutter dependency lock, analyze and all 12 tests pass. Every Flutter invocation must also pass `--suppress-analytics`; configuration opt-out alone was insufficient for the safety review.

Native app increment (2026-10-05): backend24becfc / CI37313695046 passed.
`prototype/admin_flutter` now has an explicit `CORE_API_BASE_URL` native mode
alongside the original synthetic mode. See its README for OS-secured PKCE login,
restaurant selection, order/cash permissions and test/build commands. CI adds
`native-windows` using official Flutter3.47.5 with Windows SHA256
`0ccd71931f49c2fbe394b1eeb6d79af3d624058a043ea0d03d34160581624fb8`.
Unsigned `.invalid`-origin artifacts are build smoke checks, not production apps;
first Windows result and interactive OS credential acceptance remain pending.

### Native image management

`lib/core/menu_image_editor.dart` separates selection from publication. The official
Flutter file selector reads at most 5 MiB; the native bearer route posts binary bytes
with `x-menu-version` to the existing original-core image pipeline and catalogue CAS.
Public previews are restricted to the central origin and content-addressed files.
No external image URL is fetched by the native client. Browser/native uploads share
one two-slot process budget. Real Windows picker/device acceptance is still required;
CI rendering injects synthetic selection. See the native acceptance document.

### Native team management

`team_models.dart` / `team_pane.dart` expose membership roles and 15 granular
permissions with a review/confirmation step and version checks. Existing verified
principal UUIDs only; obtain a new employee's UUID from the authenticated browser
`/manage` page. No email invitations or identity linking. The native staff router
passes restaurant-only authority to the original directory, which retains atomic
audit and last-owner protection. Platform-operator privileges do not expand native
restaurant membership grants. Test accounts remain synthetic.

### Public business profile

`restaurant_staff_profile.go` exposes six public text fields through signed
`staff:settings:read/update` scopes and the original catalogue CAS/audit. The central
staff/native endpoint is `/staff/profile`; the browser form is
`/manage/{tenant}/profile`. Both require current settings permissions; publication
requires review in the UI. No financial/private configuration, branding draft,
delivery fee or table capability enters this narrow interface. Opening hours remain
informational text; changing them does not schedule automatic opening/closing.

### Delivery pricing and district coverage

Signed `/platform-api/staff/delivery` and `/staff/geography` operations project the
original catalogue and community geography. Central native/browser routes require
settings read/update permissions. Each write merges either pricing or one zone;
full settings replacement is not accepted. Required numeric/bool command fields
cannot silently default to free delivery or disabled state when omitted. Original
catalogue locking, active-geography validation and atomic audit protect changes.
Existing order fees stay immutable. Browser zone lists/search are paginated in
50-row pages; native lists use the same page size. Geographic names are descriptive
metadata, not financial authority. Global service flags, radius/location settings,
couriers and per-kilometre pricing are outside this increment.

### Dispatcher assignment

`platform_staff_dispatch.go` exposes only minimal courier roster data and a signed
versioned assignment operation under `staff:delivery:assign`. The original Assign
transaction retains status/financial rules and now records the verified platform
actor in its event; the existing shared staff audit is reused rather than duplicated.
Browser/native forms require explicit review. Courier IDs are original 32-hex IDs,
not principal UUIDs. This does not create courier accounts, reset credentials, link
native courier identities or expose live location/customer contact data.

## Owned native courier workflow (2026-10-05, local increment)

- Dispatcher `7fc5be0` passed all CI jobs (`37352655371`).
- The next increment adds explicit `couriers:link` and separate `courier:read`,
  `courier:update`, `courier:collect` membership grants. No existing rows are
  automatically granted new permissions. Owners can review updating their full
  permission set in the existing team editor.
- Additive tenant tables `platform_courier_links` and `platform_courier_audit` are
  initialized alongside the original courier store. Versioned links are unique
  per principal/courier and transactionally audited. Unlink is allowed with active
  tasks; new bindings wait until tasks have been reassigned/finished.
- Native sections: reviewed identity binding and own courier tasks. Contact/address
  details are fetched only for the selected owned, unfinished task. Cash collection
  and delivery stage changes are separate explicit confirmations. No GPS collection.
- Use `TestPlatformCourier*`, `courier-service.test.mjs`, native
  `core_courier_test.dart` and `integration_http/courier_live_http_test.dart` for
  targeted coverage; the latter is driven by the isolated Go/Node fixture.
- Full design and release boundaries: `prototype/platform/NATIVE-COURIER.md`.
  This entry records implementation scope, not production acceptance.

## Service intake controls (local increment)

- Narrow `GET/POST /platform-api/staff/service` plus permission-checked central
  `/api/restaurants/{tenant}/staff/service` and native equivalents share the
  original catalog CAS/audit. Four booleans only: acceptingOrders,
  deliveryEnabled, pickupEnabled, tableEnabled.
- Browser `/manage/{tenant}/service` and native service editor both require review;
  no settings document replacement, price/tax edits or order cancellations.
- Regression: `TestRestaurantStaffService*`, `core_service_test.dart`, original
  actual Dart/Node/Go fixture and browser/Windows smoke. Remote acceptance is
  separate from local tests; see the completion ledger before release.

### Cross-client validation rule

Adding a backend `restaurantFail` code also changes the React translation contract,
even if no React component was edited. Run all client tests and the TypeScript/Vite
build for new codes, and add both Arabic and English messages. In restricted cloud
shells the supported `node --import tsx --test tests/*.test.ts` test-loader invocation
avoids the tsx CLI's optional Unix IPC listener; it runs the same complete test files.

## Read-only staff financial snapshot (local increment)

- `GET /platform-api/staff/orders/{number}/finance` and central/native counterparts
  require a signed payment-read grant; central routes additionally require current
  `orders:read` and `payments:read` membership. Customer tokens and courier-only
  grants cannot read restaurant-wide financial data.
- The original refund ledger's repeatable-read transaction supplies the order and
  captured/reserved/refunded/available amounts from one snapshot. A private Go
  field carries that order internally without changing legacy JSON serialization.
- Browser `/manage/{tenant}/orders/{number}/finance` and native order dialogs are
  read-only. They contain no refund execution, manual-transfer or payout controls.
  Reserved includes nonfailed pending and successful refunds; a manual report is
  explicitly not presented as provider-confirmed settlement.
- Whitelisted output excludes receipt/customer capabilities, contacts, provider
  secrets, refund request IDs, private transfer references and operator notes.
- Native caches clear on dismissal, logout, tenant/permission changes and failures;
  open financial snapshots refresh with foreground polling. Late responses cannot
  reopen a dismissed dialog. Display is limited to 100 refund records, while the
  ledger totals cover the full order history.

## Verified checkpoint — 2026-10-05 22:06 UTC

`35eb297cdb51e76f679c7b38712f7c9f79c4ed22` passed every job in
[CI37379196274](https://github.com/dukkanai/onlinu/actions/runs/37379196274).
This includes service intake, read-only financial snapshots, suspended-tenant
courier unlink and masked identity selection. 108 Flutter/210 platform tests,
full server/client checks, actual Chromium/Dart and Windows smoke/build passed.
Windows financial/picker screenshots were inspected. All data/providers in these
checks are synthetic. The overall completion ledger remains open; refund command
UI, broader management/mobile parity, WhatsApp ordering, provisioning/billing,
real account acceptance and deployment gates still require further work.

## Existing-refund management work

See `prototype/platform/REFUND-MANAGEMENT.md` for the scoped backend increment,
reviewed immutable facts, original-ledger audit and remaining browser/native
confirmation work. It does not create a second payment engine or enable real
provider transactions in development.

## Appearance draft management work

`prototype/platform/BRAND-MANAGEMENT.md` records the next original-core management
bridge. Drafts remain private; publication/restore use independent appearance
and catalog review versions, original validation and transactional staff audit.
No production appearance is changed by implementation tests.

## Cancellation/complaint bridge work

`prototype/platform/SUPPORT-MANAGEMENT.md` scopes the original customer-support
queue and reviewed staff decisions. `support:manage` is distinct from kitchen
order updates; existing memberships do not gain it automatically. Approval of a
paid cancellation creates only the original unauthorised refund intent and marks
card payment for review, without dispatching money. Browser/native forms and
remote acceptance must be recorded independently of backend unit/HTTP tests.


## Verified support checkpoint — 2026-10-06 00:21 UTC

`e3465916fe4b5cf905a96f6cba0ebcd413962df2` passed every job in
[CI37392724013](https://github.com/dukkanai/onlinu/actions/runs/37392724013).
Staff cancellation/complaint queue and reviewed decisions now include tested
browser and Flutter interfaces, with 130 Flutter and 222 platform tests, actual
Dart TLS/PKCE through Node/original Go, checked Chromium complaint resolution,
Windows decision rendering/store/build and full server/client checks. The Arabic
Windows review screenshot was inspected. Paid-card cancellation remains payment
review and creates only the original unauthorised refund intent; no real payout
or production operation occurred. Full product completion remains open. POS is
still a later option, per the owner's instruction.

## Customer-owned support handoff (local increment)

`prototype/platform/CUSTOMER-SUPPORT.md` records the confirmed-checkout customer
cancellation/complaint UI, separate signed ownership, explicit review and durable
hash-only dispatch claims. Same-key recovery reads the original support ledger,
including archived cancellations, without automatic POST replay. Local PostgreSQL,
Node/Go HTTP, 226 platform tests, React 80/build and Go vet pass; remote browser
and full regression acceptance remain pending. Unknown never-arrived writes stay
blocked for reconciliation rather than silently duplicating a customer request.


## Verified customer support checkpoint — 2026-10-06 00:44 UTC

`f1046f5ed6a8d8ec81a529cf560a0056b4ba3a8f` passed every job in
[CI37394646960](https://github.com/dukkanai/onlinu/actions/runs/37394646960).
This adds actual Chromium customer review/cancel/checked confirmation to the
local original-core and PostgreSQL evidence. The Arabic browser screenshot was
inspected and is readable. Windows 130-test regression, native renderer/store
and unsigned build also passed; platform 226 and React 80 tests pass.
Unknown-outcome reconciliation tooling, remaining full-product features and
production/external-account acceptance remain open. No production deployment.


## Explicit customer support recovery retry (local increment)

The customer can separately review and confirm retrying an unresolved support
request with its original stable ID, kind, version and reason hash. Normal
resubmission/refresh stays read-only; the original row-locked ledger prevents
duplicate logical requests. Reasons are not newly persisted centrally. Legacy
rows without original review version stay blocked rather than guessing it.
Local 226 platform and original Node/Go/HTTP regression checks pass; remote
Chromium retry confirmation and full CI are pending for this later increment.


## Verified explicit retry checkpoint — 2026-10-06 00:59 UTC

`e092c7efbc110e4c0dcec8bd1551d76997ca978f` passed all jobs in
[CI37396101646](https://github.com/dukkanai/onlinu/actions/runs/37396101646).
The customer can explicitly review/confirm a same-key retry, while ordinary
refresh/resubmit stays read-only. The original idempotency ledger prevents
duplicate logical requests. A subsequent Arabic status-label and screenshot
focus correction passes local 227 platform and original Node/Go/HTTP checks;
remote verification for that later correction remains pending.

## Original tax management bridge (local increment)

`prototype/platform/TAX-MANAGEMENT.md` documents the reviewed three-field bridge
for original gross-inclusive tax configuration. Browser/native forms retain
current permissions/version and explicit confirmation. Original catalog validation,
financial snapshots, prices and actor-audit rollback remain authoritative. Local
original PostgreSQL/Node/Go and actual Dart TLS checks pass; new Chromium/Windows
review acceptance is still pending. No real tax rate or registration was chosen.


## Verified Arabic customer support review — 2026-10-06 01:20 UTC

`a9a0147b06af0670b165e8326974dda72101c896` passed every job in
[CI37397669126](https://github.com/dukkanai/onlinu/actions/runs/37397669126).
Two old English-state browser expectations were updated after intentional Arabic
labels; no payment rule changed. The retry screenshot was inspected with readable
Arabic states and unobscured navigation. The later tax increment remains separate:
local 136 Flutter/230 platform/React 80 tests, analyzer, vet/build and actual Dart
TLS through Node/original Go pass; new tax Chromium/Windows CI remains pending.


## Verified tax checkpoint — 2026-10-06 01:31 UTC

`941056bbd6f35db91144c0d98ba63c256b62d838` passed every job in
[CI37398729778](https://github.com/dukkanai/onlinu/actions/runs/37398729778).
136 Flutter / 230 platform / 80 React checks, full server/client checks, actual
Dart TLS/PKCE, Chromium tax review and Windows renderer/store/unsigned build pass.
The Arabic Windows tax-review screenshot was inspected and is readable. No real
merchant registration/rate or production change occurred. Whole-product work
remains open, including provisioning/billing, WhatsApp and external release gates.

## Runtime secret-file preparation (local increment)

`deploy/RUNTIME-SECRETS.md` documents five opt-in Go secret-file settings, private
startup errors, immutable in-memory loading and no raw-value export to child
process environments. Existing environment configuration remains supported; the
installer and production configuration are unchanged. Actual main-help tests
prevent a configured database URL from appearing as a flag default. Related
original auth/Meta/archive/translation/restaurant and Node/Dart regressions pass
locally; remote acceptance remains pending. This is preparation for isolated
provisioning, not evidence that a provisioner or deployment has run.

## Runtime startup verification follow-on — 2026-10-06

File-backed secret commit `38c60fe` passed all CI37401147861 jobs. The following
local increment requires original administrator authentication whenever signed
platform access is configured, and adds an opt-in actual-main smoke using only
synthetic files and a uniquely owned loopback test database. Local race tests
pass; commit `9812807` subsequently passed every job in CI37405031722. See
`deploy/RUNTIME-SECRETS.md` for the exact boundary and test opt-in.

## Offline tenant-resource planning (local increment)

`deploy/tenant_plan.py` accepts strict non-secret tenant configuration and emits
non-executable, digest-identified resource plans. Distinct per-tenant resources,
loopback HTTP, pinned image references and restricted DB-role requirements are
covered by eight pure tests. All 45 deployment/packaging Python tests pass.
No Docker/secret/network operations or provisioning worker are added; see
`deploy/TENANT-PLAN.md` for remaining execution gates. Commit `ef87ab9` passed
every job in CI37407109723; this does not establish provisioning acceptance.

## Opt-in runtime image acceptance preparation

`d25f00a` passed the four ordinary CI37409249616 jobs. The separate image job
requires explicit manual input and was intentionally skipped. See
`deploy/RUNTIME-IMAGE-ACCEPTANCE.md`; external codec execution and full image
acceptance are pending, with no registry publication or deployment performed.

## Original runtime image accepted in isolated CI

Following explicit external-codec approval, `0877142` passed all five jobs in
CI37422274567. The original root Dockerfile builds and its runtime passes UID
10001/read-only/file-secret/health/admin-auth/restricted-DB checks on synthetic
fixtures without publishing ports. The report was inspected; no real calls,
registry publication, production deploy or multi-tenant isolation is implied.

## Reviewed-plan Compose rendering (local increment)

The offline planner now has an explicit `--compose` mode requiring an exact
review digest. It emits separated file-secret mounts and dedicated tenant
resources, with a digest-bound PostgreSQL 16 bootstrap asset. Local 57 Python
tests and a negative PostgreSQL 17 bootstrap check pass. CI schema validation
and opt-in positive bootstrap/image checks passed in CI37424797423 for
`264157d`; the report was inspected. No executor, secret
creation, tenant registration or deployment is performed by the renderer; see
`deploy/TENANT-COMPOSE.md` for the required gates.

## Private provisioning journal (local increment)

`prototype/platform/provisioning-journal.mjs` records operator-only initial
intents, versioned worker leases, uncertain outcomes and evidenced reconciliation
in the existing identity database. It has no public route or automatic executor,
and never activates tenants or changes external resources. Local 243 platform
tests without skips and related Go runtime race checks pass. Commit `33f15a4`
passed ordinary CI37427159676; the optional image job was skipped.
See `prototype/platform/PROVISIONING-JOURNAL.md` for authority and artifact gates.

## Two-tenant rendered Compose acceptance (local increment)

The opt-in image job now includes a two-fixture renderer acceptance script:
separate databases/media/keys, actual hardening checks, cross-network TCP denial
and container recreation without changing the neighboring fixture. Only local
image references and disposable host-file paths override the rendered spec.
Local 64 Python tests pass. Actual Docker acceptance passed with all five jobs
in CI37429655725 for `1b938f5`; the two-fixture report was inspected. See
`deploy/TENANT-COMPOSE-SMOKE.md`. No production executor or deployment is added.

## Private reviewed-artifact preparation (local increment)

`prototype/platform/provisioning-artifacts.mjs` connects the private journal to
strict offline resource compilation, matching tenant/digest and approved release
policy before returning immutable Compose plus verified bootstrap bytes. It
rechecks authority and worker fencing before/after compilation and never reads
secret files or executes Docker. Local 255 platform tests pass without skips;
related actual-main Go race tests pass. Commit `de31ccd` passed all four ordinary
CI37434333447 jobs; the unchanged optional runtime-image job was skipped.
See `prototype/platform/PROVISIONING-ARTIFACTS.md` for remaining executor gates.

## Private single-attempt coordinator (local increment)

The private `provisioning-runner.mjs` now sequences reviewed artifacts, a fenced
journal claim, injected host-lock/inspect/apply/verify operations and a strict
evidence digest. Ambiguous outcomes require reconciliation; no automatic retry,
rollback or activation is introduced. The production host driver is intentionally
absent. See `prototype/platform/PROVISIONING-RUNNER.md` for that trust boundary and
required subprocess/lock acceptance. Synthetic coordinator and real PostgreSQL/
compiler integration tests are included. Commit `040ecb5` passed all four ordinary
CI37436422280 jobs, with the optional unchanged runtime-image job skipped.


## Concrete Linux host lock (local increment)

`provisioning-host-lock.mjs` uses inherited-descriptor util-linux flock, strict
private local-file checks and stable planner resource names. Real separate-process
contention and worker-exit tests pass; lock release never deletes the lock file.
The PostgreSQL/compiler/coordinator fixture uses this concrete lock. It does not
prove Docker daemon cancellation or replace uncertain-outcome reconciliation.
See `prototype/platform/PROVISIONING-HOST-LOCK.md`. Commit `e7b6d58` passed
all four ordinary CI37438055020 jobs; the unchanged runtime-image job was skipped.

## Bounded private process transport (local increment)

`provisioning-process.mjs` provides no-shell, minimal-environment Linux subprocess
execution for a future fixed-command trusted driver. Cancellation/timeout/output
overflow stop only the owned process group and await pipe closure; errors do not
echo diagnostic output. Real synthetic parent/descendant cancellation tests are
included. Docker daemon cancellation and actual apply/recovery remain separate;
see `prototype/platform/PROVISIONING-PROCESS.md`. Commit `28709b0` passed all four
ordinary CI37440216640 jobs; the optional unchanged runtime-image job was skipped.

## Exclusive reviewed-artifact staging (local increment)

The private artifact bridge now marks its immutable in-process results; a new
stager rejects arbitrary JSON/lookalikes and requires a current claimed worker.
It exclusively creates private per-attempt Compose/receipt files plus verified
public bootstrap SQL, synchronizes them and retains partial evidence on failure.
Authority and fencing are checked before/after filesystem work. No credential
value or Docker operation is involved. See
`prototype/platform/PROVISIONING-STAGE.md`; commit `518c637` passed all four
ordinary CI37444321105 jobs, with the optional unchanged image job skipped.


## Isolated client-cancellation/daemon-state acceptance preparation

The opt-in image job now includes a guarded fixture that creates, never starts,
one owned mount-free, port-free container, aborts its command process, and checks
that the daemon object still exists. It then removes only that exact verified
fixture. Three pure guards and 64 deployment tests pass locally. Commit `7dbde99`
passed all five CI37446321930 jobs; all three runtime-image reports were inspected.
See `deploy/PROVISIONING-CANCELLATION-SMOKE.md` for the remaining production gates.

## Real journal/Docker lifecycle acceptance preparation

An opt-in fixture now joins the actual identity/provisioning database, compiler,
preflight, stager, host lock and process transport to disposable Docker tenants.
It covers success and a lost apply reply, blocks replay and requires actual
inspection plus explicit reconciliation. Test-only image/path/identity overrides
remain explicit; no production driver is claimed. Local guards and existing
regressions pass. After a canonical fixture-issuer correction, `147a8c1` passed
all five CI37451506853 jobs; all four exact-commit runtime reports were inspected.
See `deploy/PROVISIONING-JOURNAL-DOCKER-SMOKE.md` for the explicit fixture scope.

## Delivery mutation permission recheck — 2026-10-06

Delivery pricing and zone mutations now recheck current `settings:update`
authority after consuming the request body, both in management forms and the
shared browser/native staff API. This closes the interval where an earlier
permission check could outlive a revocation while a request body was arriving.
No new permissions, pricing semantics or production changes are introduced.

Focused staff tests pass (12 including subtests). The available local platform
suite passes 187 tests with 12 database-dependent skips; those skips are not a
full integration pass. A real-core integration regression revokes fixture
membership between checks and verifies all six pricing/zone transport cases
(form, browser API, native API) fail without changing the catalogue. Remote
integration acceptance is pending for this change. Restaurant origin/radius
editing remains unfinished and is not included in this checkpoint.

Acceptance update: commit `caeb2b5c0f4212340f692e792b6d99beabaaf142`
passed all four ordinary jobs in CI37465795032 (server, client, control-image,
native-windows), verified 2026-10-06 13:01 UTC. The opt-in codec-bearing image job
was intentionally not requested and was skipped. The real core/browser/native
revocation regressions are accepted for this exact commit; this does not add
restaurant origin/radius editing or change production deployment readiness.

## Delivery origin/radius API — 2026-10-06, acceptance pending

The original Go catalogue now exposes nullable latitude/longitude in its staff
coverage view and a signed `staff:settings:update` location patch. Omitted
origin preserves the coordinates; explicit null clears both; partial or invalid
coordinates and non-finite/out-of-range radius values are rejected. Existing
catalogue validation, optimistic versioning and transactional audit remain in
use. Coverage is the existing straight-line radius, not road distance or per-km
pricing. Historical order totals and all unrelated catalogue fields must remain
unchanged.

The Node staff API (including native transport) supports the same patch, rechecks
permission after reading the body, and treats a mismatched/old-core write reply
as uncertain without retry. Old core reads without coordinate fields remain
compatible. No browser or Flutter location editor is included yet.

Local Go input validation, build and vet pass. Database-backed Go coverage/audit
checks are present but skipped without the disposable PostgreSQL service. Node
focused tests pass 34/34; platform suite passes 190 with 12 database skips.
Actual signed native-to-Node-to-Go set/stale/invalid-clear/restore checks were
added to the remote integration fixture; remote acceptance is pending.

The location API commit `1f1ea2a25a850b7b29717949dc0e5c9ba8420937`
passed all four ordinary jobs in CI37468733999, verified 2026-10-06 13:21 UTC;
the optional full runtime image job was intentionally skipped. Its actual
PostgreSQL audit/coverage and signed native API regressions passed remotely.

Browser editor follow-on: management forms now expose explicit origin, straight-
line radius and customer-location requirement edits, with review, CSRF/current
permissions, strict localized decimal parsing and explicit clearing semantics.
Older core responses hide unsupported editing. Unit rendering/parsing tests pass;
actual Chromium save/clear and nine transport/revocation cases await remote CI.
A synthetic rendering screenshot is retained for review. Flutter editing remains
pending, and this does not implement per-kilometre delivery pricing.

Browser editor `7faad6dfd07bba4d2991b0cafb108b069c1828f9` passed all four
ordinary jobs in CI37470572626. The downloaded synthetic Chromium screenshot was
visually inspected: Arabic labels, coordinates, radius, review and clear/save
flow are present. Full-image acceptance was intentionally not rerun.

Native editor follow-on (acceptance pending): Flutter gains compatible nullable
origin models, a validated full-intent location command, matching acknowledgement
checks, current-tenant/version/permission guards and an explicit review dialog.
Added tests cover localized decimal input, invalid/old responses, cancellation,
revocation, real TLS native API save/stale/restore, and Windows form/review
screenshots. A checksum-verified Flutter SDK was restored locally, but package
restore did not complete in this execution. Local formatting and diff review are
not an analyzer/test pass; native analysis, tests and rendering await remote CI.

Native CI37473814757 first stopped at the formatting gate, before native analysis
or widget tests: the restored local workspace had no package configuration, so
formatting used the SDK's latest language version rather than this package's
Dart 3.5 language level. Explicit `dart format --language-version=3.5` now checks
all 73 Dart files with zero changes. This corrects formatting only; rerun native
acceptance remains required and no test gate has been weakened.

Native acceptance update: corrected commit
`418812857953510d1ca1884f6be31c143ce982ea` passed all four ordinary jobs in
CI37475052322, verified 2026-10-06 14:07 UTC. Windows analysis, unit/widget tests,
actual OS renderer/storage tests and unsigned release build passed; real native
TLS location save/stale/restore also passed with the server integration. Both
Windows location editor and review screenshots were downloaded and visually
inspected at 14:08 UTC. Arabic labels and review controls are legible. This
accepts the location/radius management feature, not production deployment or
per-kilometre pricing. Full runtime-image acceptance remains separately recorded
at `147a8c1`; it was intentionally skipped in this run.

## Durable private provisioning evidence — 2026-10-06, CI pending

A bounded immutable filesystem receipt now binds a private driver's job/worker,
tenant/plan, source commit and actual resource IDs to its observed verification
checks. It rejects arbitrary diagnostic/secret fields and unsafe filesystem
substitutions; writes are exclusive and synchronized, reads revalidate canonical
bytes/hash/binding. The component does not grant authority or independently prove
health; no production driver, deployment or activation is introduced. The real
journal/Docker fixture now writes and rereads these receipts and embeds them in
its retained synthetic report. Ten new filesystem tests plus four fixture guards
pass; local platform 202 passed / 12 database skips. See
`prototype/platform/PROVISIONING-EVIDENCE.md`; actual Docker CI is pending.

Evidence acceptance: `f9a965f035efea575836c4f8cff2f6bf01ce094f` passed all five
CI37479843024 jobs, verified 2026-10-06 14:45 UTC. The full original runtime
image and three additional isolated smoke paths passed. All four reports were
downloaded; the two immutable receipt hashes and bindings were independently
checked. Synthetic image ID is
`sha256:079bdb38d79a5184a104e33e35e3beeaa409efb12b512617b56a208fb3604442`,
not a published registry digest. Production apply, credential provisioning,
public routing, recovery and real account acceptance remain separate gates.

## Payment-method management API — 2026-10-06, CI pending

Configured payment choices for one service mode can now be read/patched through
signed settings-scoped core and browser/native staff APIs, using original
catalogue versioning, validation and actor audit. Provider credentials/readiness
and financial/order history are not changed. Configured card remains distinct
from effective payment availability, enforced by the existing quote path.
Go input/build/vet and focused Node checks pass; local platform 204 passed with
12 database skips. Actual PostgreSQL and cross-language acceptance is pending;
no management form or Flutter editor yet. See
`prototype/platform/PAYMENT-METHOD-MANAGEMENT.md`.

Payment-method API acceptance: corrected fixture commit `25c8067` passed all
four ordinary CI37485775619 jobs. The shared fixture's default card-availability
stub was explicitly disabled for the unconfigured-provider test; production
behavior was unchanged. Browser management forms are now added with explicit
review, current read/write authority, strict checkbox parsing and availability
warnings. Local page tests and platform 206 passed / 12 database skips; actual
Chromium rendering/mutations and revocation checks await CI. Flutter editor is
not yet included.

Browser payment-method acceptance: commit
`bd946185cb23f62a3183ba849eb7356134e7cf5f` passed all four ordinary jobs in
CI37488047631, verified 2026-10-06 15:40 UTC. Actual PostgreSQL and Chromium
save/restore plus read/write-revocation checks passed. The retained synthetic
browser screenshot was downloaded and visually reviewed: Arabic labels, per-mode
choices, review checkboxes and provider-availability warning are legible. The
runtime-image job was intentionally skipped; its separate accepted checkpoint
remains `f9a965f`. Flutter payment-method editing and production acceptance remain
pending. No production settings, provider credentials or real payments changed.

## Native configured payment-method editor — 2026-10-06, validation pending

Flutter now has a typed per-mode view and explicit reviewed editor, with original
mode-specific choices, stale-version/current-tenant/read-and-write permission
checks, offline/freshness guards and no automatic mutation retry. A successful
HTTP acknowledgement must preserve other modes, service flags, currency and demo
state as well as the reviewed choices and incremented catalogue version; an
inconsistent reply is uncertain. No provider credentials or real payment action
are exposed. Model/API/controller/widget regressions, real native TLS save/stale/
restore and Windows screenshot acceptance are added. Dart 3.5 formatting and diff
checks pass; local dependency restore has not completed, so analysis/tests/build
are not claimed passed until remote CI. Native image/device acceptance is pending.

Native first run CI37502537453 passed analysis but exposed two failures in the
new API/widget fixture: a map rebuilt from a dynamic list lost its string-keyed
runtime type, so the strict response parser correctly rejected it. The fixture
now explicitly rebuilds `Map<String, dynamic>`; production parsing and test
assertions remain unchanged. The native aggregate is not yet accepted.

Native payment-method acceptance: corrected commit
`e1249c76dcea4e49e26529e4d18a4860b226f8cf` passed all four ordinary jobs in
CI37503661616, verified 2026-10-06 17:36 UTC. Native analysis, all widget/unit
tests, actual Windows secure-storage/rendering tests and unsigned build passed;
actual Dart TLS save/stale/revert passed with the original Go/Node fixture.
The Windows review and saved-state screenshots were downloaded and visually
inspected: Arabic warnings, choices and explicit review/save controls are
legible. This accepts native configured payment-method management, not provider
connection, real charging, mobile-device acceptance or production deployment.
Full runtime image was intentionally skipped; its separate checkpoint remains
`f9a965f`. No production account or configuration changed.

## Shared provisioning runtime inspection — 2026-10-06, CI pending

A private pure observation gate now checks complete owned container, mount,
network and volume snapshots before the journal/Docker fixture can emit healthy
runtime evidence. Foreign resources, extra attachments/mounts, image/port drift
and known inline credentials fail closed with redacted errors. Five new test
groups plus four existing fixture guards pass locally. This prepares the trusted
executor without production effects or automatic tenant activation; actual Docker
CI for this increment is pending. See
`prototype/platform/PROVISIONING-RUNTIME-INSPECTION.md`.

Runtime inspection acceptance: commit
`9154929f905fab1b2024313c64ae0f5738686651` passed all five jobs in
CI37540564750, verified 2026-10-06 22:36 UTC. The actual journal/Docker fixture
passed both successful and unknown-reply reconciliation paths through the new
snapshot gate. All four runtime reports were downloaded and inspected; both
immutable receipts were independently rehashed and source/identity-bound. The
local image ID is
`sha256:31113c204c1aa85119a6ee26b724ec44a1c338d902d8b2d9ed886f39132a1ee8`;
this is not a published registry digest. No production driver, real credential,
public routing, activation or deployment is implied. Local platform tests also
passed 211 with 12 database skips; remote CI supplied database acceptance.

The next provisioning increment adds a fixed-command, local-context-only runtime
probe over the existing bounded process transport, used by successful and
uncertain-reply reconciliation fixtures. It verifies identifiers before building
read-only arguments, bounds daemon responses, preserves cancellation and returns
only validated resource identities. Seven new probe tests pass; actual daemon CI
for this follow-on remains pending. No production apply or account setup added.

Read-only runtime probe acceptance: commit
`d099829ea7030a2a45b75d83e1c55bbc467e55c3` passed all five jobs in
CI37542056436, verified 2026-10-06 22:49 UTC. The shared bounded reader ran in
the actual journal/Docker success and unknown-reply reconciliation paths. Four
runtime reports were downloaded and inspected, and both evidence receipts were
independently rehashed and source/identity-bound. Synthetic local image ID:
`sha256:6f0d6c0a1fb85e75eba48b37e9d8b05661206edcbd7656b7a8c975ae4ac5adfb`.
No registry publication, production apply driver, real secret provisioning or
deployment is implied. Local platform218 passed with12 database skips; actual
PostgreSQL, Windows/client and full-image validation passed remotely.

Staged provisioning artifacts now require exact, bounded, non-mutating read-back
under live actor/worker fencing before the fixture consumes them. Original
in-process handles, private directories, single-link files, owner/mode and exact
bytes are checked; authority is rechecked afterward and failures retain evidence.
All18 artifact/stage tests pass locally; remote fixture acceptance is pending.
See `prototype/platform/PROVISIONING-STAGE.md`. This does not execute production
or create, rotate or read real secret values.

Stage read-back acceptance: `58b00c01abb72e56d2157764b4a0991df52ef878`
passed all five jobs in CI37543411440, verified 2026-10-06 23:05 UTC. Exact staged
artifact verification passed in both actual journal/Docker fixture attempts.
Four runtime reports were inspected and both immutable receipts independently
rehashed and bound to the exact source and attempt. Synthetic local image ID:
`sha256:eaeb8373b6ae3c4dfae195bae7c4753625f71d4c7b6c3fd9a7f3e26b7bf3d78e`.
This is not registry publication or production execution. Local platform222 tests
passed with12 database skips; remote PostgreSQL and full-runtime gates passed.

The private executor now has a single-attempt fixed-command Compose transport and
shared empty-namespace preflight. The actual isolated journal fixture uses them,
with explicit synthetic manifest overrides kept separate from production.
Authority/integrity/emptiness checks precede a no-pull/no-build creation attempt;
lost replies never trigger retries or removal. Eight new focused test groups
pass locally; remote daemon acceptance is pending. See
`prototype/platform/PROVISIONING-COMPOSE-APPLY.md`. A production manifest/secret
supplier, public routing, activation and release permission remain separate.

Compose transport acceptance: `5d973314e5f8c794328a96ccd7f89249c3723ce9`
passed all five jobs in CI37545039166. The already-running job completed after
the user reported a near-exhausted Actions allowance; no later run was dispatched.
Four exact-source runtime reports were inspected and both receipt hashes and
bindings independently checked on 2026-10-06 23:24 UTC. Actual isolated creation,
lost-reply reconciliation and owned cleanup passed. Synthetic local image ID:
`sha256:6cc3a1a4d88a26cb434865c671c8b9336a04958e02d5aa7aac856b7732bf62d4`.
Production manifest/secret supply, routing, activation and release remain open.

## Local Docker trial and CI allowance — 2026-10-06

The owner reported an Actions allowance warning at23:17UTC; its exact kind and
remaining amount are not yet verified. New hosted dispatches are on hold while
local tests continue and heavy checks are batched. The existing run above was
allowed to finish. No runner exists on this repository and no separate owner test
server is available. No budget, billing or persistent runner access was changed.

At the owner's explicit request, official Docker29.8.2 static and rootless-extra
archives were downloaded into an isolated workspace tool folder. CLI and daemon
version commands worked. The official rootless prerequisite check failed on
missing uidmap/iptables/kernel-module requirements; the environment additionally
rejects AF_UNIX socket creation with EPERM. Disposable user/mount/network
namespaces and loopback TCP probes worked, so this is not a blanket lack of
networking. No security/filter/firewall settings were relaxed or modified.
No daemon/service or container was started. At the owner's conditional cleanup
request the complete trial was moved to recoverable OS Trash, verified absent
from its workspace installation path. Merely restoring these files is not a
working Docker runtime. Linux also does not replace actual Windows acceptance.

## Public repository decision — 2026-10-06 23:38 UTC

The owner explicitly authorized conversion to public after checking for secrets,
with the public code/history exposure explained beforehand. A local heuristic
scan covered266 commits and2118 reachable blobs across fetched branches/history;
known provider-token/private-key signatures found no matches. All184 broad
credential-like candidates were classified as placeholders, fixture values,
translation/form metadata, runtime generation or secret-file references. Extra
entropy/signature review, tracked environment/database/session-file inventory,
binary asset inventory and repository PR/comment/release surfaces were reviewed.
No real credential or private customer data was found. This is not a guarantee
of absence or a substitute for ongoing security review; GitHub's secret-scanning
endpoint had been disabled while private. No credentials were rotated or posted.

An initial visibility attempt was blocked until remaining candidate classifications
were supplied. The same action then succeeded; unauthenticated GitHub metadata
confirmed `private:false`, `visibility:public`. Existing AGPL-3.0 license remains.
Standard hosted Actions use is free for public repositories under GitHub's current
policy: https://docs.github.com/en/billing/concepts/product-billing/github-actions .
The owner-authorized public route resolves the temporary hosted-dispatch hold;
no paid/larger runner, billing budget or self-hosted registration was configured.
Local checks and batched acceptance remain preferred. The last accepted code
checkpoint is still5d97331; visibility/docs changes do not constitute new tests.

## Stable provisioning verification — 2026-10-06, CI pending

A shared private verifier now requires full owned runtime observations before
and after authenticated/unauthorized HTTP checks, with stable container/image
IDs, then writes and rereads exact-bound immutable evidence. Copied observations
prevent a changing runtime from being attested as the original one. Unknown
attempts can be inspected only through the caller's explicit reconciliation;
there is no retry/delete/activation. Six new focused groups plus four fixture
guards pass locally; actual daemon acceptance is pending. See
`prototype/platform/PROVISIONING-VERIFICATION.md`.

Stable-verifier acceptance: `813e69264da0997021bd6a8532afd22bbdbc50a9`
passed all five jobs in CI37548290444, verified 2026-10-06 23:54 UTC on standard
hosted runners after the authorized public conversion. Actual Docker success and
unknown-reply reconciliation passed the shared before/auth/after verifier. Four
runtime reports were inspected and both immutable receipts independently rehashed
and source/identity-bound. Synthetic local image ID:
`sha256:4397c735dd2d24de4b7495e0cbf5aa4696622ed37ab259b4ebca98d1125de043`.
No production credential, activation, registry publication or deployment occurred.
Local platform236 tests passed with12 DB skips; remote database/Windows/full-image
checks passed. Production manifest/secret supply and release gates remain open.

## Optional operator provisioning queue — 2026-10-07, CI pending

The private journal gains bounded filtered cursor reads, preserving PostgreSQL
microsecond ordering and labeling expired claims without mutating them. An
explicit, default-off control-plane flag enables browser-session/operator-only
JSON and Arabic GET-only views; owner/OAuth/header privilege escalation remains
blocked. No executor commands or activation controls are exposed. Pure parser,
renderer/configuration tests pass; actual database and Chromium pagination,
revocation and screenshot acceptance are pending. A local packaging guard caught
missing new runtime COPY entries, now corrected without adding executor modules.

Queue first CI37550183973 reached the actual operator HTTP checks but failed the
Chromium exact accessible-label lookup for the state selector: its enclosing
label included option text. Labels now use explicit separate `for`/`id` bindings;
the exact-label browser assertion is retained. Database-suite and aggregate
acceptance remain pending the corrected run; no gate was weakened.

Operator queue acceptance: corrected commit
`43c94a81b55a258cc96bf195c0433056ecea8116` passed all four ordinary jobs in
CI37550903838, verified 2026-10-07 00:22 UTC. Actual PostgreSQL microsecond cursor
pagination, filtered reads, expired-claim non-mutation and operator revocation
passed; real HTTP and Chromium GET filtering/paging passed. The synthetic Arabic
queue screenshot was downloaded and inspected: labels, unknown state, references
and UTC times are legible. Runtime-image was intentionally skipped; the separate
latest full-image checkpoint remains813e692. The new operator view remains
explicitly default-off, and no live deployment or execution controls were added.

## Original manifest / existing-secret metadata — 2026-10-07, CI pending

New private components bind exact original staged files to current authority and
metadata-only checks of the five approved secret references. They reject foreign
paths, incorrect UID/mode, symlinks/hard links, changed artifacts and ambiguous
acknowledgements; they create no keys and read no secret bytes. Five filesystem
and four capability test groups pass locally (27 combined artifact/preflight
checks). Actual production UID/mount policy, credentials and deployment remain
external gates. See `prototype/platform/PROVISIONING-EXECUTION-MANIFEST.md`.

## Disposable main-database restore — 2026-10-07, CI pending

The owned two-tenant runtime fixture now prepares a private PostgreSQL archive,
reads it back and restores only into a new collision-checked fixture database.
All public-table and sequence fingerprints must match, the source must remain
unchanged, and existing neighbor-uptime/isolation checks remain. Archive bytes
are not uploaded. Four new guards pass; all68 deployment/packaging checks pass.
Actual database restoration is pending full-image CI. Production/session/media
backup, off-host retention, recovery objectives and rollback remain separate.
See `deploy/FIXTURE-DATABASE-RESTORE.md`.


Manifest/backup acceptance: `7685020ebc885d2dac99f15fc5384abe79fbd32c`
passed all five jobs in [CI37553654551](https://github.com/dukkanai/onlinu/actions/runs/37553654551),
verified 2026-10-07 00:54 UTC. The private manifest/metadata tests passed ordinary
regression. The actual disposable PostgreSQL archive (89,070 bytes) restored
into a fresh collision-checked database: all43 public-table and6 sequence
fingerprints matched and the source remained unchanged. Neighbor uptime,
recreation and isolation checks passed. Four exact-source runtime reports were
inspected and both immutable verification receipts independently rehashed and
identity-bound. Synthetic local runtime image ID:
`sha256:7a4ef457b9c2e19efdee65ded24dbd4514f2a188680d74529c44fb2cb866f868`.
No archive bytes were uploaded, and no production deployment, registry publication,
real credential creation or activation occurred. Production/session/media backups,
off-host recovery and real credential/mount acceptance remain separate gates.

## Shared loopback authentication — 2026-10-07, CI pending

A private bounded direct-HTTP capability now checks health plus missing, wrong
and approved administrator-key responses without redirects, proxies, retries,
cookies or body retention. The trusted caller supplies an approved bounded key
loader; no real key is read, generated or configured here. Seven real loopback
checks and local platform255pass/12DBskips pass. The journal/Docker fixture now
uses the shared capability with public synthetic credentials. Remote acceptance
is pending; see `prototype/platform/PROVISIONING-AUTHENTICATION.md`.


Loopback-auth acceptance: `dfebcaebea60489d63c2efe4057ccd4165f15265`
passed all five jobs in [CI37554750785](https://github.com/dukkanai/onlinu/actions/runs/37554750785),
verified 2026-10-07 01:07 UTC. Both actual successful and unknown-reply runtime
verification paths passed the shared health/missing-key/wrong-key/valid-key
transport. Four source-bound runtime reports were inspected and both immutable
receipt hashes and job/worker/tenant/plan bindings independently verified.
Synthetic local image ID:
`sha256:4e7e053fb159789289d686b9720b0f3027102e7c022f3241db6ff8741af5e35b`.
Production key loading, registry publication, activation and deployment remain
separate; no real credential or provider account was used.

## Existing pinned-image preflight — 2026-10-07, CI pending

A private read-only gate resolves only the original preparation's two exact
repository digests already present on the local daemon. Linux/amd64, canonical
configuration IDs, different service images and original runtime UID are checked;
missing images fail without login, pull, build or retry. Four compiler/transport
test groups pass locally. Real reviewed release digests and registry provenance
remain external gates; see `prototype/platform/PROVISIONING-IMAGE-PREFLIGHT.md`.


Pinned-image preflight regression: `76e3419e6d38871bee407da71f54d638dbc1b3b9`
passed all four ordinary jobs in [CI37555755861](https://github.com/dukkanai/onlinu/actions/runs/37555755861),
verified 2026-10-07 01:19 UTC. Actual database, browser, native TLS, Windows tests
and builds passed. The new image-inspection tests still use a simulated Docker
transport with real compiler-branded preparations; no production registry image
was published or inspected. The optional runtime-image job was intentionally
skipped, so the latest full-image checkpoint remains `dfebcae`/CI37554750785.

## Private host-driver composition — 2026-10-07, CI pending

The existing private coordinator now has a composed driver implementation using
reviewed image inspection, original staged manifests, current heartbeat fences,
empty-resource checks, one Compose attempt and immutable verification. It has no
server route or startup wiring. Six local groups include the actual coordinator,
compiler, stager and transport with synthetic external capabilities and mock
journal, covering success/uncertainty and no replay. Original relative bootstrap
mount resolution is mirrored without changing the staged manifest. Production
host/credential/release acceptance remains open; see
`prototype/platform/PROVISIONING-HOST-DRIVER.md`.


Host-driver assembly regression: `fba4361a8abf59303bd99875ba4ad7acc8b1eb70`
passed all four ordinary jobs in [CI37556938885](https://github.com/dukkanai/onlinu/actions/runs/37556938885),
verified 2026-10-07 01:32 UTC. Local platform265 pass/12 database skips were
followed by successful actual database/browser/native TLS and Windows CI checks.
The composed-driver-specific tests use real coordinator/compiler/stager/manifest
components with explicitly synthetic external capabilities and a mock journal.
This remains component assembly acceptance, not an actual production-host apply.
Runtime-image was intentionally skipped; latest full-image remains dfebcae.

## Opt-in Android compile smoke — 2026-10-07, CI pending

The existing Dart client gains a manual, isolated standard-Linux Android build
check generated from official checksum-pinned Flutter templates. It preserves
Windows sources and the reviewed dependency lock. Only an arm64 debug APK using
control.invalid may be retained; manifest backup/cleartext/debug/package and ABI
are inspected after compilation. No device, release key, mobile login audience,
store publication or new SDK agreement is configured. Four local guards pass;
actual scaffold/build remains pending. See
`prototype/admin_flutter/ANDROID-COMPILE-SMOKE.md`.


Android compilation acceptance: `c7ca1bc9c1ba39315f8af0f78a1911e8ca2df7c2`
passed all five requested jobs in [CI37558220905](https://github.com/dukkanai/onlinu/actions/runs/37558220905),
verified 2026-10-07 02:10 UTC: Android compile, Windows, server, client and control
image. Runtime-image was intentionally skipped. The downloaded debug arm64 APK
is89,727,234 bytes, independently hashed to
`cbf438982d00ae8ef4d08c38c506233979f09b260bad011c5123500df91b9a3f`;
its ABI and source-bound report were independently checked. CI decoded and
validated the built manifest. The reserved control.invalid origin, debug status,
synthetic package identity and all device/login/distribution limitations above
remain. This is the first Android compilation checkpoint, not mobile release
or actual-device acceptance. Latest full Docker-image checkpoint remains dfebcae.

## Opt-in iOS Simulator compile smoke — 2026-10-07, CI pending

A manual standard-macOS gate generates an isolated official Flutter iOS scaffold,
copies reviewed Dart/locked dependencies, and builds only a control.invalid debug
Simulator bundle with code signing disabled. Built identity/platform/transport,
no device profile, architectures and archive hash are checked. No Apple account,
new agreement, real credentials or phone installation is involved. Three local
iOS guard groups pass; actual macOS compilation is pending. Android and iOS
artifacts include preserved project licenses plus corresponding source links.
See `prototype/admin_flutter/IOS-COMPILE-SMOKE.md`.


iOS/Android compilation acceptance: `44431e9aca475723d2f21fdd428b390f66048f70`
passed all six requested jobs in [CI37561928593](https://github.com/dukkanai/onlinu/actions/runs/37561928593),
verified 2026-10-07 02:35 UTC: server, Windows, control image, Android, iOS and web.
Runtime-image was intentionally skipped. Xcode26.6 built a dual arm64/x86_64 iOS
Simulator bundle. Its55,116,192-byte archive hashes to
`1c5edfd40cb79ab8e9e6510e2a8affbe34efe08fdd53394e452264b7a41c1580`.
The Android89,727,246-byte debug APK hashes to
`500c8ece004b99a77a28506f03e52e0772ddc3c9a1c95f7663a4e916fcdc3367`.
Both downloads were independently source/hash/size/license checked. The iOS built
plist was independently parsed from the archive and its Simulator identity,
transport/file-sharing flags and absence of a device profile verified. Android's
arm64 Flutter engine was independently checked. Neither mobile application was
run on a device or Simulator; login, platform storage, rendering and release
acceptance remain separate. Latest full Docker-image checkpoint remains dfebcae.

## Owned iOS Simulator execution — 2026-10-07, CI pending

An additional explicit iOS input creates only a fresh, uniquely identified
Simulator from an available observed runtime, tests synthetic Keychain isolation
and Arabic order-detail/logout rendering, then verifies cleanup of that device.
No existing simulator, physical phone, login account or broad cleanup is used.
Three added local ownership/selection/uncertain-create guards and Dart formatting
pass. Actual device-plugin/rendering checks are pending; the retained compile
archive remains distinct from the integration-test target. See the iOS smoke doc.

First iOS execution run CI37563287798 passed all four ordinary jobs and rebuilt
the Simulator application, but the post-boot `simctl list --json` ownership read
exceeded60 seconds before either native test began. It is not a Keychain/UI test
failure or acceptance. The owned device's verified cleanup path completed.
Subsequent ownership checks now request only device inventory with a bounded
180-second deadline; no identity check, test or cleanup guard was removed. A new
fault-injection test proves a post-boot read timeout stops test execution and
cleans only the exact reverified created device. Actual execution remains pending.


Second iOS execution run CI37564269290 passed both actual Keychain and Arabic
order-detail/logout tests and confirmed owned device cleanup. Screenshot
collection failed because Flutter test uninstalls by default; this was verified
in the pinned SDK source. The supported `--no-uninstall` option now keeps only
that new test app until evidence is copied, then the same verified device cleanup
runs. A local lifecycle test covers retention and collection. Aggregate and
visual acceptance remain pending the corrected run; no functional guard changed.


iOS execution acceptance: `28b3c73237fc298eb6114b1fab55cf83b8369452`
passed all five requested jobs in [CI37566678856](https://github.com/dukkanai/onlinu/actions/runs/37566678856),
verified 2026-10-07 03:42 UTC. The new owned iPhone17 Pro Simulator on iOS26.5
passed actual Keychain isolation/readback/removal and Arabic order-detail/logout
tests, screenshot collection and verified device cleanup. The downloaded PNG
hash `1a4feada43fbf54b9580cc414009ac915c5bba439a9614ea4d1128cbf336b532`
was independently checked and the image visually inspected: Arabic detail,
amount, note and close control are readable without clipping. The55,116,203-byte
compile archive independently hashes to
`32807fa57eea2a5661e58210e4a251ee2cf7a1c59a32fbae49e1dd4c16cf7a9c`;
its source, built plist and preserved licenses were checked. This is synthetic
Simulator execution, not a physical iPhone, mobile login or store release.
Android/runtime-image reruns were intentionally skipped; their latest separate
checkpoints remain44431e9 and dfebcae respectively.

## Mobile authentication policy preparation — 2026-10-07

The strict Windows loopback check now lives in a shared pure policy module.
Separate Android/iOS client identifiers and exact reverse-domain callbacks are
covered by opt-in policy tests, but are not enabled in the running broker.
No registration, real provider access or mobile login is performed. See
`prototype/platform/NATIVE-MOBILE-AUTH.md` for integration and release gates.
Local platform tests: 269 passed, 12 database-dependent cases skipped; the
initial runtime packaging omission was caught and corrected before this result.
Aggregate CI37593760469 passed all four ordinary jobs for `1c515984fbb8db48500ce4c1327dcc959ae0bc18`, verified 2026-10-07 08:36 UTC. Mobile and full runtime-image jobs were intentionally skipped.

## Mobile broker integration — 2026-10-07, aggregate CI pending

Local server-side integration adds explicit default-off
`CORE_NATIVE_MOBILE_ENABLED`, requiring native staff support. Registration and
callback validation bind separate Android/iOS public clients; disabled mobile
clients cannot authorize, exchange, refresh or authenticate existing bearer
grants. Browser-owned revocation remains available. Disabling is not permanent
revocation; re-enabling may restore still-valid grants. Consent labels identify
the platform and CSP handles private-use schemes without a null-origin source.
Local platform tests: 270 passed, 13 PostgreSQL-dependent cases skipped. New
actual database and HTTP coverage awaits hosted CI. Flutter/OS handoff and real
mobile-login acceptance are still incomplete. No deployed configuration changed.

Broker integration acceptance: `5fc868bbf936a29309a877c9ce7298d418726aa0`,
CI37596296616 all four ordinary jobs passed, verified 2026-10-07 08:59 UTC.
Server log confirms 383 platform tests passed, zero skipped, including actual
PostgreSQL mobile grants and both HTTP opt-in states. Flutter/OS handoff remains
incomplete; no mobile device or external-account acceptance is implied.

## Flutter mobile callback integration — 2026-10-07, aggregate CI pending

The native client now chooses separate Android/iOS client IDs, listens to raw
app-link strings, and validates active-attempt state, issuer, exact callback,
code shape and duplicate parameters before exchange. Mobile storage and refresh
requests bind the selected client; Windows keeps its existing loopback listener.
Cancellation and completed/old callbacks cannot establish a new session.
`app_links` 7.2.2 and its three dependencies were resolved by the actual pinned
Flutter SDK, with registry hashes and generated Windows registration reviewed.
Local SDK bootstrap is now working: formatter and analyzer pass; all 151 Flutter
unit/widget tests and all 80 deployment guards pass. No lock hash was invented.
Generated mobile smoke apps register only their control.invalid callback scheme.
A new iOS native-plugin self-callback test uses synthetic transport and OS secure
storage, not a real provider login. Compilation and actual Simulator execution
of this increment are pending CI; production identity, signing and login remain
separate acceptance gates.

Mobile callback acceptance: commit `7b141aad9bffa5d601db9dbd83772a09ac4a6e52`,
[CI37599337539](https://github.com/dukkanai/onlinu/actions/runs/37599337539),
all six requested jobs successful, verified 2026-10-07 09:31 UTC. Android
compilation and actual iOS own-scheme callback/Keychain/Arabic rendering tests
passed; downloaded artifacts and owned Simulator cleanup were checked. This
is synthetic callback acceptance, not a real provider login or Android device
execution. No production or release-signing configuration changed.

## Android emulator prerequisites — read-only probe, 2026-10-07

An explicit `android_probe` CI input inspects preinstalled SDK image metadata,
emulator availability, current KVM access and disk space. It installs nothing,
starts no device, accepts no new agreement and changes no security permissions.
Its report is diagnostic evidence only, never Android execution acceptance.
The default ordinary CI gates remain unchanged. Local deployment tests: 83 pass;
hosted prerequisite facts are pending the probe run.

Android preflight CI37602010239 passed and its report was downloaded: no emulator
or image installed, KVM exists but is not readable/writable by the runner. The
next explicit android_execute trial uses software emulation with no permission
changes, only official packages under already-accepted licenses, owned AVD
identity checks and bounded cleanup. Local 86 deployment guards/analyzer pass;
actual execution is pending. No new agreement or host security change is made.

First Android software-emulator execution CI37603475763: all four ordinary
jobs passed. API35 boot and owned identity were verified, and all three actual
Android tests passed (Keystore, owned callback, Arabic detail/logout). Aggregate
acceptance failed afterward while validating screenshot transfer. The subsequent
change uses bounded, strictly decoded base64 for the single owned PNG and adds
safe length/header diagnostics; it does not weaken PNG checks or cleanup. Local
87 deployment guards and Flutter analyzer pass; the corrected aggregate remains
pending. No KVM permission or license-acceptance change occurred.

Android retry CI37606273840 (`0c1e8e6`) passed the four ordinary jobs but timed
out before software-emulator boot completed. No native tests or corrected PNG
transfer ran in that retry. The earlier three Android tests passed only in
CI37603475763, whose artifact stage failed. Full Android execution acceptance
therefore remains open. Hardware-acceleration access has not been changed;
a specific temporary hosted-runner KVM permission request is pending approval.

A specifically approved accelerated Android trial is now prepared behind the
false-by-default android_accelerated input. Only the test user's KVM ACL may be
added, with a strict original-basic-ACL guard, private backup, always-run restore
and exact readback comparison. No chmod666, group change or production setting.
Local 89 guards and shell syntax checks pass; execution/restoration are pending.

The first accelerated dispatch CI37609530296 stopped in its synthetic guard
suite before the KVM grant step: test fixtures inherited the real job's KVM
mode. No KVM permission was changed in that attempt. The fixtures now explicitly
isolate software mode while separately testing KVM access validation. All 89
local guards pass with the outer environment set to KVM; the actual accelerated
trial and screenshot transfer remain pending.

Accelerated retry CI37610729654: KVM grant succeeded, API35 boot completed,
and all three real Android tests passed in nine seconds. The always-run step
restored and compared the original KVM ACL successfully. Aggregate still failed
at screenshot transfer. The new device log establishes the exact cause:
Directory.systemTemp is this app's code_cache, while retrieval used cache.
The fixed reader now uses only the observed code_cache filename, retaining
strict base64/PNG checks and all cleanup guards. Local 89 tests pass; corrected
artifact/aggregate acceptance awaits the current trial's retry.

Android execution acceptance: `28cb34e2de0c12ca0f8af69f1833e15fcf4ee775`,
[CI37612156244](https://github.com/dukkanai/onlinu/actions/runs/37612156244),
all five requested jobs passed, verified 2026-10-07 11:21 UTC. Three actual
API35 emulator tests passed, own screenshot/cleanup verified, and original KVM
permissions restored with exact comparison. The downloaded APK/source/licenses
and screenshot hashes were checked; Arabic rendering was visually inspected.
The emulator integration target uses x86_64; the separately archived compile
APK is arm64. Real-provider login, physical phones and release remain unverified.

## Structured opening-hours core — 2026-10-07, CI pending

The existing completion plan requires machine-readable hours rather than a
free-text open-now claim. A separate default-disabled Saudi schedule now has
reviewed signed settings updates, CAS/audit, date exceptions and explicit
midnight boundaries. Quotes/new orders enforce it, accepted receipt retries and
existing fulfillment remain available, and legacy profile edits preserve it.
Public timestamped status is no-store and distinguishes unconfigured hours.
Three local policy groups pass; five DB-dependent groups await hosted CI. See
`prototype/platform/OPENING-SCHEDULE.md`. UI editors/filter integration are not
included yet; no production state has been changed.

Opening-hours core acceptance: `5d355255914ebfd44c47b1f84ec42651836a0fba`,
[CI37617238660](https://github.com/dukkanai/onlinu/actions/runs/37617238660),
all four ordinary jobs passed. The server ran the full uncached race suite with
its disposable PostgreSQL URL configured; all 383 platform tests passed without
skips. The five locally skipped opening-hours DB groups are included in that
server suite. Mobile/full-image jobs were deliberately not requested.

Browser/native staff schedule transport and a two-step Arabic browser editor
are now implemented locally, with strict complete-document validation, response
binding, current permission rechecks after body parsing, CSRF, stale-version
rejection and ambiguous-result reload without automatic retry. Exceptions and
midnight ranges are explicit. Actual HTTP/Chromium acceptance is pending the
next CI; Flutter editor and public directory filtering remain incomplete.
Local browser/API increment checks: 277 platform tests passed, 13 DB-dependent
cases skipped; all 89 deployment guards passed. The first runtime-packaging
check caught the new modules missing from the explicit Docker allowlist; that
was corrected and the complete local suite rerun successfully.

Browser/API functional acceptance: `3142f2427a126769b18cd050114e83ec6dbbddaa`,
[CI37619297901](https://github.com/dukkanai/onlinu/actions/runs/37619297901),
all four ordinary jobs successful. Server logs confirm 390 platform tests with
zero skips, uncached Go race success and actual HTTP/Chromium core-control flow.
Browser review/cancel/reload/save, native shared route, stale/review/authority
checks and restoration completed. CI screenshot was uploaded, but downloading
its blob was blocked by the execution network policy. Local standalone Chromium
rendering also could not start its process-singleton socket in the sandbox.
No screenshot was visually inspected or delivered; visual acceptance remains
open. These limits do not negate the recorded hosted browser assertions, and
no access restriction was bypassed. Flutter editor/directory integration remain.

Flutter opening editor increment: immutable bounded schedule/date models, exact
native response binding, tenant/section/version write fences, stale/offline
blocking, explicit edit-to-review-to-apply UI, cancel/back and fresh reads after
uncertainty. Long interval lists wrap beneath day labels. Locally all 155 Flutter
unit/widget tests and analyzer pass. New actual Dart TLS-to-Node-to-Go and Windows
renderer tests are prepared but await ordinary hosted CI; no Android/iOS rerun or
release acceptance is implied. Browser visual-review restriction remains open.

Flutter opening-hours functional acceptance: `ccc07c730e6f890bcf6b51388af685c1cf8c7732`,
[CI37621806474](https://github.com/dukkanai/onlinu/actions/runs/37621806474),
all four ordinary jobs passed. Logs confirm 155 Flutter tests, 17 actual Windows
native tests (including schedule review/save), original uncached Go race suites,
390 platform tests with no skips, and actual Dart fixture-TLS/Node/Go integration.
Mobile jobs were not requested; no new Android/iOS claim. Retained screenshots
have not been independently downloaded/visually inspected under the current
artifact-access restriction. Public status/MCP directory integration remains.

Public opening-status adapter/MCP increment: pinned original-core GET, strict
consistent response schema and bounded timestamp age (60s past/30s future), with
published-restaurant checks before and after the read. A read-only MCP tool uses
the current catalogue auth scope; caller timestamps are rejected. Disabled
schedules remain explicitly unknown hours, and intake is not a promise of stock,
coverage or payment availability. Locally 279 platform tests passed, 13 DB cases
skipped. Actual published-core/MCP integration awaits CI; no bulk open-now search
filter or broad fan-out was added.

First public-status CI37623670037 passed the new actual published-core MCP flow
but failed the older 15-template/mode adapter parity cases because their exact
three-tool discovery expectation omitted the newly added read-only status tool.
The fixture now expects four tools and additionally calls/validates status for
each of its two isolated restaurants. No product authorization or validation was
weakened. Corrected aggregate acceptance is pending the retry.

Public status/MCP acceptance: `a088d3768c0a377b7a450d3eddf471b2f6f09c73`,
[CI37624775281](https://github.com/dukkanai/onlinu/actions/runs/37624775281),
all four ordinary jobs passed. Server logs confirm both uncached original-core
race suites and 392 platform tests with no skips. Updated 15-template/mode
parity fixtures and published-restaurant MCP status reads passed. This remains
synthetic protocol/core integration, not real ChatGPT account acceptance.

Bounded open-restaurant MCP search is implemented with explicit page/cursor and
coverage counters. It excludes unconfigured/unknown states and requires both
scheduled hours and manual intake, limiting per-process concurrent reads. Local
283 platform tests pass; 13 DB-dependent cases skipped. Actual original-core
unconfigured/always-open/search/restore flow is added for hosted CI. No external
ChatGPT account, background polling or production setting changed.

Bounded open-search acceptance: `cdd9f28c1293a046022fa62b4c8a2a3680ad0748`,
[CI37626795229](https://github.com/dukkanai/onlinu/actions/runs/37626795229),
all four ordinary jobs passed. Server logs verify original uncached Go race
suites and 396 platform tests without skips. Actual published-core MCP fixtures
prove unconfigured exclusion, reviewed always-open policy, matching search and
restoration. Pagination/concurrency/uncertainty checks also pass. This is not
external-account acceptance or evidence of a complete live restaurant directory.

Original React storefront intake increment: public opening-status snapshots now
supply the displayed new-order gate instead of the catalogue's stale manual-only
flag. Unknown/unavailable status is labeled separately and blocks fresh ordering,
while original tracking/account and uncertain accepted-order recovery remain
available. Polling is read-only every30seconds with a5second bound, pauses while
hidden, aborts obsolete reads, and fences late replies/unmounted effects. The
server remains authoritative; no client timezone calculation or availability
promise is introduced. Local84client tests passed via Node's tsx import loader
(the tsx CLI's IPC socket is unavailable here), TypeScript/Vite build passed,
and89deployment guards passed. A new isolated compiled-React Chromium check
covers all five templates, closure, unknown/retry/live updates and Arabic RTL.
Hosted renderer acceptance passed on `c5ede0fadb24fb3cc082f3be5119b99ef6a91ad7`,
[CI37646310938](https://github.com/dukkanai/onlinu/actions/runs/37646310938):
all four ordinary jobs passed. The first renderer run exposed an ungated dish
dialog add button; the fix binds the live intake state to its disabled property
and handler. The next run exposed an exact-text locator issue resolved by
separating the unknown-status text from its retry action. The final real Chromium
run passed all five templates, closed/unknown/retry states, live closing of an
already-open dish dialog, Arabic RTL, width checks, and absence of writes or
external requests. Screenshot artifact11493214249 was uploaded but has not been
independently visually inspected. No production or external-account acceptance.

WhatsApp intake preparation adds a private, read-only cart proposal boundary with
server-resolved scope/generation/peer binding, original-timestamp expiry, bounded
canonical internal cart IDs, separate event/content fingerprints and deep copies.
Original-core previews remain authoritative and do not create orders or reserve
stock. There are no new public routes, transport hooks or enabled adapters.
Provider mapping, durable inbox, explicit customer confirmation, send/recovery
and live-account acceptance remain open. See
`prototype/platform/WHATSAPP-ORDER-INTAKE.md`; hosted DB acceptance is pending.

Private WhatsApp proposal acceptance: code7226bb64b65fbf12a927d976495329bb0c30166d,
CI37661591551, all four ordinary jobs passed. Original uncached Go race suites
ran with disposable PostgreSQL configured; 396 platform cases/no skips,84client
cases/build/browser and Windows gates passed. Arabic/English error translations
fixed the first aggregate run's coverage failure. This accepts the private
read-only proposal boundary only, not a live WhatsApp shopping adapter.

Private WhatsApp inbox increment adds an immutable per-event PostgreSQL journal,
concurrent duplicate receipts, conflicting-payload rejection and unchanged expiry
across restarts. It is not initialized at startup or connected to a transport.
Local pure tests/vet and client checks are separate from its pending hosted
PostgreSQL concurrency/restart acceptance; no live message or order is created.

Private inbox acceptance:6034574e86bc4f9ce1853a53e6277e9921032b70,
CI37663927719 all four ordinary jobs passed. Dedicated verbose Go race logs
confirm actual PostgreSQL concurrent/restart/expiry/conflict/isolation tests
and original-core read-only pricing, without skipped WhatsApp cases. Full Go
race and396platform cases/no skips passed. Transport wiring and final ordering
remain unavailable; this is not a live WhatsApp test.

Private QR text extraction now uses the pinned whatsmeow event model in synthetic
tests: verified direct-chat sender consistency, opaque PN/LID separation,
history/echo/forward/edit/group rejection, bounded untrusted text and unsupported
native-order-card rejection. It is not attached to Session.onEvent and makes no
connection, sends or order. Local tests/build/translation checks precede hosted
acceptance; source binding and conversation confirmation remain separate gates.

QR extraction acceptance:cccb463831dd493a9b73ab3577903d5d7570753c,
CI37666341094 all four ordinary jobs passed. Focused Go race logs verify typed
synthetic direct-message extraction and rejection cases together with durable
inbox/core-price tests. Full Go race and396platform cases/no skips passed.
No live session event hook, QR login, incoming/outgoing message or final order.

Private WhatsApp review-store implementation is prepared: original-core complete
checkout quote/input fingerprints, per-conversation CAS/supersession, bounded
expiry, presentation binding and durable confirm/cancel intent with concurrent
replay protection. It has no startup/HTTP/provider hook or final-order dispatch.
Local compile/vet/pure/client checks are separate from pending hosted PostgreSQL
concurrency/restart/price-change acceptance. Details and limitations are in
`prototype/platform/WHATSAPP-CONVERSATION-DESIGN.md`.

Private WhatsApp review-store acceptance:e5d805ded23e4e327b869e031ea2ecfa87be6720,
CI37694002174 all four ordinary jobs passed. Four focused actual PostgreSQL/race
cases cover concurrent confirmation/restart, supersession/cancellation/expiry,
identity/price/cart/corruption and cancel-versus-confirm races. Full Go race and
396platform cases/no skips passed. A confirmed review is customer-intent evidence,
not an accepted order, successful outgoing message or payment. Final dispatch,
real account binding and conversation presentation still require implementation.

Private WhatsApp confirmed-review dispatch is implemented but unwired/default-off.
It claims one durable core submission key, binds actual normalized input/owner,
and rechecks current authority, review expiry/version and channel-policy version
inside the original stock/order transaction. Lost committed results can recover;
unknown unaccepted work cannot create a new order after expiry or a policy cycle.
No API or provider connection is enabled. Local pure checks/vet/build,84client
checks/build and89deployment guards passed; hosted PostgreSQL concurrency,
recovery and final-order acceptance remain pending.

Private final-dispatch acceptance:0d218ad8105c723b9fa06378407bfd150e4c9afc,
CI37701906784 all four ordinary jobs passed. Actual PostgreSQL/race tests create
one original-core order/reservation from12 concurrent attempts for each WhatsApp
channel identity, with stable-key lost-result recovery and stale/changed/revoked
rejection. Full Go race and396platform cases/no skips passed. Authority is synthetic
in these fixtures; live transport remains unwired/default-off with no messages.
