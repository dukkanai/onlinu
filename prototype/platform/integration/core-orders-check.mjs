import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCoreOrderClient } from '../core-order-client.mjs';

const fixture = JSON.parse(process.env.CORE_ORDER_FIXTURE);
const client = createCoreOrderClient({ issuer: 'https://platform.example', privateKey: fixture.privateKey,
  restaurants: [{ id: 'restaurant-a', baseUrl: fixture.baseUrl }] });
const subject = randomUUID(), key = randomUUID();
await assert.rejects(client.recover('restaurant-a', subject, key), { code: 'invalid_order_access', status: 404 });
const created = await client.create('restaurant-a', subject, fixture.input, key);
assert.equal(created.totalMinor, 3500); assert.equal(created.paymentStatus, 'unpaid');
assert.deepEqual(await client.create('restaurant-a', subject, fixture.input, key), created);
assert.deepEqual(await client.recover('restaurant-a', subject, key), created);
assert.deepEqual(await client.status('restaurant-a', subject, created.number), created);
const feed=await client.events('restaurant-a',subject,0,100);
assert.equal(feed.events.length,1);assert.equal(feed.events[0].sequence,1);assert.deepEqual(feed.events[0].order,((({tenantId,...order})=>order)(created)));
assert.deepEqual((await client.events('restaurant-a',randomUUID(),0,100)).events,[]);
await assert.rejects(client.status('restaurant-a', randomUUID(), created.number), { code: 'invalid_order_access', status: 404 });
await assert.rejects(client.create('restaurant-a', subject, { ...fixture.input, customerName: 'different' }, key), { code: 'conflict', status: 409 });
for (const field of ['trackingToken','accessCode','phone','address','customerName']) assert.equal(created[field], undefined);
console.log('Verified Node-signed original Go order create/retry/recovery/ownership; no payment or external service used');
