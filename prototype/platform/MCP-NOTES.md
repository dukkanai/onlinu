# Synthetic MCP adapter: exact protocol boundary

This prototype implements the real MCP **2026-07-28** HTTP protocol through the official split TypeScript SDK, `@modelcontextprotocol/server@2.2.0` and `@modelcontextprotocol/node@2.1.0`. The older monolithic `@modelcontextprotocol/sdk@1.31.0` is not used. SDK version 2 and protocol version 2 are verified separately: the tests exercise the actual HTTP envelope and `server/discover` response, not a hand-written imitation of discovery.

On 1 October 2026, private connection creation failed in the user's ChatGPT UI before login. A public read-only probe reproduced rejection of a `2025-06-18` initialization. The endpoint now enables the installed official SDK's stateless legacy fallback, including `initialize` and `notifications/initialized`, while retaining the modern transport. The SDK owns negotiation and response encoding for both eras. Tools, OAuth scopes, host/origin restrictions, and output filtering are shared; MCP Events are registered and advertised only for the modern era. This fixes the reproduced interoperability defect, but does not establish that it caused the user's failure or that the real ChatGPT connection succeeds: a fresh account attempt is still required.

Staging diagnostics record only allowlisted MCP method/version labels and HTTP status, plus fixed OAuth discovery/registration routes, HTTP method labels, and status. No request bodies, query strings, tokens, cookies, user identifiers, IPs, or tool arguments are logged. Existing bounded Docker log rotation remains in force.

The subsequent account attempt still failed. Logs from 11:51 UTC on 1 October show two initial MCP requests rejected with HTTP 415 (no parsed method), successful protected-resource and authorization-server discovery (HTTP 200), and then `POST /oauth/register` rejected with HTTP 400. No successful MCP initialization or tool discovery was recorded in that sequence. This localizes the observed blocker to DCR registration, but the existing logs did not capture which metadata field failed. It is not evidence of an Extensions rendering or event-delivery defect, nor is it proof that transport/authentication interoperability is complete.

The official plugin architecture, MCP Apps UI, Extensions, Events, connection, and authentication pages were reviewed against the implementation. New UI should use the standard `ui/*` bridge; compatibility aliases remain available. Extensions are optional UI capabilities, not an OAuth registration mechanism. MCP Events require the modern protocol and independently verified signed webhooks. DCR, CIMD, and predefined OAuth clients are distinct registration choices; at this diagnostic stage the broker supported DCR with `none`, exact configured redirects, authorization-code/PKCE, but not refresh. Do not enable CIMD, new grant types, or broaden redirect allowlists without implementing their validation.

For the next account attempt, registration rejection diagnostics now emit only fixed rejected-field names, an allowlisted authentication-method label, bounded allowlisted grant labels, and redirect-kind labels (configured, ChatGPT connection-specific, other/invalid). Raw redirect URIs and connection IDs are never recorded. Registration/security policies are unchanged. The affected suite passed 27/27; a public negative registration probe returned 400 and emitted the expected sanitized reason without creating a client. Another real-account attempt is needed to identify the incompatible field; no connection success is claimed.

The next attempt at 12:03 UTC conclusively identified the rejected field as `grant_types`: the request used `none`, an already configured redirect, and `authorization_code` plus `refresh_token`. Real refresh support was implemented rather than merely accepting an unsupported grant. Metadata and DCR now support both grants, while old clients keep their original code-only grant. Migrations add tables/columns without deleting or recreating existing client registrations, identities, sessions, orders, or tenant data.

Refresh tokens are random opaque values stored only as hashes, bound to the client, resource, verified identity, scopes and a persistent family. Rotation is transactional and locks the family; reuse revokes the family and atomically cancels the owner's event subscriptions, pending retries, and verification cache. Refresh cannot widen scopes. It expires after 24 hours idle or seven days absolute; access tokens remain at most 30 minutes and are checked against family revocation/absolute expiry. Revoking an access or refresh token revokes that family, without deleting browser sessions or other OAuth families. The prototype's existing owner-wide event cancellation policy remains explicit. Authentication-code minting and consumption are now atomic as well.

