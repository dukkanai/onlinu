import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { createCoreOrderClient } from './core-order-client.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const config = { issuer: 'https://platform.example', privateKey, restaurants: [{ id: 'restaurant-a', baseUrl: 'http://127.0.0.1:3001' }] };
const input = { mode: 'delivery', customerName: 'Synthetic', phone: '+966501234567',
  address: { country: 'SA', nationalAddress: 'ABCD1234' }, paymentMethod: 'cash_on_delivery',
  items: [{ itemId: 'rice', quantity: 2 }], expectedTotalMinor: 3500 };
const view = { number: 'R00000001', version: 1, status: 'new', paymentStatus: 'unpaid', totalMinor: 3500,
  currency: 'SAR', mode: 'delivery', updatedAt: '2026-10-05T07:00:00Z' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('service signature binds actor, tenant, exact body, route and idempotency', async () => {
  const subject = randomUUID(), key = randomUUID();
  const client = createCoreOrderClient({ ...config, fetchImpl: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:3001/platform-api/orders');
    const [payload, signature] = options.headers.authorization.slice('Platform '.length).split('.');
    const bytes = Buffer.from(payload, 'base64url');
    assert.equal(verify(null, bytes, publicKey, Buffer.from(signature, 'base64url')), true);
    const claims = JSON.parse(bytes);
    assert.equal(claims.subject, subject); assert.equal(claims.audience, 'restaurant-a');
    assert.equal(claims.issuer, config.issuer); assert.equal(claims.scope, 'orders:write');
    assert.equal(claims.method, 'POST'); assert.equal(claims.path, '/platform-api/orders');
    assert.equal(claims.bodySha256, createHash('sha256').update(options.body).digest('hex'));
    assert.equal(claims.idempotencyKey, key); assert.equal(options.headers['idempotency-key'], key);
    assert.equal(claims.expiresAt - claims.issuedAt, 60);
    assert.equal(options.redirect, 'error'); assert.equal(options.headers.cookie, undefined);
    return json({ ...view, trackingToken: 'not-for-platform', phone: 'private' });
  } });
  assert.deepEqual(await client.create('restaurant-a', subject, input, key), { tenantId: 'restaurant-a', ...view });
});

test('ambiguous write is never retried automatically or reported successful', async () => {
  let calls = 0;
  const client = createCoreOrderClient({ ...config, fetchImpl: async () => { calls++; throw Error('socket closed after submission'); } });
  await assert.rejects(client.create('restaurant-a', randomUUID(), input, randomUUID()), { code: 'order_outcome_unknown' });
  assert.equal(calls, 1);
});

test('foreign routes, invalid identities and forged amounts fail before network', async () => {
  const client = createCoreOrderClient({ ...config, fetchImpl: async () => assert.fail('must not reach network') });
  await assert.rejects(client.create('other', randomUUID(), input, randomUUID()), { code: 'restaurant_not_found' });
  await assert.rejects(client.create('restaurant-a', 'some-person', input, randomUUID()), { code: 'invalid_identity' });
  assert.throws(() => client.create('restaurant-a', randomUUID(), { ...input, expectedTotalMinor: -1 }, randomUUID()), { code: 'invalid_request' });
  assert.throws(() => client.status('restaurant-a', randomUUID(), '../admin'), { code: 'invalid_request' });
});

test('recovery preserves safe not-found while suppressing private errors', async () => {
  const missing = createCoreOrderClient({ ...config, fetchImpl: async () => json({ error: 'invalid_order_access' }, 404) });
  await assert.rejects(missing.recover('restaurant-a', randomUUID(), randomUUID()), { code: 'invalid_order_access', status: 404 });
  const privateError = createCoreOrderClient({ ...config, fetchImpl: async () => json({ error: 'password=private' }, 500) });
  await assert.rejects(privateError.status('restaurant-a', randomUUID(), view.number), { code: 'restaurant_unavailable', status: 503 });
});
