# Native client verification boundaries

## 1. Pure/controller/widget tests

`flutter --suppress-analytics test --no-pub` checks PKCE callback binding,
rotation/logout fences, typed API contracts, permission/tenant isolation,
optimistic versions, Arabic numeric input and interrupted/cancelled forms.
Gateway and OS-store mocks are explicitly synthetic. These tests do not prove a
merchant account login, an installed device or a real provider transaction.

## 2. Actual Windows plugins and rendering

`flutter --suppress-analytics test integration_test/windows_smoke_test.dart -d windows --no-pub`
uses the Windows runner, actual secure-storage plugin and native rendering.
It touches only randomly named disposable synthetic storage keys; it never
enumerates user credentials. Form gateways are synthetic. Screenshots capture
settled frames and contain fake data only. Browser launch capability is checked,
not an interactive OIDC/MFA flow. An unsigned `.invalid`-origin release build is a
compile/link check, not a deployable production client.

## 3. Actual Dart → TLS → Node → signed original Go/PostgreSQL

The existing `TestPlatformOrderNodeSignatureCompatibility` fixture can additionally
run `integration_http/core_live_http_test.dart` when `CORE_FLUTTER_TEST_BIN` points
to an absolute official Flutter executable. The CI server job installs the same
checksum-pinned Flutter 3.47.5 SDK and enables this path; its verbose output must
include `Verified actual Dart PKCE/broker consent...`.

Prepare the disposable test databases and environment described by the CI workflow,
install locked platform/Flutter dependencies, and run from repository root:

```sh
CORE_FLUTTER_TEST_BIN=/absolute/flutter/bin/flutter \
TEST_CORE_ADAPTER=1 \
go test -race -count=1 -v ./cmd/server -run '^TestPlatformOrderNodeSignatureCompatibility$'
```

The fixture requires `TEST_RESTAURANT_PG_URL` and `IDENTITY_TEST_DATABASE_URL`
pointing at the isolated test databases. Do not point test variables at production.
The original Go test supplies its temporary core endpoint/signing key and the Node
fixture creates isolated central schemas and synthetic verified identities.
No real provider account or payment is used; existing mocked-provider assertions
remain in place. This is an additional opt-in integration test, not a silently
skipped case inside the ordinary Flutter unit suite.

What is actually exercised:

- Real `CoreAuth`, `CoreApi` and `CoreController` HTTP code, PKCE/code exchange and
  broker CSRF-protected consent using a seeded synthetic browser session.
- HTTPS with a per-run generated certificate for reserved `platform.example`.
  Only that certificate is trusted in the test client's isolated SecurityContext;
  a deliberately wrong hostname is rejected. No `badCertificateCallback`, OS trust
  installation, DNS/proxy/firewall change or browser warning bypass is used.
- A test-only connection factory routes the reserved origin to the local TLS
  listener while retaining certificate hostname verification. No public service
  is contacted by the native protocol test.
- Staff profile, historical order details, an actual accepted→preparing transition,
  versioned menu/category/options/stock updates, channel toggle/restore, and
  disabled draft creation through the real Node and original Go APIs.
- Rotating refresh, deliberate replay of an old synthetic refresh token, family
  revocation, loss of access and clearing of controller/cache/store state.
- The parent fixture independently verifies the advanced order version and still
  checks cash settlement/stale conflicts, exactly three orders and provider-call
  deduplication. No extra orders are created by this native test.

The TLS key/certificate live only in an owned temporary fixture directory and are
removed afterward. Synthetic session material is passed only to the fixture child,
not printed or committed. The consent browser/identity provider is seeded rather
than a real system-browser login; OS keystore verification remains in section2.

## Still required before release

Real merchant-device/system-browser/OIDC/MFA acceptance, signing/update/rollback,
provider-account acceptance, desktop accessibility acceptance (including NVDA),
remaining management parity, device/printer-specific tests, load/distributed-limit
verification and an explicitly approved production rollout. POS vendor integration
is deferred by the owner and is not covered by these tests.

## Native menu image increment (2026-10-05)

