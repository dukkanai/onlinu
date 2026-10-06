# Native client verification boundaries

Latest verified code: `35eb297cdb51e76f679c7b38712f7c9f79c4ed22`, all jobs passed
[CI37379196274](https://github.com/dukkanai/onlinu/actions/runs/37379196274) on
2026-10-05. 108 Flutter tests, native Windows renderer/store/build, actual Dart
HTTP and Chromium checks passed. Financial/picker screenshots were inspected.
Historical pending notes below describe earlier increments and are superseded by
this result where the feature is covered. Real account/device/provider acceptance
and production deployment are not implied.

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

## Dispatch to existing original-core couriers

The dispatcher can read a minimal roster (at most 500 rows: ID/name/active/current
availability) and explicitly assign, reassign or unassign an unfinished delivery
order. Native/browser review binds the restaurant, order and version. Original
`restaurantCouriers.Assign` remains authoritative and atomically writes its existing
event plus the platform actor audit; a failed audit rolls back the assignment.
No contact details, usernames, passwords, tracking capabilities or location data are
returned by the roster/assignment projection. Existing financial values are unchanged.

Original courier account IDs are **32 lowercase hexadecimal characters** and are
not the control-plane principal UUIDs. No automatic identity linkage is attempted.
A native `delivery:read` grant alone cannot enumerate the roster or dispatch orders;
`delivery:assign` is required. The native screen operates from authorized order rows.
Account creation/password resets, native courier login/identity linking and location
tracking remain separate incomplete work. Existing original courier account flows
are preserved; all accounts created in automated tests are isolated synthetic data.

Local tests cover exact response/version/money bindings, stale/no-op/revoked writes,
late roster revocation, explicit review/cancel, actor attribution and rollback. Actual
Dart TLS tests assign then unassign without new orders or payment calls. The parent
fixture checks both resulting versions before settlement. Windows/Chromium UI
acceptance remains a distinct remote gate for this increment.

## Explicit courier identities and owned work

New native sections require `couriers:link` or `courier:read` respectively.
Bindings require an eligible verified tenant principal, explicit selection and
review; no name/email matching, automatic grant expansion or actual-account
setup occurs during tests. A separate `courier:collect` grant cannot advance a
stage, and `courier:update` cannot confirm cash. The own-work list is bounded to
100 unfinished assignments; selected details show delivery contact/address only.
Versioned link checks run inside the original order transaction. Native unlink
is not a password-login revocation; the binding review explains that limit.

`core_courier_test.dart` checks models, acknowledgements, freshness/permission
fences and review UX. `courier_live_http_test.dart` runs actual Dart through a
pinned synthetic TLS endpoint to Node and Go, with seeded browser identity and
explicit PKCE consent. The Windows smoke includes owned cash and link review
screenshots. Remote results must be recorded before calling this verified on
Windows. No device GPS, real employee binding or production migration is covered.

## Reviewed service intake switches

The native `استقبال الطلبات` section and `/manage/{tenant}/service` expose four
booleans only: global acceptance, delivery, pickup and table ordering. Writes need
`settings:update`, the reviewed catalog version and explicit review. Omitted
fields are preserved, malformed boolean values are rejected, and an open shop
must have at least one enabled method. Existing order settlement is not disabled;
prices/tax/payment configuration and table capability codes are unchanged.

101 Flutter tests/analyzer and 206 platform tests pass locally with the service
increment. Go audit rollback, preserved documents/order history and closed-intake
quote denial pass. Actual Dart closes/reopens through Node and Go and rejects a
stale version; dedicated HTTP checks reject courier access, CSRF failures and
unrelated fields. The additional Chromium and Windows form checks remain pending
until this increment's remote CI completes. No live shop was closed or reopened.

The first service CI (`37362384371`) caught missing legacy React translations for
`invalid_service_modes`. Arabic/English messages and the central browser error
page were added. All 80 React tests and TypeScript/Vite build pass locally; the
platform Arabic-error regression also passes. This correction needs its own full
remote CI result; do not treat the original failed aggregate as release success.

## Read-only financial/refund review

A staff order's financial dialog requires both order-read and payment-read grants.
It shows verified captured funds, reserved refunds, confirmed refunds and available
balance from the original transactional ledger. Pending and manual-report states
remain distinct from confirmed settlement. The dialog and central browser page are
read-only; refund creation/authorization/manual resolution remain a later increment.

Local tests cover sanitized projection, original refund processing/idempotency,
late-response dismissal, current grants, DTO validation and no native payout button.
Actual Dart reads through the Node/Go fixture; new Chromium and Windows rendering
checks must still pass remotely. No real payment or refund has been executed.

## Existing refund review increment (remote acceptance pending)

Manager-only detail now supports reviewed authorization, manual reporting,
provider-reference verification and provider-state refresh for an existing ID.
No new refund creation is added. Two-stage native review binds amount/provider/
demo/version and requires an explicit checked confirmation. Manual reports remain
unconfirmed by the provider. Unknown replies recover by reading the same ID.

Local 115-test Flutter suite and actual Dart-to-Node-to-Go TLS integration pass.
Revoked/closed/backgrounded and stale views are tested; duplicate clicks do not
resend. Windows `windows-refund-review.png`, actual Chromium and the new full CI
result remain to be verified. All money and merchant identities are synthetic.

### Refund verification checkpoint — 2026-10-05 23:02 UTC

Refund UI89e650d passed CI37384391681 and RTL fixture27e8096 passed all jobs in
CI37385242822. Actual Chromium review/cancel, Windows renderer/store/build and
Dart/Node/Go integration succeeded. `windows-refund-review.png` was inspected:
Arabic RTL, amount/provider/demo/version and checked confirmation are readable,
without clipping. This supersedes the pending refund notes above; no real money
was used. Full SaaS and real-account acceptance remain open.

## Appearance review increment (remote acceptance pending)

The core appearance section edits a private original draft, then separately
reviews publication or restoration. Both state/catalog versions and current
settings grants are required. Unedited colors/media are preserved; publication
warns that the entire existing draft becomes public. Foreground freshness,
revocation, duplicate clicks, stale versions and no automatic retry are tested.
Local121 Flutter tests and actual Dart/Node/Go draft/publication/restore pass.
Actual Chromium and Windows draft-review screenshot still need their new CI result.

### Appearance verification checkpoint — 2026-10-05 23:22 UTC

Commit c5446aa passed all CI37387124412 jobs. Actual Chromium and Windows
acceptance passed and `windows-brand-draft-review.png` was visually inspected:
Arabic RTL, tenant, both versions and the private-draft confirmation are readable
without clipping. This supersedes the pending appearance notes above. Color/media
editing and actual customer-template visual preview remain in the original UI.

## Customer support review increment — 2026-10-06 (remote acceptance pending)

The support queue and exact-order lookup reuse original cancellation/complaint
state. `support:manage` is independent of kitchen order-update and refund grants;
existing memberships are not upgraded automatically. Decisions need reason,
review and checked confirmation. Paid-card cancellation remains payment `review`,
with an unauthorised refund intent rather than a payout. Finance can be opened
separately when the staff member already has its grants.

Local 130 Flutter tests and actual Dart TLS/Node/Go support decisions pass, including
suspended-tenant settlement, no refund authority, late/closed/duplicate/stale
requests and revoked-grant masking. Existing native refund tests also pass after
allowing its independently protected dialog from the support section. Actual
Chromium and `windows-support-decision-review.png` still need the new CI result.

## Tax configuration increment — local, 2026-10-06

136 Flutter unit/widget tests and analyzer pass. New cases cover exact Arabic
basis-point parsing, full reviewed transport tuple, wrong-result detection,
stale/background protection, private-field masking, inert cancel and unknown
write recovery. Actual Dart TLS/PKCE → Node → original Go tax update/stale/restore
passes against synthetic PostgreSQL. New Windows review capture/build and Chromium
flow remain remote checks for the tax increment; prior CI does not cover it.

Tax increment remote acceptance: all CI37398729778 jobs passed on
941056bbd6f35db91144c0d98ba63c256b62d838. Actual Chromium tax review and
Windows renderer/store/build passed; windows-tax-review.png was inspected with
readable Arabic facts and checked confirmation, without clipping. All identifiers
and changes remain synthetic; actual device/legal/production gates are separate.
