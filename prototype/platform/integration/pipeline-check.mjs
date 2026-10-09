// Run only inside the synthetic platform container. Uses a disposable DB schema;
// tenant fixtures retain one synthetic drink order as an auditable test result.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { Webhook } from 'standardwebhooks';
import { createPlatform, configuration } from '../src.mjs';

const config=configuration();
assert.equal(config.baseUrl,'http://127.0.0.1:18787');
assert.equal(new URL(config.databaseUrl).pathname,'/prototype_platform');
const schema=`pipeline_test_${randomBytes(8).toString('hex')}`;
const control=new pg.Pool({connectionString:config.databaseUrl});
await control.query(`CREATE SCHEMA ${schema}`);
const pool=new pg.Pool({connectionString:config.databaseUrl,options:`-c search_path=${schema}`});
const secret=`whsec_${randomBytes(32).toString('base64')}`;
const received=[];
let app;
try {
  app=await createPlatform(config,{pool,webhookFetch:async(_url,request)=>{
    const payload=new Webhook(secret).verify(request.body,request.headers);
    if(payload.type!=='verification')received.push(payload);
    return {status:200,ok:true,json:async()=>({challenge:payload.challenge})};
  }});
  const access=await app.auth.issue('customer-alice');
  const alice=await app.auth.authenticate({headers:{authorization:`Bearer ${access.accessToken}`}},{bearerOnly:true});
  const cart={tenantId:'demo-b',items:[{itemId:'drink',quantity:1}],expectedTotalMinor:700,idempotencyKey:randomUUID()};
  const checkout=await app.store.prepare(alice,cart);
  const order=await app.store.confirm(alice,checkout.checkoutId);
  await app.tick(); // Consume pre-subscription outbox without replay.
  assert.equal(app.workerHealth.consecutiveFailures,0);
  const params={name:'order.status_changed',arguments:{tenantId:'demo-b',orderId:order.id},
    delivery:{mode:'webhook',url:'https://receiver.example/prototype',secret},ttlMs:60_000};
  await app.events.subscribe(alice,params);
  const paid=await app.tenantRequest('demo-b',`/orders/${order.id}/simulate-payment`,{principal:alice,method:'POST',body:{}});
  await app.tick();
  assert.equal(app.workerHealth.consecutiveFailures,0);
  assert.equal(received.length,1);
  assert.equal(received[0].data.orderId,order.id);
  assert.equal(received[0].data.version,paid.version);
  assert.equal(received[0].data.status,'accepted');
  assert.equal(received[0].data.paymentStatus,'paid');
  assert.doesNotMatch(JSON.stringify(received),/ownerId|customer-alice|phone|address|whsec_/);
  await app.tick();assert.equal(received.length,1,'persisted cursor/dedup prevents redelivery');
  await app.events.revokeAll(alice.id);
  await app.tenantRequest('demo-b',`/orders/${order.id}/status`,{principal:await app.auth.principal('merchant-b'),method:'POST',body:{status:'preparing',expectedVersion:paid.version}});
  await app.tick();assert.equal(received.length,1,'explicit disconnect prevents further delivery');
  console.log('PASS real Go outbox -> durable platform cursor -> signed callback -> deduplication -> disconnect (injected receiver; not ChatGPT)');
} finally {
  if(app)await app.close();else await pool.end();
  // Random validated test-only schema, never the public schema or restaurant DB.
  assert.match(schema,/^pipeline_test_[a-f0-9]{16}$/);
  await control.query(`DROP SCHEMA ${schema} CASCADE`);
  await control.end();
}
