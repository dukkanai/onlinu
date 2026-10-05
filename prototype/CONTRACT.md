# Synthetic two restaurant prototype contract

This directory is an isolated proof of capability, not a replacement for the existing restaurant domain or a production release. Do not connect existing databases, volumes, credentials, or WhatsApp services. All fixtures and identities are synthetic. No real payment is authorized.

## Components and ownership

- `tenant/`: minimal Go HTTP service, one process and PostgreSQL database per restaurant. It proves routing, isolation, server pricing, order idempotency and transitions; feature parity/migration of the original domain remains later work.
- `platform/`: Node service for the directory, synthetic authentication, checkout handoff, MCP adapter, durable subscriptions and event delivery. PostgreSQL stores platform state.
- `admin_flutter/`: Flutter Windows-first prototype consuming the platform REST API. No privileged tenant or platform keys shipped to clients.
- Root `compose.yml`: a separate Compose project with loopback-only published platform port, private tenant networks, independent named volumes, and no Docker socket mount.
- `staging/compose.yml`: a second project, `restaurant-saas-staging`, with fresh mounted secrets and four private databases including Dex identity storage. Apex HTTPS is routed only to its loopback services, not to legacy. No existing feature or upstream license is removed. No snapshot/backup is created for this stage at the owner's request.

## Fixtures

Tenants: `demo-a` and `demo-b`. Principals: `customer-alice`, `customer-bob`, `merchant-a` (only demo-a), `merchant-b` (only demo-b). Development identity selection is deliberately unauthenticated and must remain synthetic/local; it is not production OAuth identity verification. Tokens are short-lived random opaque values, not principal names.

Remote staging requires `AUTH_MODE=oidc`: a signed ID token from the same-origin Dex issuer, PKCE, nonce, single-use state and browser binding establish one of four allowlisted synthetic tester identities. Verified email is bound persistently to issuer/subject; provider role claims are ignored. `/dev/*` is disabled at both proxy and application. Browser sessions use `__Host-restaurant_session` with Secure/HttpOnly/SameSite=Lax and session-bound CSRF tokens. Browser and OAuth session kinds cannot substitute for each other in staging. OAuth authorization takes the authenticated browser identity and explicit consent, never a caller-supplied identity. Access tokens expire after at most 30 minutes. OAuth clients registered with `refresh_token` also receive single-use, rotating refresh tokens: only hashes are stored, with a 24-hour idle expiry and a seven-day absolute grant lifetime. Refresh is bound to client, resource, identity and existing scopes; scopes may narrow but never expand. Replay invalidates the family and transactionally cancels the owner's event subscriptions. Existing code-only clients and browser sessions are preserved. Production customer enrollment is not implemented.

## Tenant internal HTTP contract

Every route except `GET /health` requires `Authorization: Bearer <TENANT_SERVICE_TOKEN>`. The platform asserts `X-Actor-ID` and `X-Actor-Role` after authenticating and authorizing its own user. IDs are scoped to the tenant's own database. The tenant validates role and owner independently. The public cannot choose these trusted headers through the platform API.

- `GET /menu` -> `{tenantId,name,currency:"SAR",items:[{id,name,priceMinor,stock}]}`.
- `POST /quote`, body `{items:[{itemId,quantity}]}` -> `{tenantId,currency,totalMinor,items}`. Read-only, no reservation or order.
- `POST /orders`, customer only, body `{items,expectedTotalMinor,idempotencyKey}` -> `{id,tenantId,ownerId,currency,totalMinor,status,paymentStatus,version,items}`. Prices integer minor units; immutable snapshots. Pending payment, one order for identical key/owner; differing payload returns 409. No customer PII accepted in this synthetic service. Reserve stock transactionally.
- `GET /orders/:id`: owning customer or tenant merchant only; unknown/foreign order returns 404.
- `GET /orders/by-idempotency?key=<encoded key>`: owning customer only; read-only recovery after an ambiguous creation response. Unknown/foreign key ->404; never creates an order or reserves stock.
- `GET /orders`: merchant only -> `{orders:[...]}`.
- `POST /orders/:id/simulate-payment`: owning customer, fixture mode only, explicitly LOCAL SIMULATION; idempotent paid transition. Body `{}`.
- `POST /orders/:id/confirm-test-payment`: platform service role only, fixture mode; body `{provider:"moyasar-test",reference,amountMinor,currency:"SAR"}` after server-to-server sandbox invoice verification. Requires exact total and unique provider reference. Never trusts a browser/webhook payment claim.
- `POST /orders/:id/status`: merchant only, body `{status,expectedVersion}`. States `pending_payment -> accepted -> preparing -> ready -> completed`; payment simulation moves pending_payment to accepted. No completion of unpaid orders, no backward transition, stale version ->409.
- `GET /events?after=<integer>&limit=100`: platform service role only. Durable transactional outbox rows `{sequence,eventId,tenantId,orderId,ownerId,status,paymentStatus,version,occurredAt}`; PII-free. Returns `{events:[...]}`. GET does not acknowledge/remove rows.

Errors: HTTP 400/401/403/404/409/413/503 with `{error:"stable_code"}`; no SQL details/secrets. Limits: JSON32KiB, 20 distinct items, integer quantity1..20. Reject unknown fields on writes. Tenant fixed by env, never by user payload.

## Platform REST contract

All state-changing browser APIs require exact same Origin or a bearer token with no Origin. Development endpoints also require the configured local origin; no CORS wildcard. `PUBLIC_BASE_URL` defaults `http://127.0.0.1:18787`. Host and Origin are checked; no automatic trust of forwarded headers. Authenticated customer reads additionally require `orders:read`, customer mutations `orders:write`, and MCP events `events:read`; narrowed OAuth grants cannot escalate through REST. Merchant memberships are checked separately. Explicit OAuth token revocation also cancels that customer's current event subscriptions and pending deliveries; other valid sessions can establish a new subscription.

