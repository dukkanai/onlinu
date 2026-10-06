# onlinu — project reference

Updated: 2026-10-05 UTC. Initial inspected upstream: `main` at
`90b16a000c2cad908e51e78d01a07bfb4e785410`.

## Workspace and source of truth

- Working directory: `/workspace/scratch/46a62ae0b82b/onlinu`.
- Remote: `https://github.com/dukkanai/onlinu.git` (private).
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
