import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { createCoreOrderClient, allowedPaymentURL } from './core-order-client.mjs';

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

test('payment URLs stay provider-bound and payment scope is separate from order creation',async()=>{
  for(const raw of ['https://checkout.stripe.com.evil.test/x','javascript:alert(1)','http://checkout.stripe.com/x','https://checkout.stripe.com:443/x','https://checkout.stripe.com@evil.test/x'])assert.equal(allowedPaymentURL('stripe',raw),false);
  assert.equal(allowedPaymentURL('stripe','https://checkout.stripe.com/c/test#fragment'),true);
  assert.equal(allowedPaymentURL('moyasar','https://checkout.stripe.com/c/test'),false);
  const client=createCoreOrderClient({...config,fetchImpl:async(url,options)=>{
    const claims=JSON.parse(Buffer.from(options.headers.authorization.slice('Platform '.length).split('.')[0],'base64url'));
    assert.equal(claims.scope,'payments:write');assert.equal(claims.idempotencyKey,'');
    return json({attemptId:'test-attempt',status:'pending',provider:'stripe',mode:'test',url:'https://evil.example/pay'});
  }});
  await assert.rejects(client.payment('restaurant-a',randomUUID(),view.number,'start','stripe'),{code:'order_outcome_unknown'});
});
test('staff detail uses its own scope and preserves Unicode notes without structured contact capabilities',async()=>{
  const client=createCoreOrderClient({...config,fetchImpl:async(url,options)=>{
    assert.ok(url.endsWith('/platform-api/staff/orders/'+view.number));
    const claims=JSON.parse(Buffer.from(options.headers.authorization.slice('Platform '.length).split('.')[0],'base64url'));
    assert.equal(claims.scope,'staff:orders:read');
    return json({...view,items:[{itemId:'rice',name:'Rice',quantity:1,unitPriceMinor:2500,totalMinor:2500,options:[]}],
      notes:'🍚'.repeat(1000),createdAt:view.updatedAt,phone:'private',address:{private:true},accessCode:'private'});
  }});
  const detail=await client.staffOrder('restaurant-a',randomUUID(),view.number);
  assert.equal([...detail.notes].length,1000);assert.equal(detail.items[0].name,'Rice');
  for(const field of ['phone','address','accessCode'])assert.equal(detail[field],undefined);
  assert.throws(()=>client.staffOrder('restaurant-a',randomUUID(),'../other'),{code:'invalid_request'});
});

test('owned financial detail is separately scoped and drops contacts and receipt capabilities',async()=>{
 const details={...view,subtotalMinor:3000,deliveryFeeMinor:500,demo:true,createdAt:view.updatedAt,
  tax:{enabled:false,rateBps:0,number:'',netMinor:3500,taxMinor:0,grossMinor:3500},
  items:[{itemId:'rice',name:'Rice',quantity:2,unitPriceMinor:1500,totalMinor:3000,options:[]}]};
 const client=createCoreOrderClient({...config,fetchImpl:async(url,options)=>{
  assert.equal(url,'http://127.0.0.1:3001/platform-api/order-details/'+view.number);
  const claims=JSON.parse(Buffer.from(options.headers.authorization.slice(9).split('.')[0],'base64url'));
  assert.equal(claims.scope,'orders:read');
  return json({...details,phone:'private',address:{street:'private'},trackingToken:'private',accessCode:'private'});
 }});
 assert.deepEqual(await client.details('restaurant-a',randomUUID(),view.number),{tenantId:'restaurant-a',...details});
 assert.throws(()=>client.details('restaurant-a',randomUUID(),'../admin'),{code:'invalid_request'});
});

test('menu creation signs a bounded staff operation and rejects settings injection',async()=>{
 const category={id:'drinks',name:'Drinks',sort:0};
 const client=createCoreOrderClient({...config,fetchImpl:async(url,options)=>{
  assert.equal(url,'http://127.0.0.1:3001/platform-api/staff/menu/categories');
  const claims=JSON.parse(Buffer.from(options.headers.authorization.slice(9).split('.')[0],'base64url'));
  assert.equal(claims.scope,'staff:menu:update');assert.equal(claims.method,'POST');
  assert.deepEqual(JSON.parse(options.body),{expectedVersion:2,category});return json({version:3,category},201);
 }});
 assert.equal((await client.createMenuCategory('restaurant-a',randomUUID(),{expectedVersion:2,category})).version,3);
 assert.throws(()=>client.createMenuCategory('restaurant-a',randomUUID(),{expectedVersion:2,category,settings:{}}),{code:'invalid_request'});
 assert.throws(()=>client.createMenuItem('restaurant-a',randomUUID(),{expectedVersion:2,item:{...input,id:'../unsafe'}}),{code:'invalid_request'});
});

