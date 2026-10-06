import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createServer,request as httpRequest} from 'node:http';
import pg from 'pg';
import {mkdir} from 'node:fs/promises';
import {createControlPlane} from '../control-plane.mjs';
export async function checkCustomerSupportUI(fixture){
 const database=new URL(process.env.IDENTITY_TEST_DATABASE_URL);assert.equal(database.pathname,'/astracalls_identity_test');assert.equal(database.searchParams.has('dbname'),false);
 const schema='customer_support_flow_'+randomBytes(8).toString('hex'),admin=new pg.Pool({connectionString:database.href});await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new pg.Pool({connectionString:database.href,options:`-c search_path=${schema}`}),base='https://platform.example',issuer='https://identity.example/';let server;
 try{
  const app=await createControlPlane({pool,baseUrl:base,csrfKey:randomBytes(32).toString('base64'),serviceSigningKey:fixture.privateKey,oidc:{issuer,clientId:'test',clientSecret:'synthetic-fixture-only'},restaurants:[{id:'restaurant-a',name:'Synthetic',cuisine:'saudi',baseUrl:fixture.baseUrl}]},{oidcClientAdapter:{async authorizationUrl(){return issuer+'authorize';},async exchange(){throw Error('unused');}}});
  const make=async subject=>{const who=await app.directory.verifiedIdentity({issuer,subject}),session=await app.auth.issue(who.id,undefined,{kind:'browser'}),cookie='__Host-platform_session='+session.accessToken;return {...who,role:'customer',scopes:['orders:read','orders:write'],cookie,csrf:app.auth.csrfToken({headers:{cookie}})};};
  const owner=await make('owner'),customer=await make('customer'),outsider=await make('outsider');await pool.query('UPDATE platform_identities SET platform_admin=TRUE WHERE id=$1',[owner.id]);await app.directory.createTenant(owner.id,{id:'restaurant-a',name:'Synthetic',ownerId:owner.id});await app.directory.setTenantStatus(owner.id,'restaurant-a',{status:'active',expectedVersion:1});
  const checkout=await app.checkouts.prepare(customer,{tenantId:'restaurant-a',mode:'delivery',address:{country:'SA'},items:[{itemId:'rice',quantity:2,optionIds:['extra','free']}],expectedTotalMinor:3500,idempotencyKey:randomUUID()});
  const order=await app.checkouts.confirm(customer,checkout.checkoutId,{customerName:'Synthetic customer',phone:'+966501234567',paymentMethod:'cash_on_delivery',address:{country:'SA',nationalAddress:'ABCD1234'}});
  server=createServer(app.handle);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const local='http://127.0.0.1:'+server.address().port;
  const send=(path,{who=customer,body,headers={}}={})=>new Promise((resolve,reject)=>{const req=httpRequest(local+path,{method:body?'POST':'GET',headers:{host:'platform.example',cookie:who.cookie,...(body?{origin:base,'content-type':'application/json'}:{}),...headers}},res=>{let raw='';res.on('data',v=>raw+=v);res.on('end',()=>resolve({status:res.statusCode,raw,headers:res.headers}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});
  const path='/checkout/'+checkout.checkoutId+'/support',input={csrf:customer.csrf,kind:'cancellation',requestId:randomUUID(),version:order.version,reason:'Synthetic changed plans'};
  assert.equal((await send(path,{who:outsider})).status,404);
  assert.equal((await send(path,{headers:{authorization:'Bearer synthetic'}})).status,403);
  const initial=await send(path);assert.equal(initial.status,200);assert.match(initial.raw,/مراجعة طلب إلغاء/);assert.doesNotMatch(initial.raw,/\+966501234567|trackingToken/);
  assert.equal((await send(path+'/review',{body:{...input,csrf:'bad'}})).status,403);
  assert.equal((await send(path+'/review',{body:input})).status,200);
  assert.equal((await send(path+'/execute',{body:input})).status,400);
  assert.equal((await send(path+'/review',{body:{...input,version:order.version+1}})).status,409);
  assert.equal((await app.checkouts.support(customer,checkout.checkoutId)).order.version,order.version,'Review is not execution');
  if(process.env.CORE_BROWSER_TEST==='1'){
    const {chromium}=await import('playwright-core');const browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=<-loopback>']});
    try{
      const context=await browser.newContext({locale:'ar-SA'});await context.addCookies([{name:'__Host-platform_session',value:customer.cookie.split('=')[1],url:base,secure:true,httpOnly:true,sameSite:'Lax'}]);
      await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url()),headers=await request.allHeaders();if(url.origin!==base)return route.abort();const response=await new Promise((resolve,reject)=>{const req=httpRequest(local+url.pathname+url.search,{method:request.method(),headers:{...headers,host:'platform.example'}},res=>{const chunks=[];res.on('data',v=>chunks.push(v));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});req.on('error',reject);req.end(request.postDataBuffer()??undefined);});await route.fulfill(response);});
      const page=await context.newPage();page.setDefaultTimeout(8000);await page.goto(base+path);
      await page.getByLabel('سبب طلب إلغاء',{exact:true}).fill('Synthetic browser cancellation');await page.getByRole('button',{name:'مراجعة طلب إلغاء',exact:true}).click();
      await page.getByRole('button',{name:'تأكيد إرسال طلب الدعم',exact:true}).click();assert.ok(page.url().endsWith('/review'));
      await page.getByRole('link',{name:'إلغاء المراجعة',exact:true}).click();await page.getByRole('button',{name:'مراجعة طلب إلغاء',exact:true}).waitFor();
      assert.equal((await app.checkouts.support(customer,checkout.checkoutId)).order.version,order.version);
      await page.getByLabel('سبب طلب إلغاء',{exact:true}).fill('Synthetic confirmed cancellation');await page.getByRole('button',{name:'مراجعة طلب إلغاء',exact:true}).click();
      await page.getByLabel('راجعت الطلب والسبب وأؤكد الإرسال',{exact:true}).check();await page.getByRole('heading',{name:'متابعة الإلغاء والشكاوى',exact:true}).click();await page.waitForTimeout(300);await mkdir('../../artifacts/customer-support',{recursive:true});await page.screenshot({path:'../../artifacts/customer-support/customer-support-review.png',fullPage:true});await page.getByRole('button',{name:'تأكيد إرسال طلب الدعم',exact:true}).click();await page.waitForURL(base+path);
      await page.getByText('تمت الموافقة',{exact:false}).waitFor();
      console.log('Verified actual Chromium customer cancellation review, unchecked guard, inert cancel and confirmed original-core cancellation.');
    }finally{await browser.close();}
  }else assert.equal((await send(path+'/execute',{body:{...input,reviewed:'yes'}})).status,303);
  const cancelled=await app.checkouts.support(customer,checkout.checkoutId);assert.equal(cancelled.order.status,'cancelled');assert.equal(cancelled.order.cancellation.status,'approved');assert.equal(cancelled.order.paymentStatus,'unpaid');
  const complaint={...input,kind:'complaint',requestId:randomUUID(),version:cancelled.order.version,reason:'Synthetic private complaint',reviewed:'yes'};
  await app.directory.setTenantStatus(owner.id,'restaurant-a',{status:'suspended',expectedVersion:2});
  const frozen={requestId:complaint.requestId,kind:complaint.kind,version:complaint.version,reason:complaint.reason,reviewed:true};
  const canonical=Object.fromEntries(Object.keys(frozen).sort().map(key=>[key,frozen[key]]));
  const hash=createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  // Simulate a process stopping after durable claim but before original dispatch.
  await pool.query("INSERT INTO platform_core_support_intents(checkout_id,request_id,kind,request_hash,state,review_version) VALUES($1,$2,'complaint',$3,'dispatching',$4)",[checkout.checkoutId,complaint.requestId,hash,complaint.version]);
  const unknown=await send(path);assert.equal(unknown.status,200);assert.match(unknown.raw,/مراجعة إعادة الإرسال بنفس المرجع/);
  assert.equal((await send(path+'/execute',{body:complaint})).status,303);
  assert.equal((await app.checkouts.support(customer,checkout.checkoutId)).order.complaints.length,0,'Normal resubmit only reads recovery');
  assert.equal((await send(path+'/retry-review',{body:{...complaint,reason:'different'}})).status,409);
  assert.equal((await send(path+'/retry-review',{body:complaint})).status,200);
  assert.equal((await send(path+'/retry-execute',{body:{...complaint,reviewed:undefined}})).status,400);
  if(process.env.CORE_BROWSER_TEST==='1'){
    const {chromium}=await import('playwright-core');const browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=<-loopback>']});
    try{
      const context=await browser.newContext({locale:'ar-SA'});await context.addCookies([{name:'__Host-platform_session',value:customer.cookie.split('=')[1],url:base,secure:true,httpOnly:true,sameSite:'Lax'}]);
      await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url()),headers=await request.allHeaders();if(url.origin!==base)return route.abort();const response=await new Promise((resolve,reject)=>{const req=httpRequest(local+url.pathname+url.search,{method:request.method(),headers:{...headers,host:'platform.example'}},res=>{const chunks=[];res.on('data',v=>chunks.push(v));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});req.on('error',reject);req.end(request.postDataBuffer()??undefined);});await route.fulfill(response);});
      const page=await context.newPage();page.setDefaultTimeout(8000);await page.goto(base+path);
      await page.getByLabel('أعد كتابة السبب الأصلي',{exact:true}).fill(complaint.reason);await page.getByRole('button',{name:'مراجعة إعادة الإرسال بنفس المرجع',exact:true}).click();
      await page.getByRole('button',{name:'تأكيد إرسال طلب الدعم',exact:true}).click();assert.ok(page.url().endsWith('/retry-review'));
      await page.getByLabel('راجعت الطلب والسبب وأؤكد الإرسال',{exact:true}).check();await page.getByRole('heading',{name:'متابعة الإلغاء والشكاوى',exact:true}).click();await page.waitForTimeout(300);await page.screenshot({path:'../../artifacts/customer-support/customer-support-retry-review.png',fullPage:true});await page.getByRole('button',{name:'تأكيد إرسال طلب الدعم',exact:true}).click();await page.waitForURL(base+path);
      console.log('Verified actual Chromium separately reviewed same-key customer retry after a durable unsubmitted intent; unchecked retry cannot execute.');
    }finally{await browser.close();}
  }else assert.equal((await send(path+'/retry-execute',{body:complaint})).status,303);

  assert.equal((await send(path+'/execute',{body:complaint})).status,303);
  const after=await app.checkouts.support(customer,checkout.checkoutId);assert.equal(after.order.complaints.length,1);assert.equal(after.pending,null);
  const intents=(await pool.query('SELECT * FROM platform_core_support_intents')).rows;assert.equal(intents.length,2);assert.ok(intents.every(row=>row.state==='recorded'));assert.equal(JSON.stringify(intents).includes(complaint.reason),false);
  await pool.query('UPDATE platform_identities SET enabled=FALSE WHERE id=$1',[customer.id]);assert.notEqual((await send(path)).status,200);
  console.log('Verified actual customer browser ownership, CSRF, review, original cancellation/complaint rules, duplicate suppression and hash-only intent persistence.');
 }finally{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
