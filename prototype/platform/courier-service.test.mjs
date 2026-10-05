import test from 'node:test';
import assert from 'node:assert/strict';
import {createCourierService,createCourierApi} from './courier-service.mjs';
const actor='11111111-1111-4111-8111-111111111111',target='22222222-2222-4222-8222-222222222222',disabled='33333333-3333-4333-8333-333333333333',courier='a'.repeat(32),ref='platform:'+'b'.repeat(64);
function fixture(){
 const calls=[],permissions=new Set(['couriers:link','courier:read','courier:update','courier:collect']);
 const candidates=[{principalId:target,displayName:'Synthetic courier',eligible:true},{principalId:disabled,displayName:'Disabled',eligible:false}];
 const row={id:courier,name:'Courier',active:true,availability:'offline',version:0,ownerRef:null,activeOrders:0};
 const directory={async authorize(who,tenant,permission){calls.push(['authorize',who,tenant,permission]);if(who!==actor||tenant!=='a'||!permissions.has(permission))throw Object.assign(Error('forbidden'),{code:'forbidden'});return {tenantStatus:'active'};},async courierCandidates(who,tenant){await this.authorize(who,tenant,'couriers:link');return candidates;}};
 const orderClient={principalRef(tenant,id){assert.equal(tenant,'a');return id===target?ref:'platform:'+'c'.repeat(64);},async courierLinks(){calls.push(['links']);return {links:[row]};},async setCourierLink(tenant,who,id,input){calls.push(['write',input]);return {...row,version:input.expectedVersion+1,ownerRef:input.ownerRef||null};},async courierWork(){calls.push(['work']);return {orders:[]};},async courierDetail(){calls.push(['detail']);return {};},async courierChange(...args){calls.push(['change',...args]);return {};},async courierAvailability(){calls.push(['availability']);return {};}};
 return {service:createCourierService({directory,orderClient}),directory,orderClient,calls,permissions,row,candidates};
}
test('courier binding uses explicit eligible identity, hides core pseudorefs and confirms version',async()=>{
 const f=fixture();let result=await f.service.links(actor,'a');assert.deepEqual(result.candidates,[{principalId:target,displayName:'Synthetic courier'}]);assert.equal(result.links[0].bound,false);assert.equal('ownerRef' in result.links[0],false);
 result=await f.service.setLink(actor,'a',courier,{expectedVersion:0,principalId:target});assert.equal(result.link.principalId,target);assert.equal(result.link.bound,true);assert.deepEqual(f.calls.find(v=>v[0]==='write')[1],{expectedVersion:0,ownerRef:ref});
 result=await f.service.setLink(actor,'a',courier,{expectedVersion:1,principalId:''});assert.equal(result.link.bound,false);
 for(const principalId of [disabled,actor])await assert.rejects(f.service.setLink(actor,'a',courier,{expectedVersion:0,principalId}),{code:'forbidden'});
 for(const input of [{expectedVersion:0},{expectedVersion:0,principalId:null},{expectedVersion:0,principalId:target,ownerRef:ref},{expectedVersion:-1,principalId:target}])await assert.rejects(f.service.setLink(actor,'a',courier,input),{code:'invalid_request'});
 f.orderClient.setCourierLink=async()=>({...f.row,version:99,ownerRef:ref});await assert.rejects(f.service.setLink(actor,'a',courier,{expectedVersion:0,principalId:target}),{code:'order_outcome_unknown'});
});
test('courier grants are independent and revocation is checked before every operation',async()=>{
 const f=fixture();f.permissions.clear();f.permissions.add('courier:read');
 await f.service.work(actor,'a');await f.service.detail(actor,'a','R1234567890');
 await assert.rejects(f.service.links(actor,'a'),{code:'forbidden'});
 await assert.rejects(f.service.change(actor,'a','R1234567890','status',{}),{code:'forbidden'});
 await assert.rejects(f.service.change(actor,'a','R1234567890','cash',{}),{code:'forbidden'});
 await assert.rejects(f.service.availability(actor,'a',{}),{code:'forbidden'});
 f.permissions.add('courier:collect');await f.service.change(actor,'a','R1234567890','cash',{});
 await assert.rejects(f.service.change(actor,'a','R1234567890','status',{}),{code:'forbidden'});
 f.permissions.delete('courier:read');await assert.rejects(f.service.change(actor,'a','R1234567890','cash',{}),{code:'forbidden'});
 await assert.rejects(f.service.work(actor,'b'),{code:'forbidden'});
 assert.equal(f.calls.filter(v=>v[0]==='change').length,1);
});
test('courier API does not accept queries, ambiguous methods or foreign route shapes',async()=>{
 const f=fixture(),api=createCourierApi({...f,body:async()=>({}),json:(_,status,data)=>({status,data})});
 assert.equal((await api({method:'GET'},{},{id:actor},new URL('https://platform.example/api/restaurants/a/courier-work'))).status,200);
 for(const path of ['/api/restaurants/a/courier-work?all=1','/api/restaurants/a/courier-work/availability?x=1'])await assert.rejects(api({method:'GET'},{},{id:actor},new URL('https://platform.example'+path)),{code:'invalid_request'});
 for(const path of ['/api/restaurants/a/courier-work/availability','/api/restaurants/a/courier-work/orders/other','/api/restaurants/a/courier-links/'+actor])await assert.rejects(api({method:'GET'},{},{id:actor},new URL('https://platform.example'+path)),{code:'not_found'});
});

test('suspension can revoke a binding but never grant a new one, including a mid-review pause',async()=>{
 const f=fixture();f.directory.authorize=async()=>({tenantStatus:'suspended'});
 // Deliberately keep a stale eligible candidate to exercise the final recheck.
 await assert.rejects(f.service.setLink(actor,'a',courier,{expectedVersion:0,principalId:target}),{code:'tenant_suspended'});
 const revoked=await f.service.setLink(actor,'a',courier,{expectedVersion:1,principalId:''});assert.equal(revoked.link.bound,false);assert.equal(f.calls.filter(v=>v[0]==='write').length,1);
});