test('staff image upload signs exact raw bytes instead of JSON/base64 content',async()=>{
 const bytes=Buffer.from([0,255,128,10]),url='/restaurant-media/'+'a'.repeat(64)+'.png';
 const client=createCoreOrderClient({...config,fetchImpl:async(target,options)=>{
  assert.equal(target,'http://127.0.0.1:3001/platform-api/staff/images');assert.equal(options.headers['content-type'],'application/octet-stream');assert.deepEqual(options.body,bytes);
  const claims=JSON.parse(Buffer.from(options.headers.authorization.slice(9).split('.')[0],'base64url'));
  assert.equal(claims.scope,'staff:media:write');assert.equal(claims.bodySha256,createHash('sha256').update(bytes).digest('hex'));
  return json({url},201);
 }});
 assert.equal((await client.uploadImage('restaurant-a',randomUUID(),bytes)).url,url);
 assert.throws(()=>client.uploadImage('restaurant-a',randomUUID(),Buffer.alloc(5*1024*1024+1)),{code:'image_too_large'});
});

test('staff catalogue summary supports the original 5000-item bound with byte limits unchanged',async()=>{
 let count=5000;
 const client=createCoreOrderClient({...config,fetchImpl:async()=>json({version:1,name:'Synthetic',currency:'SAR',categories:[{id:'main',name:'Main',sort:0}],items:Array.from({length:count},(_,i)=>({id:'item-'+i,categoryId:'main',name:'Item',priceMinor:100,available:false,sort:i}))})});
 assert.equal((await client.menu('restaurant-a',randomUUID())).items.length,5000);
 count=5001;await assert.rejects(client.menu('restaurant-a',randomUUID()),{code:'restaurant_unavailable'});
});

test('service switches sign narrow settings scope and reject omitted, unknown and coercible values',async()=>{
 const actor=randomUUID(),flags={acceptingOrders:true,deliveryEnabled:true,pickupEnabled:true,tableEnabled:false};let calls=0;
 const client=createCoreOrderClient({...config,fetchImpl:async(url,options)=>{calls++;assert.equal(new URL(url).pathname,'/platform-api/staff/service');const claims=JSON.parse(Buffer.from(options.headers.authorization.slice(9).split('.')[0],'base64url'));assert.equal(claims.scope,options.method==='GET'?'staff:settings:read':'staff:settings:update');return json({version:options.method==='GET'?1:2,...flags,...(options.body?JSON.parse(options.body):{}),taxNumber:'private'});}});
 const initial=await client.service('restaurant-a',actor);assert.equal(initial.taxNumber,undefined);
 for(const value of [{expectedVersion:1},{expectedVersion:1,acceptingOrders:'false'},{expectedVersion:1,acceptingOrders:null},{expectedVersion:1,paymentMethods:[]}])assert.throws(()=>client.patchService('restaurant-a',actor,value),{code:'invalid_request'});
 const closed=await client.patchService('restaurant-a',actor,{expectedVersion:1,acceptingOrders:false});assert.equal(closed.acceptingOrders,false);assert.equal(closed.expectedVersion,undefined);assert.equal(calls,2);
});

test('reviewed refund transport binds immutable tuple and scope, strips private capabilities and never retries',async()=>{
 const subject=randomUUID(),refundId=randomUUID();let calls=0;
 const reviewed={version:2,reviewed:true,amountMinor:1000,currency:'SAR',provider:'stripe',demo:true};
 const detail={id:refundId,version:3,status:'requested',provider:'stripe',currency:'SAR',amountMinor:1000,taxMinor:0,confirmation:'',authorized:true,submitted:false,createdAt:view.updatedAt,updatedAt:view.updatedAt,number:view.number,orderVersion:4,orderTotalMinor:3500,capturedMinor:3500,demo:true,reason:'Synthetic cancellation',providerReference:'',manualReference:'',resolutionReason:'',capability:{automatic:true,partial:true,manual:false,reason:''}};
 const client=createCoreOrderClient({...config,fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,config.restaurants[0].baseUrl+'/platform-api/staff/orders/'+view.number+'/refunds/'+refundId+'/authorize');
  const [payload,signature]=options.headers.authorization.slice(9).split('.');const bytes=Buffer.from(payload,'base64url'),claims=JSON.parse(bytes);
  assert.equal(verify(null,bytes,publicKey,Buffer.from(signature,'base64url')),true);assert.equal(claims.scope,'staff:refunds:authorize');assert.equal(claims.subject,subject);
  assert.equal(claims.bodySha256,createHash('sha256').update(options.body).digest('hex'));assert.deepEqual(JSON.parse(options.body),reviewed);
  return json({...detail,requestId:'private',trackingToken:'private',phone:'private'});
 }});
 for(const invalid of [{...reviewed,reviewed:false},{...reviewed,provider:undefined},{...reviewed,amountMinor:0},{...reviewed,unexpected:true}])assert.throws(()=>client.refundCommand('restaurant-a',subject,view.number,refundId,'authorize',invalid),{code:'invalid_request'});
 assert.equal(calls,0);
 assert.deepEqual(await client.refundCommand('restaurant-a',subject,view.number,refundId,'authorize',reviewed),{tenantId:'restaurant-a',...detail});assert.equal(calls,1);
 const uncertain=createCoreOrderClient({...config,fetchImpl:async()=>{calls++;throw Error('lost reply');}});
 await assert.rejects(uncertain.refundCommand('restaurant-a',subject,view.number,refundId,'authorize',reviewed),{code:'order_outcome_unknown'});assert.equal(calls,2);
});

