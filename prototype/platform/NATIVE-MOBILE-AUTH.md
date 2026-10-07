# Mobile authentication preparation

The running native broker still accepts only the Windows public client. Mobile
login is **not enabled or accepted** by this increment. No mobile configuration
flag, client registration, browser handoff, deep-link handler or credential is
created by the new pure policy module.

`native-client-policy.mjs` now owns the unchanged Windows identifier, loopback
template and strict non-privileged-port check used by `auth.mjs`. Its separate
opt-in policy constructor prepares two distinct public client identifiers and
exact private-use callbacks for Android and iOS. It is not wired into the broker.

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

- Explicit default-off server activation and verified fixed client registrations.
- Client-bound exact callbacks at authorization and exchange; disabled-client
  handling for refresh and existing grants; preserve customer/native isolation.
- Consent page client labels and CSP that correctly handles private-use schemes.
- External system browser, PKCE S256, state and issuer checks, active-attempt-only
  callbacks, cancellation, duplicate callbacks and timeout handling in Flutter.
- Platform-specific secure storage binding, native deep-link configuration and
  synthetic end-to-end Android/iOS tests, including interrupted/repeated flows.
- Physical-device, domain ownership, final package identity and release review.

No embedded webview, real identity-provider configuration, store account, signing
identity, DNS change or production access is authorized or performed here.

Run `node --test native-client-policy.test.mjs native-auth.test.mjs` from this
directory. The PostgreSQL native grant test requires the documented disposable
`IDENTITY_TEST_DATABASE_URL`; a local skip is not database acceptance. Full CI
results are recorded by exact commit in `plans/IMPLEMENTATION-STATUS.md`.
