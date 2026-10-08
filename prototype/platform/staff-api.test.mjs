import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createStaffApi} from './staff-api.mjs';
const uri=new URL('https://platform.example/api/restaurants/a/staff/menu/items/rice/image');
function request(bytes,headers={}){const req=Readable.from([bytes]);req.method='POST';req.headers={'content-type':'application/octet-stream','x-menu-version':'4',...headers};return req;}
test('binary staff image assignment shares slots, authorization and the original catalogue CAS',async()=>{
 const slots={active:0},calls=[],bytes=Buffer.from([137,80,78,71]);
 const api=createStaffApi({uploadSlots:slots,directory:{async authorize(...args){calls.push(['authorize',...args]);}},orderClient:{
  async menuItem(...args){calls.push(['read',...args]);return{version:4};},
  async uploadImage(tenant,actor,input){assert.equal(slots.active,1);assert.deepEqual(input,bytes);return{url:'/restaurant-media/'+'a'.repeat(64)+'.png'};},
  async patchMenuItem(tenant,actor,item,input){calls.push(['patch',tenant,actor,item,input]);return{version:5};},
 },json:(res,status,data)=>({status,data})});
 const result=await api(request(bytes),{}, {id:'staff'},uri);assert.equal(result.status,200);assert.equal(slots.active,0);
 assert.equal(calls.filter(v=>v[0]==='authorize').length,3);assert.deepEqual(calls.at(-1),['patch','a','staff','rice',{expectedVersion:4,imageUrl:'/restaurant-media/'+'a'.repeat(64)+'.png'}]);
});
test('image metadata, stale versions, revoked access and quota fail before assignment',async()=>{
 const slots={active:2};let uploads=0,reads=0,authorizations=0;
 const api=createStaffApi({uploadSlots:slots,directory:{async authorize(){authorizations++;if(authorizations===5)throw Object.assign(Error(),{status:403,code:'forbidden'});}},orderClient:{async menuItem(){reads++;return{version:5};},async uploadImage(){uploads++;}},json:()=>{throw Error('unexpected assignment');}});
 await assert.rejects(api(request(Buffer.from('x')),{}, {id:'staff'},uri),{status:429});assert.equal(reads,0);assert.equal(slots.active,2);
 slots.active=0;
 await assert.rejects(api(request(Buffer.from('x'),{'x-menu-version':'4,4'}),{}, {id:'staff'},uri),{status:400});
 await assert.rejects(api(request(Buffer.from('x'),{'content-type':'application/json'}),{}, {id:'staff'},uri),{status:415});
 await assert.rejects(api(request(Buffer.from('x')),{}, {id:'staff'},uri),{code:'catalog_changed'});assert.equal(uploads,0);assert.equal(slots.active,0);
 await assert.rejects(api(request(Buffer.from('x')),{}, {id:'staff'},uri),{code:'forbidden'});assert.equal(uploads,0);assert.equal(slots.active,0);
});
test('binary image byte limit is enforced and slot is released',async()=>{
 const slots={active:0};const api=createStaffApi({uploadSlots:slots,directory:{async authorize(){}},orderClient:{},json(){throw Error('unexpected');}});
 await assert.rejects(api(request(Buffer.alloc(5*1024*1024+1)),{}, {id:'staff'},uri),{status:413});assert.equal(slots.active,0);
 await assert.rejects(api(request(Buffer.alloc(0)),{}, {id:'staff'},uri),{code:'image_invalid'});assert.equal(slots.active,0);
});
test('revocation during original-core upload prevents assignment and releases the shared slot',async()=>{
 const slots={active:0};let checks=0,uploaded=false,patched=false;
 const api=createStaffApi({uploadSlots:slots,directory:{async authorize(){if(++checks===3)throw Object.assign(Error(),{status:403,code:'forbidden'});}},orderClient:{
  async menuItem(){return{version:4};},async uploadImage(){uploaded=true;return{url:'/restaurant-media/'+'a'.repeat(64)+'.png'};},async patchMenuItem(){patched=true;}
 },json(){throw Error('unexpected');}});
 await assert.rejects(api(request(Buffer.from('x')),{}, {id:'staff'},uri),{code:'forbidden'});
 assert.equal(uploaded,true);assert.equal(patched,false);assert.equal(slots.active,0);
});

