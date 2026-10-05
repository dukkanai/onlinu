import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createStore, validateCart } from './store.mjs';

test('cart canonicalization and strict input limits', () => {
  assert.deepEqual(validateCart({ items: [{itemId:'meal',quantity:2},{itemId:'drink',quantity:1}] }),
    [{itemId:'drink',quantity:1},{itemId:'meal',quantity:2}]);
  for (const input of [null, {}, {items:[]}, {items:[{itemId:'meal',quantity:0}]},
    {items:[{itemId:'meal',quantity:1.5}]}, {items:[{itemId:'meal',quantity:1,priceMinor:1}]},
    {items:[{itemId:'meal',quantity:1},{itemId:'meal',quantity:1}]},
    {items:[{itemId:'meal',quantity:1}],ownerId:'customer-bob'},
  ]) assert.throws(() => validateCart(input), { code:'invalid_cart' });
});

const alice = { id: 'customer-alice', role: 'customer', scopes: ['orders:read', 'orders:write'] };
const checkoutId = '11111111-1111-4111-8111-111111111111';
const orderId = '22222222-2222-4222-8222-222222222222';
const preparedCart = { tenantId: 'demo-a', items: [{ itemId: 'meal', quantity: 1 }],
  expectedTotalMinor: 1500, idempotencyKey: 'cart-attempt-001' };
const failure = (status, code) => Object.assign(new Error(code), { status, code });

// Keep the platform journal and the tenant's committed order in separate fake
// stores. Failure injection happens between commits, so restarting createStore
// cannot recover from local memory or accidentally manufacture another order.
function fixture({ expired = false, state = 'pending' } = {}) {
  const row = {
    id: checkoutId, principal_id: alice.id, tenant_id: 'demo-a',
    idem_key: preparedCart.idempotencyKey,
    request_hash: createHash('sha256').update(JSON.stringify({ items: preparedCart.items, total: 1500 })).digest('hex'),
    items: structuredClone(preparedCart.items), total_minor: '1500', currency: 'SAR',
    expires_at: new Date(Date.now() + (expired ? -60_000 : 60_000)),
    order_id: null, confirmation_state: state,
  };
  const stateful = { row, requests: [], created: 0, orders: new Map(),
    loseReply: false, failOrderWrite: false, failClaim: false, expireAtClaim: false, lookupFailure: null };
  const result = value => ({ rowCount: value ? 1 : 0, rows: value ? [structuredClone(value)] : [] });
  const pool = {
    async query(sql, values = []) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      if (statement.startsWith('SELECT * FROM demo_checkouts WHERE id=')) {
        return result(values[0] === row.id && values[1] === row.principal_id ? row : null);
      }
      if (statement.startsWith('SELECT * FROM demo_checkouts WHERE principal_id=')) {
        return result(values[0] === row.principal_id && values[1] === row.tenant_id && values[2] === row.idem_key ? row : null);
      }
      if (statement.startsWith("UPDATE demo_checkouts SET confirmation_state='dispatching'")) {
        if (stateful.failClaim) throw failure(503, 'journal_unavailable');
        if (stateful.expireAtClaim) row.expires_at = new Date(Date.now() - 1000);
        if (values[0] !== row.id || values[1] !== row.principal_id || row.order_id || row.expires_at <= new Date()) return result(null);
        row.confirmation_state = 'dispatching';
        return result(row);
      }
      if (statement.startsWith('UPDATE demo_checkouts SET order_id=')) {
        if (stateful.failOrderWrite) {
          stateful.failOrderWrite = false;
          throw failure(503, 'journal_write_lost');
        }
        if (values[1] !== row.id || values[2] !== row.principal_id || (row.order_id && row.order_id !== values[0])) return result(null);
        row.order_id = values[0];
        row.confirmation_state = 'confirmed';
        return result(row);
      }
      throw new Error(`unexpected fake SQL: ${statement}`);
    },
  };
  function seedOrder(ownerId = alice.id) {
    const order = { id: orderId, tenantId: row.tenant_id, ownerId, totalMinor: 1500,
      currency: 'SAR', status: 'pending_payment', paymentStatus: 'pending', version: 1,
      items: structuredClone(row.items) };
    stateful.orders.set(`${ownerId}:checkout:${row.id}`, order);
    return structuredClone(order);
  }
  async function tenantRequest(tenantId, path, options = {}) {
    stateful.requests.push({ tenantId, path, options: structuredClone(options) });
    assert.equal(tenantId, row.tenant_id);
    const key = `${options.principal?.id}:checkout:${row.id}`;
    if (path.startsWith('/orders/by-idempotency?')) {
      assert.equal(options.method ?? 'GET', 'GET');
      assert.equal(new URL(path, 'http://tenant').searchParams.get('key'), `checkout:${row.id}`);
      if (stateful.lookupFailure) throw stateful.lookupFailure;
      const order = stateful.orders.get(key);
      if (!order) throw failure(404, 'order_not_found');
      return structuredClone(order);
    }
    if (path === '/orders' && options.method === 'POST') {
      assert.equal(row.confirmation_state, 'dispatching', 'intent must be durable before remote dispatch');
      assert.equal(options.body.idempotencyKey, `checkout:${row.id}`);
      let order = stateful.orders.get(key);
      if (!order) {
        order = seedOrder(options.principal.id);
        stateful.created++;
      }
      if (stateful.loseReply) {
        stateful.loseReply = false;
        throw failure(503, 'restaurant_unavailable');
      }
      return structuredClone(order);
    }
    if (path === `/orders/${orderId}`) {
      const order = stateful.orders.get(key);
      if (!order) throw failure(404, 'order_not_found');
      return structuredClone(order);
    }
    throw new Error(`unexpected tenant request: ${path}`);
  }
  function restart() {
    return createStore({ pool, baseUrl: 'http://127.0.0.1:18787', tenantRequest,
      listRestaurants: () => [{ id: 'demo-a' }] });
  }
  return Object.assign(stateful, { restart, seedOrder,
    expire() { row.expires_at = new Date(Date.now() - 1000); } });
}

