import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createMcpHandler, MCP_PROTOCOL_VERSION, PROTOCOL_STATUS, UI_RESOURCE_URI } from './mcp.mjs';
import { CORE_MENU_UI_HTML, CORE_MENU_UI_RESOURCE_URI } from './core-menu-ui.mjs';

const alice = { id: 'customer-alice', role: 'customer', tenantIds: [], scopes: ['orders:read', 'orders:write', 'events:read'] };
const bob = { ...alice, id: 'customer-bob' };
const merchant = { id: 'merchant-a', role: 'merchant', tenantIds: ['demo-a'], scopes: ['orders:read', 'orders:write', 'events:read'] };
const restaurant = { id: 'demo-a', name: 'Synthetic A', cuisine: 'saudi', template: 'classic' };
const menu = { tenantId: 'demo-a', name: 'Synthetic A', currency: 'SAR', items: [{ id: 'rice', name: 'Rice', priceMinor: 2500, stock: 9 }] };
const quote = { tenantId: 'demo-a', currency: 'SAR', totalMinor: 2500, items: [{ itemId: 'rice', name: 'Rice', quantity: 1, unitPriceMinor: 2500, totalMinor: 2500 }] };
const order = { ...quote, id: 'order-a', status: 'accepted', paymentStatus: 'paid', version: 2, ownerId: alice.id, phone: 'must-never-leak', address: { text: 'must-never-leak' } };
const cart = { tenantId: 'demo-a', items: [{ itemId: 'rice', quantity: 1 }] };
const handoff = { ...cart, expectedTotalMinor: 2500, idempotencyKey: 'cart-key-123' };