Before deployment, 65 affected tests passed with no skips, including real disposable PostgreSQL migrations, concurrent rotation, rollback, replay, scope narrowing, expiry, disabled identities, browser isolation, HTTP registration/token/revocation, and Events lifecycle checks. Test databases were removed afterwards; no staging/original data was removed. Actual account acceptance remains a separate verification step.

## Implemented and locally tested

- Stateless, per-request MCP server instances. No authenticated principal is reused across requests or tenants. HTTP bodies are capped at 32 KiB, host/origin must match the configured URL exactly, and private calls require a verified customer principal with the required scope. The injected platform callbacks independently enforce object ownership.
- Five tools: `search_restaurants`, `get_restaurant_menu`, `quote_cart`, `prepare_checkout`, and `get_order_status`. No payment simulator, merchant action, raw customer profile, phone, precise location, or address is exposed as a tool.
- Strict input schemas, integer minor-unit prices, explicit output schemas, read/write/idempotency annotations, and output allowlists. Unexpected callback fields are stripped before returning either model-visible text or `structuredContent`. Provider/database errors are replaced with stable errors.
- An MCP Apps HTML resource (`text/html;profile=mcp-app`) and the documented `_meta.ui.resourceUri` plus `openai/ui` global/thread entrypoints. The same UI is registered for sidebar and conversation-panel discovery. Its HTML must be self-contained; external fetch/script origins are not granted by its CSP.
- `events/list`, `events/subscribe`, and `events/unsubscribe` on the same authenticated MCP endpoint. They delegate to the durable `events.mjs` module. That module owns access checks, deterministic subscription IDs, callback verification, encryption, retry, expiry, and delivery signatures. The adapter does not turn payment simulation into an MCP tool.
- The SDK's exact protocol/version/header checks, including unsupported versions and header/body disagreement. Legacy clients are deliberately rejected. Generic `subscriptions/listen` SSE streams are not an alternate delivery channel.

## Calling the modern endpoint

Modern requests need the version and method headers, and a matching per-request metadata envelope in `params._meta`. Calls naming a tool/resource also need `Mcp-Name` with the tool name or resource URI. The following is a discovery request, not a legacy `initialize` handshake:

```http
POST /mcp
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2026-07-28
Mcp-Method: server/discover
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "server/discover",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "synthetic-test", "version": "0.1.0" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

The test suite covers discovery, tools/resource metadata, anonymous browsing, customer scope checks, per-request isolation, output minimization, unauthorized/invalid filters, event delegation and categorized errors, origin/host checks, request limits, and rejection of protocol mismatches. Callback fixtures in `mcp.test.mjs` are not proof of database persistence or real webhook delivery; those are tested in the event/service integration suites.

### OAuth challenges and private staging

Protected `tools/call` failures use the SDK's actual MCP tool-result encoding: HTTP 200, `resultType: "complete"`, `isError: true`, and an array of Bearer challenges under `_meta["mcp/www_authenticate"]`. Each challenge contains `resource_metadata`, the required `scope`, `error`, and `error_description`. Missing/expired credentials use `invalid_token`; insufficient customer permissions use `insufficient_scope`. No business callback runs and no structured business data is returned on either path. This lets ChatGPT initiate account linking or request additional permission, as described in the official authentication guide. HTTP 200 here is protocol transport success, **not authorization success**.

Tool descriptors expose `securitySchemes` at the **top level** and mirror it in `_meta.securitySchemes`. The installed `@modelcontextprotocol/server@2.2.0` high-level `registerTool` options/default descriptor builder do not preserve this OpenAI field. Therefore the adapter registers tool execution normally, then uses the SDK's public `server.setRequestHandler('tools/list', ...)` hook for discovery descriptors, deriving their JSON schemas and metadata from the same registration objects. This narrow compatibility adapter does not replace transport, protocol negotiation, envelope validation, execution validation, or result encoding. HTTP tests verify both copies of the field and the unchanged SDK-generated MCP2 `resultType`/server metadata; an ignored high-level option is not considered proof of support.

Event methods retain transport-level HTTP 401/403 challenges. Invalid credentials used for metadata/transport requests can likewise receive HTTP 401. Every request is authenticated independently; cookie-only private tool calls without the exact Origin do not inherit authorization. Ownership rejection is not automatically converted into an OAuth prompt, preventing reauthentication loops for someone else's order.

`requireCatalogAuth: true` protects the three browsing/quotation tools with the existing `orders:read` scope, so all five data tools need OAuth on private staging. Its default remains `false` for isolated loopback fixtures only. `server/discover`, tool descriptors, and the static UI resource remain discoverable without data access; the UI HTML must not embed credentials or restaurant/customer data. This option does not disable the platform's development login routes: the staging operator must separately remove public synthetic identity selection and inject a real verified login principal through `authenticate`.

The chosen staging deployment uses the origin-only URL `https://almujeeb.info`, not a subpath. The protected-resource metadata URL is `https://almujeeb.info/.well-known/oauth-protected-resource`; its resource identifier must match the platform's `https://almujeeb.info/mcp` audience. Checkout links must stay on that exact origin beneath `/checkout/`. Path-prefixed deployment is deliberately unsupported by this factory until the metadata/routing/checkout contracts are changed together. Forwarded headers do not select the trusted origin or metadata URL.

