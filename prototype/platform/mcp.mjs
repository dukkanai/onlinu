import { McpServer, ProtocolError, SUPPORTED_PROTOCOL_VERSIONS as SDK_LEGACY_VERSIONS, createMcpHandler as createSdkHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { coreCatalogSchema, coreQuoteSchema, corePreviewInput, coreOpeningStatusSchema } from './core-adapter.mjs';
import { coreOrderView } from './core-order-client.mjs';

export const MCP_PROTOCOL_VERSION = '2026-07-28';
export const UI_RESOURCE_URI = 'ui://restaurant-prototype/directory.html';
export const PROTOCOL_STATUS = Object.freeze({
  supportedVersions: [MCP_PROTOCOL_VERSION, ...SDK_LEGACY_VERSIONS],
  sdk: '@modelcontextprotocol/server@2.2.0',
  extensions: ['global', 'thread'],
  events: true,
  delivery: 'webhook',
  legacyProtocol: true,
  actualChatGPTVerified: false,
  productionIdentityVerified: false,
});

const MAX_BODY = 32 * 1024;
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const minor = z.number().int().min(0).max(40_000_000_000);
const cartItems = z.array(z.object({ itemId: identifier, quantity: z.number().int().min(1).max(20) }).strict()).min(1).max(20);
const orderArgs = z.object({ tenantId: identifier, orderId: identifier }).strict();
const quoteArgs = z.object({ tenantId: identifier, items: cartItems }).strict();
const checkoutArgs = quoteArgs.extend({ expectedTotalMinor: minor, idempotencyKey: identifier.min(8) }).strict();
const searchArgs = z.object({ query: z.string().max(100).optional(), cuisine: z.string().max(60).optional() }).strict();
const line = z.object({ itemId: identifier, name: z.string().max(250), quantity: z.number().int(), unitPriceMinor: minor, totalMinor: minor });
const outputs = {
  search: z.object({ restaurants: z.array(z.object({ id: identifier, name: z.string().max(250), cuisine: z.string().max(100), template: z.string().max(100) })).max(100) }),
  menu: z.object({ tenantId: identifier, name: z.string().max(250), currency: z.literal('SAR'), items: z.array(z.object({ id: identifier, name: z.string().max(250), priceMinor: minor, stock: z.number().int().min(0) })).max(500) }),
  quote: z.object({ tenantId: identifier, currency: z.literal('SAR'), totalMinor: minor, items: z.array(line).max(20) }),
  checkout: z.object({ checkoutId: identifier, tenantId: identifier, totalMinor: minor, currency: z.literal('SAR'), checkoutUrl: z.string().url(), expiresAt: z.string().datetime({ offset: true }) }),
  order: z.object({ id: identifier, tenantId: identifier, currency: z.literal('SAR'), totalMinor: minor, status: z.enum(['pending_payment', 'accepted', 'preparing', 'ready', 'completed']), paymentStatus: z.enum(['pending', 'paid']), version: z.number().int().min(1) }),
};
const requiredScopes = { prepare_checkout: 'orders:write', get_order_status: 'orders:read' };
const allowedMethods = new Set(['server/discover', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'resources/list', 'resources/read', 'ping', 'events/list', 'events/subscribe', 'events/unsubscribe']);
const safeErrorCodes = new Set(['invalid_request', 'invalid_items', 'not_found', 'forbidden', 'price_changed', 'out_of_stock', 'idempotency_conflict', 'version_conflict', 'checkout_expired', 'rate_limited', 'service_unavailable']);
for (const code of ['invalid_quantity', 'invalid_option', 'store_closed', 'mode_unavailable',
  'item_unavailable', 'delivery_unavailable', 'delivery_minimum', 'table_unavailable',
  'payment_unavailable', 'invalid_district', 'district_unavailable', 'country_required',
  'location_required', 'outside_delivery_area', 'restaurant_not_found']) safeErrorCodes.add(code);
const eventMeta = { _meta: z.record(z.string(), z.unknown()).optional() };
const eventIdentity = {
  name: z.string().min(1).max(100),
  arguments: orderArgs,
  delivery: z.object({ mode: z.literal('webhook'), url: z.string().url().max(2048) }).strict(),
};
const eventSubscribe = z.object({ ...eventIdentity, delivery: eventIdentity.delivery.extend({ secret: z.string().min(1).max(200) }).strict(), cursor: z.string().max(1024).nullable().optional(), ttlMs: z.number().int().positive().nullable().optional(), ...eventMeta }).strict();
const eventUnsubscribe = z.object({ ...eventIdentity, ...eventMeta }).strict();
const eventList = z.object({ cursor: z.string().max(1024).optional(), ...eventMeta }).strict();
const jsonObject = z.record(z.string(), z.unknown());
const eventListResult = z.object({ events: z.array(z.object({ name: z.string(), description: z.string(), delivery: z.array(z.literal('webhook')), inputSchema: jsonObject, payloadSchema: jsonObject })).max(20), nextCursor: z.string().optional() });
const eventSubscribeResult = z.object({ id: z.string(), refreshBefore: z.string().datetime({ offset: true }).nullable(), cursor: z.string().nullable(), truncated: z.boolean() });

function rpcError(res, status, id, code, message, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: typeof id === 'string' || typeof id === 'number' ? id : null, error: { code, message } }));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_BODY) throw Object.assign(new Error('body_too_large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid_json'), { status: 400 }); }
}

