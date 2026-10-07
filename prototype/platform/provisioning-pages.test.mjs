import test from 'node:test';
import assert from 'node:assert/strict';
import { provisioningQuery, provisioningQueuePage } from './provisioning-pages.mjs';
test('operator read filters reject duplicates unknown fields bad limits and paths',()=>{
  assert.deepEqual(provisioningQuery(new URLSearchParams('state=unknown&tenantId=demo-a&limit=25')),{state:'unknown',tenantId:'demo-a',limit:25});
  assert.deepEqual(provisioningQuery(new URLSearchParams('state=&tenantId=')),{});
  for(const raw of ['state=queued&state=unknown','command=apply','limit=0','limit=101','limit=01','limit=1.5','tenantId=../other','after=','state=running'])assert.throws(()=>provisioningQuery(new URLSearchParams(raw)),{code:'invalid_request'});
});
test('queue page escapes data and has no mutation action or implicit expiry',()=>{
  const html=provisioningQueuePage({jobs:[{tenantId:'<script>bad</script>',state:'claimed',leaseExpired:true,id:'id',version:2,createdAt:'time',updatedAt:'time',planDigest:'<img>',evidenceDigest:null}],nextCursor:'12345678-1234-4234-8234-123456789abc'},{state:'claimed',limit:1});
  assert.ok(html.includes('&lt;script&gt;bad&lt;/script&gt;'));assert.ok(!html.includes('<script>'));
  assert.match(html,/انتهت مهلة العامل/);assert.match(html,/لا يعني نشر المطعم/);assert.match(html,/method="get"/);
  assert.ok(!/method="post"|onclick=|<script|password|accessToken/.test(html));
  assert.ok(html.includes('state=claimed&amp;limit=1&amp;after='));
  assert.match(provisioningQueuePage({jobs:[],nextCursor:null},{}),/لا توجد طلبات مطابقة/);
});
