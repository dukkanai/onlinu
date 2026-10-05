# Verified tester login

This module adds an OIDC authorization-code login for explicitly provisioned staging testers. It does not implement open registration, restaurant enrollment or production account recovery.

`createOidcLogin({pool,issuer,clientId,clientSecret,baseUrl,identityMap})` returns:

- `init()`: creates only the OIDC flow and identity-binding tables; no discovery/network call at startup.
- `begin(returnTo = '/')`: returns `{authorizationUrl,bindingCookie}`. The caller sets the opaque binding cookie as `__Host-oidc_binding`, Secure, HttpOnly, SameSite=Lax, Path=/, lifetime ten minutes. Do not log the cookie or authorization URL.
- `complete(absoluteCallbackUrl,bindingCookie)`: returns `{principalId,returnTo}` after verification. The exact callback is `${baseUrl}/auth/callback`. The caller rejects duplicate cookies, clears the binding cookie, checks that the mapped local identity is still enabled, and issues its own limited session. Never accept a principal or role supplied by the browser.

Configuration is server-owned. The issuer and base URL must use HTTPS. For this deployment the provider is self-hosted Dex at `https://almujeeb.info/identity` and client ID is `restaurant-staging-web`; its client secret comes from the deployment secret file. Provider endpoints must stay on the issuer's HTTPS origin. Redirects are forbidden, each provider request has a ten-second deadline, and response bodies are capped at one MiB. Discovery is lazy, cached after success and retried after failure, so provider/proxy startup does not form a boot dependency cycle.

The adapter uses `openid-client` 6.8.8 with state, a fresh nonce, PKCE S256, an ID-token requirement and explicit `enableNonRepudiationChecks`. This last setting adds issuer-JWKS signature verification to the library's issuer, audience, expiration, nonce and response checks. No unsigned payload decoding is used as proof of identity. Access, refresh and ID token strings are not persisted, returned or logged.

These are the upstream Dex/OIDC tokens, not the application's separate downstream OAuth broker tokens. Since 1 October 2026, that broker supports rotating refresh tokens for ChatGPT clients that register the refresh grant. Downstream refresh-token hashes and client/resource/scope bindings are stored in PostgreSQL; raw values are returned only to the authorized OAuth client and are never logged. The upstream OIDC validation and synthetic tester allowlist are unchanged.

Each login has independent random state, cookie binding, nonce and PKCE verifier. PostgreSQL stores SHA-256 state/cookie hashes, the nonce/verifier and a ten-minute expiry. The state and browser binding are checked in constant time under a row lock; valid state is deleted and committed **before** exchanging the code. A wrong browser binding does not consume another browser's flow. Failed exchanges require starting again. Expired rows are purged when a new login starts. The nonce and PKCE verifier are temporarily sensitive server-side flow data: database access and backups must retain the existing isolation requirements; no provider tokens are in these rows.

Only an exact server-configured email with boolean `email_verified: true` may establish a first binding. The issuer's opaque `sub` is used as-is; Dex's subject encoding is not decoded or guessed. The module then pins `(issuer,sub)` to the local identity, with a unique local identity per issuer. A different subject cannot claim an already-bound identity merely by presenting its email, and an existing subject cannot switch to a different local identity. Recreating a Dex user with a new subject requires an explicit audited administrative rebinding outside this module. Provider role/group claims do not assign application permissions.

Return destinations are limited to `/`, `/checkout/<id>` and `/oauth/authorize?...` on the application's origin. Credentials, external/protocol-relative URLs, backslashes, control characters and fragments are rejected. The downstream OAuth authorization route remains responsible for validating all of its client, redirect URI, scope, state and PKCE parameters.

The root application owns HTTP rate limiting, CSRF protection for browser writes, cookie/session issuance and revocation, disabled-account enforcement, proxy configuration and Dex account/password administration. Factory `clientAdapter`/`now` and adapter `fetchImpl` injection exist for tests; deployment uses the real adapter and HTTPS fetch. No development identity selector should be publicly reachable as an alternative to this verified login.

Tests distinguish actual `openid-client` validation against a locally simulated signed HTTPS provider from PostgreSQL flow/binding integration. The latter uses a random isolated schema when `TEST_DATABASE_URL` is set. A successful complete browser login against the deployed Dex instance remains a separate acceptance check; fake-provider tests do not establish that result.

Primary references: [official OIDC example](https://github.com/panva/openid-client/blob/main/examples/oidc.ts), [explicit JWT signature validation](https://github.com/panva/openid-client/blob/main/docs/functions/enableNonRepudiationChecks.md), [authorization-code grant checks](https://github.com/panva/openid-client/blob/main/docs/functions/authorizationCodeGrant.md).
