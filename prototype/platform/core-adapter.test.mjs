import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createCoreAdapter } from './core-adapter.mjs';

const restaurants = [{ id: 'a', name: 'مطعم أ', cuisine: 'saudi', baseUrl: 'https://a.example' },
  { id: 'b', name: 'Restaurant B', cuisine: 'italian', baseUrl: 'https://b.example' }];
const catalog = { version: 3, settings: { name: 'مطعم أ', description: '', currency: 'SAR',
  acceptingOrders: true, pickupEnabled: true, deliveryEnabled: true, tableEnabled: true,
  demo: true, openingHours: '', defaultLanguage: 'ar', menuLanguage: 'ar',
  paymentMethods: { pickup: ['card'] }, taxEnabled: true, taxRateBps: 1500,
  deliveryFeeMinor: 500, deliveryMinimumMinor: 0, brand: { storefrontTemplate: 'showcase', font: 'cairo' } },
  categories: [{ id: 'main', name: 'Main', sort: 0 }],
  items: [{ id: 'rice', categoryId: 'main', name: 'أرز', description: '', priceMinor: 1200,
    imageUrl: '/restaurant-media/test.png', available: true, sort: 0,
    options: [{ id: 'extra', name: 'Extra', priceMinor: 300, available: true }] }],
  tables: [{ code: 'secret-qr' }], privateSecret: 'do-not-return' };
const input = { mode: 'pickup', customerName: 'Synthetic', phone: '+966501234567',
  items: [{ itemId: 'rice', quantity: 2, optionIds: ['extra'] }] };
const quote = { currency: 'SAR', subtotalMinor: 3000, deliveryFeeMinor: 0, totalMinor: 3000,
  demo: true, paymentMethods: ['card'], tax: { enabled: true, rateBps: 1500,
    number: '', netMinor: 2609, taxMinor: 391, grossMinor: 3000 },
  items: [{ itemId: 'rice', name: 'أرز', quantity: 2, unitPriceMinor: 1500, totalMinor: 3000,
    options: catalog.items[0].options }] };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('core bridge pins routes, strips private fields and preserves real options/brand', async () => {
  const calls = [];
  const adapter = createCoreAdapter({ restaurants, fetchImpl: async (...args) => { calls.push(args); return json(catalog); } });
  const menu = await adapter.getMenu('a');
  assert.equal(menu.tenantId, 'a'); assert.equal(menu.settings.brand.storefrontTemplate, 'showcase');
  assert.deepEqual(menu.items[0].options, catalog.items[0].options);
  assert.equal(menu.tables, undefined); assert.equal(menu.privateSecret, undefined);
  assert.equal(menu.items[0].stock, undefined, 'Never fabricate stock quantities from availability');
  assert.equal(calls[0][0], 'https://a.example/storefront-api/catalog');
  assert.equal(calls[0][1].headers.Authorization, undefined);
  assert.equal(calls[0][1].redirect, 'error');
  assert.deepEqual(adapter.listRestaurants({ cuisine: 'italian' }), [{ id: 'b', name: 'Restaurant B', cuisine: 'italian' }]);
});

test('quote uses authoritative core fees/tax/options and has no order side effects', async () => {
  let seen;
  const adapter = createCoreAdapter({ restaurants, fetchImpl: async (url, options) => {
    seen = { url, options }; return json({ ...quote, privatePaymentToken: 'secret' });
  } });
  const result = await adapter.quote('b', input);
  assert.deepEqual(result, { tenantId: 'b', ...quote });
  assert.equal(seen.url, 'https://b.example/storefront-api/quote');
  assert.deepEqual(JSON.parse(seen.options.body), input);
  assert.equal(seen.options.method, 'POST');
  assert.equal(adapter.capabilities('b').createOrder, false);
  assert.equal(adapter.capabilities('b').whatsappOrderIngress, false);
});

test('unrecognized tenant/input URLs and forged prices are rejected before network', async () => {
  let count = 0;
  const adapter = createCoreAdapter({ restaurants, fetchImpl: async () => { count++; return json(quote); } });
  await assert.rejects(adapter.getMenu('https://evil.example'), { code: 'restaurant_not_found' });
  for (const bad of [{ ...input, baseUrl: 'https://evil.example' }, { ...input, expectedTotalMinor: 1 },
    { ...input, items: [{ itemId: 'rice', quantity: 1, priceMinor: 1 }] },
    { ...input, items: [{ itemId: '../secret', quantity: 1 }] }]) {
    assert.throws(() => adapter.quote('a', bad), { code: 'invalid_request' });
  }
  assert.equal(count, 0);
});

test('configuration is copied and duplicate origins cannot alias restaurants', async () => {
  const rows = structuredClone(restaurants);
  const adapter = createCoreAdapter({ restaurants: rows, fetchImpl: async url => { assert.match(url, /^https:\/\/a\.example\//); return json(catalog); } });
  rows[0].baseUrl = 'https://evil.example';
  await adapter.getMenu('a');
  for (const baseUrl of ['https://user:pass@example.com', 'https://example.com/private', 'file:///tmp/data', 'https://example.com?target=x']) {
    assert.throws(() => createCoreAdapter({ restaurants: [{ ...restaurants[0], baseUrl }] }));
  }
  assert.throws(() => createCoreAdapter({ restaurants: [restaurants[0], { ...restaurants[1], baseUrl: restaurants[0].baseUrl }] }));
});

test('invalid/oversized upstream responses and sensitive errors fail closed', async () => {
  for (const response of [new Response('<html>password</html>'), json({ ...catalog, version: 'bad' }),
    new Response('x'.repeat(100), { headers: { 'content-type': 'application/json' } })]) {
    const adapter = createCoreAdapter({ restaurants, maxBytes: 50, fetchImpl: async () => response });
    await assert.rejects(adapter.getMenu('a'), { code: 'invalid_restaurant_response' });
  }
  const privateError = createCoreAdapter({ restaurants, fetchImpl: async () => json({ error: 'postgres password=secret' }, 500) });
  await assert.rejects(privateError.getMenu('a'), { code: 'restaurant_unavailable' });
  const stock = createCoreAdapter({ restaurants, fetchImpl: async () => json({ error: 'out_of_stock' }, 409) });
  await assert.rejects(stock.quote('a', input), { code: 'out_of_stock', status: 409 });
});

test('redirect from configured origin never reaches its target', async t => {
  let leaked = false;
  const server = createServer((req, res) => {
    if (req.url === '/target') { leaked = true; res.end('{}'); }
    else { res.writeHead(302, { location: '/target' }); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const adapter = createCoreAdapter({ restaurants: [{ ...restaurants[0], baseUrl: `http://127.0.0.1:${server.address().port}` }] });
  await assert.rejects(adapter.getMenu('a'), { code: 'restaurant_unavailable' });
  assert.equal(leaked, false);
});

test('preview excludes contact/payment/price fields and routes only to preview', async () => {
  const adapter = createCoreAdapter({ restaurants, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://a.example/storefront-api/preview');
    assert.deepEqual(JSON.parse(options.body), { mode: 'pickup', items: input.items });
    return json(quote);
  } });
  assert.deepEqual(await adapter.preview('a', { mode: 'pickup', items: input.items }), { tenantId: 'a', ...quote });
  for (const extra of [{ phone: 'private' }, { customerName: 'private' }, { expectedTotalMinor: 1 },
    { address: { country: 'SA', street: 'private street' } }]) {
    assert.throws(() => adapter.preview('a', { mode: 'pickup', items: input.items, ...extra }), { code: 'invalid_request' });
  }
});