function envelope(method, params = {}, id = 1, version = MCP_PROTOCOL_VERSION) {
  return { jsonrpc: '2.0', id, method, params: { ...params, _meta: {
    'io.modelcontextprotocol/protocolVersion': version,
    'io.modelcontextprotocol/clientInfo': { name: 'synthetic-protocol-test', version: '0.1.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  } } };
}

async function setup(t, overrides = {}) {
  const calls = [];
  let handler;
  const server = createServer((req, res) => handler(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const record = (name, result) => async (...args) => { calls.push({ name, args }); return result; };
  const events = {
    list: record('events/list', { events: [{ name: 'order.status_changed', description: 'Order state change for an owned order.', delivery: ['webhook'], inputSchema: { type: 'object' }, payloadSchema: { type: 'object' } }] }),
    subscribe: record('events/subscribe', { id: 'sub-1', refreshBefore: '2026-10-01T00:00:00Z', cursor: null, truncated: false }),
    unsubscribe: record('events/unsubscribe', {}),
  };
  handler = createMcpHandler({
    baseUrl,
    authenticate: async req => ({ 'Bearer alice': alice, 'Bearer bob': bob, 'Bearer merchant': merchant, 'Bearer no-scope': { ...alice, scopes: [] } })[req.headers.authorization] ?? null,
    listRestaurants: record('listRestaurants', { restaurants: [{ ...restaurant, privateSecret: 'not-for-model' }] }),
    getMenu: record('getMenu', menu),
    quoteCart: record('quoteCart', quote),
    prepareCheckout: record('prepareCheckout', { checkoutId: 'checkout-a', tenantId: 'demo-a', totalMinor: 2500, currency: 'SAR', checkoutUrl: `${baseUrl}/checkout/checkout-a`, expiresAt: '2026-10-01T00:00:00Z' }),
    getOrderStatus: async (principal, args) => {
      calls.push({ name: 'getOrderStatus', args: [principal, args] });
      if (principal.id !== alice.id || args.tenantId !== 'demo-a') throw Object.assign(new Error('private database details'), { code: 'not_found' });
      return order;
    },
    events,
    uiHtml: '<!doctype html><html lang="ar"><body>Synthetic fixture</body></html>',
    ...overrides,
  });
  async function send(body, { token, headers = {}, method = 'POST', raw, legacy = false } = {}) {
    const response = await fetch(`${baseUrl}/mcp`, { method, headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(!legacy ? { 'MCP-Protocol-Version': MCP_PROTOCOL_VERSION } : {}),
      ...(!legacy && body?.method ? { 'Mcp-Method': body.method } : {}),
      ...(!legacy && (body?.params?.name || body?.params?.uri) ? { 'Mcp-Name': body.params.name ?? body.params.uri } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    }, ...(method === 'POST' ? { body: raw ?? JSON.stringify(body) } : {}) });
    const text = await response.text();
    // The official stateless legacy transport responds over SSE. Modern
    // single-result requests use JSON; exercise both real wire formats.
    const payload = response.headers.get('content-type')?.startsWith('text/event-stream')
      ? text.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
      : text;
    return { status: response.status, headers: response.headers, text, body: payload ? JSON.parse(payload) : null };
  }
  return { baseUrl, calls, send, call: (name, args = {}, options = {}) => send(envelope('tools/call', { name, arguments: args }), options) };
}

test('official MCP2 transport discovers exact protocol and webhook capability', async t => {
  const fixture = await setup(t);
  const result = await fixture.send(envelope('server/discover'));
  assert.equal(result.status, 200, result.text);
  assert.equal(result.body.result.resultType, 'complete');
  assert.deepEqual(result.body.result.supportedVersions, [MCP_PROTOCOL_VERSION]);
  assert.deepEqual(result.body.result.capabilities.events, {});
  assert.ok(result.body.result.capabilities.tools);
  assert.ok(result.body.result.capabilities.resources);
  assert.equal(PROTOCOL_STATUS.actualChatGPTVerified, false);
  assert.equal(fixture.calls.length, 0);
});

test('five tools expose accurate schemas and sidebar/thread metadata but no simulator or merchant tools', async t => {
  const fixture = await setup(t);
  const result = await fixture.send(envelope('tools/list'));
  assert.equal(result.status, 200, result.text);
  const tools = result.body.result.tools;
  assert.deepEqual(tools.map(tool => tool.name), ['search_restaurants', 'get_restaurant_menu', 'quote_cart', 'prepare_checkout', 'get_order_status']);
  const search = tools[0];
  assert.equal(search._meta.ui.resourceUri, UI_RESOURCE_URI);
  assert.deepEqual(search._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
  assert.equal(search.inputSchema.additionalProperties, false);
  assert.equal(tools[3].annotations.readOnlyHint, false);
  assert.equal(tools[3].annotations.idempotentHint, true);
  assert.deepEqual(search.securitySchemes, [{ type: 'noauth' }]);
  assert.deepEqual(tools[3].securitySchemes, [{ type: 'oauth2', scopes: ['orders:write'] }]);
  assert.deepEqual(tools[3]._meta.securitySchemes, [{ type: 'oauth2', scopes: ['orders:write'] }]);
  for (const tool of tools) assert.deepEqual(tool.securitySchemes, tool._meta.securitySchemes);
  assert.ok(tools.every(tool => tool.outputSchema.type === 'object'));
  assert.equal(tools[1]._meta.ui, undefined);
});

test('UI resource uses MCP Apps MIME and deny-by-default external CSP', async t => {
  const fixture = await setup(t);
  const result = await fixture.send(envelope('resources/read', { uri: UI_RESOURCE_URI }));
  assert.equal(result.status, 200, result.text);
  const resource = result.body.result.contents[0];
  assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
  assert.match(resource.text, /Synthetic fixture/);
  assert.deepEqual(resource._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
});

test('real core exposes a versioned, read-only menu UI without rendering each quote or enabling checkout from the app', async t => {
  const coreAdapter = { listRestaurants: async () => [], getMenu: async () => { throw Error('unused'); }, preview: async () => { throw Error('unused'); } };
  const fixture = await setup(t, { coreAdapter, coreCheckouts: { prepare() { throw Error('unused'); }, status() { throw Error('unused'); } } });
  for (const legacy of [false, true]) {
    const send = (method, params = {}) => fixture.send(legacy ? { jsonrpc: '2.0', id: 1, method, params } : envelope(method, params), { legacy });
    const tools = (await send('tools/list')).body.result.tools;
    const menu = tools.find(tool => tool.name === 'get_restaurant_menu');
    assert.equal(menu._meta.ui.resourceUri, CORE_MENU_UI_RESOURCE_URI);
    assert.equal(menu._meta['openai/outputTemplate'], CORE_MENU_UI_RESOURCE_URI);
    assert.equal(menu._meta['openai/widgetAccessible'], true);
    assert.deepEqual(menu._meta.ui.visibility, ['model', 'app']);
    assert.deepEqual(menu.securitySchemes, [{ type: 'noauth' }]);
    assert.equal(menu.annotations.readOnlyHint, true);
    const quote = tools.find(tool => tool.name === 'quote_cart');
    assert.equal(quote._meta.ui.resourceUri, undefined, 'Repricing must not instantiate another widget');
    assert.equal(quote._meta['openai/widgetAccessible'], true);
    assert.deepEqual(quote._meta.ui.visibility, ['model', 'app']);
    assert.equal(quote.annotations.readOnlyHint, true);
    for (const name of ['prepare_checkout', 'get_order_status', 'search_restaurants']) {
      const tool = tools.find(row => row.name === name);
      assert.deepEqual(tool._meta.ui.visibility, ['model']);
      assert.equal(tool._meta['openai/widgetAccessible'], false);
      assert.equal(tool._meta.ui.resourceUri, undefined);
    }
    const resources = (await send('resources/list')).body.result.resources;
    assert.deepEqual(resources.map(row => row.uri), [CORE_MENU_UI_RESOURCE_URI]);
    const resource = (await send('resources/read', { uri: CORE_MENU_UI_RESOURCE_URI })).body.result.contents[0];
    assert.equal(resource.text, CORE_MENU_UI_HTML);
    assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
    assert.deepEqual(resource._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
    assert.match(resource.text, /ui\/initialize/);
    assert.match(resource.text, /tools\/call/);
    assert.match(resource.text, /dir="rtl"/);
    assert.doesNotMatch(resource.text, /prepare_checkout|create_order|requestCheckout|https?:\/\/|fetch\(|XMLHttpRequest|localStorage/);
  }
  assert.equal(fixture.calls.length, 0, 'Reading static UI never reads private data or performs a backend action');
});

test('adding the real core UI does not bypass private catalog OAuth or widen its scope', async t => {
  let reads = 0;
  const coreAdapter = { listRestaurants: async () => [], getMenu: async () => { reads++; throw Error('unused'); }, preview: async () => { reads++; throw Error('unused'); } };
  const fixture = await setup(t, { coreAdapter, requireCatalogAuth: true });
  const tools = (await fixture.send(envelope('tools/list'))).body.result.tools;
  for (const name of ['get_restaurant_menu', 'quote_cart']) {
    const tool = tools.find(row => row.name === name);
    assert.deepEqual(tool.securitySchemes, [{ type: 'oauth2', scopes: ['orders:read'] }]);
    assert.deepEqual(tool._meta.securitySchemes, tool.securitySchemes);
    const args = name === 'get_restaurant_menu' ? { tenantId: 'demo-a' } : { ...cart, mode: 'pickup' };
    for (const token of [undefined, 'no-scope', 'merchant']) {
      const result = (await fixture.call(name, args, { token })).body.result;
      assert.equal(result.isError, true);
      assert.match(result._meta['mcp/www_authenticate'][0], /scope="orders:read"/);
    }
  }
  assert.equal(reads, 0);
  const resource = await fixture.send(envelope('resources/read', { uri: CORE_MENU_UI_RESOURCE_URI }));
  assert.equal(resource.body.result.contents[0].text, CORE_MENU_UI_HTML);
  assert.equal(reads, 0);
});

test('public catalog/menu/quote work without authentication and do not leak extra output', async t => {
  const fixture = await setup(t);
  const search = await fixture.call('search_restaurants', { query: 'synthetic', cuisine: 'saudi' });
  assert.equal(search.body.result.isError, undefined);
  assert.deepEqual(search.body.result.structuredContent, { restaurants: [restaurant] });
  const menuResult = await fixture.call('get_restaurant_menu', { tenantId: 'demo-a' });
  assert.deepEqual(menuResult.body.result.structuredContent, menu);
  const quoteResult = await fixture.call('quote_cart', cart);
  assert.deepEqual(quoteResult.body.result.structuredContent, quote);
  assert.equal(fixture.calls.at(-1).args[0], null);
});

test('protected tools return SDK-encoded OAuth challenge results without calling the backend', async t => {
  const fixture = await setup(t);
  const anonymous = await fixture.call('prepare_checkout', handoff);
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.body.result.resultType, 'complete');
  assert.equal(anonymous.body.result.isError, true);
  const challenge = anonymous.body.result._meta['mcp/www_authenticate'][0];
  assert.match(challenge, /oauth-protected-resource/);
  assert.match(challenge, /scope="orders:write"/);
  assert.match(challenge, /error="invalid_token"/);
  assert.match(challenge, /error_description="[^"]+"/);
  assert.equal(anonymous.body.result.structuredContent, undefined);
  for (const token of ['no-scope', 'merchant', 'invalid']) {
    const response = await fixture.call('prepare_checkout', handoff, { token });
    assert.equal(response.status, 200);
    assert.equal(response.body.result.isError, true);
    assert.match(response.body.result._meta['mcp/www_authenticate'][0], token === 'invalid' ? /error="invalid_token"/ : /error="insufficient_scope"/);
  }
  assert.equal(fixture.calls.length, 0);
  const accepted = await fixture.call('prepare_checkout', handoff, { token: 'alice' });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.result.structuredContent.checkoutId, 'checkout-a');
  assert.equal(fixture.calls[0].args[0].id, alice.id);
  assert.equal(fixture.calls[0].args[1].idempotencyKey, handoff.idempotencyKey);
});

test('cookie-only private tools without exact Origin cannot bypass authentication', async t => {
  const fixture = await setup(t, { authenticate: async () => alice });
  const withoutOrigin = await fixture.call('prepare_checkout', handoff);
  assert.equal(withoutOrigin.status, 200);
  assert.equal(withoutOrigin.body.result.isError, true);
  assert.match(withoutOrigin.body.result._meta['mcp/www_authenticate'][0], /error="invalid_token"/);
  assert.equal(fixture.calls.length, 0);
  const sameOrigin = await fixture.call('prepare_checkout', handoff, { headers: { origin: fixture.baseUrl } });
  assert.equal(sameOrigin.body.result.structuredContent.checkoutId, 'checkout-a');
});

test('private staging catalog requires OAuth on all data tools but leaves static discovery and UI readable', async t => {
  const fixture = await setup(t, { requireCatalogAuth: true });
  const tools = await fixture.send(envelope('tools/list'));
  assert.equal(tools.status, 200);
  for (const descriptor of tools.body.result.tools.slice(0, 3)) {
    assert.deepEqual(descriptor.securitySchemes, [{ type: 'oauth2', scopes: ['orders:read'] }]);
    assert.deepEqual(descriptor._meta.securitySchemes, [{ type: 'oauth2', scopes: ['orders:read'] }]);
  }
  assert.equal(tools.body.result.resultType, 'complete');
  assert.equal(tools.body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'restaurant-saas-synthetic-prototype');
  for (const descriptor of tools.body.result.tools) assert.deepEqual(descriptor.securitySchemes, descriptor._meta.securitySchemes);
  for (const [name, args] of [['search_restaurants', {}], ['get_restaurant_menu', { tenantId: 'demo-a' }], ['quote_cart', cart]]) {
    const response = await fixture.call(name, args);
    assert.equal(response.status, 200);
    assert.equal(response.body.result.isError, true);
    assert.match(response.body.result._meta['mcp/www_authenticate'][0], /scope="orders:read"/);
    assert.equal(response.body.result.structuredContent, undefined);
    const denied = await fixture.call(name, args, { token: 'no-scope' });
    assert.match(denied.body.result._meta['mcp/www_authenticate'][0], /error="insufficient_scope"/);
  }
  assert.equal(fixture.calls.length, 0);
  const staticUi = await fixture.send(envelope('resources/read', { uri: UI_RESOURCE_URI }));
  assert.equal(staticUi.status, 200);
  assert.match(staticUi.body.result.contents[0].text, /Synthetic fixture/);
  assert.equal(fixture.calls.length, 0);
  for (const [name, args] of [['search_restaurants', {}], ['get_restaurant_menu', { tenantId: 'demo-a' }], ['quote_cart', cart]]) {
    const response = await fixture.call(name, args, { token: 'alice' });
    assert.equal(response.status, 200);
    assert.notEqual(response.body.result.isError, true);
    assert.ok(response.body.result.structuredContent);
  }
  assert.equal(fixture.calls.length, 3);
});

test('ownership delegated for every request and PII stripped from successful status', async t => {
  const fixture = await setup(t);
  const args = { tenantId: 'demo-a', orderId: 'order-a' };
  const [a, b] = await Promise.all([fixture.call('get_order_status', args, { token: 'alice' }), fixture.call('get_order_status', args, { token: 'bob' })]);
  assert.equal(a.body.result.structuredContent.id, 'order-a');
  assert.doesNotMatch(a.text, /ownerId|phone|address|must-never-leak|customer-alice/);
  assert.equal(b.body.result.isError, true);
  assert.equal(b.body.result.content[0].text, 'not_found');
  assert.doesNotMatch(b.text, /private database/);
  const wrongTenant = await fixture.call('get_order_status', { ...args, tenantId: 'demo-b' }, { token: 'alice' });
  assert.equal(wrongTenant.body.result.isError, true);
});

test('unknown fields, invalid quantity and unsupported private tools never call backend', async t => {
  const fixture = await setup(t);
  for (const args of [{ ...cart, phone: 'not-accepted' }, { ...cart, items: [{ itemId: 'rice', quantity: 0 }] }, { ...cart, items: [{ itemId: 'rice', quantity: 1.5 }] }]) {
    const result = await fixture.call('quote_cart', args);
    assert.equal(result.body.result?.isError ?? Boolean(result.body.error), true);
  }
  const missing = await fixture.call('simulate_payment', { tenantId: 'demo-a' }, { token: 'alice' });
  assert.ok(missing.body.error || missing.body.result.isError);
  assert.equal(fixture.calls.length, 0);
});

test('backend exceptions and hostile checkout links cannot leak via model output', async t => {
  const fixture = await setup(t, {
    getMenu: async () => { throw new Error('postgres://secret@db?token=private'); },
    prepareCheckout: async () => ({ checkoutId: 'checkout-a', tenantId: 'demo-a', totalMinor: 2500, currency: 'SAR', checkoutUrl: 'https://attacker.example/checkout/a', expiresAt: '2026-10-01T00:00:00Z' }),
  });
  for (const result of [await fixture.call('get_restaurant_menu', { tenantId: 'demo-a' }), await fixture.call('prepare_checkout', handoff, { token: 'alice' })]) {
    assert.equal(result.body.result.isError, true);
    assert.equal(result.body.result.content[0].text, 'service_unavailable');
    assert.doesNotMatch(result.text, /postgres:|secret@|attacker/);
  }
});

test('events methods use the same authenticated endpoint and forward only validated params', async t => {
  const fixture = await setup(t);
  assert.equal((await fixture.send(envelope('events/list'))).status, 401);
  const insufficient = await fixture.send(envelope('events/list'), { token: 'no-scope' });
  assert.equal(insufficient.status, 403);
  assert.match(insufficient.headers.get('www-authenticate'), /error="insufficient_scope"/);
  assert.match(insufficient.headers.get('www-authenticate'), /error_description="[^"]+"/);
  const listed = await fixture.send(envelope('events/list'), { token: 'alice' });
  assert.equal(listed.body.result.events[0].name, 'order.status_changed');
  const params = { name: 'order.status_changed', arguments: { tenantId: 'demo-a', orderId: 'order-a' }, delivery: { mode: 'webhook', url: 'https://receiver.example/callback', secret: `whsec_${Buffer.alloc(32, 7).toString('base64')}` }, cursor: null, ttlMs: 60000 };
  const subscribed = await fixture.send(envelope('events/subscribe', params), { token: 'alice' });
  assert.equal(subscribed.body.result.id, 'sub-1');
  assert.deepEqual(fixture.calls.at(-1).args, [alice, params]);
  assert.doesNotMatch(subscribed.text, /whsec_|receiver\.example|customer-alice/);
  const unsubscribe = { name: params.name, arguments: params.arguments, delivery: { mode: 'webhook', url: params.delivery.url } };
  const stopped = await fixture.send(envelope('events/unsubscribe', unsubscribe), { token: 'alice' });
  assert.equal(stopped.status, 200);
  assert.deepEqual(fixture.calls.at(-1).args, [alice, unsubscribe]);
});

test('event transport rejects malformed filters and preserves categorized callback error only', async t => {
  const fixture = await setup(t, { events: {
    list: async () => ({ events: [] }),
    subscribe: async () => { throw { code: -32015, message: 'private callback secret', data: { reason: 'timeout', secret: 'private' } }; },
    unsubscribe: async () => ({}),
  } });
  const args = { name: 'order.status_changed', arguments: { tenantId: 'demo-a', orderId: 'order-a' }, delivery: { mode: 'webhook', url: 'https://receiver.example/callback', secret: 'whsec_test' } };
  const failed = await fixture.send(envelope('events/subscribe', args), { token: 'alice' });
  assert.equal(failed.body.error.code, -32015);
  assert.deepEqual(failed.body.error.data, { reason: 'timeout' });
  assert.doesNotMatch(failed.text, /private callback|secret/);
  const invalid = await fixture.send(envelope('events/subscribe', { ...args, arguments: { ...args.arguments, ownerId: 'customer-bob' } }), { token: 'alice' });
  assert.equal(invalid.body.error.code, -32602);
});

test('unsupported modern versions, absent envelope and header mismatches fail closed', async t => {
  const fixture = await setup(t);
  const unsupported = await fixture.send(envelope('server/discover', {}, 1, '2027-01-01'), { headers: { 'MCP-Protocol-Version': '2027-01-01' } });
  assert.equal(unsupported.body.error.code, -32022);
  const missingEnvelope = await fixture.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  assert.ok(missingEnvelope.body.error);
  const mismatch = await fixture.send(envelope('tools/list'), { headers: { 'Mcp-Method': 'tools/call' } });
  assert.equal(mismatch.body.error.code, -32020);
  assert.equal(fixture.calls.length, 0);
});

test('legacy initialization works without modern headers and does not advertise MCP2 Events', async t => {
  const fixture = await setup(t, { requireCatalogAuth: true });
  for (const version of ['2025-11-25', '2025-06-18', '2025-03-26']) {
    const initialized = await fixture.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'legacy-test', version: '1' } } }, { legacy: true });
    assert.equal(initialized.status, 200, initialized.text);
    assert.equal(initialized.body.result.protocolVersion, version);
    assert.ok(initialized.body.result.capabilities.tools);
    assert.ok(initialized.body.result.capabilities.resources);
    assert.equal(initialized.body.result.capabilities.events, undefined);
    assert.equal(initialized.headers.get('mcp-session-id'), null);
  }
  const notified = await fixture.send({ jsonrpc: '2.0', method: 'notifications/initialized' }, { legacy: true });
  assert.equal(notified.status, 202);
  assert.equal(fixture.calls.length, 0);
});

test('legacy discovery and UI remain readable while every staging data tool requires OAuth', async t => {
  const fixture = await setup(t, { requireCatalogAuth: true });
  const tools = await fixture.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { legacy: true, headers: { 'MCP-Protocol-Version': '2025-06-18' } });
  assert.equal(tools.status, 200, tools.text);
  assert.equal(tools.body.result.tools.length, 5);
  assert.equal(tools.body.result.resultType, undefined);
  for (const tool of tools.body.result.tools) assert.equal(tool.securitySchemes[0].type, 'oauth2');
  const ui = await fixture.send({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: UI_RESOURCE_URI } }, { legacy: true });
  assert.equal(ui.status, 200, ui.text);
  assert.equal(ui.body.result.contents[0].mimeType, 'text/html;profile=mcp-app');
  for (const [name, args] of [['search_restaurants', {}], ['get_restaurant_menu', { tenantId: 'demo-a' }], ['quote_cart', cart], ['prepare_checkout', handoff], ['get_order_status', { tenantId: 'demo-a', orderId: 'order-a' }]]) {
    const rejected = await fixture.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name, arguments: args } }, { legacy: true });
    assert.equal(rejected.status, 200, rejected.text);
    assert.equal(rejected.body.result.isError, true);
    assert.ok(rejected.body.result._meta['mcp/www_authenticate']);
  }
  assert.equal(fixture.calls.length, 0);
  const accepted = await fixture.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_order_status', arguments: { tenantId: 'demo-a', orderId: 'order-a' } } }, { legacy: true, token: 'alice' });
  assert.equal(accepted.body.result.structuredContent.id, 'order-a');
  assert.doesNotMatch(accepted.text, /must-never-leak|ownerId/);
  const otherCustomer = await fixture.send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_order_status', arguments: { tenantId: 'demo-a', orderId: 'order-a' } } }, { legacy: true, token: 'bob' });
  assert.equal(otherCustomer.body.result.isError, true);
  assert.doesNotMatch(otherCustomer.text, /private database/);
});

