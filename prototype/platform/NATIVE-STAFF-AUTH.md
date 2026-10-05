# Native staff authorization — implementation in progress

The Windows client will use the system browser and Authorization Code + PKCE
S256, following [RFC8252](https://www.rfc-editor.org/rfc/rfc8252.html). It will
listen only on IPv4 loopback at an ephemeral non-privileged port and verify state
and issuer before exchanging a code. No embedded login webview, fixture identity
selector, restaurant master key or client secret belongs in the real app.
Device authorization is not selected for these browser-capable native clients.

## Implemented broker profile

The shared, tested broker now has an explicit `native_staff` profile:

- Separate issuer `{platform-origin}/native` and resource `{issuer}/api`.
- Fixed public client `onlinu-native-windows-v1`; dynamic registration disabled.
- Only `staff:access`, separate from customer/MCP scopes. Authority for each
  restaurant operation must still come from current directory permissions.
- Exact callback path `http://127.0.0.1:{port}/oauth/callback`, ports 1024–65535.
  No localhost aliases, alternate IP spellings, credentials, queries, fragments,
  extra paths or arbitrary remote redirects. The exact requested port remains
  bound to the single-use authorization code and token exchange.
- Verified principal resolver required; fixture mode and native browser-cookie
  sessions rejected. Runtime will require live staff memberships.
- Access tokens 15 minutes, rotating refresh family at most 8 hours. Existing
  customer token lifetimes and scopes retain their previous defaults.
- Tokens are stored hashed. Rotation/reuse revocation stays transactional.
  Revocation is now issuer/resource scoped, so customer and native endpoints
  cannot accidentally invalidate each other's grants.
- Own-grant listing exposes only grant identifiers/client IDs/expiry, not tokens;
  own grant or all-native-grant revocation is available for the upcoming browser
  device page. Restaurant owners do not receive other users' tokens.

At this checkpoint the profile is tested but not exposed by the HTTP runtime.
Native consent, staff API routing and Flutter consumption are the next steps.
No real OAuth client consent, credential, provider configuration or deployment
has been performed. Real identity-provider MFA policy, OS secure storage,
Windows acceptance/signing and Android/iOS callback setup remain release gates.

## Tests

Isolated PostgreSQL tests cover port/path allowlisting, code/verifier/resource
binding, replay, separate customer/native audiences and revocation, hashed
storage, lifetime bounds, rotating-refresh reuse, own-grant isolation and live
membership/identity resolution. Existing customer refresh/event and core flows
run unchanged alongside these cases. Passing these tests is not a claim of
completed native application login or OS-specific acceptance.
