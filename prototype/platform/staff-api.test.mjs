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
