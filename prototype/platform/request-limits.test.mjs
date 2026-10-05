import test from 'node:test';
import assert from 'node:assert/strict';
import {trustedClientAddress,createRequestLimiter} from './request-limits.mjs';
const req=(ip,forwarded)=>({socket:{remoteAddress:ip},headers:forwarded===undefined?{}:{'x-forwarded-for':forwarded}});
test('forwarded headers have no effect without an explicitly trusted socket peer',()=>{
 const address=trustedClientAddress();
 assert.equal(address(req('198.51.100.1','203.0.113.9')),'198.51.100.1');
 assert.equal(address(req('127.0.0.1','spoofed')),'127.0.0.1');
 assert.equal(address(req('::ffff:127.0.0.1')),'127.0.0.1');
 assert.equal(address(req('2001:0db8:0:0::1')),'2001:db8::1');
});
test('trusted proxy chains stop at the first untrusted hop and ignore forged left values',()=>{
 const address=trustedClientAddress(['127.0.0.1/32','10.0.0.0/24','2001:db8:1::/64']);
 assert.equal(address(req('127.0.0.1','203.0.113.5')),'203.0.113.5');
 assert.equal(address(req('::ffff:127.0.0.1','spoof, 198.51.100.5, 10.0.0.2')),'198.51.100.5');
 assert.equal(address(req('127.0.0.1','203.0.113.5, 10.1.0.2')),'10.1.0.2');
 assert.equal(address(req('2001:db8:1::2','2001:db8:2::3')),'2001:db8:2::3');
 assert.equal(address(req('127.0.0.1')),'127.0.0.1');
});
test('bad proxy configuration and malformed trusted headers fail closed',()=>{
 for(const ranges of [true,'127.0.0.1',null,['0.0.0.0/0'],['::/0'],['localhost/32'],['127.0.0.1'],['127.0.0.1/33'],['::1/129'],['fe80::1%eth0/64'],Array(33).fill('127.0.0.1/32')])assert.throws(()=>trustedClientAddress(ranges));
 const address=trustedClientAddress(['127.0.0.1/32']);
 for(const header of ['', 'unknown','198.51.100.1:123','[::1]','fe80::1%eth0','198.51.100.1,',Array(17).fill('127.0.0.1').join(','),'a'.repeat(2049),['198.51.100.1']])assert.throws(()=>address(req('127.0.0.1',header)),{code:'invalid_forwarded_address'});
});
test('proxy clients have independent budgets while spoofing cannot reset a budget',()=>{
 let now=1000;const rate=createRequestLimiter({trustedProxyCidrs:['127.0.0.1/32'],limit:2,now:()=>now});
 rate(req('127.0.0.1','198.51.100.1'));rate(req('127.0.0.1','198.51.100.1'));
 assert.throws(()=>rate(req('127.0.0.1','203.0.113.9,198.51.100.1')),{status:429,code:'rate_limited',retryAfter:60});
 rate(req('127.0.0.1','198.51.100.2'));
 now+=60000;rate(req('127.0.0.1','198.51.100.1'));
 const direct=createRequestLimiter({limit:1});direct(req('198.51.100.8','203.0.113.1'));
 assert.throws(()=>direct(req('::ffff:198.51.100.8','203.0.113.2')),{status:429});
});
test('bounded high-cardinality budget recovers after expiry without a per-request sweep',()=>{
 let now=0;const rate=createRequestLimiter({maxKeys:10000,now:()=>now});
 for(let i=0;i<10000;i++)rate(req(`198.18.${i>>>8}.${i&255}`));
 assert.throws(()=>rate(req('198.19.0.1')),{status:429});
 rate(req('198.18.0.1'));
 now=60000;rate(req('198.19.0.1'));
});