test('financial read requires both order and payment grants and offers no write route',async()=>{
 const calls=[],grants=new Set(['orders:read']);
 const api=createStaffApi({directory:{async authorize(actor,tenant,permission){calls.push(permission);if(!grants.has(permission))throw Object.assign(Error(),{code:'forbidden'});}},orderClient:{async finance(){return{number:'R1234567890'};}},json:(_,status,data)=>({status,data})});
 const url=new URL('https://platform.example/api/restaurants/a/staff/orders/R1234567890/finance');
 await assert.rejects(api({method:'GET'},{},{id:'staff'},url),{code:'forbidden'});grants.add('payments:read');assert.equal((await api({method:'GET'},{},{id:'staff'},url)).status,200);assert.deepEqual(calls,['orders:read','payments:read','orders:read','payments:read']);
 await assert.rejects(api({method:'POST'},{},{id:'staff'},url),{code:'not_found'});
});

test('existing refund commands require all grants again after reading the body and never retry',async()=>{
 const grants=new Set(['orders:read','payments:read']),calls=[];
 const url=new URL('https://platform.example/api/restaurants/a/staff/orders/R1234567890/refunds/11111111-1111-4111-8111-111111111111/authorize');
 let revoke=false;
 const api=createStaffApi({directory:{async authorize(actor,tenant,grant){if(!grants.has(grant))throw Object.assign(Error(),{code:'forbidden'});}},body:async()=>{if(revoke)grants.delete('refunds:manage');return {reviewed:true};},orderClient:{async refundCommand(...args){calls.push(args);throw Object.assign(Error(),{code:'order_outcome_unknown'});}},json:()=>assert.fail('unknown outcome cannot be reported as success')});
 await assert.rejects(api({method:'POST'},{},{id:'staff'},url),{code:'forbidden'});assert.equal(calls.length,0);
 grants.add('refunds:manage');revoke=true;
 await assert.rejects(api({method:'POST'},{},{id:'staff'},url),{code:'forbidden'});assert.equal(calls.length,0);
 grants.add('refunds:manage');revoke=false;
 await assert.rejects(api({method:'POST'},{},{id:'staff'},url),{code:'order_outcome_unknown'});assert.equal(calls.length,1);
 assert.deepEqual(calls[0],['a','staff','R1234567890','11111111-1111-4111-8111-111111111111','authorize',{reviewed:true}]);
});

test('appearance commands require current read/write grants and preserve action separation',async()=>{
 const grants=new Set(['settings:read']),calls=[];let revoke=false;
 const api=createStaffApi({directory:{async authorize(a,t,p){if(!grants.has(p))throw Object.assign(Error(),{code:'forbidden'});}},body:async()=>{if(revoke)grants.delete('settings:update');return{version:1,catalogVersion:2,reviewed:true};},orderClient:{async brand(){return{version:1};},async brandCommand(...args){calls.push(args);return{version:2};}},json:(_,status,data)=>({status,data})});
 const base='https://platform.example/api/restaurants/a/staff/brand';
 assert.equal((await api({method:'GET'},{},{id:'staff'},new URL(base))).status,200);
 await assert.rejects(api({method:'POST'},{},{id:'staff'},new URL(base+'/publish')),{code:'forbidden'});
 grants.add('settings:update');revoke=true;await assert.rejects(api({method:'POST'},{},{id:'staff'},new URL(base+'/publish')),{code:'forbidden'});assert.equal(calls.length,0);
 grants.add('settings:update');revoke=false;await api({method:'POST'},{},{id:'staff'},new URL(base+'/revert'));assert.equal(calls.length,1);assert.equal(calls[0][2],'revert');
});

test('order-update alone never authorizes cancellation decisions and support grants are rechecked',async()=>{
 const grants=new Set(['orders:read','orders:update']);let calls=0,revoke=false;
 const api=createStaffApi({directory:{async authorize(a,t,p){if(!grants.has(p))throw Object.assign(Error(),{code:'forbidden'});}},body:async()=>{if(revoke)grants.delete('support:manage');return{version:1,reviewed:true,approve:false,reason:'Synthetic rejection'};},orderClient:{async supportCommand(){calls++;return{};}},json:(_,status,data)=>({status,data})});
 const url=new URL('https://platform.example/api/restaurants/a/staff/support/orders/R1234567890/11111111-1111-4111-8111-111111111111/decide');
 await assert.rejects(api({method:'POST'},{},{id:'staff'},url),{code:'forbidden'});assert.equal(calls,0);
 grants.add('support:manage');revoke=true;await assert.rejects(api({method:'POST'},{},{id:'staff'},url),{code:'forbidden'});assert.equal(calls,0);
 grants.add('support:manage');revoke=false;assert.equal((await api({method:'POST'},{},{id:'staff'},url)).status,200);assert.equal(calls,1);
});