test('refund reads reject a mismatched original order or refund identity',async()=>{
 const id=randomUUID();const client=createCoreOrderClient({...config,fetchImpl:async()=>json({id:randomUUID(),version:1,status:'review',provider:'',currency:'SAR',amountMinor:100,taxMinor:0,confirmation:'',authorized:false,submitted:false,createdAt:view.updatedAt,updatedAt:view.updatedAt,number:view.number,orderVersion:1,orderTotalMinor:100,capturedMinor:100,demo:true,reason:'synthetic',providerReference:'',manualReference:'',resolutionReason:'',capability:{automatic:false,partial:true,manual:true,reason:'manual_review_required'}})});
 await assert.rejects(client.refund('restaurant-a',randomUUID(),view.number,id),{code:'restaurant_unavailable'});
});

test('appearance draft transport binds independent versions, exact scope and explicit false',async()=>{
 const appearance={template:'classic',storefrontTemplate:'classic',font:'system',headingFont:'',bodyFont:'',buttonFont:'',layout:'grid',textSize:'normal',radius:'soft',shadow:'soft',imageFit:'cover',hideHero:false,introTitle:'',introText:'',logoUrl:'',coverUrl:'',introImageUrl:'',...Object.fromEntries(['primaryColor','primaryTextColor','secondaryColor','secondaryTextColor','headingColor','bodyColor','pageColor','cardColor','cartColor','borderColor'].map(k=>[k,'#ffffff']))};
 let calls=0;const input={version:2,catalogVersion:4,reviewed:true,storefrontTemplate:'editorial',hideHero:false};
 const client=createCoreOrderClient({...config,fetchImpl:async(url,options)=>{calls++;assert.ok(url.endsWith('/staff/brand/draft'));const claims=JSON.parse(Buffer.from(options.headers.authorization.slice(9).split('.')[0],'base64url'));assert.equal(claims.scope,'staff:brand:draft');assert.deepEqual(JSON.parse(options.body),input);return json({version:3,catalogVersion:4,live:appearance,draft:{...appearance,storefrontTemplate:'editorial'},hasPrevious:false,providerSecret:'not-public'});}});
 for(const bad of [{...input,reviewed:false},{...input,paymentMethods:{}},{version:2,catalogVersion:4,reviewed:true},{...input,storefrontTemplate:'unknown'}])assert.throws(()=>client.brandCommand('restaurant-a',randomUUID(),'draft',bad),{code:'invalid_request'});
 const result=await client.brandCommand('restaurant-a',randomUUID(),'draft',input);assert.equal(result.providerSecret,undefined);assert.equal(result.draft.storefrontTemplate,'editorial');assert.equal(calls,1);
 assert.throws(()=>client.brandCommand('restaurant-a',randomUUID(),'publish',input),{code:'invalid_request'});
});

test('support decision binds request identity and explicit rejection without exposing receipt capabilities',async()=>{
 const id=randomUUID(),subject=randomUUID(),input={version:1,reviewed:true,approve:false,reason:'Synthetic rejection'};let calls=0;
 const result={...view,version:2,cancellationPending:false,openComplaints:0,demo:true,cancellation:{id,status:'rejected',reason:'Synthetic customer reason',decisionReason:input.reason,requestedAt:view.updatedAt,decidedAt:view.updatedAt,requestedBeforePreparation:false},complaints:[],cancellationHistory:[],historyLimit:20,historyTruncated:false};
 const client=createCoreOrderClient({...config,fetchImpl:async(url,options)=>{calls++;assert.ok(url.endsWith('/staff/support/orders/'+view.number+'/'+id+'/decide'));const claims=JSON.parse(Buffer.from(options.headers.authorization.slice(9).split('.')[0],'base64url'));assert.equal(claims.scope,'staff:support:decide');assert.deepEqual(JSON.parse(options.body),input);return json({...result,trackingToken:'private',phone:'private'});}});
 for(const bad of [{...input,reviewed:false},{...input,approve:undefined},{...input,reason:'  '},{...input,payout:true}])assert.throws(()=>client.supportCommand('restaurant-a',subject,view.number,id,'decide',bad),{code:'invalid_request'});
 const value=await client.supportCommand('restaurant-a',subject,view.number,id,'decide',input);assert.equal(calls,1);assert.equal(value.cancellation.status,'rejected');assert.equal(value.phone,undefined);assert.equal(value.trackingToken,undefined);
});
