import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createIdentityDirectory } from './identity-directory.mjs';
import { createCoreCheckouts } from './core-checkouts.mjs';

test('owned core handoffs are durable, private and idempotent across ambiguous outcomes', { skip: !process.env.IDENTITY_TEST_DATABASE_URL }, async t => {
  const url = new URL(process.env.IDENTITY_TEST_DATABASE_URL); assert.equal(url.pathname,'/astracalls_identity_test');
  assert.equal(url.searchParams.has('dbname'),false);
  const schema = `checkout_test_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({connectionString:url.href}); await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({connectionString:url.href,options:`-c search_path=${schema}`,max:10});
  t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  const directory = createIdentityDirectory({pool,trustedIssuers:['https://identity.example/']});await directory.init();
  const make = async subject=>({...await directory.verifiedIdentity({issuer:'https://identity.example/',subject}),role:'customer',scopes:['orders:read','orders:write']});
  const alice=await make('alice'),bob=await make('bob');
  await pool.query('UPDATE platform_identities SET platform_admin=TRUE WHERE id=$1',[alice.id]);
  await directory.createTenant(alice.id,{id:'a',name:'A',ownerId:alice.id});
  await directory.setTenantStatus(alice.id,'a',{status:'active',expectedVersion:1});
  const orders=new Map();let creates=0,loseReply=false,failBeforeCreate=false;
  const quote={tenantId:'a',currency:'SAR',totalMinor:2500};
  const core={async preview(){return quote;},async quote(){return quote;}};
  const notFound=()=>Object.assign(Error('not found'),{status:404,code:'invalid_order_access'});
  const client={
    async create(tenant,subject,input,key){
      creates++;
      if(failBeforeCreate)throw Object.assign(Error('network'),{status:503,code:'order_outcome_unknown'});
      if(!orders.has(key))orders.set(key,{owner:subject,number:`R${String(orders.size+1).padStart(8,'0')}`,version:1,status:'new',paymentStatus:'unpaid',totalMinor:2500,currency:'SAR',mode:'pickup',updatedAt:new Date().toISOString()});
      if(loseReply)throw Object.assign(Error('lost reply'),{status:503,code:'order_outcome_unknown'});
      const {owner,...order}=orders.get(key);assert.equal(owner,subject);return{tenantId:tenant,...order};
    },
    async recover(tenant,subject,key){const row=orders.get(key);if(!row||row.owner!==subject)throw notFound();const{owner,...order}=row;return{tenantId:tenant,...order};},
    async status(tenant,subject,number){const row=[...orders.values()].find(row=>row.number===number&&row.owner===subject);if(!row)throw notFound();const{owner,...order}=row;return{tenantId:tenant,...order};},
  };
  const store=createCoreCheckouts({pool,baseUrl:'https://platform.example',core,orderClient:client,
    resolvePrincipal:directory.resolve,isTenantActive:async id=>(await directory.published([id])).length===1});await store.init();
  const prepare=key=>({tenantId:'a',mode:'pickup',items:[{itemId:'rice',quantity:1,optionIds:['extra']}],expectedTotalMinor:2500,idempotencyKey:key});
  const contact={customerName:'Synthetic',phone:'+966501234567',paymentMethod:'card',paymentProvider:'sandbox'};

  await t.test('prepare creates no order, concurrent duplicate returns one owned link',async()=>{
    const key=randomUUID(),input=prepare(key);
    const results=await Promise.all(Array.from({length:8},()=>store.prepare(alice,input)));
    assert.equal(new Set(results.map(row=>row.checkoutId)).size,1);assert.equal(creates,0);
    await assert.rejects(store.prepare(alice,{...input,expectedTotalMinor:1}),{code:'idempotency_conflict'});
    await assert.rejects(store.prepare(alice,{...prepare(randomUUID()),phone:'not-for-model'}),{code:'invalid_request'});
    await assert.rejects(store.get(bob,results[0].checkoutId),{code:'not_found'});
    assert.equal(JSON.stringify((await store.get(alice,results[0].checkoutId)).cart).includes('Synthetic'),false);
  });
  await t.test('explicit confirmation dispatches original core exactly once logically',async()=>{
    const checkout=await store.prepare(alice,prepare(randomUUID()));
    await assert.rejects(store.confirm(bob,checkout.checkoutId,contact),{code:'not_found'});
    await assert.rejects(store.confirm(alice,checkout.checkoutId,{...contact,items:[]}),{code:'invalid_request'});
    const before=orders.size;
    const results=await Promise.all([store.confirm(alice,checkout.checkoutId,contact),store.confirm(alice,checkout.checkoutId,contact)]);
    assert.equal(results[0].number,results[1].number);assert.equal(orders.size,before+1);
    const row=(await pool.query('SELECT * FROM platform_core_checkouts WHERE id=$1',[checkout.checkoutId])).rows[0];
    assert.equal(row.state,'confirmed');assert.equal(JSON.stringify(row).includes(contact.phone),false);
    await assert.rejects(store.status(bob,'a',results[0].number),{code:'not_found'});
  });
  await t.test('expired pending handoff cannot submit',async()=>{
    const checkout=await store.prepare(alice,prepare(randomUUID()));
    await pool.query("UPDATE platform_core_checkouts SET expires_at=now()-interval '1 minute' WHERE id=$1",[checkout.checkoutId]);
    const before=creates;
    await assert.rejects(store.confirm(alice,checkout.checkoutId,contact),{code:'checkout_expired'});
    assert.equal(creates,before);
  });
  await t.test('lost reply recovers same order after expiry without resubmission',async()=>{
    const checkout=await store.prepare(alice,prepare(randomUUID()));loseReply=true;
    await assert.rejects(store.confirm(alice,checkout.checkoutId,contact),{code:'order_outcome_unknown'});loseReply=false;
    const before=creates;
    await pool.query("UPDATE platform_core_checkouts SET expires_at=now()-interval '1 minute' WHERE id=$1",[checkout.checkoutId]);
    const recovered=await store.confirm(alice,checkout.checkoutId,{});
    assert.equal(creates,before);assert.equal(recovered.number,orders.get(checkout.checkoutId).number);
  });
  await t.test('unknown attempt freezes payload; a changed retry cannot create another order',async()=>{
    const checkout=await store.prepare(alice,prepare(randomUUID()));failBeforeCreate=true;
    await assert.rejects(store.confirm(alice,checkout.checkoutId,contact),{code:'order_outcome_unknown'});failBeforeCreate=false;
    const before=creates;
    await assert.rejects(store.confirm(alice,checkout.checkoutId,{...contact,customerName:'different'}),{code:'confirmation_conflict'});
    assert.equal(creates,before);
    await store.confirm(alice,checkout.checkoutId,contact);assert.equal(creates,before+1);
  });
  await t.test('failed final DB save leaves a recoverable accepted core order',async()=>{
    const checkout=await store.prepare(alice,prepare(randomUUID()));
    await pool.query(`CREATE FUNCTION reject_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.state='confirmed' THEN RAISE EXCEPTION 'synthetic write failure'; END IF;RETURN NEW;END $$;
      CREATE TRIGGER reject_confirmation BEFORE UPDATE ON platform_core_checkouts FOR EACH ROW EXECUTE FUNCTION reject_confirmation()`);
    await assert.rejects(store.confirm(alice,checkout.checkoutId,contact));const before=creates;
    await pool.query('DROP TRIGGER reject_confirmation ON platform_core_checkouts');
    await store.confirm(alice,checkout.checkoutId,contact);assert.equal(creates,before);
  });
  await t.test('suspension prevents new submission while accepted orders remain recoverable',async()=>{
    const pending=await store.prepare(alice,prepare(randomUUID()));
    await directory.setTenantStatus(alice.id,'a',{status:'suspended',expectedVersion:2});
    await assert.rejects(store.confirm(alice,pending.checkoutId,contact),{code:'tenant_unavailable'});
    await assert.rejects(store.prepare(alice,prepare(randomUUID())),{code:'tenant_unavailable'});
    await directory.setTenantStatus(alice.id,'a',{status:'active',expectedVersion:3});
  });
  await t.test('disabled principal cannot read or confirm using a retained grant',async()=>{
    const pending=await store.prepare(alice,prepare(randomUUID()));
    await pool.query('UPDATE platform_identities SET enabled=FALSE WHERE id=$1',[alice.id]);
    await assert.rejects(store.get(alice,pending.checkoutId),{code:'identity_disabled'});
    await assert.rejects(store.confirm(alice,pending.checkoutId,contact),{code:'identity_disabled'});
  });
});
