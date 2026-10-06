import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createServer,request as httpRequest} from 'node:http';
import pg from 'pg';
import {createControlPlane} from '../control-plane.mjs';
import {checkNativeDart} from './native-dart-check.mjs';
export async function checkSupportUI(fixture){
 const database=new URL(process.env.IDENTITY_TEST_DATABASE_URL);assert.equal(database.pathname,'/astracalls_identity_test');assert.equal(database.searchParams.has('dbname'),false);
 const schema='support_flow_'+randomBytes(8).toString('hex'),admin=new pg.Pool({connectionString:database.href});await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new pg.Pool({connectionString:database.href,options:`-c search_path=${schema}`}),base='https://platform.example',issuer='https://identity.example/';let server;
 try{
  const app=await createControlPlane({pool,baseUrl:base,csrfKey:randomBytes(32).toString('base64'),serviceSigningKey:fixture.privateKey,nativeStaffEnabled:true,oidc:{issuer,clientId:'test',clientSecret:'synthetic-fixture-only'},restaurants:[{id:'restaurant-a',name:'Synthetic',cuisine:'saudi',baseUrl:fixture.baseUrl}]},{oidcClientAdapter:{async authorizationUrl(){return issuer+'authorize';},async exchange(){throw Error('unused');}}});
  const make=async subject=>{const who=await app.directory.verifiedIdentity({issuer,subject}),session=await app.auth.issue(who.id,undefined,{kind:'browser'}),cookie='__Host-platform_session='+session.accessToken;return {...who,cookie,csrf:app.auth.csrfToken({headers:{cookie}})};};
  const owner=await make('owner'),manager=await make('support-manager'),kitchen=await make('kitchen'),outsider=await make('outsider');await pool.query('UPDATE platform_identities SET platform_admin=TRUE WHERE id=$1',[owner.id]);await app.directory.createTenant(owner.id,{id:'restaurant-a',name:'Synthetic',ownerId:owner.id});await app.directory.setTenantStatus(owner.id,'restaurant-a',{status:'active',expectedVersion:1});
  await app.directory.setMembership(owner.id,'restaurant-a',manager.id,{role:'manager',permissions:['orders:read','support:manage','payments:read'],enabled:true,expectedVersion:null});await app.directory.setMembership(owner.id,'restaurant-a',kitchen.id,{role:'kitchen',enabled:true,expectedVersion:null});
  server=createServer(app.handle);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const local='http://127.0.0.1:'+server.address().port;
  const send=(path,{who=manager,body}={})=>new Promise((resolve,reject)=>{const req=httpRequest(local+path,{method:body?'POST':'GET',headers:{host:'platform.example',cookie:who.cookie,...(body?{origin:base,'content-type':'application/json','x-csrf-token':who.csrf}:{})}},res=>{let raw='';res.on('data',v=>raw+=v);res.on('end',()=>resolve({status:res.statusCode,raw,headers:res.headers}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});
  const path='/manage/restaurant-a/support/'+fixture.number,apiPath='/api/restaurants/restaurant-a/staff/support/orders/'+fixture.number;
  assert.equal((await send('/manage/restaurant-a/support',{who:outsider})).status,403);
  const read=await send(path,{who:kitchen});assert.equal(read.status,200);assert.doesNotMatch(read.raw,/مراجعة الموافقة/);assert.match(read.raw,/Synthetic private customer reason/);
  const before=JSON.parse((await send(apiPath)).raw),id=before.cancellation.id;
  const input={csrf:manager.csrf,action:'decide',version:before.version,approve:'true',reason:'Synthetic browser review'};
  assert.equal((await send(path+'/'+id+'/review',{who:kitchen,body:{...input,csrf:kitchen.csrf}})).status,403);
  assert.equal((await send(path+'/'+id+'/review',{body:{...input,csrf:'bad'}})).status,403);
  const review=await send(path+'/'+id+'/review',{body:input});assert.equal(review.status,200);assert.match(review.raw,/name="reviewed" value="yes" required/);
  assert.equal((await send(path+'/'+id+'/execute',{body:input})).status,400);
  assert.equal((await send(path+'/'+id+'/execute',{body:{...input,reviewed:'yes',version:before.version-1}})).status,409);
  if(process.env.CORE_BROWSER_TEST==='1'){
    const {chromium}=await import('playwright-core');const browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=<-loopback>']});
    try{
      const context=await browser.newContext({locale:'ar-SA'});await context.addCookies([{name:'__Host-platform_session',value:manager.cookie.split('=')[1],url:base,secure:true,httpOnly:true,sameSite:'Lax'}]);
      await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url()),headers=await request.allHeaders();if(url.origin!==base)return route.abort();const response=await new Promise((resolve,reject)=>{const req=httpRequest(local+url.pathname+url.search,{method:request.method(),headers:{...headers,host:'platform.example'}},res=>{const chunks=[];res.on('data',v=>chunks.push(v));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});req.on('error',reject);req.end(request.postDataBuffer()??undefined);});await route.fulfill(response);});
      const page=await context.newPage();page.setDefaultTimeout(8000);await page.goto(base+path);
      const form=page.locator('form').filter({has:page.getByRole('button',{name:'مراجعة الموافقة على الإلغاء',exact:true})});await form.getByLabel('سبب القرار أو تفاصيل المعالجة',{exact:true}).fill('Synthetic browser approval');await form.getByRole('button',{name:'مراجعة الموافقة على الإلغاء',exact:true}).click();
      await page.getByRole('button',{name:'تأكيد قرار الدعم',exact:true}).click();assert.ok(page.url().endsWith('/review'),'Unchecked confirmation cannot execute');await page.getByRole('link',{name:'إلغاء مراجعة الدعم',exact:true}).click();await page.getByRole('button',{name:'مراجعة الموافقة على الإلغاء',exact:true}).waitFor();
      const complaint=page.locator(`form[action$="/${before.complaints[0].id}/review"]`);await complaint.getByLabel('سبب القرار أو تفاصيل المعالجة',{exact:true}).fill('Synthetic browser resolved complaint');await complaint.getByRole('button',{name:'مراجعة معالجة الشكوى',exact:true}).click();await page.getByLabel('راجعت الطلب والسبب وأثر القرار وأؤكد التنفيذ',{exact:true}).check();await page.getByRole('button',{name:'تأكيد قرار الدعم',exact:true}).click();await page.waitForURL(base+path);
      console.log('Verified actual Chromium support review, unchecked confirmation, inert cancellation and reviewed complaint resolution.');
    }finally{await browser.close();}
  }
  if(process.env.CORE_BROWSER_TEST!=='1'){
    const first=before.complaints[0],body={csrf:manager.csrf,action:'resolve',version:before.version,reason:'Synthetic browser-route complaint resolution'};
    assert.equal((await send(path+'/'+first.id+'/review',{body})).status,200);assert.equal((await send(path+'/'+first.id+'/execute',{body:{...body,reviewed:'yes'}})).status,303);
  }
  const remaining=JSON.parse((await send(apiPath)).raw);assert.equal(remaining.openComplaints,1);assert.equal(remaining.cancellationPending,true);input.version=remaining.version;
  await app.directory.setTenantStatus(owner.id,'restaurant-a',{status:'suspended',expectedVersion:2});
  if(process.env.CORE_FLUTTER_TEST_BIN)await checkNativeDart({app,browserCookie:manager.cookie,principalId:manager.id,orderNumber:fixture.number,support:true});
  else{
    assert.equal((await send(path+'/'+id+'/review',{body:input})).status,200);assert.equal((await send(path+'/'+id+'/execute',{body:{...input,reviewed:'yes'}})).status,303);
    const current=JSON.parse((await send(apiPath)).raw);assert.equal((await send(path+'/'+current.complaints.find(c=>c.status==='open').id+'/execute',{body:{csrf:manager.csrf,action:'resolve',version:current.version,reason:'Synthetic complaint resolution',reviewed:'yes'}})).status,303);
  }
  const queue=JSON.parse((await send('/api/restaurants/restaurant-a/staff/support')).raw);assert.equal(queue.orders.length,0);
  const finance=JSON.parse((await send('/api/restaurants/restaurant-a/staff/orders/'+fixture.number+'/finance')).raw);assert.equal(finance.refundedMinor,0);assert.equal(finance.refunds[0].authorized,false);
  assert.equal((await send('/api/restaurants/restaurant-a/staff/orders/'+fixture.number+'/refunds/'+finance.refunds[0].id+'/authorize',{body:{}})).status,403,'Support grant never implies payout authority');
  await app.directory.setMembership(owner.id,'restaurant-a',manager.id,{role:'manager',permissions:['orders:read'],enabled:true,expectedVersion:1});assert.equal((await send(path+'/'+id+'/review',{body:input})).status,403);
  console.log('Verified browser-session support privacy, CSRF, explicit grant, suspended-tenant settlement, and independent refund authority; synthetic customer only.');
 }finally{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