test('tax writes require read and update again after body parsing',async()=>{
 const grants=new Set(['settings:read']);let writes=0,revoke=false;
 const api=createStaffApi({directory:{async authorize(a,t,p){if(!grants.has(p))throw Object.assign(Error(),{code:'forbidden'});}},body:async()=>{if(revoke)grants.delete('settings:read');return{reviewed:true};},orderClient:{async tax(){return{};},async patchTax(){writes++;return{};}},json:(_,status,data)=>({status,data})});
 const url=new URL('https://platform.example/api/restaurants/a/staff/tax');assert.equal((await api({method:'GET'},{},{id:'staff'},url)).status,200);
 await assert.rejects(api({method:'POST'},{},{id:'staff'},url),{code:'forbidden'});grants.add('settings:update');revoke=true;await assert.rejects(api({method:'POST'},{},{id:'staff'},url),{code:'forbidden'});assert.equal(writes,0);revoke=false;grants.add('settings:read');await api({method:'POST'},{},{id:'staff'},url);assert.equal(writes,1);
});

test('delivery writes recheck authority after body parsing and never retry an uncertain mutation',async t=>{
 for(const action of ['pricing','zone','location'])await t.test(action,async()=>{
  let granted=false,revoke=false,reads=0,writes=0;
  const input=action==='location'?{expectedVersion:4,origin:{latitude:0,longitude:0},radiusKm:1}:action==='pricing'?{expectedVersion:4,mode:'flat',feeMinor:500,minimumMinor:0}:{expectedVersion:4,zone:{districtId:'sa-d-1',enabled:true,feeMinor:500}};
  const api=createStaffApi({
   directory:{async authorize(actor,tenant,permission){assert.equal(actor,'staff');assert.equal(tenant,'a');assert.equal(permission,'settings:update');if(!granted)throw Object.assign(Error(),{code:'forbidden'});}},
   body:async()=>{reads++;if(revoke)granted=false;return input;},
   orderClient:{async patchDelivery(...args){writes++;assert.deepEqual(args,['a','staff',action,input]);throw Object.assign(Error(),{code:'order_outcome_unknown'});}},
   json:()=>assert.fail('an uncertain mutation must not report success'),
  });
  const url=new URL('https://platform.example/api/restaurants/a/staff/delivery/'+action);
  await assert.rejects(api({method:'POST'},{},{id:'staff'},url),{code:'forbidden'});assert.equal(reads,0);assert.equal(writes,0);
  granted=true;revoke=true;
  await assert.rejects(api({method:'POST'},{},{id:'staff'},url),{code:'forbidden'});assert.equal(reads,1);assert.equal(writes,0);
  granted=true;revoke=false;
  await assert.rejects(api({method:'POST'},{},{id:'staff'},url),{code:'order_outcome_unknown'});assert.equal(writes,1);
 });
});

test('payment-method edits require read and write again after body parsing',async()=>{
 const grants=new Set(['settings:read']);let writes=0,revoke='';
 const api=createStaffApi({directory:{async authorize(a,t,p){if(!grants.has(p))throw Object.assign(Error(),{code:'forbidden'});}},body:async()=>{if(revoke)grants.delete(revoke);return{expectedVersion:1,mode:'delivery',methods:['card']};},orderClient:{async paymentMethods(){return{};},async patchPaymentMethods(){writes++;return{};}},json:(_,status,data)=>({status,data})});
 const url=new URL('https://platform.example/api/restaurants/a/staff/payment-methods');
 assert.equal((await api({method:'GET'},{},{id:'staff'},url)).status,200);
 await assert.rejects(api({method:'POST'},{},{id:'staff'},url),{code:'forbidden'});
 for(const permission of ['settings:read','settings:update']){
  grants.add('settings:read');grants.add('settings:update');revoke=permission;
  await assert.rejects(api({method:'POST'},{},{id:'staff'},url),{code:'forbidden'});assert.equal(writes,0);
 }
 grants.add('settings:read');grants.add('settings:update');revoke='';
 await api({method:'POST'},{},{id:'staff'},url);assert.equal(writes,1);
});

