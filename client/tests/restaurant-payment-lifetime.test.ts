import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { PaymentPanel } from "../src/restaurant/customer/PaymentPanel";
import { createPaymentLifetime, mergePaymentOrder } from "../src/restaurant/customer/paymentLifetime";
import type { Order } from "../src/restaurant/types";

const source = readFileSync(new URL("../src/restaurant/customer/PaymentPanel.tsx", import.meta.url), "utf8");
const first = source.indexOf("  const refresh ="), second = source.indexOf("  const pay =");
const order = {number:"R00000001",version:2,demo:true,payment:{method:"card",provider:"paylink",status:"unpaid"}} as Order;
const attempt = {attemptId:"11111111-1111-4111-8111-111111111111",provider:"paylink",mode:"test",status:"pending",url:"https://paymentpilot.paylink.sa/pay/info/123"};
function deferred() { let resolve!:(value:unknown)=>void, reject!:(value:unknown)=>void;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; }
function harness(kind:"refresh"|"pay", holdAt=0, accountId="customer-A", paymentResult=attempt) {
  const lifetime=createPaymentLifetime(), dispose=lifetime.mount(), hold=deferred();
  const effects:string[]=[], requests:{path:string;method?:string}[]=[];
  const env={lifetime,mutation:{current:false},readGeneration:{current:0},order,customerId:"customer-A",token:"synthetic-token",base:`/orders/${order.number}`,headers:{"X-Order-Token":"synthetic-token"},
    setBusy:(value:boolean)=>effects.push(`busy:${value}`),setError:(value:string)=>effects.push(`error:${value}`),setAttempt:(value:unknown)=>effects.push(value?"attempt":"attempt:cleared"),
    onUpdated:()=>effects.push("updated"),fail:()=>effects.push("failed"),retainPaymentReceipt:()=>effects.push("retained"),
    safePaymentURL:()=>attempt.url,isolatedHyperPayDocument:()=>"synthetic-widget",
    window:{location:{origin:"https://synthetic.invalid",assign:()=>effects.push("redirect")}},
    storefront:async(path:string,options?:{method?:string})=>{const i=requests.length;requests.push({path,method:options?.method});if(i===holdAt)return hold.promise;return path==="/account"?{customer:accountId?{id:accountId}:null}:path.endsWith("/payment")||path.endsWith("/refresh")?paymentResult:order;},
  };
  const callback=source.slice(kind==="refresh"?first:second,kind==="refresh"?second:source.indexOf("  const payment ="));
  // Execute the actual callback, not a reimplementation. No network or provider.
  const js=ts.transpileModule(`${callback}\nreturn ${kind};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const run=new Function(...Object.keys(env),js)(...Object.values(env)) as ()=>Promise<void>;
  return {run,hold,requests,effects,dispose,env};
}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));

test("payment scopes reset for order, token and customer changes",()=>{
  const key=(props:Partial<Parameters<typeof PaymentPanel>[0]>={})=>PaymentPanel({order,token:"A",customerId:"A",onUpdated:()=>{},...props}).key;
  assert.notEqual(key(),key({order:{...order,number:"R00000002"}}));
  assert.notEqual(key(),key({token:"B"}));assert.notEqual(key(),key({customerId:"B"}));
  assert.equal(key(),key({order:{...order,version:3}}));
});
test("payment lifetime does not reactivate old callbacks after remount",()=>{
  const life=createPaymentLifetime(),stop=life.mount(),old=life.capture();assert.ok(old());stop();const stopNew=life.mount();stop();assert.equal(old(),false);assert.ok(life.capture()());stopNew();assert.equal(life.capture()(),false);
});
test("payment order update keeps selected identity and latest version",()=>{
  assert.equal(mergePaymentOrder(order,{...order,number:"B"}),order);
  assert.equal(mergePaymentOrder(order,{...order,version:1}),order);
  assert.equal(mergePaymentOrder(null,order),null);
  const newer={...order,version:3};assert.equal(mergePaymentOrder(order,newer),newer);
});
for(const kind of ["refresh","pay"] as const) {
  test(`${kind}: late first response has no UI, receipt, follow-on read or redirect after scope leaves`,async()=>{
    const h=harness(kind), running=h.run();h.dispose();h.effects.length=0;h.hold.resolve(attempt);await running;
    assert.deepEqual(h.effects,[]);assert.equal(h.requests.length,1);assert.equal(h.requests[0].method,"POST");
  });
  test(`${kind}: late failure cannot show error or unlock a newer panel`,async()=>{
    const h=harness(kind), running=h.run();h.dispose();h.effects.length=0;h.hold.reject(Error("uncertain synthetic response"));await running;
    assert.deepEqual(h.effects,[]);assert.equal(h.requests.length,1);
  });
  test(`${kind}: duplicate clicks do not send another POST`,async()=>{
    const h=harness(kind),running=h.run();await h.run();assert.equal(h.requests.length,1);h.hold.resolve(attempt);await running;assert.equal(h.requests.filter(r=>r.method==="POST").length,1);h.dispose();
  });
}
test("refresh: delayed order read cannot overwrite the newly selected order",async()=>{
  const h=harness("refresh",1), running=h.run();await tick();assert.equal(h.requests.length,2);h.dispose();h.effects.length=0;h.hold.resolve(order);await running;assert.deepEqual(h.effects,[]);
});
test("refresh: active completion applies status and unlocks",async()=>{
  const h=harness("refresh"),running=h.run();h.hold.resolve(attempt);await running;assert.deepEqual(h.effects,["busy:true","error:","attempt","updated","busy:false"]);h.dispose();
});
test("pay: terminal result order read is fenced",async()=>{
  const h=harness("pay",1,"customer-A",{...attempt,status:"paid"}),running=h.run();await tick();assert.equal(h.requests.length,2);h.dispose();h.effects.length=0;h.hold.resolve(order);await running;assert.deepEqual(h.effects,[]);
});
test("pay: delayed account read cannot retain receipt or navigate after leaving",async()=>{
  const h=harness("pay",1),running=h.run();await tick();assert.equal(h.requests.at(-1)?.path,"/account");assert.ok(!h.effects.includes("attempt"));h.dispose();h.effects.length=0;h.hold.resolve({customer:{id:"customer-A"}});await running;assert.deepEqual(h.effects,[]);
});
test("pay: account changed without a render cannot receive old receipt",async()=>{
  const h=harness("pay",0,"customer-B"),running=h.run();h.hold.resolve(attempt);await running;
  assert.ok(h.effects.includes("error:errors.unauthorized"));assert.ok(!h.effects.includes("attempt"));assert.ok(!h.effects.includes("retained"));assert.ok(!h.effects.includes("redirect"));h.dispose();
});
test("pay: active successful attempt retains receipt and navigates once",async()=>{
  const h=harness("pay"),running=h.run();h.hold.resolve(attempt);await running;
  assert.deepEqual(h.effects,["busy:true","error:","attempt","retained","redirect","busy:false"]);assert.equal(h.requests.length,2);h.dispose();
});

for(const mismatch of [{provider:"other-provider"},{mode:"live"}]) {
  test(`pay: ${Object.keys(mismatch)[0]} mismatch has no attempt, account read, receipt or navigation`,async()=>{
    const h=harness("pay"),running=h.run();h.hold.resolve({...attempt,...mismatch});await running;
    assert.deepEqual(h.effects,["busy:true","error:","error:payment.checkoutUnavailable","busy:false"]);
    assert.equal(h.requests.length,1);h.dispose();
  });
}
