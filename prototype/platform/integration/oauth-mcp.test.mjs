import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

// Intentionally not configurable: never point these synthetic identity tests
// at a production endpoint. Start the isolated prototype Compose project first.
const BASE = 'http://127.0.0.1:18787';
const RESOURCE = `${BASE}/mcp`;
const REDIRECT = `${BASE}/dev/oauth-callback`;
const PROTOCOL = '2026-07-28';
const EXPECTED_TOOLS = ['search_restaurants', 'get_restaurant_menu', 'quote_cart', 'prepare_checkout', 'get_order_status'];
let nextId = 0;

async function request(path, { method = 'GET', token, origin, json, form, headers = {} } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(8000),
    headers: {
      ...(json === undefined ? {} : { 'content-type': 'application/json' }),
      ...(form === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {}),
      ...headers,
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    ...(form === undefined ? {} : { body: new URLSearchParams(form).toString() }),
  });
  const text = await response.text();
  const body = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null;
  return { status: response.status, headers: response.headers, body, text };
}

function rpc(method, params = {}, token) {
  return request('/mcp', {
    method: 'POST', token,
    headers: {
      accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL,
      'Mcp-Method': method,
      ...(params.name || params.uri ? { 'Mcp-Name': params.name ?? params.uri } : {}),
    },
    json: {
      jsonrpc: '2.0', id: ++nextId, method,
      params: { ...params, _meta: {
        'io.modelcontextprotocol/protocolVersion': PROTOCOL,
        'io.modelcontextprotocol/clientInfo': { name: 'compose-integration-test', version: '0.1.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } },
    },
  });
}

function tool(name, args = {}, token) {
  return rpc('tools/call', { name, arguments: args }, token);
}

function successfulTool(response) {
  assert.equal(response.status, 200);
  assert.equal(response.body.error, undefined);
  assert.notEqual(response.body.result?.isError, true);
  return response.body.result.structuredContent;
}

function toolAuthChallenge(response, scope, error) {
  // A delivered MCP error result is HTTP 200, not a successful business action.
  // REST and event methods intentionally retain their HTTP 401/403 contract.
  assert.equal(response.status, 200);
  assert.equal(response.body.error, undefined);
  assert.equal(response.body.result?.resultType, 'complete');
  assert.equal(response.body.result.isError, true);
  assert.equal(response.body.result.structuredContent, undefined);
  const challenges = response.body.result._meta?.['mcp/www_authenticate'];
  assert.ok(Array.isArray(challenges));
  assert.equal(challenges.length, 1);
  assert.ok(challenges[0].startsWith(`Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`));
  assert.ok(challenges[0].includes(`scope="${scope}"`));
  assert.ok(challenges[0].includes(`error="${error}"`));
  assert.match(challenges[0], /error_description="[^"]+"/);
  noCustomerSecrets(response);
}

function noCustomerSecrets(response) {
  assert.doesNotMatch(response.text, /"(?:ownerId|principal_id|phone|email|address|accessToken|access_token|secret|token_hash)"/);
  assert.doesNotMatch(response.text, /customer-(?:alice|bob)|merchant-[ab]|postgres(?:ql)?:\/\//);
}

test('Compose OAuth + authentic MCP2 integration (synthetic identity, no real money)', { timeout: 60_000 }, async t => {
  const health = await request('/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.mode, 'synthetic', 'Refusing non-synthetic target');
  assert.equal(health.body.paymentMode, 'local-simulator', 'Refusing external payment mode');

  // Bob avoids revoking Alice subscriptions used by the parallel lifecycle suite.
  // Tokens/code/verifier stay in memory and are never logged.
  let fullToken;
  let narrowToken;
  let clientId;
  let checkoutId;
  let orderId;
  let unconfirmedCheckoutId;
  let menuA;
  let menuB;
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = `synthetic_${randomUUID()}`;

  await t.test('discovery, five tools and Extensions resource come from the actual server', async () => {
    const discover = await rpc('server/discover');
    assert.equal(discover.status, 200);
    assert.equal(discover.body.result.resultType, 'complete');
    assert.deepEqual(discover.body.result.supportedVersions, [PROTOCOL]);
    assert.deepEqual(discover.body.result.capabilities.events, {});
    const listed = await rpc('tools/list');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.result.tools.map(item => item.name), EXPECTED_TOOLS);
    const directory = listed.body.result.tools[0];
    assert.deepEqual(directory._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
    const resource = await rpc('resources/read', { uri: directory._meta.ui.resourceUri });
    assert.equal(resource.status, 200);
    assert.equal(resource.body.result.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.ok(resource.body.result.contents[0].text.length > 100);
    noCustomerSecrets(discover);
    noCustomerSecrets(listed);
  });

  await t.test('anonymous directory, menus and quotes route to both independent Go tenants', async () => {
    const search = await tool('search_restaurants');
    assert.deepEqual(successfulTool(search).restaurants.map(item => item.id).sort(), ['demo-a', 'demo-b']);
    noCustomerSecrets(search);
    const a = await tool('get_restaurant_menu', { tenantId: 'demo-a' });
    const b = await tool('get_restaurant_menu', { tenantId: 'demo-b' });
    menuA = successfulTool(a);
    menuB = successfulTool(b);
    assert.equal(menuA.tenantId, 'demo-a');
    assert.equal(menuB.tenantId, 'demo-b');
    assert.equal(menuA.items.find(item => item.id === 'meal').priceMinor, 3000);
    assert.equal(menuB.items.find(item => item.id === 'meal').priceMinor, 4500);
    for (const [tenantId, expected] of [['demo-a', 3000], ['demo-b', 4500]]) {
      const quote = await tool('quote_cart', { tenantId, items: [{ itemId: 'meal', quantity: 1 }] });
      assert.equal(successfulTool(quote).totalMinor, expected);
      noCustomerSecrets(quote);
    }
  });

  await t.test('private methods require authentication and local dev identity requires exact Origin', async () => {
    assert.equal((await request('/dev/session', { method: 'POST', json: { identity: 'customer-bob' } })).status, 403);
    assert.equal((await request('/dev/session', { method: 'POST', origin: 'https://hostile.example', json: { identity: 'customer-bob' } })).status, 403);
    const session = await request('/dev/session', { method: 'POST', origin: BASE, json: { identity: 'customer-bob' } });
    assert.equal(session.status, 200);
    assert.equal(session.body.principal.id, 'customer-bob');
    assert.match(session.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    fullToken = session.body.accessToken;
    assert.equal(typeof fullToken, 'string');
    const unauthorized = await rpc('events/list');
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get('www-authenticate'), /oauth-protected-resource/);
    const listed = await rpc('events/list', {}, fullToken);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.result.events[0].name, 'order.status_changed');
    assert.deepEqual(listed.body.result.events[0].delivery, ['webhook']);
    noCustomerSecrets(listed);
  });

  await t.test('MCP checkout handoff uses persisted data and does not place an order or consume stock', async () => {
    const args = { tenantId: 'demo-a', items: [{ itemId: 'drink', quantity: 1 }], expectedTotalMinor: 500, idempotencyKey: `oauth-handoff-${randomUUID()}` };
    toolAuthChallenge(await tool('prepare_checkout', args), 'orders:write', 'invalid_token');
    const before = successfulTool(await tool('get_restaurant_menu', { tenantId: 'demo-a' })).items.find(item => item.id === 'drink').stock;
    const response = await tool('prepare_checkout', args, fullToken);
    const prepared = successfulTool(response);
    unconfirmedCheckoutId = prepared.checkoutId;
    assert.equal(prepared.checkoutUrl, `${BASE}/checkout/${prepared.checkoutId}`);
    assert.equal(prepared.totalMinor, 500);
    const stored = await request(`/api/checkouts/${prepared.checkoutId}`, { token: fullToken });
    assert.equal(stored.status, 200);
    assert.equal(stored.body.orderId, null);
    const repeated = successfulTool(await tool('prepare_checkout', args, fullToken));
    assert.equal(repeated.checkoutId, prepared.checkoutId);
    const after = successfulTool(await tool('get_restaurant_menu', { tenantId: 'demo-a' })).items.find(item => item.id === 'drink').stock;
    assert.equal(after, before);
    noCustomerSecrets(response);
  });

  await t.test('OAuth metadata + exact DCR allowlist + S256/state/issuer and grant replay protection', async () => {
    const metadata = await request('/.well-known/oauth-protected-resource');
    assert.equal(metadata.body.resource, RESOURCE);
    assert.deepEqual(metadata.body.authorization_servers, [BASE]);
    const authorization = await request('/.well-known/oauth-authorization-server');
    assert.equal(authorization.body.issuer, BASE);
    assert.deepEqual(authorization.body.code_challenge_methods_supported, ['S256']);
    assert.equal(authorization.body.authorization_response_iss_parameter_supported, true);
    const invalidRegistration = await request('/oauth/register', { method: 'POST', json: { redirect_uris: ['https://unapproved.example/callback'] } });
    assert.equal(invalidRegistration.status, 400);
    const registration = await request('/oauth/register', { method: 'POST', json: { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] } });
    assert.equal(registration.status, 201);
    clientId = registration.body.client_id;
    const authorizationArgs = { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE, scope: 'orders:read', code_challenge_method: 'S256', code_challenge: challenge, state };
    const invalidAuthorization = await request('/oauth/authorize', { method: 'POST', origin: BASE, form: { ...authorizationArgs, resource: 'https://different.example/mcp', identity: 'customer-bob' } });
    assert.equal(invalidAuthorization.status, 400);
    const authorized = await request('/oauth/authorize', { method: 'POST', origin: BASE, form: { ...authorizationArgs, identity: 'customer-bob' } });
    assert.equal(authorized.status, 302);
    const location = new URL(authorized.headers.get('location'));
    assert.equal(location.origin + location.pathname, REDIRECT);
    assert.equal(location.searchParams.get('state'), state);
    assert.equal(location.searchParams.get('iss'), BASE);
    const code = location.searchParams.get('code');
    assert.equal(typeof code, 'string');
    const grant = { grant_type: 'authorization_code', client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE, code, code_verifier: verifier };
    assert.equal((await request('/oauth/token', { method: 'POST', form: { ...grant, resource: 'https://different.example/mcp' } })).status, 400);
    assert.equal((await request('/oauth/token', { method: 'POST', form: { ...grant, code_verifier: randomBytes(48).toString('base64url') } })).status, 400);
    const exchange = await request('/oauth/token', { method: 'POST', form: grant });
    assert.equal(exchange.status, 200);
    assert.equal(exchange.body.token_type, 'Bearer');
    assert.equal(exchange.body.scope, 'orders:read');
    assert.equal(exchange.body.resource, RESOURCE);
    narrowToken = exchange.body.access_token;
    assert.equal(typeof narrowToken, 'string');
    assert.equal((await request('/oauth/token', { method: 'POST', form: grant })).status, 400);
  });

  await t.test('narrowed OAuth token cannot write via MCP or REST, but can read its own confirmed order', async () => {
    const args = { items: [{ itemId: 'drink', quantity: 1 }], expectedTotalMinor: 500, idempotencyKey: 'oauth-mcp-bob-one-drink-v1' };
    toolAuthChallenge(await tool('prepare_checkout', { tenantId: 'demo-a', ...args }, narrowToken), 'orders:write', 'insufficient_scope');
    assert.equal((await rpc('events/list', {}, narrowToken)).status, 403);
    assert.equal((await request('/api/restaurants/demo-a/checkouts', { method: 'POST', token: narrowToken, json: args })).status, 403);
    assert.equal((await request(`/api/checkouts/${unconfirmedCheckoutId}/confirm`, { method: 'POST', token: narrowToken, json: {} })).status, 403);

    // A single idempotent fixture order consumes at most one drink across reruns.
    const checkout = await request('/api/restaurants/demo-a/checkouts', { method: 'POST', token: fullToken, json: args });
    assert.equal(checkout.status, 201);
    checkoutId = checkout.body.checkoutId;
    const confirmed = await request(`/api/checkouts/${checkoutId}/confirm`, { method: 'POST', token: fullToken, json: {} });
    assert.equal(confirmed.status, 200);
    orderId = confirmed.body.order.id;
    assert.equal(confirmed.body.order.paymentStatus, 'pending');
    assert.equal((await request(`/api/restaurants/demo-a/orders/${orderId}/simulate-payment`, { method: 'POST', token: narrowToken, json: {} })).status, 403);
    const own = await request(`/api/restaurants/demo-a/orders/${orderId}`, { token: narrowToken });
    assert.equal(own.status, 200);
    assert.equal(own.body.id, orderId);
    const status = await tool('get_order_status', { tenantId: 'demo-a', orderId }, narrowToken);
    assert.equal(successfulTool(status).id, orderId);
    assert.equal(successfulTool(status).paymentStatus, 'pending');
    noCustomerSecrets(status);
  });

  await t.test('MCP event subscriptions reject a private HTTPS destination without sending traffic', async () => {
    const response = await rpc('events/subscribe', {
      name: 'order.status_changed', arguments: { tenantId: 'demo-a', orderId },
      delivery: { mode: 'webhook', url: 'https://127.0.0.1/callback', secret: `whsec_${randomBytes(32).toString('base64')}` },
      cursor: null,
    }, fullToken);
    assert.equal(response.body.error?.code, -32602);
    noCustomerSecrets(response);
    assert.doesNotMatch(response.text, /whsec_/);
  });

  await t.test('explicit OAuth disconnect is idempotent and the revoked token is rejected', async () => {
    assert.equal((await request('/oauth/revoke', { method: 'POST', form: { token: narrowToken } })).status, 200);
    assert.equal((await request('/oauth/revoke', { method: 'POST', form: { token: narrowToken } })).status, 200);
    assert.equal((await request(`/api/restaurants/demo-a/orders/${orderId}`, { token: narrowToken })).status, 401);
    toolAuthChallenge(await tool('get_order_status', { tenantId: 'demo-a', orderId }, narrowToken), 'orders:read', 'invalid_token');
    // Revoke the synthetic full-scope session too; the one fixture order remains.
    assert.equal((await request('/oauth/revoke', { method: 'POST', form: { token: fullToken } })).status, 200);
  });
});
