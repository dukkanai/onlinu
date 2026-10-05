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