function hasScope(principal, scope) {
  return principal?.role === 'customer' && Array.isArray(principal.scopes) && principal.scopes.includes(scope);
}

function safeToolFailure(error) {
  // Never reflect errors from PostgreSQL, tenant services, credentials, or provider URLs.
  const errorCode = safeErrorCodes.has(error?.code) ? error.code : 'service_unavailable';
  return { isError: true, content: [{ type: 'text', text: errorCode }] };
}

function safeEventFailure(error) {
  if (error?.code === -32015) {
    const reasons = ['challenge_failed', 'timeout', 'dns_failed', 'address_blocked', 'redirect_blocked', 'response_too_large', 'payload_too_large', 'invalid_request', 'network_error'];
    return new ProtocolError(-32015, 'CallbackEndpointError', { reason: reasons.includes(error.data?.reason) ? error.data.reason : 'challenge_failed' });
  }
  if ([-32602, -32001, -32003, -32004].includes(error?.code)) return new ProtocolError(error.code, 'event_request_rejected');
  return new ProtocolError(-32603, 'event_service_unavailable');
}

/**
 * Synthetic-data adapter. Token issuance and validation belong to the platform;
 * this module checks customer roles/scopes and the callbacks check ownership.
 * The official v2 SDK performs transport/envelope handling and server/discover.
 */
