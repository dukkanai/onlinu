// Deliberately separate from parallel HTTP tests: restarts only our prototype apps.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execute=promisify(execFile);
const directory=fileURLToPath(new URL('../../',import.meta.url));
const base='http://127.0.0.1:18787';
async function call(path,token,input){
  const response=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{Origin:base,
    ...(token?{Authorization:`Bearer ${token}`} :{}),...(input===undefined?{}:{'Content-Type':'application/json'})},
    ...(input===undefined?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(3000)});
  const value=await response.json();assert.ok(response.ok,`${response.status} ${value.error??''}`);return value;
}
const health=await call('/health');assert.equal(health.mode,'synthetic');
const {accessToken:token}=await call('/dev/session',null,{identity:'customer-alice'});
const cart={items:[{itemId:'meal',quantity:1}],expectedTotalMinor:4500,idempotencyKey:randomUUID()};
const checkout=await call('/api/restaurants/demo-b/checkouts',token,cart);
const confirmed=await call(`/api/checkouts/${checkout.checkoutId}/confirm`,token,{});
const order=await call(confirmed.simulationUrl,token,{});
await execute('docker',['compose','-f','compose.yml','restart','platform','tenant-a','tenant-b'],{cwd:directory,timeout:45_000});
let ready=false;
for(let attempt=0;attempt<40;attempt++){
  try{const current=await call(`/api/restaurants/demo-b/orders/${order.id}`,token);assert.deepEqual(current,order);ready=true;break;}
  catch{await new Promise(resolve=>setTimeout(resolve,500));}
}
assert.equal(ready,true,'order/session must survive application-container restart');
assert.equal((await call(`/api/checkouts/${checkout.checkoutId}/confirm`,token,{})).order.id,order.id);
assert.equal((await call('/api/restaurants/demo-b/checkouts',token,cart)).checkoutId,checkout.checkoutId);
console.log('PASS real prototype app-container restart preserves token, checkout, paid order and idempotency; not a backup-restore/HA test');
