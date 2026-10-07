# Opt-in Android debug compilation

The CI `android_smoke` input prepares an isolated Android project from the exact
checksum-verified official Flutter3.47.5 templates, then copies the reviewed Dart
application, tests and dependency lock into it. It never overwrites the existing
Windows project or runs a code-writing agent. The source repository remains the
input; generated SDK paths, Gradle caches and signing files are not committed.

The job runs only when manually selected on a standard Linux runner. It analyzes
and tests the copied Dart code and compiles an arm64 debug APK with the reserved
`https://control.invalid` origin. No real account, API endpoint or phone is used.
The package is deliberately `dev.synthetic.restaurant_admin_prototype`, labeled
Onlinu Android Smoke, not a final publisher identity. Android debug signing uses
only the ephemeral runner's ordinary debug build material; no release key or
store account is configured or retained.

The generated main manifest disables Android backup and cleartext traffic and
requires Internet access. The compiled manifest is independently decoded with
the runner's existing APK analyzer and checked for those settings, the expected
package and the debug flag. The archive must contain the selected arm64 Flutter
engine only. A hash-bound JSON report and debug APK are retained for three days;
no key, local.properties, Gradle cache or source credential is uploaded.

The script does not accept a new Android SDK license agreement or run
`--android-licenses`. A missing required SDK/license/analyzer is a build blocker,
not permission to create accounts or accept terms automatically. It uses the
hosted runner's preinstalled SDK and existing accepted configuration.

This gate proves compilation only after CI succeeds. It does not prove Android
rendering, secure-storage behavior, file picking, browser login, lifecycle,
background notifications or physical-device operation. The current native login
client remains Windows-specific; no Android production audience is enabled by
this build. iOS, final application identity, release signing and store delivery
remain separate work. The generated Android scaffold is a reproducible test
workspace, not yet a checked-in shipping Android runner.

Four local Python guard groups pass. Local official SDK download/checksum and
extraction succeeded; local Flutter-tool bootstrap dependency restoration timed
out, so scaffold generation and actual Android compilation are pending CI.


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

Follow-on mobile-auth preparation (2026-10-07, CI pending): local dependency
resolution now succeeds with the pinned SDK. Android chooses its own public
client and exact reverse-domain callback; its generated smoke manifest disables
Flutter's competing deep-link handler and registers only
`invalid.control.onlinu.android`. Decoded-manifest guards verify that exact
scheme/filter. No Android device execution or production login is claimed.

Mobile callback acceptance: commit `7b141aad9bffa5d601db9dbd83772a09ac4a6e52`,
[CI37599337539](https://github.com/dukkanai/onlinu/actions/runs/37599337539),
all six requested jobs successful, verified 2026-10-07 09:31 UTC. Android
compilation and actual iOS own-scheme callback/Keychain/Arabic rendering tests
passed; downloaded artifacts and owned Simulator cleanup were checked. This
is synthetic callback acceptance, not a real provider login or Android device
execution. No production or release-signing configuration changed.

## Software-emulator execution (pending acceptance)

The read-only hosted probe CI37602010239 established that its runner had no
emulator/system image and no KVM access. The new explicit `android_execute`
input therefore attempts bounded software emulation without sudo, ACL changes,
KVM permissions or other host security changes. Android documents this mode as
unsupported and slow; successful startup and tests are not assumed.

Only Google's installed SDK manager may fetch the fixed API35 Google APIs
x86_64 image and emulator. Existing runner license acceptance may be used; any
new license prompt is declined. A unique AVD uses exclusively owned temporary
paths and a free port pair. Its actual guest name must match the created nonce
before tests. No existing AVD, physical phone or shared ADB daemon is stopped.
Ten-minute boot and fifteen-minute test bounds apply. Cleanup stops only the
created process group, checks that the owned guest no longer responds, and
removes only its own temporary files; uncertain cleanup prevents acceptance.

The three new integration tests cover Android secure-storage isolation,
owned-app URL-scheme callback with synthetic transport, and Arabic order detail
rendering/logout. The archived arm64 debug app and x86_64 integration target
are distinct builds from the same reviewed source. Neither is store-signed or
configured for a real provider. Local 86 Python guards and Flutter analysis
pass; actual emulator startup, rendering and storage checks await CI.

## Specifically approved accelerated trial (pending acceptance)

`android_accelerated` remains false by default. Its explicit hosted test enables
only the current runner user's read/write ACL on `/dev/kvm`, after saving and
validating the original basic ACL. It does not use world-writable permissions,
change group membership, change networking, or touch production. An always-run
step restores the saved ACL to that exact device and compares readback before
artifact publication. The emulator driver itself changes no permissions and
requires effective access before selecting `-accel on`.

This option requires applicable action-time authorization for the security
change; its presence is not standing approval for future invocations. The
current approved trial addresses the software-boot timeout and rechecks the
still-unverified base64 screenshot transfer. Local 89 guard tests and both
permission-step shell syntax checks pass. Actual accelerated execution and ACL
restoration remain to be verified in CI.

Android execution acceptance: `28cb34e2de0c12ca0f8af69f1833e15fcf4ee775`,
[CI37612156244](https://github.com/dukkanai/onlinu/actions/runs/37612156244),
all five requested jobs passed, verified 2026-10-07 11:21 UTC. Three actual
API35 emulator tests passed, own screenshot/cleanup verified, and original KVM
permissions restored with exact comparison. The downloaded APK/source/licenses
and screenshot hashes were checked; Arabic rendering was visually inspected.
The emulator integration target uses x86_64; the separately archived compile
APK is arm64. Real-provider login, physical phones and release remain unverified.
