import assert from 'node:assert/strict';
import test from 'node:test';
import {createRecoveryFixture,customer,quoteFor,tableCode} from '../../prototype/platform/integration/storefront-recovery-fixture.mjs';

const input={mode:'table',tableCode,paymentMethod:'cash_after',paymentProvider:'',items:[{itemId:'dish-A',quantity:1,optionIds:[]}],expectedTotalMinor:1000,expectedQuoteHash:'a'.repeat(64)};
const headers={'idempotency-key':'59fd4c9d-0f07-4f22-9bca-9be816ec70bc'};

test('browser recovery fixture delays delivery without changing accepted order identity',async()=>{
  const fixture=createRecoveryFixture({initialCustomer:customer('customer-A')});
  const delayed=fixture.hold('POST','/orders');let delivered=false;
  const first=fixture.handle('POST','/orders',input,headers).then(result=>{delivered=true;return result;});
  const entered=await delayed.entered;
  assert.equal(entered.customerId,'customer-A');
  assert.equal(fixture.submissions.size,1);assert.equal(delivered,false);
  await fixture.handle('POST','/account/logout',{});
  await fixture.handle('POST','/account/login',{username:'customer-B',password:'synthetic-password-only'});
  delayed.release({status:401,body:{error:'session_expired'}});
  assert.equal((await first).status,401);
  assert.equal((await fixture.handle('POST','/orders',input,headers)).status,409);
  assert.equal(fixture.submissions.size,1);
  await fixture.handle('POST','/account/logout',{});
  await fixture.handle('POST','/account/login',{username:'customer-A',password:'synthetic-password-only'});
  const retry=await fixture.handle('POST','/orders',input,headers);
  assert.equal(retry.status,200);assert.equal(retry.body.order.number,'R00000011');
  assert.equal(fixture.submissions.size,1);
  assert.deepEqual(fixture.unexpected,[]);
});

test('browser recovery fixture requires matching private receipt or owner for reads',async()=>{
  const fixture=createRecoveryFixture();
  const original=fixture.orders.get('R00000001').receipt;
  assert.equal((await fixture.handle('GET',`/orders/${original.order.number}`)).status,403);
  const read=await fixture.handle('GET',`/orders/${original.order.number}`,null,{'x-order-token':original.trackingToken});
  assert.equal(read.status,200);assert.equal(read.body.number,original.order.number);
  read.body.number='modified-outside-fixture';
  assert.equal(fixture.orders.get('R00000001').receipt.order.number,'R00000001');
  assert.equal((await fixture.handle('POST','/orders/lookup',{number:original.order.number,accessCode:'wrong'})).status,403);
  assert.equal((await fixture.handle('POST','/orders/lookup',{number:original.order.number,accessCode:original.accessCode})).status,200);
});

test('browser recovery fixture closes pending gates and rejects non-fixture operations',async()=>{
  const fixture=createRecoveryFixture(), original=fixture.orders.get('R00000001').receipt;
  const held=fixture.hold('GET',`/orders/${original.order.number}`);
  const pending=fixture.handle('GET',`/orders/${original.order.number}`,null,{'x-order-token':original.trackingToken});
  await held.entered;fixture.releaseAll();assert.equal((await pending).status,200);
  const denied=await fixture.handle('POST',`/orders/${original.order.number}/payment`,{provider:'real-provider'});
  assert.equal(denied.status,404);assert.equal(fixture.unexpected.length,1);
  assert.equal(fixture.submissions.size,0);
  assert.throws(()=>quoteFor({...input,paymentMethod:'card'}));
  assert.throws(()=>quoteFor({...input,items:[{itemId:'unlisted',quantity:1,optionIds:[]}]}));
});

test('browser payment fixture delays only synthetic responses and retains order isolation',async()=>{
  const fixture=createRecoveryFixture(), receipt=fixture.orders.get('R00000001').receipt;
  receipt.order.payment={...receipt.order.payment,method:'card',provider:'paylink'};
  const path=`/orders/${receipt.order.number}/payment`, token={'x-order-token':receipt.trackingToken};
  assert.equal((await fixture.handle('POST',path,{provider:'paylink'},{})).status,403);
  const delayed=fixture.hold('POST',path),pending=fixture.handle('POST',path,{provider:'paylink'},token);
  await delayed.entered;
  assert.equal(fixture.submissions.size,0);delayed.release();
  const result=await pending;assert.equal(result.status,200);assert.equal(result.body.mode,'test');
  assert.equal((await fixture.handle('POST',`${path}/refresh`,{},token)).status,200);
  assert.equal((await fixture.handle('GET',path,null,token)).status,200);
  assert.deepEqual(fixture.unexpected,[]);assert.equal(fixture.submissions.size,0);
});
