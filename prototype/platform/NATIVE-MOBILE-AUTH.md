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

- Run the new actual PostgreSQL and HTTP tests in CI for opt-in registration,
  client/callback binding, disabled-client access, refresh, revocation and CSP.
  Local unit tests do not substitute for those checks.
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
