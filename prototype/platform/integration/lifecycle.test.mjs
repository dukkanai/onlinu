import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.PROTOTYPE_TEST_URL ?? 'http://127.0.0.1:18787';
if (base !== 'http://127.0.0.1:18787') throw new Error('Tests are restricted to the synthetic loopback prototype');
async function request(path, {token, input, method = input === undefined ? 'GET' : 'POST', headers = {}} = {}) {
  const response = await fetch(base + path, {method, redirect:'manual', headers: {
    Origin:base, ...(input === undefined ? {} : {'Content-Type':'application/json'}),
    ...(token ? {Authorization:`Bearer ${token}`} : {}), ...headers,
  }, ...(input === undefined ? {} : {body:JSON.stringify(input)})});
  const value = await response.json();
  return {status:response.status,value};
}
const ok = (result, status=200) => {assert.equal(result.status,status,JSON.stringify(result.value));return result.value;};
async function session(identity) {return ok(await request('/dev/session',{input:{identity}})).accessToken;}

test('two actual tenant databases: catalog, checkout ownership, price and stock, payment and merchant lifecycle', async t => {
  const [alice,merchantA,merchantB] = await Promise.all(['customer-alice','merchant-a','merchant-b'].map(session));
  const catalog = ok(await request('/api/restaurants'));
  assert.deepEqual(catalog.restaurants.map(r=>r.id),['demo-a','demo-b']);
  assert.equal(ok(await request('/api/restaurants?query=مشويات')).restaurants[0].id,'demo-b');
  const [menuA,menuB] = await Promise.all(['demo-a','demo-b'].map(async id=>ok(await request(`/api/restaurants/${id}/menu`))));
  const mealA=menuA.items.find(item=>item.id==='meal'), mealB=menuB.items.find(item=>item.id==='meal');
  assert.equal(mealA.priceMinor,3000);assert.equal(mealB.priceMinor,4500);
  const items=[{itemId:'meal',quantity:1}];
  const quote=ok(await request('/api/restaurants/demo-a/quote',{input:{items}}));
  assert.equal(quote.totalMinor,3000);
  await t.test('caller cannot inject identity, price or role, or use a foreign browser origin',async()=>{
    assert.equal((await request('/dev/session',{input:{identity:'customer-alice'},headers:{Origin:'https://foreign.example'}})).status,403);
    assert.equal((await request('/api/restaurants/demo-a/checkouts',{input:{items,expectedTotalMinor:3000,idempotencyKey:randomUUID()},headers:{'X-Actor-ID':'customer-alice','X-Actor-Role':'customer'}})).status,401);
    assert.equal((await request('/api/restaurants/demo-a/quote',{input:{items,totalMinor:1}})).status,400);
    assert.equal((await request('/api/restaurants/demo-a/checkouts',{token:alice,input:{items,expectedTotalMinor:1,idempotencyKey:randomUUID()}})).status,409);
    assert.equal((await request('/api/restaurants/demo-a/checkouts',{token:merchantA,input:{items,expectedTotalMinor:3000,idempotencyKey:randomUUID()}})).status,403);
  });
  const cart={items,expectedTotalMinor:3000,idempotencyKey:randomUUID()};
  const sessions=await Promise.all(Array.from({length:4},()=>request('/api/restaurants/demo-a/checkouts',{token:alice,input:cart})));
  const checkouts=sessions.map(result=>ok(result,201));
  assert.equal(new Set(checkouts.map(c=>c.checkoutId)).size,1);
  const checkout=checkouts[0];
  assert.equal((await request('/api/restaurants/demo-a/checkouts',{token:alice,input:{...cart,items:[{itemId:'drink',quantity:1}],expectedTotalMinor:500}})).status,409);
  const beforeConfirm=ok(await request('/api/restaurants/demo-a/menu')).items.find(i=>i.id==='meal').stock;
  assert.equal(beforeConfirm,mealA.stock,'preparing checkout does not reserve stock');
  const confirmations=await Promise.all(Array.from({length:4},()=>request(`/api/checkouts/${checkout.checkoutId}/confirm`,{token:alice,input:{}})));
  const orders=confirmations.map(result=>ok(result).order);
  assert.equal(new Set(orders.map(order=>order.id)).size,1);
  let order=orders[0];
  assert.equal(order.status,'pending_payment');assert.equal(order.paymentStatus,'pending');
  assert.equal('ownerId' in order,false);
  assert.equal(ok(await request('/api/restaurants/demo-a/menu')).items.find(i=>i.id==='meal').stock,beforeConfirm-1);
  const orderPath=`/api/restaurants/demo-a/orders/${order.id}`;
  const merchantPath=`/api/merchant/restaurants/demo-a/orders/${order.id}/status`;
  await t.test('tenant and customer boundaries survive order identifiers being known',async()=>{
    const bob=await session('customer-bob');
    assert.equal((await request(`/api/checkouts/${checkout.checkoutId}`,{token:bob})).status,404);
    assert.equal((await request(orderPath,{token:bob})).status,404);
    assert.equal((await request(`${orderPath}/simulate-payment`,{token:bob,input:{}})).status,404);
    assert.equal((await request(`/api/restaurants/demo-b/orders/${order.id}`,{token:alice})).status,404);
    assert.equal((await request('/api/merchant/restaurants/demo-b/orders',{token:merchantA})).status,403);
    assert.equal((await request(merchantPath,{token:merchantB,input:{status:'preparing',expectedVersion:order.version}})).status,403);
    assert.equal((await request(merchantPath,{token:alice,input:{status:'preparing',expectedVersion:order.version}})).status,403);
  });
  assert.equal((await request(merchantPath,{token:merchantA,input:{status:'preparing',expectedVersion:order.version}})).status,409);
  order=ok(await request(`${orderPath}/simulate-payment`,{token:alice,input:{}}));
  assert.equal(order.status,'accepted');assert.equal(order.paymentStatus,'paid');
  assert.deepEqual(ok(await request(`${orderPath}/simulate-payment`,{token:alice,input:{}})),order);
  for(const status of ['preparing','ready','completed']) {
    const oldVersion=order.version;
    order=ok(await request(merchantPath,{token:merchantA,input:{status,expectedVersion:oldVersion}}));
    assert.equal(order.status,status);assert.equal(order.version,oldVersion+1);
    assert.equal((await request(merchantPath,{token:merchantA,input:{status,expectedVersion:oldVersion}})).status,409);
  }
  assert.equal(ok(await request(orderPath,{token:alice})).status,'completed');
  assert.ok(ok(await request('/api/merchant/restaurants/demo-a/orders',{token:merchantA})).orders.some(o=>o.id===order.id));
  assert.equal(ok(await request('/api/restaurants/demo-b/menu')).items.find(i=>i.id==='meal').stock,mealB.stock,'other tenant stock is untouched');
});