### UI bridge boundary

The real-core menu now has its own standard MCP Apps component and versioned
resource, distinct from the older synthetic directory described below. Its
read-only price-preview boundary and current verification are documented in
[CORE-MENU-UI.md](CORE-MENU-UI.md). Only `get_restaurant_menu` opens that component;
subsequent `quote_cart` results update it without a new UI resource attachment.

OpenAI documents `window.openai.callTool(name, args)` as a ChatGPT compatibility alias for the shared MCP Apps `tools/call` bridge. A self-contained prototype UI may feature-detect that alias; if absent it must explain that the host integration is unavailable rather than silently granting direct network access. Such a UI is ChatGPT-specific and must not be described as portable across MCP Apps hosts. The standard `ui/initialize`, tool input/result notifications, and shared bridge are the preferred foundation for the eventual UI. Neither the existence of the JavaScript alias nor correct server metadata is proof that the user's actual ChatGPT account has successfully rendered the sidebar/thread panel.

## Not claimed by a passing local test

This is **not** a published plugin or a completed live ChatGPT integration. `PROTOCOL_STATUS.actualChatGPTVerified` remains false. The user's actual account entitlement, global/thread rendering, successful callback verification by ChatGPT, task behavior, account disconnection, and public review must be tested using the real account and an explicitly authorized endpoint. No public tunnel is started here.

The loopback platform's synthetic identity selector is not production identity verification, even when used through an OAuth authorization-code/PKCE test flow. It must not be publicly exposed and must never protect real restaurant or customer data. Public staging must use verified authentication; production acceptance, publisher/domain validation, and real Moyasar sandbox acceptance remain separate gates. No OpenAI model inference is invoked by this adapter, and it requires no OpenAI API key.

The Saudi storage decision covers the platform-controlled data stores/backups/logs. Data sent to ChatGPT is governed separately; this adapter minimizes it but cannot promise where OpenAI stores its own copy.

## Official guidance consulted

- [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- [MCP Events](https://developers.openai.com/plugins/build/mcp-events)
- [Plugin Extensions](https://developers.openai.com/plugins/build/extensions)
- [MCP Apps UI](https://developers.openai.com/plugins/build/chatgpt-ui)
- [Authentication](https://developers.openai.com/plugins/build/auth)

The exact SDK API and protocol envelope were checked against the installed official packages' source/type declarations and actual HTTP responses. Event delivery is the draft webhook feature described by OpenAI, not a claim that every MCP host supports it.