The native client uses the official Flutter `file_selector` plugin, reads a single
PNG/JPEG as a bounded stream (5 MiB), and requires an explicit upload after selection.
The fixed native binary endpoint shares the two-upload budget with browser uploads,
rechecks membership after reading and after normalization, and uses the original Go
image normalizer followed by catalogue CAS. A failed assignment may leave an orphan
blob; no old image is deleted. Only content-addressed same-origin public previews are
fetched, without bearer/cookies, with MIME, byte, magic, digest and dimension bounds.

Unit tests cover cancellation, explicit upload, stale versions, permission changes,
late preview after logout, URL restrictions and byte limits. The actual Dart TLS
fixture now uploads to Go, fetches the normalized preview, and rejects stale/invalid
images. Windows rendering uses an injected synthetic picker; it does **not** prove
the interactive OS chooser, filesystem permission handling or a merchant's device.
Those checks remain a release acceptance requirement.

## Native team management increment

The team section lists current membership records and supports adding an already
verified principal UUID, assigning a role/defaults or granular permissions, changing
a restaurant-local display name, and disabling/re-enabling membership. Every change
has a review step, version CAS and explicit confirmation. The original transactional
directory still enforces audit insertion, grant limits and last-owner protection.
No email matching, account creation, invitations or platform-operator promotion is
performed. New users obtain their UUID after verified browser login at `/manage`.

Native membership operations now explicitly use restaurant-only directory authority:
a platform operator's separate privileges cannot elevate a limited restaurant role.
Suspended restaurants cannot change membership through this native path. Directory
and HTTP regression tests cover this distinction; browser platform operations retain
their existing policy. The Dart TLS fixture verifies listing, versioned alias update,
stale conflict and last-owner protection with synthetic principals. Windows rendering
uses a synthetic gateway; real staff accounts/permissions require separate acceptance.

## Public restaurant profile increment

The six public business-text fields (name, description, address, phone, informational
opening-hours text and pickup instructions) have separate settings read/update
permissions. Browser and native forms require review before publication. They do not
change prices, tax identifiers, payment configuration, delivery rules, appearance
drafts or table capabilities. Opening-hours text is not an automatic ordering schedule.
The original catalogue row-lock CAS and transactional actor audit are reused; focused
Go tests cover preservation, stale versions, validation and rollback on audit failure.
Real Dart HTTP tests cover the narrow update and stale conflicts. Chromium and Windows
form acceptance runs in CI; actual merchant data remains outside these synthetic tests.

## Delivery pricing and district coverage increment

Native and browser forms reuse the original flat/district fee policy and original
geographic hierarchy. Each pricing edit or single-zone edit has catalogue CAS,
settings permissions and actor-attributed transactional audit. A positive enabled
flag requires an explicitly configured fee; zero is free, null is unconfigured.
Retired districts can be disabled but not re-enabled. Public dataset name, GPL-2.0
license and non-official/incomplete-data warning are retained. Descriptive geographic
names are not quote authority; the original save transaction validates active parents.

The UI reviews the effect on new orders across channels. Existing order fee snapshots,
other zones, radius/location requirements, payment settings, table capabilities and
appearance drafts remain unchanged. No automatic write retry occurs. This increment
does not implement per-kilometre pricing, native geographic corrections, courier
assignment/tracking, or changing the restaurant's service/global-opening flags.

Local tests cover historical fee preservation, explicit zero/missing fees, hierarchy,
stale versions, retired-zone disabling, permission loss and audit rollback. Actual
Dart TLS tests traverse the geographic hierarchy, save a free zone, toggle pricing
and restore the original mode. Chromium/Windows form verification is a separate CI
gate; all data used by these fixtures is synthetic.

### Functional fixture client budgets

The expanded browser suite and native suite previously shared one loopback IP and
exhausted the real 240-request/minute ingress budget. The native TLS fixture now
binds a distinct ephemeral loopback client address (`127.0.0.2`); the intercepted
browser forwards from `127.0.0.3`, separate from the direct API harness. The Node fixture
asserts the observed peer. Production limits, proxy trust and authentication remain
unchanged. This isolates functional client scenarios rather than disabling throttling.
It is not a NAT/shared-IP or distributed-load acceptance test: those capacity/fairness
gates remain required before production, especially with multiple polling devices.
