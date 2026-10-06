import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {checkSupportUI} from './support-ui-check.mjs';
import {createCoreOrderClient} from '../core-order-client.mjs';
const fixture=JSON.parse(process.env.CORE_SUPPORT_FIXTURE),actor=randomUUID();
const client=createCoreOrderClient({issuer:'https://platform.example',privateKey:fixture.privateKey,restaurants:[{id:'restaurant-a',baseUrl:fixture.baseUrl}]});
const queue=await client.support('restaurant-a',actor);assert.equal(queue.orders.length,1);assert.equal(queue.orders[0].number,fixture.number);assert.equal(queue.orders[0].cancellationPending,true);assert.equal(queue.orders[0].openComplaints,2);assert.equal(queue.orders[0].reason,undefined);
const before=await client.supportDetail('restaurant-a',actor,fixture.number);assert.equal(before.phone,undefined);assert.equal(before.trackingToken,undefined);
await assert.rejects(client.supportCommand('restaurant-a',actor,fixture.number,before.cancellation.id,'decide',{version:before.version-1,reviewed:true,approve:true,reason:'Synthetic approval'}),{code:'conflict'});
if(process.env.IDENTITY_TEST_DATABASE_URL){await checkSupportUI(fixture);}else{
const cancelled=await client.supportCommand('restaurant-a',actor,fixture.number,before.cancellation.id,'decide',{version:before.version,reviewed:true,approve:true,reason:'Synthetic approved cancellation'});assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.paymentStatus,'review'); // Original paid-card cancellation awaits separate refund review.
let current=cancelled;for(const complaint of cancelled.complaints){current=await client.supportCommand('restaurant-a',actor,fixture.number,complaint.id,'resolve',{version:current.version,reviewed:true,reason:'Synthetic complaint resolution'});}assert.ok(current.complaints.every(c=>c.status==='resolved'));assert.equal(current.totalMinor,before.totalMinor);
}
assert.equal((await client.support('restaurant-a',actor)).orders.length,0);
console.log('Verified actual Node-signed support queue, stale decision denial, reviewed cancellation and complaint resolution; original fake captured funds remain unrefunded.');