In staging, all catalog REST endpoints and all five MCP tools require authentication. Browser mutations additionally require `X-CSRF-Token` (consent uses hidden `_csrf`). OAuth backchannels and the payment webhook use their own authentication/verification rules. `GET /auth/login` starts verified login, `GET /auth/callback` consumes it, `GET /api/session` returns a cookie-authenticated principal and CSRF token, and `POST /auth/logout` revokes that browser session. Browser logout does not claim to revoke independent ChatGPT OAuth grants.

- `GET /health` -> `{status:"ok",mode:"synthetic"}`.
- `POST /dev/session`, body `{identity}` one fixture above -> `{accessToken,expiresAt,principal:{id,role,tenantIds}}`. Also sets HttpOnly same-site cookie for local checkout. Synthetic-only, not a production login.
- `GET /api/restaurants` -> `{restaurants:[{id,name,cuisine,template}]}`.
- `GET /api/restaurants/:tenantId/menu` public.
- `POST /api/restaurants/:tenantId/quote` public, body as tenant quote.
- `POST /api/restaurants/:tenantId/checkouts` authenticated customer, body `{items,expectedTotalMinor,idempotencyKey}` -> `{checkoutId,tenantId,totalMinor,currency,checkoutUrl,expiresAt}`. Creates a short-lived checkout session only, not an order/payment.
- `GET /checkout/:checkoutId` -> generic checkout HTML without private data. `GET /api/checkouts/:checkoutId` loads its data only for the authenticated owning fixture customer; neither GET purchases.
- `POST /api/checkouts/:checkoutId/confirm`, body `{}` -> `{order,paymentMode,simulationUrl}` in local mode or `{order,paymentMode,paymentUrl}` in Moyasar test mode. Owning customer, explicit confirmation; durable dispatch intent and stable order idempotency key recover an existing order even after checkout expiry, without creating a fresh expired order.
- `POST /api/restaurants/:tenantId/orders/:orderId/simulate-payment`, body `{}` -> order. Local simulation only, visibly labelled; no Moyasar claim.
- `GET /api/restaurants/:tenantId/orders/:orderId` -> order view with ownerId stripped; owning customer. Merchants use the separate membership-authorized list route below.
- `POST /api/restaurants/:tenantId/orders/:orderId/payment-status`, body `{}` -> order after an authoritative Moyasar sandbox check; configured sandbox only. Return URL/webhook payload alone is never payment evidence.
- `GET /api/merchant/restaurants` -> `{restaurants:[...]}` for principal memberships only.
- `GET /api/merchant/restaurants/:tenantId/orders` -> `{orders:[...]}` authorized merchant.
- `POST /api/merchant/restaurants/:tenantId/orders/:orderId/status`, body `{status,expectedVersion}` -> updated order; merchant membership required.
- `GET/POST /api/merchant/restaurants/:tenantId/channels`: owning merchant only. POST body `{enabled,connectionMode:"qr"|"cloud_api",expectedVersion}`. Changes are versioned and audited atomically; stale versions return409. Responses explicitly report `scope:"synthetic_configuration_only"`, `configured:false`, `operational:false`. These preferences do not enable or disable the original WhatsApp service yet.

Flutter starts with a clearly marked synthetic identity selector for merchant-a/b, keeps bearer only in memory, refreshes orders on demand/short interval, stops writes while offline, and offers the next allowed status. OAuth production login, notifications/background delivery, printing, signed Windows release, and full admin feature parity are separate acceptance gates.

## Integration modules for platform

`mcp.mjs` exports `createMcpHandler({baseUrl, authenticate, listRestaurants, getMenu, quoteCart, prepareCheckout, getOrderStatus, events, uiHtml, requireCatalogAuth=false})`, returning async `(req,res)`. `authenticate(req)` returns principal or null. Other callbacks take `(principal,args)` except `listRestaurants(args)` and `getMenu(args)`. Required scopes/ownership are enforced by platform callbacks. `events` exposes `list(principal)`, `subscribe(principal,params)`, `unsubscribe(principal,params)`. No MCP tool exposes simulate-payment or merchant actions. Unauthorized tool calls return the SDK's completed error result with `_meta["mcp/www_authenticate"]`; REST/events retain HTTP401/403. Tool discovery emits both top-level `securitySchemes` and the metadata mirror. `requireCatalogAuth:true` protects catalog tools in staging. If installed SDK cannot implement MCP2 faithfully, fail closed for unsupported protocol features and document the gap rather than claiming compatibility.

`events.mjs` exports `createEvents({pool,encryptionKey,authorizeOrder,webhookFetch,now})` returning `{init,list,subscribe,unsubscribe,revokeAll,enqueue,dispatchOnce}`. `pool` is a node-postgres Pool. `authorizeOrder(principal,{tenantId,orderId})` either resolves owned order or throws. `enqueue(event)` accepts the outbox shape above; deduplicate `(subscriptionId,eventId)` and persist. `dispatchOnce()` rechecks ownership and expiry, signs exact bytes, bounded retries, never follows redirects; return counters without secrets. `revokeAll(ownerID)` is an internal disconnect hook, not a public tool. `webhookFetch` may be injected only by tests; production default enforces public HTTPS pinned DNS. Signing secrets encrypted by external env key. Timers belong to root platform, not module imports.

Prototype tests must distinguish local simulation, protocol-level tests, untested actual ChatGPT account behavior, absent real Moyasar sandbox credentials, and unavailable Windows build acceptance. Do not advertise production-ready OAuth or fully implemented original business rules.