export function createMcpHandler({ baseUrl, authenticate, listRestaurants, getMenu, quoteCart, prepareCheckout, getOrderStatus, events, uiHtml, coreAdapter, coreCheckouts, requireCatalogAuth = false, onProtocolExchange = () => {} }) {
  const base = new URL(baseUrl);
  const metadataUrl = new URL('/.well-known/oauth-protected-resource', base).href;
  const eventEnabled = (!coreAdapter || !!coreCheckouts) && ['list', 'subscribe', 'unsubscribe'].every(key => typeof events?.[key] === 'function');
  if (base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('invalid_mcp_base_url');
  if (typeof requireCatalogAuth !== 'boolean') throw new Error('invalid_catalog_auth_option');
  if (typeof onProtocolExchange !== 'function') throw new Error('invalid_protocol_reporter');
  const catalogScope = requireCatalogAuth ? 'orders:read' : undefined;
  const toolScopes = { ...requiredScopes, search_restaurants: catalogScope, get_restaurant_menu: catalogScope, quote_cart: catalogScope };

  function authChallenge(scope, error = 'invalid_token') {
    const description = error === 'insufficient_scope'
      ? 'The connected account does not have the required customer permission.'
      : 'Connect your account to use this tool.';
    return `Bearer resource_metadata="${metadataUrl}", scope="${scope}", error="${error}", error_description="${description}"`;
  }

  function toolAuthFailure(scope, principal) {
    return {
      isError: true,
      content: [{ type: 'text', text: principal ? 'authorization_required' : 'authentication_required' }],
      _meta: { 'mcp/www_authenticate': [authChallenge(scope, principal ? 'insufficient_scope' : 'invalid_token')] },
    };
  }

  function makeServer(principal, era) {
    // Webhook Events require MCP2. Older clients get the same protected tools
    // and UI resources, without an unsupported event capability.
    const modernEvents = eventEnabled && era === 'modern';
    const server = new McpServer({ name: coreAdapter ? 'restaurant-core-catalog' : 'restaurant-saas-synthetic-prototype', version: '0.1.0' }, {
      instructions: coreAdapter
        ? 'Restaurant core integration. Money is in SAR minor units. Cart previews do not reserve stock, place orders or accept payments. Do not collect customer names, phone numbers or street addresses. If delivery requires location, ask the customer before supplying it. ' + (coreCheckouts ? 'Prepare checkout only creates an owned website handoff. The customer must confirm on the website to place the order; preparing a link is not an order or payment. Order status is private to the connected customer. ' + (eventEnabled?'Owned order Events are available.':'Events are not enabled.') : 'Orders, checkout and events are not available in this integration stage.')
        : 'Synthetic restaurant prototype. All money is SAR minor units. Quote before preparing checkout. Checkout only creates a handoff; a customer must confirm on the website. No real payment, personal details, precise locations, or merchant operations are available through these tools.',
      capabilities: { ...(modernEvents ? { events: {} } : {}) },
    });
    const toolDescriptors = [];

    const register = (name, title, description, inputSchema, outputSchema, callback, { scope, write = false, ui = false } = {}) => {
      const securitySchemes = scope ? [{ type: 'oauth2', scopes: [scope] }] : [{ type: 'noauth' }];
      const config = {
        title,
        description,
        inputSchema,
        outputSchema,
        annotations: { readOnlyHint: !write, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: {
          securitySchemes,
          ...(ui ? { ui: { resourceUri: UI_RESOURCE_URI }, 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } } : {}),
        },
      };
      server.registerTool(name, config, async args => {
        // Return the challenge inside a real tool result, so ChatGPT can start
        // account linking/reauthorization. The SDK encodes the MCP2 result; do
        // not replace this with a hand-written JSON-RPC response or a fake 401.
        if (scope && !hasScope(principal, scope)) return toolAuthFailure(scope, principal);
        try {
          // Zod objects strip all unlisted output fields, including ownerId/PII.
          const output = outputSchema.parse(await callback(args));
          if (name === 'prepare_checkout') {
            const checkout = new URL(output.checkoutUrl);
            if (checkout.origin !== base.origin || !checkout.pathname.startsWith('/checkout/') || checkout.username || checkout.password || checkout.search || checkout.hash) throw new Error('unsafe_checkout_url');
          }
          return { structuredContent: output, content: [{ type: 'text', text: JSON.stringify(output) }] };
        } catch (error) { return safeToolFailure(error); }
      });
      // The installed official SDK 2.2.0 drops unknown registerTool config
      // fields, including OpenAI's top-level securitySchemes. Build discovery
      // from the SAME schema/config objects via its supported request-handler
      // hook below. Registered execution/validation remain owned by the SDK.
      toolDescriptors.push({
        ...config,
        name,
        inputSchema: z.toJSONSchema(inputSchema, { io: 'input', target: 'draft-07' }),
        outputSchema: z.toJSONSchema(outputSchema, { io: 'output', target: 'draft-07' }),
        securitySchemes,
      });
    };

    if (coreAdapter) {
      register('search_restaurants', 'Find restaurants', 'Search the configured restaurant directory. No personal data or order creation.', searchArgs,
        z.object({ restaurants: z.array(z.object({ id: identifier, name: z.string().max(4096), cuisine: z.string().max(4096) })).max(1000) }),
        async args => ({ restaurants: await coreAdapter.listRestaurants(args) }), { scope: catalogScope });
      if(typeof coreAdapter.openingStatus==='function')register('get_restaurant_opening_status','Read current restaurant acceptance','Read a fresh server-evaluated Saudi opening-schedule and manual intake snapshot for a published restaurant. Disabled schedule means opening hours are not configured; acceptingOrders is not proof of stock, delivery coverage or payment availability. Checkout remains authoritative.',
        z.object({tenantId:identifier}).strict(),coreOpeningStatusSchema.safeExtend({tenantId:identifier}),args=>coreAdapter.openingStatus(args.tenantId),{scope:catalogScope});
      register('get_restaurant_menu', 'Read the restaurant menu', 'Read original menu categories, available items/options, prices and published appearance. Availability is not a stock reservation.',
        z.object({ tenantId: identifier }).strict(), coreCatalogSchema.extend({ tenantId: identifier }),
        args => coreAdapter.getMenu(args.tenantId), { scope: catalogScope });
      register('quote_cart', 'Preview cart price', 'Authoritative original restaurant pricing, delivery coverage, options and tax. No contact details, order, payment or stock reservation. For delivery, supply the requested area; ask consent before using location.',
        corePreviewInput.extend({ tenantId: identifier }).strict(), coreQuoteSchema.extend({ tenantId: identifier }),
        ({ tenantId, ...input }) => coreAdapter.preview(tenantId, input), { scope: catalogScope });
      if (coreCheckouts) {
        register('prepare_checkout', 'Prepare owned checkout', 'Create a private website link for the connected customer to enter contact details and explicitly confirm. No order, stock reservation or payment occurs here. Reuse the same idempotencyKey for the same cart.',
          corePreviewInput.extend({ tenantId: identifier, expectedTotalMinor: minor, idempotencyKey: identifier.min(8).max(100) }).strict(),
          outputs.checkout, args => coreCheckouts.prepare(principal, args), { scope: 'orders:write', write: true });
        register('get_order_status', 'Read my core order', 'Read the status and amount of an original restaurant order owned by the connected customer. No contact details or receipt secrets are returned.',
          orderArgs, coreOrderView.extend({ tenantId: identifier }), args => coreCheckouts.status(principal, args.tenantId, args.orderId), { scope: 'orders:read' });
      }
    } else {
    register('search_restaurants', 'Browse synthetic restaurants', 'Find the two synthetic restaurants by name or cuisine. Opens the directory UI; does not access personal data.', searchArgs, outputs.search, args => listRestaurants(args), { ui: true, scope: catalogScope });
    register('get_restaurant_menu', 'Read restaurant menu', 'Get menu items, prices in SAR minor units, and current stock for the selected restaurant.', z.object({ tenantId: identifier }).strict(), outputs.menu, args => getMenu(args), { scope: catalogScope });
    register('quote_cart', 'Quote a cart', 'Compute authoritative current prices for selected items. Read only: does not reserve stock or create an order.', quoteArgs, outputs.quote, args => quoteCart(principal, args), { scope: catalogScope });
    register('prepare_checkout', 'Prepare checkout handoff', 'Create a short-lived website checkout link after reviewing a quote. Does not place an order, charge a card, or collect customer details. Use the same idempotencyKey when retrying the same cart.', checkoutArgs, outputs.checkout, args => prepareCheckout(principal, args), { scope: 'orders:write', write: true });
    register('get_order_status', 'Read my order status', 'Read a confirmed order belonging to the authenticated customer. Returns status and amount only, never the customer name, phone, address, or receipt.', orderArgs, outputs.order, args => getOrderStatus(principal, args), { scope: 'orders:read' });
    }

    // This is a documented low-level SDK API, not a replacement transport or a
    // handwritten protocol response. The SDK still supplies resultType, cache
    // metadata, validation of the request envelope, and JSON-RPC encoding.
    server.server.setRequestHandler('tools/list', () => ({ tools: toolDescriptors }));

    if (!coreAdapter) server.registerResource('restaurant-directory', UI_RESOURCE_URI, { title: 'Synthetic restaurant directory', mimeType: 'text/html;profile=mcp-app' }, async () => ({
      contents: [{
        uri: UI_RESOURCE_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: uiHtml,
        _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
      }],
    }));

    if (modernEvents) {
      const registerEvent = (method, schema, output, callback) => {
        server.server.setRequestHandler(method, { params: schema, result: output }, async params => {
          if (!hasScope(principal, 'events:read')) throw new ProtocolError(-32003, 'forbidden');
          const { _meta, ...args } = params;
          try { return output.parse(await callback(args)); }
          catch (error) { throw safeEventFailure(error); }
        });
      };
      registerEvent('events/list', eventList, eventListResult, async args => {
        // A single bounded catalog; silently ignoring a cursor could loop clients.
        if (args.cursor) throw new ProtocolError(-32602, 'invalid_cursor');
        return events.list(principal);
      });
      registerEvent('events/subscribe', eventSubscribe, eventSubscribeResult, args => events.subscribe(principal, args));
      registerEvent('events/unsubscribe', eventUnsubscribe, z.object({}).strip(), args => events.unsubscribe(principal, args));
    }
    return server;
  }

  return async function mcpHandler(req, res) {
    let observedMethod = 'unknown';
    let observedVersion = 'unspecified';
    const safeVersion = value => PROTOCOL_STATUS.supportedVersions.includes(value) ? value : 'unsupported';
    if (req.headers['mcp-protocol-version']) observedVersion = safeVersion(req.headers['mcp-protocol-version']);
    res.once('finish', () => {
      // Only fixed method/version labels and HTTP status: never log bodies,
      // tool arguments, URL queries, credentials, cookies, users, or IPs.
      try { onProtocolExchange({ method: observedMethod, protocol: observedVersion, status: res.statusCode }); }
      catch { /* Diagnostics must not change protocol behavior. */ }
    });
    // Exact origin/host (including port) avoids both DNS rebinding and localhost
    // cross-origin writes. Forwarded headers never select the trusted origin.
    if (req.headers.host !== base.host || (req.headers.origin !== undefined && req.headers.origin !== base.origin)) return rpcError(res, 403, null, -32003, 'invalid_origin');
    if (req.method !== 'POST') return rpcError(res, 405, null, -32600, 'method_not_allowed', { allow: 'POST' });
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return rpcError(res, 415, null, -32600, 'json_required');
    let body;
    try { body = await readBody(req); }
    catch (error) { return rpcError(res, error.status ?? 400, null, error.status === 413 ? -32600 : -32700, error.message); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return rpcError(res, 400, null, -32600, 'single_request_required');
    if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') return rpcError(res, 400, body.id, -32600, 'invalid_request');
    if (allowedMethods.has(body.method)) observedMethod = body.method;
    const claimedVersion = body.params?._meta?.['io.modelcontextprotocol/protocolVersion'] ?? (body.method === 'initialize' ? body.params?.protocolVersion : undefined);
    if (claimedVersion !== undefined) observedVersion = safeVersion(claimedVersion);
    // No generic SDK subscription streams, sampling, elicitation, or session
    // endpoints. Our only asynchronous delivery surface is signed webhooks.
    // The SDK owns both legacy initialization and modern version negotiation.
    if (!allowedMethods.has(body.method)) return rpcError(res, 200, body.id, -32601, 'method_not_found');

    let principal;
    try { principal = await authenticate(req); }
    catch { return rpcError(res, 503, body.id, -32603, 'authentication_unavailable'); }
    const isToolCall = body.method === 'tools/call';
    const scope = isToolCall ? toolScopes[body.params?.name] : body.method.startsWith('events/') ? 'events:read' : undefined;
    const missingBearer = scope && !req.headers.origin && !/^Bearer\s+\S+$/i.test(req.headers.authorization ?? '');
    if (scope && isToolCall) {
      // A cookie without Origin must never authenticate a private MCP call.
      // Missing/expired credentials and insufficient scopes become safe tool
      // errors below, after the official SDK validates the protocol envelope.
      if (missingBearer) principal = null;
    } else {
      // Events and transport-level metadata requests retain HTTP challenges.
      const challenge = scope ? authChallenge(scope)
        : `Bearer resource_metadata="${metadataUrl}", error="invalid_token", error_description="A valid access token is required."`;
      if ((!principal && (scope || req.headers.authorization)) || missingBearer) return rpcError(res, 401, body.id, -32001, 'authentication_required', { 'www-authenticate': challenge });
      if (scope && !hasScope(principal, scope)) return rpcError(res, 403, body.id, -32003, 'insufficient_scope', { 'www-authenticate': authChallenge(scope, 'insufficient_scope') });
    }

    // The factory captures only this verified request's principal. There is no
    // shared mutable auth state, cached transport session, or client tenant key.
    const sdk = createSdkHandler(ctx => makeServer(principal, ctx.era), { legacy: 'stateless', responseMode: 'auto', maxRequestBodySize: MAX_BODY, keepAliveMs: 0 });
    res.setHeader('cache-control', 'no-store');
    try { await toNodeHandler(sdk, { maxRequestBodySize: MAX_BODY })(req, res, body); }
    finally { await sdk.close(); }
  };
}
