import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createServer,request as httpRequest} from 'node:http';
import pg from 'pg';
import {createCoreOrderClient} from '../core-order-client.mjs';
import {createControlPlane} from '../control-plane.mjs';
import {checkNativeDart} from './native-dart-check.mjs';
const fixture=JSON.parse(process.env.CORE_TAX_FIXTURE),actor=randomUUID();
const client=createCoreOrderClient({issuer:'https://platform.example',privateKey:fixture.privateKey,restaurants:[{id:'restaurant-a',baseUrl:fixture.baseUrl}]});
const before=await client.tax('restaurant-a',actor);
const first=await client.patchTax('restaurant-a',actor,{expectedVersion:before.version,reviewed:true,enabled:true,rateBps:1500,taxNumber:'SYNTHETIC-NOT-A-TAX-ID'});
assert.equal(first.version,before.version+1);assert.equal(first.pricesIncludeTax,true);
await assert.rejects(client.patchTax('restaurant-a',actor,{expectedVersion:before.version,reviewed:true,enabled:false,rateBps:0,taxNumber:''}),{code:'catalog_changed'});
if(!process.env.IDENTITY_TEST_DATABASE_URL){console.log('Verified actual signed tax configuration and stale denial.');process.exit(0);}
const database=new URL(process.env.IDENTITY_TEST_DATABASE_URL);assert.equal(database.pathname,'/astracalls_identity_test');assert.equal(database.searchParams.has('dbname'),false);
const schema='tax_flow_'+randomBytes(8).toString('hex'),admin=new pg.Pool({connectionString:database.href});await admin.query(`CREATE SCHEMA ${schema}`);
const pool=new pg.Pool({connectionString:database.href,options:`-c search_path=${schema}`}),base='https://platform.example',issuer='https://identity.example/';let server;
try{
 const app=await createControlPlane({pool,baseUrl:base,csrfKey:randomBytes(32).toString('base64'),serviceSigningKey:fixture.privateKey,nativeStaffEnabled:true,oidc:{issuer,clientId:'test',clientSecret:'synthetic-fixture-only'},restaurants:[{id:'restaurant-a',name:'Synthetic',cuisine:'saudi',baseUrl:fixture.baseUrl}]},{oidcClientAdapter:{async authorizationUrl(){return issuer+'authorize';},async exchange(){throw Error('unused');}}});
 const make=async subject=>{const who=await app.directory.verifiedIdentity({issuer,subject}),session=await app.auth.issue(who.id,undefined,{kind:'browser'}),cookie='__Host-platform_session='+session.accessToken;return {...who,cookie,csrf:app.auth.csrfToken({headers:{cookie}})};};
 const owner=await make('owner'),reader=await make('reader'),outsider=await make('outsider');await pool.query('UPDATE platform_identities SET platform_admin=TRUE WHERE id=$1',[owner.id]);await app.directory.createTenant(owner.id,{id:'restaurant-a',name:'Synthetic',ownerId:owner.id});await app.directory.setTenantStatus(owner.id,'restaurant-a',{status:'active',expectedVersion:1});
 await app.directory.setMembership(owner.id,'restaurant-a',reader.id,{role:'manager',permissions:['settings:read'],enabled:true,expectedVersion:null});
 server=createServer(app.handle);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const local='http://127.0.0.1:'+server.address().port;
 const send=(path,{who=owner,body}={})=>new Promise((resolve,reject)=>{const req=httpRequest(local+path,{method:body?'POST':'GET',headers:{host:'platform.example',cookie:who.cookie,...(body?{origin:base,'content-type':'application/json'}:{})}},res=>{let raw='';res.on('data',v=>raw+=v);res.on('end',()=>resolve({status:res.statusCode,raw,headers:res.headers}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});
 const path='/manage/restaurant-a/tax',input={csrf:owner.csrf,expectedVersion:first.version,enabled:'true',rate:'5.25',taxNumber:'SYNTHETIC-BROWSER-TAX'};
 assert.equal((await send(path,{who:outsider})).status,403);const read=await send(path,{who:reader});assert.equal(read.status,200);assert.doesNotMatch(read.raw,/<form/);
 assert.equal((await send(path+'/review',{body:{...input,csrf:'bad'}})).status,403);
 assert.equal((await send(path+'/review',{who:reader,body:{...input,csrf:reader.csrf}})).status,403);
 assert.equal((await send(path+'/review',{body:input})).status,200);assert.equal((await send(path+'/execute',{body:input})).status,400);
 assert.equal((await send(path+'/review',{body:{...input,expectedVersion:first.version-1}})).status,409);
 assert.equal((await client.tax('restaurant-a',actor)).rateBps,1500);
 if(process.env.CORE_BROWSER_TEST==='1'){
  const {chromium}=await import('playwright-core');const browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=<-loopback>']});
  try{
   const context=await browser.newContext({locale:'ar-SA'});await context.addCookies([{name:'__Host-platform_session',value:owner.cookie.split('=')[1],url:base,secure:true,httpOnly:true,sameSite:'Lax'}]);
   await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url()),headers=await request.allHeaders();if(url.origin!==base)return route.abort();const response=await new Promise((resolve,reject)=>{const req=httpRequest(local+url.pathname+url.search,{method:request.method(),headers:{...headers,host:'platform.example'}},res=>{const chunks=[];res.on('data',v=>chunks.push(v));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});req.on('error',reject);req.end(request.postDataBuffer()??undefined);});await route.fulfill(response);});
   const page=await context.newPage();page.setDefaultTimeout(8000);await page.goto(base+path);
   await page.getByLabel('النسبة المئوية',{exact:true}).fill('5.25');await page.getByLabel('رقم التسجيل الضريبي',{exact:true}).fill(input.taxNumber);await page.getByRole('button',{name:'مراجعة إعدادات الضريبة',exact:true}).click();
   await page.getByRole('button',{name:'حفظ إعدادات الضريبة',exact:true}).click();assert.ok(page.url().endsWith('/review'));await page.getByRole('link',{name:'إلغاء مراجعة الضريبة',exact:true}).click();await page.getByRole('button',{name:'مراجعة إعدادات الضريبة',exact:true}).waitFor();assert.equal((await client.tax('restaurant-a',actor)).rateBps,1500);
   await page.getByLabel('النسبة المئوية',{exact:true}).fill('5.25');await page.getByLabel('رقم التسجيل الضريبي',{exact:true}).fill(input.taxNumber);await page.getByRole('button',{name:'مراجعة إعدادات الضريبة',exact:true}).click();await page.getByLabel('راجعت النسبة والتسجيل وأثرهما على الطلبات الجديدة',{exact:true}).check();await page.getByRole('button',{name:'حفظ إعدادات الضريبة',exact:true}).click();await page.waitForURL(base+path);
   console.log('Verified actual Chromium tax review, inert cancel, unchecked denial and confirmed synthetic configuration.');
  }finally{await browser.close();}
 }else assert.equal((await send(path+'/execute',{body:{...input,reviewed:'yes'}})).status,303);
 assert.equal((await client.tax('restaurant-a',actor)).rateBps,525);
 if(process.env.CORE_FLUTTER_TEST_BIN)await checkNativeDart({app,browserCookie:owner.cookie,principalId:owner.id,orderNumber:'R00000000',tax:true});
 await app.directory.setTenantStatus(owner.id,'restaurant-a',{status:'suspended',expectedVersion:2});assert.equal((await send(path+'/execute',{body:{...input,reviewed:'yes'}})).status,403);
 console.log('Verified tax browser ownership, independent read/update grants, CSRF, explicit review, original version/audit and suspended-tenant denial. No real registration or legal/tax determination.');
}finally{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
