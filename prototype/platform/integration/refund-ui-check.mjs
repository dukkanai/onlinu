import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createServer,request as httpRequest} from 'node:http';
import pg from 'pg';
import {createControlPlane} from '../control-plane.mjs';
import {checkNativeDart} from './native-dart-check.mjs';
export async function checkRefundUI(fixture){
 const database=new URL(process.env.IDENTITY_TEST_DATABASE_URL);assert.equal(database.pathname,'/astracalls_identity_test');assert.equal(database.searchParams.has('dbname'),false);
 const schema='refund_flow_'+randomBytes(8).toString('hex'),admin=new pg.Pool({connectionString:database.href});await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new pg.Pool({connectionString:database.href,options:`-c search_path=${schema}`}),base='https://platform.example',issuer='https://identity.example/';let server;
 try{
  const app=await createControlPlane({pool,baseUrl:base,csrfKey:randomBytes(32).toString('base64'),serviceSigningKey:fixture.privateKey,nativeStaffEnabled:true,oidc:{issuer,clientId:'test',clientSecret:'synthetic-fixture-only'},restaurants:[{id:'restaurant-a',name:'Synthetic',cuisine:'saudi',baseUrl:fixture.baseUrl}]},{oidcClientAdapter:{async authorizationUrl(){return issuer+'authorize';},async exchange(){throw Error('unused');}}});
  const make=async subject=>{const who=await app.directory.verifiedIdentity({issuer,subject}),session=await app.auth.issue(who.id,undefined,{kind:'browser'}),cookie='__Host-platform_session='+session.accessToken;return {...who,cookie,csrf:app.auth.csrfToken({headers:{cookie}})};};
  const owner=await make('owner'),reader=await make('reader');await pool.query('UPDATE platform_identities SET platform_admin=TRUE WHERE id=$1',[owner.id]);await app.directory.createTenant(owner.id,{id:'restaurant-a',name:'Synthetic',ownerId:owner.id});await app.directory.setTenantStatus(owner.id,'restaurant-a',{status:'active',expectedVersion:1});await app.directory.setMembership(owner.id,'restaurant-a',reader.id,{role:'manager',permissions:['orders:read','payments:read'],enabled:true,expectedVersion:null});
  server=createServer(app.handle);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const local='http://127.0.0.1:'+server.address().port;
  const send=(path,{who=owner,body}={})=>new Promise((resolve,reject)=>{const req=httpRequest(local+path,{method:body?'POST':'GET',headers:{host:'platform.example',cookie:who.cookie,...(body?{origin:base,'content-type':'application/json'}:{})}},res=>{let raw='';res.on('data',v=>raw+=v);res.on('end',()=>resolve({status:res.statusCode,raw,headers:res.headers}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});
  const path='/manage/restaurant-a/orders/'+fixture.number+'/refunds/'+fixture.refundId;
  assert.equal((await send(path,{who:reader})).status,403);
  const page=await send(path);assert.equal(page.status,200);assert.match(page.raw,/مراجعة التصريح/);assert.doesNotMatch(page.raw,/تأكيد إجراء الاسترداد/);
  assert.equal((await send(path+'/review',{body:{action:'authorize',csrf:'bad'}})).status,403);
  const review=await send(path+'/review',{body:{action:'authorize',csrf:owner.csrf}});assert.equal(review.status,200);assert.match(review.raw,/تأكيد إجراء الاسترداد/);assert.match(review.raw,/name="reviewed" value="yes" required/);
  const payload={action:'authorize',csrf:owner.csrf,version:fixture.version,amountMinor:fixture.amountMinor,currency:'SAR',provider:fixture.provider,demo:String(fixture.demo)};
  assert.equal((await send(path+'/execute',{body:payload})).status,400);
  assert.equal((await send(path+'/execute',{body:{...payload,reviewed:'yes',amountMinor:fixture.amountMinor+1}})).status,409);
  if(process.env.CORE_BROWSER_TEST==='1'){
    const {chromium}=await import('playwright-core');
    const browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=<-loopback>']});
    try{
      const context=await browser.newContext({locale:'ar-SA'});
      await context.addCookies([{name:'__Host-platform_session',value:owner.cookie.split('=')[1],url:base,secure:true,httpOnly:true,sameSite:'Lax'}]);
      await context.route('**/*',async route=>{
        const request=route.request(),url=new URL(request.url()),headers=await request.allHeaders();
        if(url.origin!==base)return route.abort();
        const response=await new Promise((resolve,reject)=>{
          const req=httpRequest(local+url.pathname+url.search,{method:request.method(),headers:{...headers,host:'platform.example'}},res=>{const chunks=[];res.on('data',v=>chunks.push(v));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});
          req.on('error',reject);req.end(request.postDataBuffer()??undefined);
        });await route.fulfill(response);
      });
      const page=await context.newPage();page.setDefaultTimeout(8000);await page.goto(base+path);
      await page.getByRole('button',{name:'مراجعة التصريح بتنفيذ الاسترداد',exact:true}).click();
      const confirm=page.getByRole('button',{name:'تأكيد إجراء الاسترداد',exact:true});await confirm.waitFor();
      await confirm.click();assert.ok(page.url().endsWith('/review'),'unchecked browser validation prevents execution');
      await page.getByRole('link',{name:'إلغاء المراجعة',exact:true}).click();
      await page.getByRole('button',{name:'مراجعة التصريح بتنفيذ الاسترداد',exact:true}).waitFor();
      assert.equal(await page.getByRole('button',{name:'تأكيد إجراء الاسترداد',exact:true}).count(),0);
      console.log('Verified actual Chromium refund review, unchecked-confirmation prevention and inert cancellation.');
    }finally{await browser.close();}
  }
  if(process.env.CORE_FLUTTER_TEST_BIN)await checkNativeDart({app,browserCookie:owner.cookie,principalId:owner.id,orderNumber:fixture.number,refund:true,refundId:fixture.refundId});
  else assert.equal((await send(path+'/execute',{body:{...payload,reviewed:'yes'}})).status,303);
  assert.equal((await send(path+'/execute',{body:{...payload,reviewed:'yes'}})).status,303,'Repeating the same already-authorized intent does not create another intent');
  const recovered=await send(path);assert.equal(recovered.status,200);assert.doesNotMatch(recovered.raw,/مراجعة التصريح/);
  console.log('Verified real browser-session refund routes, three-grant privacy, CSRF, review-before-execute, tuple mismatch and same-ID recovery; synthetic only.');
 }finally{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
