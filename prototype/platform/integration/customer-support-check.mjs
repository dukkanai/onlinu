import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createCoreOrderClient} from '../core-order-client.mjs';
const fixture=JSON.parse(process.env.CORE_CUSTOMER_SUPPORT_FIXTURE);
const client=createCoreOrderClient({issuer:'https://platform.example',privateKey:fixture.privateKey,restaurants:[{id:'restaurant-a',baseUrl:fixture.baseUrl}]});
const {actor,number}=fixture;
const before=await client.customerSupport('restaurant-a',actor,number);
assert.equal(before.cancellation,null);assert.ok(before.cancellationHistory.length>0);
await assert.rejects(client.customerSupport('restaurant-a',randomUUID(),number),{status:404,code:'invalid_order_access'});
const old=await client.customerSupportRecovery('restaurant-a',actor,number,'cancellation',fixture.oldKey);
assert.equal(old.recorded,true);assert.equal(old.order.cancellation,null);
const key=randomUUID(),input={version:before.version,reviewed:true,reason:'Synthetic customer-owned complaint'};
assert.equal((await client.customerSupportRecovery('restaurant-a',actor,number,'complaint',key)).recorded,false);
const receipt=await client.customerSupportCommand('restaurant-a',actor,number,'complaint',key,input);
assert.equal(receipt.recorded,true);assert.equal(receipt.order.version,before.version+1);
assert.equal(receipt.order.complaints.find(c=>c.id===key).reason,input.reason);
await assert.rejects(client.customerSupportCommand('restaurant-a',actor,number,'complaint',randomUUID(),input),{status:409,code:'conflict'});
assert.equal(receipt.order.phone,undefined);assert.equal(receipt.order.trackingToken,undefined);
const repeat=await client.customerSupportCommand('restaurant-a',actor,number,'complaint',key,input);
assert.equal(repeat.order.version,receipt.order.version);
await assert.rejects(client.customerSupportCommand('restaurant-a',actor,number,'complaint',key,{...input,reason:'Different'}),{status:409,code:'conflict'});
assert.equal((await client.customerSupportRecovery('restaurant-a',actor,number,'complaint',key)).recorded,true);
console.log('Verified actual Node/original Go customer ownership, reviewed complaint, stable-key retry, conflict and archived cancellation recovery. No receipt capability or payout authority.');

if(process.env.IDENTITY_TEST_DATABASE_URL){const {checkCustomerSupportUI}=await import('./customer-support-ui-check.mjs');await checkCustomerSupportUI(fixture);}
