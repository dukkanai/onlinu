import test from 'node:test';
import assert from 'node:assert/strict';
import {createOpeningMonitor, parseOpeningStatus, type OpeningStatus} from '../src/restaurant/customer/opening-status';
const status: OpeningStatus={version:1,scheduleEnabled:true,withinHours:true,acceptingOrders:true,timeZone:'Asia/Riyadh',evaluatedAt:'2026-10-07T14:00:00Z'};
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
function timers(){let next=0;const jobs=new Map<number,{run:()=>void,delay:number}>();return{jobs,schedule:(run:()=>void,delay:number)=>{const id=++next;jobs.set(id,{run,delay});return()=>{jobs.delete(id);};},fire:(delay:number)=>{const pair=[...jobs].find(([,v])=>v.delay===delay);assert.ok(pair);jobs.delete(pair[0]);pair[1].run();}};}
test('opening snapshot rejects malformed and contradictory claims; no local timezone inference',()=>{
 assert.deepEqual(parseOpeningStatus(status),status);
 assert.equal(parseOpeningStatus({...status,scheduleEnabled:false,withinHours:null})?.acceptingOrders,true);
 for(const change of [{version:0},{version:1.5},{version:Number.MAX_SAFE_INTEGER+1},{withinHours:null},{withinHours:false},{scheduleEnabled:false},{timeZone:'UTC'},{evaluatedAt:'tomorrow'},{acceptingOrders:'true'},{private:'unexpected'}])assert.equal(parseOpeningStatus({...status,...change}),null);
 for(const key of Object.keys(status)){const value={...status} as Record<string,unknown>;delete value[key];assert.equal(parseOpeningStatus(value),null);}
 assert.equal(parseOpeningStatus(null),null);assert.equal(parseOpeningStatus([]),null);
});
test('old requests cannot overwrite newer results and hidden/unmounted pages stop polling',async()=>{
 const clock=timers(),values:Array<OpeningStatus|null>=[],reads:Array<{signal:AbortSignal,resolve:(value:unknown)=>void}>=[];let visible=true;
 const monitor=createOpeningMonitor({visible:()=>visible,schedule:clock.schedule,changed:v=>values.push(v),read:signal=>new Promise(resolve=>reads.push({signal,resolve}))});
 monitor.refresh();await flush();monitor.refresh();await flush();assert.equal(reads[0].signal.aborted,true);
 reads[1].resolve({...status,version:2,withinHours:false,acceptingOrders:false});await flush();assert.equal(values.at(-1)?.version,2);
 reads[0].resolve(status);await flush();assert.equal(values.length,1);assert.equal(clock.jobs.size,1);
 visible=false;monitor.refresh();assert.equal(values.at(-1),null);assert.equal(clock.jobs.size,0);assert.equal(reads.length,2);
 visible=true;monitor.refresh();await flush();monitor.stop();reads[2].resolve(status);await flush();assert.equal(values.at(-1),null);assert.equal(clock.jobs.size,0);
 monitor.refresh();await flush();assert.equal(reads.length,3);
});
test('slow, invalid and failed reads become unknown rather than a stale open promise',async()=>{
 const clock=timers(),values:Array<OpeningStatus|null>=[];let resolve:(v:unknown)=>void=()=>{};
 const monitor=createOpeningMonitor({visible:()=>true,schedule:clock.schedule,changed:v=>values.push(v),read:()=>new Promise(r=>resolve=r)});
 monitor.refresh();await flush();clock.fire(5000);assert.equal(values.at(-1),null);resolve(status);await flush();assert.equal(values.length,1);
 clock.fire(30000);await flush();resolve({acceptingOrders:true});await flush();assert.equal(values.at(-1),null);assert.equal(clock.jobs.size,1);monitor.stop();assert.equal(clock.jobs.size,0);
 const failed=createOpeningMonitor({visible:()=>true,schedule:clock.schedule,changed:v=>values.push(v),read:async()=>{throw Error('network');}});failed.refresh();await flush();assert.equal(values.at(-1),null);failed.stop();assert.equal(clock.jobs.size,0);
});
test('strict-mode cleanup before the first microtask does not start an abandoned request',async()=>{
 const clock=timers();let reads=0;const monitor=createOpeningMonitor({visible:()=>true,schedule:clock.schedule,changed:()=>assert.fail('disposed'),read:async()=>{reads++;return status;}});
 monitor.refresh();monitor.stop();await flush();assert.equal(reads,0);assert.equal(clock.jobs.size,0);
});