test('opening schedule rechecks read/write after body and binds the restaurant',async()=>{
 const url=new URL('https://platform.example/api/restaurants/a/staff/opening-schedule'),calls=[],grants=new Set(['settings:read']);let revoke=false;
 const api=createStaffApi({directory:{async authorize(actor,tenant,grant){assert.equal(actor,'staff');assert.equal(tenant,'a');if(!grants.has(grant))throw Object.assign(Error(),{code:'forbidden'});}},body:async()=>{if(revoke)grants.delete('settings:update');return{reviewed:true};},orderClient:{async openingSchedule(...args){calls.push(['read',...args]);return{version:1};},async patchOpeningSchedule(...args){calls.push(['write',...args]);return{version:2};}},json:(_,status,data)=>({status,data})});
 assert.equal((await api({method:'GET'},{},{id:'staff'},url)).status,200);
 await assert.rejects(api({method:'POST'},{},{id:'staff'},url),{code:'forbidden'});
 grants.add('settings:update');revoke=true;await assert.rejects(api({method:'POST'},{},{id:'staff'},url),{code:'forbidden'});assert.equal(calls.length,1);
 grants.add('settings:update');revoke=false;assert.equal((await api({method:'POST'},{},{id:'staff'},url)).data.version,2);assert.deepEqual(calls.at(-1),['write','a','staff',{reviewed:true}]);
 await assert.rejects(api({method:'DELETE'},{},{id:'staff'},url),{code:'invalid_request'});
 await assert.rejects(api({method:'GET'},{},{id:'staff'},new URL(url+'?at=tomorrow')),{code:'invalid_request'});
});

test('channel changes recheck current authority after reading a delayed body',async()=>{
 let granted=true,writes=0,reads=0;
 const api=createStaffApi({directory:{async authorize(actor,tenant,permission){assert.deepEqual([actor,tenant,permission],['staff','a','channels:manage']);if(!granted)throw Object.assign(Error(),{code:'forbidden'});}},
  body:async()=>{reads++;granted=false;return{newOrdersEnabled:true,expectedVersion:1};},
  orderClient:{async setChannel(){writes++;return{};}},json:(_,status,data)=>({status,data})});
 const url=new URL('https://platform.example/api/restaurants/a/staff/channels/web');
 await assert.rejects(api({method:'POST'},{},{id:'staff'},url),{code:'forbidden'});
 assert.equal(reads,1);assert.equal(writes,0);
});

test('remaining staff mutations reject revocation during body consumption without retry',async t=>{
 const routes=[
  ['orders/R00000001/courier','delivery:assign','assignCourier'],
  ['service','settings:update','patchService'],['profile','settings:update','patchProfile'],
  ['menu/categories/main','menu:update','patchMenuCategory'],
  ['menu/items','menu:update','createMenuItem'],['menu/categories','menu:update','createMenuCategory'],
  ['menu/items/rice','menu:update','patchMenuItem'],['stock/rice','stock:update','setStock'],
  ['orders/R00000001/status','orders:update','staffChange'],['orders/R00000001/cash','payments:collect','staffChange'],
 ];
 for(const[path,permission,method]of routes)await t.test(path,async()=>{
  let granted=false,revoke=true,reads=0,writes=0;
  const input={fixture:'unchanged'};
  const api=createStaffApi({directory:{async authorize(actor,tenant,grant){assert.deepEqual([actor,tenant,grant],['staff','a',permission]);if(!granted)throw Object.assign(Error(),{code:'forbidden'});}},
   body:async()=>{reads++;if(revoke)granted=false;return input;},
   orderClient:{async[method](...args){assert.equal(args.at(-1),input);writes++;throw Object.assign(Error(),{code:'order_outcome_unknown'});}},json:()=>assert.fail('unknown write reported success')});
  const url=new URL('https://platform.example/api/restaurants/a/staff/'+path);
  await assert.rejects(api({method:'POST'},{},{id:'staff'},url),{code:'forbidden'});assert.equal(reads,0);assert.equal(writes,0);
  granted=true;await assert.rejects(api({method:'POST'},{},{id:'staff'},url),{code:'forbidden'});assert.equal(writes,0);
  granted=true;revoke=false;await assert.rejects(api({method:'POST'},{},{id:'staff'},url),{code:'order_outcome_unknown'});assert.equal(writes,1);
 });
});
