import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import pg from 'pg';
import { createControlPlane } from '../control-plane.mjs';
import { MCP_PROTOCOL_VERSION } from '../mcp.mjs';
import { Webhook } from 'standardwebhooks';

const fixture=JSON.parse(process.env.CORE_ORDER_FIXTURE);
const database=new URL(process.env.IDENTITY_TEST_DATABASE_URL);
assert.equal(database.pathname,'/astracalls_identity_test');assert.equal(database.searchParams.has('dbname'),false);
const schema=`core_flow_${randomBytes(8).toString('hex')}`;
const admin=new pg.Pool({connectionString:database.href});await admin.query(`CREATE SCHEMA ${schema}`);
const pool=new pg.Pool({connectionString:database.href,options:`-c search_path=${schema}`});
const baseUrl='https://platform.example',issuer='https://identity.example/';
let server;
try {
  const callbackBodies=[];
  const webhookSecret=`whsec_${randomBytes(32).toString('base64')}`;
  const app=await createControlPlane({pool,baseUrl,csrfKey:randomBytes(32).toString('base64'),serviceSigningKey:fixture.privateKey,
    eventsEncryptionKey:randomBytes(32).toString('base64'),
    oidc:{issuer,clientId:'integration-test',clientSecret:'synthetic-client-secret-only'},
    restaurants:[{id:'restaurant-a',name:'Actual Go fixture',cuisine:'saudi',baseUrl:fixture.baseUrl}],
  },{oidcClientAdapter:{async authorizationUrl(){return `${issuer}authorize`;},async exchange(){throw Error('unused');}},
    webhookFetch:async(url,options)=>{
      assert.equal(url,'https://receiver.example/events');
      const value=JSON.parse(options.body);
      if(value.type==='verification')return new Response(JSON.stringify({challenge:value.challenge}),{headers:{'content-type':'application/json'}});
      new Webhook(webhookSecret).verify(options.body,options.headers);callbackBodies.push(value);
      return new Response('{}',{headers:{'content-type':'application/json'}});
    },
  });
  const make=async subject=>{
    const {id}=await app.directory.verifiedIdentity({issuer,subject});
    const browser=await app.auth.issue(id,undefined,{kind:'browser'}),oauth=await app.auth.issue(id,['orders:read','orders:write','events:read']);
    return{id,cookie:`__Host-platform_session=${browser.accessToken}`,token:oauth.accessToken};
  };
  const alice=await make('alice'),bob=await make('bob');
  await pool.query('UPDATE platform_identities SET platform_admin=TRUE WHERE id=$1',[alice.id]);
  await app.directory.createTenant(alice.id,{id:'restaurant-a',name:'Actual Go fixture',ownerId:alice.id});
  await app.directory.setTenantStatus(alice.id,'restaurant-a',{status:'active',expectedVersion:1});
  server=createServer(app.handle);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const local=`http://127.0.0.1:${server.address().port}`;
  const send=(path,{method='GET',body,cookie,token,headers={}}={})=>new Promise((resolve,reject)=>{
    const request=httpRequest(local+path,{method,headers:{host:'platform.example',accept:'application/json',
      ...(cookie?{cookie}:{}),...(token?{authorization:`Bearer ${token}`} : {}),
      ...(body?{'content-type':'application/json'}:{}),...headers}},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{
        const text=Buffer.concat(chunks).toString('utf8');let data;try{data=JSON.parse(text);}catch{data=text;}
        resolve({status:response.statusCode,data,headers:response.headers});
      });
    });request.on('error',reject);request.end(body?JSON.stringify(body):undefined);
  });
  const rpc=async(name,args,who)=>{
    const response=await send('/mcp',{method:'POST',token:who?.token,headers:{'MCP-Protocol-Version':MCP_PROTOCOL_VERSION,'Mcp-Method':'tools/call','Mcp-Name':name},
      body:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args,_meta:{
        'io.modelcontextprotocol/protocolVersion':MCP_PROTOCOL_VERSION,
        'io.modelcontextprotocol/clientInfo':{name:'core-checkout-test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{},
      }}}});assert.equal(response.status,200);return response.data.result;
  };
  const cart={tenantId:'restaurant-a',mode:'delivery',items:fixture.input.items,address:{country:'SA'}};
  const preview=await rpc('quote_cart',cart);assert.equal(preview.structuredContent.totalMinor,3500);
  const handoff={...cart,expectedTotalMinor:3500,idempotencyKey:'owned-checkout-test'};
  assert.equal((await rpc('prepare_checkout',handoff)).isError,true);
  const prepared=await rpc('prepare_checkout',handoff,alice);assert.equal(prepared.isError,undefined,JSON.stringify(prepared));
  const checkout=prepared.structuredContent;assert.equal(new URL(checkout.checkoutUrl).origin,baseUrl);
  assert.deepEqual((await rpc('prepare_checkout',handoff,alice)).structuredContent,checkout);
  const path='/checkout/'+checkout.checkoutId;
  assert.equal((await send(path,{cookie:bob.cookie})).status,404);
  const page=await send(path,{cookie:alice.cookie});assert.equal(page.status,200);assert.match(page.data,/35\.00/);
  const csrf=/name="csrf" value="([A-Za-z0-9_-]+)"/.exec(page.data)?.[1];assert.ok(csrf);
  const contact={customerName:'Synthetic',phone:'+966501234567',paymentMethod:'cash_on_delivery',address:{country:'SA',nationalAddress:'ABCD1234'}};
  const confirm=async(who,extra={})=>send(path+'/confirm',{method:'POST',cookie:who.cookie,headers:{origin:baseUrl},body:{...contact,csrf,...extra}});
  assert.equal((await confirm(alice,{csrf:'bad'})).status,403);
  const confirmed=await confirm(alice);assert.equal(confirmed.status,200,JSON.stringify(confirmed));
  const order=confirmed.data.order;assert.equal(order.totalMinor,3500);assert.equal(order.paymentStatus,'unpaid');
  assert.deepEqual((await confirm(alice)).data.order,order);
  assert.equal((await confirm(bob)).status,403,'CSRF token is bound to Alice browser');
  const tracked=await rpc('get_order_status',{tenantId:'restaurant-a',orderId:order.number},alice);
  assert.deepEqual(tracked.structuredContent,order);
  assert.equal((await rpc('get_order_status',{tenantId:'restaurant-a',orderId:order.number},bob)).isError,true);
  for(const field of ['customerName','phone','address','accessCode','trackingToken'])assert.equal(order[field],undefined);
  const state=(await pool.query('SELECT state FROM platform_core_checkouts WHERE id=$1',[checkout.checkoutId])).rows[0];assert.equal(state.state,'confirmed');
  const subscription={name:'order.status_changed',arguments:{tenantId:'restaurant-a',orderId:order.number},delivery:{mode:'webhook',url:'https://receiver.example/events',secret:webhookSecret}};
  const eventResponse=await send('/mcp',{method:'POST',token:alice.token,
    headers:{'MCP-Protocol-Version':MCP_PROTOCOL_VERSION,'Mcp-Method':'events/subscribe','Mcp-Name':subscription.name},
    body:{jsonrpc:'2.0',id:2,method:'events/subscribe',params:{...subscription,_meta:{
      'io.modelcontextprotocol/protocolVersion':MCP_PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientInfo':{name:'core-checkout-test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{},
    }}}});
  assert.equal(eventResponse.status,200);assert.equal(eventResponse.data.error,undefined,JSON.stringify(eventResponse.data));
  assert.ok(Date.parse(eventResponse.data.result.refreshBefore)<=Date.now()+1800_000,'Event lifetime cannot outlast the active grant');
  await app.eventWorker.ingest(alice.id,'restaurant-a');
  assert.equal((await app.events.dispatchOnce()).attempted,0,'No pre-subscription history replay');
  // Existing native management API is used only with the Go fixture's synthetic
  // admin key. The real control plane never receives a restaurant master key.
  const advanced=await fetch(`${fixture.baseUrl}/api/restaurant/orders/${order.number}`,{method:'PATCH',headers:{'content-type':'application/json','X-API-Key':'restaurant-test-master'},body:JSON.stringify({status:'accepted',version:order.version})});
  assert.equal(advanced.status,200);
  await pool.query(`CREATE FUNCTION reject_core_cursor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic cursor failure';END $$;
    CREATE TRIGGER reject_core_cursor BEFORE UPDATE ON platform_core_event_cursors FOR EACH ROW EXECUTE FUNCTION reject_core_cursor()`);
  await assert.rejects(app.eventWorker.ingest(alice.id,'restaurant-a'));
  await pool.query('DROP TRIGGER reject_core_cursor ON platform_core_event_cursors');
  await app.eventWorker.ingest(alice.id,'restaurant-a');
  assert.equal((await app.events.dispatchOnce()).delivered,1);assert.equal(callbackBodies.length,1);
  assert.equal(callbackBodies[0].data.orderId,order.number);assert.equal(callbackBodies[0].data.status,'accepted');
  assert.equal(JSON.stringify(callbackBodies[0]).includes(contact.phone),false);
  await app.eventWorker.ingest(alice.id,'restaurant-a');assert.equal((await app.events.dispatchOnce()).attempted,0);
  await app.eventWorker.tick();
  assert.equal(app.eventWorker.health.consecutiveFailures,0);
  assert.ok(app.eventWorker.health.lastSuccessAt,'Scheduled worker query and dispatch complete');
  assert.equal(callbackBodies.length,1,'Scheduled replay remains deduplicated');
  const card=await rpc('prepare_checkout',{...cart,mode:'pickup',expectedTotalMinor:3000,idempotencyKey:'browser-card-checkout'},alice);
  assert.equal(card.isError,undefined);
  const cardPath='/checkout/'+card.structuredContent.checkoutId;
  const cardPage=await send(cardPath,{cookie:alice.cookie});
  assert.match(cardPage.data,/<option value="stripe">/);
  const cardConfirm=await send(cardPath+'/confirm',{method:'POST',cookie:alice.cookie,headers:{origin:baseUrl},
    body:{...contact,paymentMethod:'card',paymentProvider:'stripe',csrf}});
  assert.equal(cardConfirm.status,200);assert.equal(cardConfirm.data.order.paymentStatus,'unpaid');
  const pay=(cookie,token=csrf)=>send(cardPath+'/payment',{method:'POST',cookie,headers:{origin:baseUrl},body:{csrf:token}});
  assert.equal((await pay(alice.cookie,'bad')).status,403);
  assert.equal((await pay(bob.cookie)).status,403);
  const payment=await pay(alice.cookie);assert.equal(payment.status,303);
  assert.match(payment.headers.location,/^https:\/\/checkout\.stripe\.com\//);
  assert.equal((await pay(alice.cookie)).headers.location,payment.headers.location);
  const refresh=await send(cardPath+'/refresh-payment',{method:'POST',cookie:alice.cookie,headers:{origin:baseUrl},body:{csrf}});
  assert.equal(refresh.status,303);assert.equal(refresh.headers.location,cardPath);
  assert.match((await send(cardPath,{cookie:alice.cookie})).data,/حالة الدفع: paid/);
  await app.auth.revoke(alice.token);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM event_subscriptions WHERE active')).rows[0].n,0);
  console.log('Verified transactional original-core events, owner-only ingestion, signed callback, crash-safe cursor deduplication and OAuth revocation; callback transport mocked');
  console.log('Verified MCP preview -> owned handoff -> CSRF-protected browser confirmation -> signed original Go order -> private MCP status; duplicate confirmation stays one order');
} finally {
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
}
