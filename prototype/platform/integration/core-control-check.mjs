import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import pg from 'pg';
import { createControlPlane } from '../control-plane.mjs';
import { MCP_PROTOCOL_VERSION } from '../mcp.mjs';
import { Webhook } from 'standardwebhooks';
import { pkceChallenge } from '../auth.mjs';

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
    redirectAllowlist:['https://client.example/callback'],
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
  const staffPath='/api/restaurants/restaurant-a/staff/orders';
  assert.equal((await send(staffPath,{token:alice.token})).status,403,'Customer OAuth cannot use staff APIs');
  assert.equal((await send(staffPath,{cookie:bob.cookie})).status,403);
  const listed=await send(staffPath,{cookie:alice.cookie});assert.equal(listed.status,200);
  assert.ok(listed.data.orders.some(row=>row.number===order.number));
  assert.equal(JSON.stringify(listed.data).includes(contact.phone),false);
  await app.directory.setMembership(alice.id,'restaurant-a',bob.id,{role:'kitchen',enabled:true,expectedVersion:null});
  const kitchenPage=await send('/manage/restaurant-a/orders',{cookie:bob.cookie});
  assert.equal(kitchenPage.status,200);assert.match(kitchenPage.data,/تحديث الحالة/);assert.doesNotMatch(kitchenPage.data,/تأكيد استلام المبلغ النقدي/);
  const kitchenDetail=await send(staffPath+'/'+order.number,{cookie:bob.cookie});
  assert.equal(kitchenDetail.status,200);assert.equal(kitchenDetail.data.items[0].name,'Rice');
  assert.equal(kitchenDetail.data.items[0].quantity,2);assert.equal(kitchenDetail.data.items[0].options.length,2);
  for(const field of ['customerName','phone','address','trackingToken','accessCode'])assert.equal(kitchenDetail.data[field],undefined);
  assert.equal((await send(staffPath+'/'+order.number,{token:alice.token})).status,403);
  assert.match((await send('/manage/restaurant-a/orders/'+order.number,{cookie:bob.cookie})).data,/الأصناف/);
  assert.equal((await send('/manage/restaurant-b/orders',{cookie:bob.cookie})).status,403);
  const loginPage=await send('/manage');assert.equal(loginPage.status,302);assert.equal(loginPage.headers.location,'/auth/login?returnTo=%2Fmanage');
  assert.equal((await send(loginPage.headers.location)).status,302,'OIDC accepts the bounded management return path');
  const bobMe=await send('/api/me',{cookie:bob.cookie});
  const channelsPath='/api/restaurants/restaurant-a/staff/channels';
  assert.equal((await send(channelsPath,{cookie:bob.cookie})).status,403,'Kitchen cannot configure channels');
  assert.equal((await send(channelsPath,{token:alice.token})).status,403,'Customer OAuth cannot configure channels');
  const staffPost=(who,path,body)=>send(staffPath+path,{method:'POST',cookie:who.cookie,headers:{origin:baseUrl,'x-csrf-token':who.id===alice.id?csrf:bobMe.data.csrfToken},body});
  assert.equal((await staffPost(bob,`/${order.number}/cash`,{version:order.version})).status,403);
  const advanced=await staffPost(bob,`/${order.number}/status`,{status:'accepted',version:order.version});
  assert.equal(advanced.status,200,JSON.stringify(advanced));
  assert.equal((await staffPost(bob,`/${order.number}/status`,{status:'preparing',version:order.version})).status,409);
  await app.directory.setMembership(alice.id,'restaurant-a',bob.id,{role:'kitchen',enabled:false,expectedVersion:1});
  assert.equal((await send(staffPath,{cookie:bob.cookie})).status,403,'Revoked staff membership applies on the next request');
  assert.equal((await send('/manage/restaurant-a/orders',{cookie:bob.cookie})).status,403);
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
  const channels=await send(channelsPath,{cookie:alice.cookie});assert.equal(channels.status,200);
  assert.equal(channels.data.channels.find(row=>row.channel==='whatsapp_qr').adapterImplemented,false);
  const setChannel=(channel,newOrdersEnabled,expectedVersion)=>send(channelsPath+'/'+channel,{method:'POST',cookie:alice.cookie,
    headers:{origin:baseUrl,'x-csrf-token':csrf},body:{newOrdersEnabled,expectedVersion}});
  assert.equal((await setChannel('chatgpt','false',1)).status,400);
  assert.equal((await setChannel('chatgpt',false,1)).status,200);
  assert.equal((await setChannel('chatgpt',true,1)).status,409);
  assert.equal((await confirm(alice)).data.order.number,order.number,'Accepted checkout remains recoverable after channel disable');
  const disabledHandoff=await rpc('prepare_checkout',{...handoff,idempotencyKey:'disabled-channel-handoff'},alice);
  assert.equal(disabledHandoff.isError,undefined,'Browsing and preparing do not reserve stock');
  const disabledId=disabledHandoff.structuredContent.checkoutId;
  const disabledConfirm=()=>send('/checkout/'+disabledId+'/confirm',{method:'POST',cookie:alice.cookie,headers:{origin:baseUrl},body:{...contact,csrf}});
  const disabledResult=await disabledConfirm();assert.equal(disabledResult.status,409);assert.equal(disabledResult.data.error,'channel_ordering_disabled');
  await pool.query("UPDATE platform_core_checkouts SET expires_at=now()-interval '1 minute' WHERE id=$1",[disabledId]);
  assert.equal((await setChannel('chatgpt',true,2)).status,200);
  assert.equal((await disabledConfirm()).data.error,'checkout_expired','Expired unresolved submission cannot create after channel reopens');
  const card=await rpc('prepare_checkout',{...cart,mode:'pickup',expectedTotalMinor:3000,idempotencyKey:'browser-card-checkout'},alice);
  assert.equal(card.isError,undefined);
  const cardPath='/checkout/'+card.structuredContent.checkoutId;
  const cardPage=await send(cardPath,{cookie:alice.cookie});
  assert.equal(cardPage.headers['referrer-policy'],'same-origin');
  assert.match(cardPage.headers['content-security-policy'],/form-action 'self' https:\/\/checkout\.stripe\.com /);
  assert.equal(cardPage.headers['content-security-policy'].includes('*'),false);
  assert.match(cardPage.data,/<option value="stripe">/);
  const cardConfirm=await send(cardPath+'/confirm',{method:'POST',cookie:alice.cookie,headers:{origin:baseUrl},
    body:{...contact,paymentMethod:'card',paymentProvider:'stripe',csrf}});
  assert.equal(cardConfirm.status,200);assert.equal(cardConfirm.data.order.paymentStatus,'unpaid');
  const pay=(cookie,token=csrf)=>send(cardPath+'/payment',{method:'POST',cookie,headers:{origin:baseUrl},body:{csrf:token}});
  assert.equal((await pay(alice.cookie,'bad')).status,403);
  assert.equal((await pay(bob.cookie)).status,403);
  if(process.env.CORE_BROWSER_TEST==='1'){
    const {chromium}=await import('playwright-core');
    const browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/usr/bin/google-chrome',headless:true,
      args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking',
        '--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=<-loopback>']});
    try{
      const context=await browser.newContext({locale:'ar-SA'});
      await context.addCookies([{name:'__Host-platform_session',value:alice.cookie.split('=')[1],url:baseUrl,secure:true,httpOnly:true,sameSite:'Lax'}]);
      let providerVisits=0;
      let oauthCallback;
      const page=await context.newPage();page.setDefaultTimeout(8000);
      const interceptionErrors=[];
      const cdp=await context.newCDPSession(page);
      // CDP intercepts redirect hops too. A dead loopback-only browser proxy is
      // a second safety barrier: no missed interception can contact a provider.
      await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
      cdp.on('Fetch.requestPaused',async event=>{
        const request=event.request,url=new URL(request.url);
        const headers=Object.fromEntries(Object.entries(request.headers).map(([key,value])=>[key.toLowerCase(),value]));
        const fulfill=(status,body,headers={'content-type':'text/html; charset=utf-8'})=>cdp.send('Fetch.fulfillRequest',{
          requestId:event.requestId,responseCode:status,responseHeaders:Object.entries(headers).map(([name,value])=>({name,value})),body:Buffer.from(body).toString('base64')});
        try{
        if(url.origin===baseUrl){
          if(request.method==='POST')assert.equal(headers.origin,baseUrl,'HTML forms preserve same-origin validation');
          // Use the same raw HTTP forwarding as the integration helper: keep
          // Host and browser cookies exactly, without fetch header normalization.
          const response=await new Promise((resolve,reject)=>{
            const upstream=httpRequest(local+url.pathname+url.search,{method:request.method,headers:{...headers,host:'platform.example'}},response=>{
              const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks)}));
            });upstream.on('error',reject);upstream.end(request.postData);
          });
          const responseHeaders=Object.fromEntries(Object.entries(response.headers).filter(([name])=>!['connection','transfer-encoding','content-length','set-cookie'].includes(name)));
          await fulfill(response.status,response.body,responseHeaders);return;
        }
        if(url.origin==='https://checkout.stripe.com'){
          assert.equal(headers.cookie,undefined,'Provider must not receive the platform cookie');
          if(event.resourceType==='Document')assert.equal(headers.referer,undefined,'Provider navigation must not receive private checkout URLs');
          else assert.ok(!headers.referer||new URL(headers.referer).origin===url.origin,'Provider subresources may refer only to their own origin');
          if(event.resourceType==='Document')providerVisits++;
          await fulfill(200,'<!doctype html><title>Synthetic provider</title><h1>Mock payment page</h1>');return;
        }
        if(url.origin==='https://client.example'&&url.pathname==='/callback'){
          assert.equal(headers.cookie,undefined);
          assert.equal(headers.referer,undefined);
          oauthCallback=url;
          await fulfill(200,'<!doctype html><title>Synthetic OAuth client</title>');return;
        }
        if(event.resourceType==='Document')throw new Error('Unexpected browser destination');
        await cdp.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'});
        }catch(error){interceptionErrors.push(error.message);await cdp.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'}).catch(()=>{});}
      });
      const browserDiagnostics=[];
      page.on('console',message=>{if(message.type()==='error')browserDiagnostics.push(message.text());});
      page.on('response',response=>{if(response.status()>=400)browserDiagnostics.push(`${response.status()} ${new URL(response.url()).pathname}`);});
      await page.goto(baseUrl+cardPath);
      assert.match(await page.locator('body').innerText(),/الانتقال لصفحة الدفع/,
        `Initial browser checkout failed: ${JSON.stringify({path:new URL(page.url()).pathname,errors:interceptionErrors,console:browserDiagnostics})}`);
      await page.getByRole('button',{name:'الانتقال لصفحة الدفع'}).click();
      try{await page.waitForURL('https://checkout.stripe.com/**');}
      catch(error){console.error('Synthetic browser navigation diagnostics',new URL(page.url()).pathname,await page.locator('body').innerText(),browserDiagnostics,interceptionErrors);throw error;}
      assert.equal(providerVisits,1);
      await page.goBack();await page.waitForURL(baseUrl+cardPath);
      assert.match(await page.locator('body').innerText(),/حالة الدفع: pending/);
      await page.goto(baseUrl+'/manage');
      await page.getByRole('link',{name:'restaurant-a',exact:true}).click();
      await page.waitForURL(baseUrl+'/manage/restaurant-a/orders');
      assert.match(await page.locator('body').innerText(),/تحديث الحالة/);
      await page.getByRole('link',{name:order.number,exact:true}).click();
      await page.waitForURL(baseUrl+'/manage/restaurant-a/orders/'+order.number);
      assert.match(await page.locator('body').innerText(),/Rice/);
      assert.equal((await page.locator('body').innerText()).includes(contact.phone),false);
      await page.goto(baseUrl+'/manage/restaurant-a/channels');
      assert.equal(await page.locator('form[action$="/channels/whatsapp_qr"]').count(),0);
      const webForm=page.locator('form[action$="/channels/web"]');
      await webForm.getByLabel('استقبال طلبات الموقع').selectOption('false');
      await webForm.getByRole('button').click();
      await page.locator('form[action$="/channels/web"] input[name="expectedVersion"][value="2"]').waitFor({state:'attached'});
      assert.equal(await webForm.getByLabel('استقبال طلبات الموقع').inputValue(),'false');
      await webForm.getByLabel('استقبال طلبات الموقع').selectOption('true');
      await webForm.getByRole('button').click();
      await page.locator('form[action$="/channels/web"] input[name="expectedVersion"][value="3"]').waitFor({state:'attached'});
      const registration=await app.auth.register({redirect_uris:['https://client.example/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code'],response_types:['code']});
      const verifier=randomBytes(32).toString('base64url');
      const grant={client_id:registration.client_id,redirect_uri:'https://client.example/callback',response_type:'code',resource:baseUrl+'/mcp',
        scope:'orders:read',state:'synthetic-browser-state',code_challenge_method:'S256',code_challenge:pkceChallenge(verifier)};
      await page.goto(baseUrl+'/oauth/authorize?'+new URLSearchParams(grant));
      await page.getByRole('button',{name:'موافقة',exact:true}).click();
      await page.waitForURL('https://client.example/callback?**');
      assert.equal(oauthCallback.searchParams.get('state'),grant.state);
      const exchanged=await app.auth.exchange({grant_type:'authorization_code',client_id:grant.client_id,redirect_uri:grant.redirect_uri,
        code:oauthCallback.searchParams.get('code'),code_verifier:verifier,resource:grant.resource});
      assert.ok(exchanged.access_token);
      await app.auth.revoke(exchanged.access_token);
      assert.deepEqual(interceptionErrors,[]);
      console.log('Verified Chromium payment form, provider-bound CSP redirect, private cookie isolation and Back navigation using intercepted test origins');
      console.log('Verified authenticated staff navigation and real browser OAuth consent -> registered callback -> PKCE exchange using synthetic identities');
    }finally{await browser.close();}
  }
  const payment=await pay(alice.cookie);assert.equal(payment.status,303);
  assert.match(payment.headers.location,/^https:\/\/checkout\.stripe\.com\//);
  assert.equal((await pay(alice.cookie)).headers.location,payment.headers.location);
  const refresh=await send(cardPath+'/refresh-payment',{method:'POST',cookie:alice.cookie,headers:{origin:baseUrl},body:{csrf}});
  assert.equal(refresh.status,303);assert.equal(refresh.headers.location,cardPath);
  assert.match((await send(cardPath,{cookie:alice.cookie})).data,/حالة الدفع: paid/);
  await app.auth.revoke(alice.token);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM event_subscriptions WHERE active')).rows[0].n,0);
  await app.directory.setTenantStatus(alice.id,'restaurant-a',{status:'suspended',expectedVersion:2});
  assert.equal((await send(staffPath,{cookie:alice.cookie})).status,200,'Suspension preserves existing order operations');
  assert.equal((await send(channelsPath,{cookie:alice.cookie})).status,403,'Suspension does not permit enabling new channel work');
  const cash=await staffPost(alice,`/${order.number}/cash`,{version:advanced.data.version});
  assert.equal(cash.status,200);assert.equal(cash.data.paymentStatus,'paid');
  assert.equal((await staffPost(alice,`/${order.number}/cash`,{version:advanced.data.version})).status,409);
  console.log('Verified live staff membership, customer OAuth exclusion, kitchen cash denial, version conflicts, revocation and suspended-tenant settlement without restaurant master keys');
  console.log('Verified transactional original-core events, owner-only ingestion, signed callback, crash-safe cursor deduplication and OAuth revocation; callback transport mocked');
  console.log('Verified MCP preview -> owned handoff -> CSRF-protected browser confirmation -> signed original Go order -> private MCP status; duplicate confirmation stays one order');
} finally {
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
}