test('lost tenant reply recovers one committed order after checkout expiry and restart', async () => {
  const f = fixture();
  f.loseReply = true;
  await assert.rejects(f.restart().confirm(alice, checkoutId), { code: 'restaurant_unavailable' });
  assert.equal(f.row.confirmation_state, 'dispatching');
  assert.equal(f.row.order_id, null);
  assert.equal(f.created, 1);
  f.expire();
  const store = f.restart();
  const checkout = await store.prepare(alice, preparedCart);
  assert.equal(checkout.checkoutId, checkoutId, 'same preparation key must still reach recovery');
  const order = await store.confirm(alice, checkoutId);
  assert.equal(order.id, orderId);
  assert.equal(f.row.order_id, orderId);
  assert.equal(f.row.confirmation_state, 'confirmed');
  assert.equal(f.created, 1);
  assert.equal(f.requests.filter(request => request.options.method === 'POST').length, 1);
  assert.equal(f.requests.at(-1).options.principal.id, alice.id);
});

test('lost platform journal write recovers the tenant order after expiry', async () => {
  const f = fixture();
  f.failOrderWrite = true;
  await assert.rejects(f.restart().confirm(alice, checkoutId), { code: 'journal_write_lost' });
  assert.equal(f.row.order_id, null);
  f.expire();
  const order = await f.restart().confirm(alice, checkoutId);
  assert.equal(order.id, orderId);
  assert.equal(f.created, 1);
  assert.equal(f.requests.filter(request => request.options.method === 'POST').length, 1);
});

test('expired checkouts with no committed order never create a fresh order', async () => {
  for (const state of ['pending', 'dispatching']) {
    const f = fixture({ expired: true, state });
    await assert.rejects(f.restart().confirm(alice, checkoutId), { status: 409, code: 'checkout_expired' });
    assert.equal(f.created, 0);
    assert.equal(f.requests.length, 1);
    assert.match(f.requests[0].path, /^\/orders\/by-idempotency\?/);
  }
});

test('expired legacy checkout can recover an order without a prior confirmation marker', async () => {
  const f = fixture({ expired: true });
  f.seedOrder();
  const order = await f.restart().confirm(alice, checkoutId);
  assert.equal(order.id, orderId);
  assert.equal(f.row.confirmation_state, 'confirmed');
  assert.equal(f.created, 0);
  assert.equal(f.requests.length, 1);
});

test('database expiry between reading and claiming does not dispatch an order', async () => {
  const f = fixture();
  f.expireAtClaim = true;
  await assert.rejects(f.restart().confirm(alice, checkoutId), { code: 'checkout_expired' });
  assert.equal(f.created, 0);
  assert.equal(f.row.confirmation_state, 'pending');
  assert.equal(f.requests.filter(request => request.options.method === 'POST').length, 0);
});

test('failed intent persistence or unavailable recovery lookup cannot fall through to creation', async () => {
  const unrecorded = fixture();
  unrecorded.failClaim = true;
  await assert.rejects(unrecorded.restart().confirm(alice, checkoutId), { code: 'journal_unavailable' });
  assert.equal(unrecorded.requests.length, 0);
  const ambiguous = fixture({ state: 'dispatching' });
  ambiguous.lookupFailure = failure(503, 'restaurant_unavailable');
  await assert.rejects(ambiguous.restart().confirm(alice, checkoutId), { code: 'restaurant_unavailable' });
  assert.equal(ambiguous.created, 0);
  assert.equal(ambiguous.requests.length, 1);
});

test('recovery requires checkout ownership before asking the tenant', async () => {
  const f = fixture({ expired: true, state: 'dispatching' });
  f.seedOrder();
  const bob = { ...alice, id: 'customer-bob' };
  await assert.rejects(f.restart().confirm(bob, checkoutId), { status: 404, code: 'not_found' });
  assert.equal(f.requests.length, 0);
  assert.equal(f.row.order_id, null);
});

test('store methods enforce independent read and write grants', async () => {
  const f = fixture();
  const store = f.restart();
  const reader = { ...alice, scopes: ['orders:read'] };
  const writer = { ...alice, scopes: ['orders:write'] };
  const eventsOnly = { ...alice, scopes: ['events:read'] };
  assert.equal((await store.checkout(reader, checkoutId)).id, checkoutId);
  for (const principal of [reader, eventsOnly, { ...alice, scopes: [] }]) {
    await assert.rejects(store.prepare(principal, preparedCart), { status: 403, code: 'insufficient_scope' });
    await assert.rejects(store.confirm(principal, checkoutId), { status: 403, code: 'insufficient_scope' });
  }
  for (const principal of [writer, eventsOnly]) {
    await assert.rejects(store.checkout(principal, checkoutId), { status: 403, code: 'insufficient_scope' });
  }
  assert.equal(f.requests.length, 0, 'denied scopes must not reach the tenant');
  assert.equal((await store.confirm(writer, checkoutId)).id, orderId, 'write permission does not also require read permission');
  await assert.rejects(store.confirm({ ...alice, role: 'merchant' }, checkoutId), { code: 'customer_required' });
});
