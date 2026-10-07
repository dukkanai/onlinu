# Mobile authentication preparation

The broker accepts only the Windows public client by default. The new
`CORE_NATIVE_MOBILE_ENABLED=true` flag additionally requires
`CORE_NATIVE_STAFF_ENABLED=true`. No deployed environment has been changed.
This server-side preparation is **not end-to-end mobile login acceptance**;
Flutter handoff and native deep-link integration remain incomplete.

`native-client-policy.mjs` now owns the unchanged Windows identifier, loopback
template and strict non-privileged-port check used by `auth.mjs`. Its separate
opt-in policy constructor defines two distinct public client identifiers and
exact private-use callbacks for Android and iOS. The broker registers only
enabled clients and refuses to overwrite mismatched existing registrations.
Codes and refresh grants remain bound to the exact client and resource. Turning
the mobile flag off prevents mobile authorization, exchange, refresh and bearer
authentication, even when an unexpired mobile grant remains stored. Disabling
does not delete or permanently revoke grants: re-enabling can restore unexpired
access; the browser-owned sessions page can explicitly revoke those grants.
Native token revocation also requires an enabled client; browser-owned
revocation remains available independently of the mobile flag.

Mobile callbacks derive from a trusted canonical HTTPS DNS origin, with the
hostname reversed, and the platform appended. For the synthetic origin
`https://platform.example`, the iOS callback is
`example.platform.onlinu.ios:/oauth/callback`. This follows the private-use URI
shape in [RFC 8252 section 7.1](https://www.rfc-editor.org/rfc/rfc8252.html#section-7.1).
No domain ownership is established by syntax validation. A release must verify
publisher control of the real domain and bind the same scheme to the packaged
app. Loopback, arbitrary schemes, alternate ports, noncanonical origins, query
parameters, fragments, platform swaps and normalized aliases are not accepted as
mobile callback registrations. Existing Windows loopback behavior is unchanged.

## Remaining integration gates

- External system browser, PKCE S256, state and issuer checks, active-attempt-only
  callbacks, cancellation, duplicate callbacks and timeout handling in Flutter.
- Platform-specific secure storage binding, native deep-link configuration and
  synthetic end-to-end Android/iOS tests, including interrupted/repeated flows.
- Physical-device, domain ownership, final package identity and release review.

Consent names the selected platform; its form-action CSP uses the validated
private-use scheme rather than the URL parser's null origin. Actual operating-
system browser handoff and its CSP behavior still need device integration tests.
No embedded webview, real identity-provider configuration, store account, signing
identity, DNS change or production access is performed here.

Run `node --test native-client-policy.test.mjs native-auth.test.mjs` from this
directory. The PostgreSQL native grant test requires the documented disposable
`IDENTITY_TEST_DATABASE_URL`; a local skip is not database acceptance. Full CI
results are recorded by exact commit in `plans/IMPLEMENTATION-STATUS.md`.

## Broker acceptance

Commit `5fc868bbf936a29309a877c9ce7298d418726aa0` passed all four ordinary
jobs in [CI37596296616](https://github.com/dukkanai/onlinu/actions/runs/37596296616),
verified 2026-10-07 08:59 UTC. Its server log confirms 383 platform tests passed
without skips, including actual PostgreSQL grant checks and HTTP opt-in false/true
suites. This does not establish OS browser handoff or Flutter mobile login.

## Flutter callback integration (CI pending)

The client now selects platform-specific IDs and consumes raw app-link strings
only during a live PKCE attempt. It rejects callback/path/platform substitutions,
unknown or repeated fields, wrong state/issuer, stale and duplicate results.
Cancellation, errors and timeout retain no new token; stored refresh data must
match the selected platform client. Windows keeps its loopback transport.
The generated debug mobile runners register only the scheme for control.invalid;
real release manifests must bind the approved production domain separately.
Local formatter/analyzer and 151 Flutter tests pass. A new iOS Simulator test
will exercise the real URL handler and secure storage with synthetic replies;
that does not substitute for an external-browser identity-provider login.

Mobile callback acceptance: commit `7b141aad9bffa5d601db9dbd83772a09ac4a6e52`,
[CI37599337539](https://github.com/dukkanai/onlinu/actions/runs/37599337539),
all six requested jobs successful, verified 2026-10-07 09:31 UTC. Android
compilation and actual iOS own-scheme callback/Keychain/Arabic rendering tests
passed; downloaded artifacts and owned Simulator cleanup were checked. This
is synthetic callback acceptance, not a real provider login or Android device
execution. No production or release-signing configuration changed.

Android execution acceptance: `28cb34e2de0c12ca0f8af69f1833e15fcf4ee775`,
[CI37612156244](https://github.com/dukkanai/onlinu/actions/runs/37612156244),
all five requested jobs passed, verified 2026-10-07 11:21 UTC. Three actual
API35 emulator tests passed, own screenshot/cleanup verified, and original KVM
permissions restored with exact comparison. The downloaded APK/source/licenses
and screenshot hashes were checked; Arabic rendering was visually inspected.
The emulator integration target uses x86_64; the separately archived compile
APK is arm64. Real-provider login, physical phones and release remain unverified.
