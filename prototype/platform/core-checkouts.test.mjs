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
  const quote={tenantId:'a',currency:'SAR',totalMinor:2500,subtotalMinor:2500,deliveryFeeMinor:0,demo:false,paymentMethods:['card'],
    tax:{enabled:false,rateBps:0,number:'',netMinor:2500,taxMinor:0,grossMinor:2500},
    items:[{itemId:'rice',name:'Rice',quantity:1,unitPriceMinor:2500,totalMinor:2500,options:[{id:'extra',name:'Extra',priceMinor:0,available:true}]}]};
  let currentQuote=quote;
  const core={async preview(){return currentQuote;},async quote(){return currentQuote;}};
  const notFound=()=>Object.assign(Error('not found'),{status:404,code:'invalid_order_access'});
  const client={
    async create(tenant,subject,input,key){
      assert.match(input.expectedQuoteHash,/^[0-9a-f]{64}$/,'Every real checkout dispatch binds the reviewed quote');
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
  await t.test('same-total changes to reviewed details require a new quote before dispatch',async()=>{
    const checkout=await store.prepare(alice,prepare(randomUUID()));const before=creates;
    currentQuote={...quote,items:[{...quote.items[0],name:'Changed item title'}]};
    try{await assert.rejects(store.confirm(alice,checkout.checkoutId,contact),{code:'quote_changed'});assert.equal(creates,before);}
    finally{currentQuote=quote;}
  });
  await t.test('lost reply recovers same order after expiry without resubmission',async()=>{
    const checkout=await store.prepare(alice,prepare(randomUUID()));loseReply=true;
    await assert.rejects(store.confirm(alice,checkout.checkoutId,contact),{code:'order_outcome_unknown'});loseReply=false;
    const before=creates;
    await pool.query("UPDATE platform_core_checkouts SET expires_at=now()-interval '1 minute' WHERE id=$1",[checkout.checkoutId]);
    const recovered=await store.confirm(alice,checkout.checkoutId,{});
    assert.equal(creates,before);assert.equal(recovered.number,orders.get(checkout.checkoutId).number);
  });
  await t.test('expired unresolved dispatch may recover but cannot start a new order',async()=>{
    const checkout=await store.prepare(alice,prepare(randomUUID()));failBeforeCreate=true;
    await assert.rejects(store.confirm(alice,checkout.checkoutId,contact),{code:'order_outcome_unknown'});failBeforeCreate=false;
    await pool.query("UPDATE platform_core_checkouts SET expires_at=now()-interval '1 minute' WHERE id=$1",[checkout.checkoutId]);
    const before=creates;
    await assert.rejects(store.confirm(alice,checkout.checkoutId,contact),{code:'checkout_expired'});
    assert.equal(creates,before);assert.equal(orders.has(checkout.checkoutId),false);
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
  await t.test('support claims are private, owner-bound and never replay an uncertain write',async()=>{
    const checkout=await store.prepare(alice,prepare(randomUUID()));await store.confirm(alice,checkout.checkoutId,contact);
    const row=orders.get(checkout.checkoutId),receipts=new Map();let writes=0,lose=false,failBefore=false,knownReject=false;
    const detail=()=>({...row,demo:false,cancellation:null,complaints:[],cancellationHistory:[],historyLimit:20,historyTruncated:false});
    client.customerSupport=async(tenant,subject,number)=>{assert.equal(subject,alice.id);assert.equal(number,row.number);return detail();};
    client.customerSupportRecovery=async(tenant,subject,number,kind,key)=>{assert.equal(subject,alice.id);assert.equal(number,row.number);return{order:detail(),kind,requestId:key,recorded:receipts.has(key)};};
    client.customerSupportCommand=async(tenant,subject,number,kind,key,input)=>{
      assert.equal(subject,alice.id);assert.equal(number,row.number);writes++;
      if(knownReject)throw Object.assign(Error('stale'),{status:409,code:'conflict'});
      if(failBefore)throw Object.assign(Error('unknown'),{status:503,code:'order_outcome_unknown'});
      row.version++;receipts.set(key,true);
      if(lose)throw Object.assign(Error('lost'),{status:503,code:'order_outcome_unknown'});
      return{order:detail(),kind,requestId:key,recorded:true};
    };
    const value={requestId:randomUUID(),kind:'complaint',version:row.version,reviewed:true,reason:'Synthetic private support text'};
    await assert.rejects(store.submitSupport(bob,checkout.checkoutId,value),{code:'not_found'});
    await assert.rejects(store.support(bob,checkout.checkoutId),{code:'not_found'});
    await assert.rejects(store.submitSupport({...alice,scopes:['orders:read']},checkout.checkoutId,value),{code:'insufficient_scope'});
    await assert.rejects(store.submitSupport(alice,checkout.checkoutId,{...value,reviewed:false}),{code:'invalid_request'});
    assert.equal(writes,0);
    lose=true;await assert.rejects(store.submitSupport(alice,checkout.checkoutId,value),{code:'order_outcome_unknown'});lose=false;
    const pending=(await pool.query('SELECT * FROM platform_core_support_intents WHERE checkout_id=$1',[checkout.checkoutId])).rows[0];
    assert.equal(pending.state,'dispatching');assert.equal(JSON.stringify(pending).includes(value.reason),false);
    await assert.rejects(store.submitSupport(alice,checkout.checkoutId,{...value,reason:'different'}),{code:'confirmation_conflict'});
    const results=await Promise.all(Array.from({length:5},()=>store.submitSupport(alice,checkout.checkoutId,value)));
    assert.ok(results.every(result=>result.recorded));assert.equal(writes,1);
    assert.equal((await store.support(alice,checkout.checkoutId)).pending,null);
    const rejected={...value,requestId:randomUUID(),version:row.version};knownReject=true;
    await assert.rejects(store.submitSupport(alice,checkout.checkoutId,rejected),{code:'conflict'});knownReject=false;
    await assert.rejects(store.submitSupport(alice,checkout.checkoutId,rejected),{code:'support_request_rejected'});
    const ambiguous={...value,requestId:randomUUID(),version:row.version};failBefore=true;
    await assert.rejects(store.submitSupport(alice,checkout.checkoutId,ambiguous),{code:'order_outcome_unknown'});failBefore=false;
    const count=writes;
    await assert.rejects(store.submitSupport(alice,checkout.checkoutId,ambiguous),{code:'order_outcome_unknown'});
    await assert.rejects(store.submitSupport(alice,checkout.checkoutId,{...ambiguous,requestId:randomUUID()}),{code:'support_request_pending'});
    assert.equal(writes,count);assert.deepEqual((await store.support(alice,checkout.checkoutId)).pending,{requestId:ambiguous.requestId,kind:'complaint'});
    // Original service can finish after the response timed out; later reads settle
    // the same durable key without a second submission or saved private reason.
    receipts.set(ambiguous.requestId,true);assert.equal((await store.support(alice,checkout.checkoutId)).pending,null);
    const concurrent={...value,requestId:randomUUID(),version:row.version};
    const beforeConcurrent=writes;
    await Promise.allSettled(Array.from({length:8},()=>store.submitSupport(alice,checkout.checkoutId,concurrent)));
    assert.equal(writes,beforeConcurrent+1);assert.equal((await store.support(alice,checkout.checkoutId)).pending,null);
    const databaseFailure={...value,requestId:randomUUID(),version:row.version};
    await pool.query(`CREATE FUNCTION reject_support_recorded() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.state='recorded' THEN RAISE EXCEPTION 'synthetic persistence failure'; END IF;RETURN NEW;END $$;
      CREATE TRIGGER reject_support_recorded BEFORE UPDATE ON platform_core_support_intents FOR EACH ROW EXECUTE FUNCTION reject_support_recorded()`);
    await assert.rejects(store.submitSupport(alice,checkout.checkoutId,databaseFailure));const afterFailedSave=writes;
    await pool.query('DROP TRIGGER reject_support_recorded ON platform_core_support_intents');
    assert.equal((await store.submitSupport(alice,checkout.checkoutId,databaseFailure)).recorded,true);assert.equal(writes,afterFailedSave);
    await pool.query(`CREATE FUNCTION reject_support_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'synthetic claim failure'; END $$;
      CREATE TRIGGER reject_support_claim BEFORE INSERT ON platform_core_support_intents FOR EACH ROW EXECUTE FUNCTION reject_support_claim()`);
    await assert.rejects(store.submitSupport(alice,checkout.checkoutId,{...value,requestId:randomUUID(),version:row.version}));assert.equal(writes,afterFailedSave);
    await pool.query('DROP TRIGGER reject_support_claim ON platform_core_support_intents');
    await pool.query("UPDATE platform_core_checkouts SET expires_at=now()-interval '1 day' WHERE id=$1",[checkout.checkoutId]);
    assert.equal((await store.support(alice,checkout.checkoutId)).order.number,row.number);
  });
  await t.test('disabled principal cannot read or confirm using a retained grant',async()=>{
    const pending=await store.prepare(alice,prepare(randomUUID()));
    await pool.query('UPDATE platform_identities SET enabled=FALSE WHERE id=$1',[alice.id]);
    await assert.rejects(store.get(alice,pending.checkoutId),{code:'identity_disabled'});
    await assert.rejects(store.confirm(alice,pending.checkoutId,contact),{code:'identity_disabled'});
  });
});
