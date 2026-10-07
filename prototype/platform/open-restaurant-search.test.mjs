import test from 'node:test';
import assert from 'node:assert/strict';
import {createOpenRestaurantSearch,openSearchOutput} from './open-restaurant-search.mjs';
const at=Date.parse('2026-10-07T13:00:00Z');
const row=id=>({id,name:id,cuisine:'saudi'});
const status=id=>({tenantId:id,version:1,scheduleEnabled:true,withinHours:true,acceptingOrders:true,timeZone:'Asia/Riyadh',evaluatedAt:new Date(at).toISOString()});
test('open search distinguishes closed, unconfigured and unavailable without guessing',async()=>{
 const search=createOpenRestaurantSearch({now:()=>at,listRestaurants:async()=>['a','b','c','d','e','f'].map(row),openingStatus:async id=>{
  if(id==='d')throw Error('private backend detail');
  return {...status(id),...(id==='b'?{withinHours:false,acceptingOrders:false}:id==='c'?{scheduleEnabled:false,withinHours:null}:id==='e'?{tenantId:'foreign'}:id==='f'?{evaluatedAt:new Date(at-60001).toISOString()}: {})};
 }});
 const result=await search({});assert.equal(openSearchOutput.safeParse(result).success,true);assert.deepEqual(result.restaurants.map(v=>v.id),['a']);assert.equal(result.closed,1);assert.equal(result.unconfigured,1);assert.equal(result.unavailable,3);assert.equal(result.checked,6);assert.equal(result.hasMore,false);assert.equal(result.nextAfter,null);assert.doesNotMatch(JSON.stringify(result),/private backend/);
});
test('pagination scans a bounded ordered candidate page and limits parallel core reads',async()=>{
 let active=0,peak=0;const seen=[];
 const search=createOpenRestaurantSearch({now:()=>at,listRestaurants:async()=>Array.from({length:23},(_,i)=>row('r'+String(i).padStart(2,'0'))).reverse(),openingStatus:async id=>{active++;peak=Math.max(peak,active);seen.push(id);await new Promise(resolve=>setTimeout(resolve,2));active--;return status(id);}});
 const first=await search({limit:7});assert.equal(first.checked,7);assert.equal(first.nextAfter,'r06');assert.equal(first.hasMore,true);assert.equal(peak,5);
 const next=await search({after:first.nextAfter,limit:20});assert.equal(next.checked,16);assert.equal(next.hasMore,false);assert.equal(new Set(seen).size,23);assert.equal(seen.length,23);
 for(const input of [{limit:21},{limit:0},{at:'tomorrow'},{after:'../x'},{query:'x'.repeat(101)}])await assert.rejects(search(input),{code:'invalid_request'});
});
test('process search bound rejects overload and releases after failed or successful reads',async()=>{
 let unblock;const barrier=new Promise(resolve=>unblock=resolve);
 const search=createOpenRestaurantSearch({now:()=>at,listRestaurants:async()=>{await barrier;return[row('a')];},openingStatus:async id=>status(id)});
 const one=search({}),two=search({});await assert.rejects(search({}),{code:'rate_limited'});unblock();await Promise.all([one,two]);assert.equal((await search({})).checked,1);
 let fail=true;const failed=createOpenRestaurantSearch({listRestaurants:async()=>{if(fail)throw Error('db down');return[];},openingStatus:async()=>assert.fail('no candidate')});
 await assert.rejects(failed({}));await assert.rejects(failed({}));fail=false;assert.equal((await failed({})).checked,0);
});