test('protocol diagnostics contain only fixed labels and status, never user input or credentials', async t => {
  const reports = [];
  const fixture = await setup(t, { onProtocolExchange: record => reports.push(record) });
  await fixture.send({ jsonrpc: '2.0', id: 9, method: 'secret-user-input', params: { secret: 'do-not-log' } }, { legacy: true, headers: { 'MCP-Protocol-Version': 'private-token-value', authorization: 'Bearer private-token', cookie: 'private-cookie' } });
  await fixture.send({ jsonrpc: '2.0', id: 10, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'private-client-name', version: '1' } } }, { legacy: true });
  assert.deepEqual(reports, [
    { method: 'unknown', protocol: 'unsupported', status: 200 },
    { method: 'initialize', protocol: '2025-06-18', status: 200 },
  ]);
  assert.doesNotMatch(JSON.stringify(reports), /secret-user|do-not-log|private-/);
});

test('HTTP boundary rejects wrong host/origin, oversized bodies, batches and non-JSON', async t => {
  const fixture = await setup(t);
  const body = envelope('tools/list');
  assert.equal((await fixture.send(body, { headers: { origin: 'https://hostile.example' } })).status, 403);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(`${fixture.baseUrl}/mcp`, { method: 'POST', headers: { host: 'hostile.example', 'content-type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
  assert.equal(wrongHostStatus, 403);
  assert.equal((await fixture.send(body, { raw: JSON.stringify({ padding: 'x'.repeat(33 * 1024) }) })).status, 413);
  assert.equal((await fixture.send([body])).status, 400);
  assert.equal((await fixture.send(body, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await fixture.send(body, { method: 'GET' })).status, 405);
  assert.equal((await fixture.send(body, { token: 'invalid' })).status, 401);
  assert.equal((await fixture.send({ ...body, method: 123 })).status, 400);
  const stream = await fixture.send(envelope('subscriptions/listen'));
  assert.equal(stream.body.error.code, -32601);
});

test('core opening status is read-only, scoped and rejects caller clocks',async t=>{
 let reads=0;
 const value={tenantId:'demo-a',version:1,scheduleEnabled:false,withinHours:null,acceptingOrders:true,timeZone:'Asia/Riyadh',evaluatedAt:new Date().toISOString()};
 const fixture=await setup(t,{requireCatalogAuth:true,coreAdapter:{async listRestaurants(){return[];},async getMenu(){throw Error('unused');},async preview(){throw Error('unused');},async openingStatus(id){reads++;assert.equal(id,'demo-a');return value;}}});
 const denied=await fixture.call('get_restaurant_opening_status',{tenantId:'demo-a'});assert.equal(denied.body.result.isError,true);assert.equal(reads,0);
 const bad=await fixture.call('get_restaurant_opening_status',{tenantId:'demo-a',at:'yesterday'},{token:'alice'});assert.ok(bad.body.error||bad.body.result.isError);assert.equal(reads,0);
 const response=await fixture.call('get_restaurant_opening_status',{tenantId:'demo-a'},{token:'alice'});assert.deepEqual(response.body.result.structuredContent,value);assert.equal(reads,1);
});

test('bounded open search is read-only and requires catalog scope',async t=>{
 let reads=0;
 const value={restaurants:[],checked:2,closed:1,unconfigured:1,unavailable:0,nextAfter:'demo-b',hasMore:true,evaluatedAt:new Date().toISOString()};
 const fixture=await setup(t,{requireCatalogAuth:true,coreAdapter:{async listRestaurants(){return[];},async getMenu(){throw Error('unused');},async preview(){throw Error('unused');},async searchOpenRestaurants(args){reads++;assert.deepEqual(args,{limit:2});return value;}}});
 assert.equal((await fixture.call('search_open_restaurants',{limit:2})).body.result.isError,true);assert.equal(reads,0);
 const response=await fixture.call('search_open_restaurants',{limit:2},{token:'alice'});assert.deepEqual(response.body.result.structuredContent,value);assert.equal(reads,1);
 const bad=await fixture.call('search_open_restaurants',{limit:999},{token:'alice'});assert.ok(bad.body.error||bad.body.result.isError);assert.equal(reads,1);
});

test('opening tools enforce the same cookie Origin boundary in modern and legacy private catalogs', async t => {
  for (const legacy of [false, true]) await t.test(legacy ? 'legacy' : 'modern', async t => {
    let reads = 0;
    const fixture = await setup(t, { requireCatalogAuth: true,
      authenticate: async req => req.headers.authorization === 'Bearer no-scope' ? { ...alice, scopes: [] }
        : req.headers.authorization === 'Bearer alice' || req.headers.cookie ? alice : null,
      coreAdapter: { async listRestaurants() { return []; },
        async openingStatus(tenantId) { reads++; return { tenantId, version: 1, scheduleEnabled: false, withinHours: null,
          acceptingOrders: true, timeZone: 'Asia/Riyadh', evaluatedAt: new Date().toISOString() }; },
        async searchOpenRestaurants() { reads++; return { restaurants: [], checked: 0, closed: 0, unconfigured: 0,
          unavailable: 0, nextAfter: null, hasMore: false, evaluatedAt: new Date().toISOString() }; },
      },
    });
    for (const [name, args] of [['get_restaurant_opening_status', { tenantId: 'demo-a' }], ['search_open_restaurants', {}]]) {
      const call = options => fixture.send(legacy ? { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }
        : envelope('tools/call', { name, arguments: args }), { legacy, ...options });
      const before = reads;
      for (const options of [{}, { headers: { cookie: 'synthetic=present' } }, { token: 'no-scope' }]) {
        const result = (await call(options)).body.result;
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent, undefined);
        assert.match(result._meta['mcp/www_authenticate'][0], /scope="orders:read"/);
      }
      assert.equal(reads, before, 'Rejected requests must never read the catalog');
      assert.equal((await call({ headers: { cookie: 'synthetic=present', origin: 'https://foreign.example' } })).status, 403);
      for (const options of [{ token: 'alice' }, { headers: { cookie: 'synthetic=present', origin: fixture.baseUrl } }]) {
        assert.ok((await call(options)).body.result.structuredContent);
      }
      assert.equal(reads, before + 2);
    }
  });
});

test('public opening tools remain available without credentials', async t => {
  let reads = 0;
  const fixture = await setup(t, { coreAdapter: { async listRestaurants() { return []; },
    async openingStatus(tenantId) { reads++; return { tenantId, version: 1, scheduleEnabled: false, withinHours: null,
      acceptingOrders: true, timeZone: 'Asia/Riyadh', evaluatedAt: new Date().toISOString() }; },
    async searchOpenRestaurants() { reads++; return { restaurants: [], checked: 0, closed: 0, unconfigured: 0,
      unavailable: 0, nextAfter: null, hasMore: false, evaluatedAt: new Date().toISOString() }; },
  } });
  assert.ok((await fixture.call('get_restaurant_opening_status', { tenantId: 'demo-a' })).body.result.structuredContent);
  assert.ok((await fixture.call('search_open_restaurants', {})).body.result.structuredContent);
  assert.equal(reads, 2);
});
