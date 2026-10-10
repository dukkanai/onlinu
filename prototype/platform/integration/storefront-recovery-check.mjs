// Real compiled React + Playwright. All server responses below are isolated
// synthetic fixtures. There is no real order, payment, login, or remote service.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {createRecoveryFixture,customer,pendingKey,cartKey,tableCode} from './storefront-recovery-fixture.mjs';

async function bounded(promise,label,milliseconds=15000){
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(`${label} timed out`)),milliseconds);})]);}
  finally{clearTimeout(timer);}
}
const settled=page=>bounded(page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))),'renderer settlement');
const originalPosts=fixture=>fixture.requests.filter(request=>request.method==='POST'&&request.path==='/orders');
const entered=hold=>bounded(hold.entered,'expected deferred fixture request');
async function storage(page,key){return page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)??'null'),key);}
async function cart(page){return page.evaluate(key=>JSON.parse(localStorage.getItem(key)??'[]'),cartKey);}

async function scenario(browser,root,evidence,name,options,run){
  const fixture=createRecoveryFixture(options), errors=[];
  const server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://127.0.0.1');
      if(url.pathname.startsWith('/storefront-api/')){
        let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>100000)throw Error('oversized fixture request');}
        const result=await fixture.handle(req.method,url.pathname.slice('/storefront-api'.length),raw?JSON.parse(raw):null,req.headers);
        if(res.destroyed)return;
        res.writeHead(result.status,{'content-type':'application/json','cache-control':'no-store'});res.end(result.status===204?'':JSON.stringify(result.body));return;
      }
      if(req.method!=='GET'){errors.push('non-GET static request');res.writeHead(405);res.end();return;}
      const asset=/^\/(?:assets|fonts|icons)\//.test(url.pathname), file=asset?resolve(root,'.'+decodeURIComponent(url.pathname)):resolve(root,'index.html');
      assert.ok(file.startsWith(root.endsWith(sep)?root:root+sep));
      const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png'}[extname(file)]??'application/octet-stream';
      const bytes=await readFile(file);res.writeHead(200,{'content-type':mime,'cache-control':'no-store'});res.end(bytes);
    }catch(error){errors.push(error.message);if(!res.destroyed){res.writeHead(500);res.end();}}
  });
  await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  const origin=`http://127.0.0.1:${server.address().port}`;
  let context;
  try{
    context=await browser.newContext({viewport:{width:390,height:844},locale:'en-US'});
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(errors.push('external browser request'),route.abort()));
    await context.addInitScript(()=>{if(!localStorage.getItem('restaurant.locale'))localStorage.setItem('restaurant.locale','en');});
    const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
    await bounded(run({page,context,origin,fixture,errors}),`recovery scenario ${name}`,90000);
    await mkdir(evidence,{recursive:true});await page.screenshot({path:resolve(evidence,`recovery-${name}.png`),fullPage:true});
    assert.deepEqual(fixture.unexpected,[]);assert.deepEqual(errors,[]);
    console.log(`Verified compiled React recovery: ${name}`);
  }finally{
    // Unblock synthetic responses before closing the browser context. A failed
    // selector or assertion must not leave cleanup waiting on a held request.
    fixture.releaseAll();
    try{if(context)await bounded(context.close(),'fixture context cleanup');}
    finally{server.closeAllConnections();await bounded(new Promise(resolve=>server.close(resolve)),'fixture server cleanup');}
  }
}

async function addDish(page,name){
  await page.getByRole('button',{name,exact:true}).click();
  const dialog=page.getByRole('dialog',{name,exact:true});
  await dialog.getByRole('button',{name:/^Add to order/}).click();
}
async function startCheckout(page,origin){
  await page.goto(`${origin}/?table=${tableCode}`);
  await addDish(page,'Synthetic dish A');
  await page.getByRole('button',{name:'Your order',exact:true}).click();
  await page.getByRole('heading',{name:'Complete your order',exact:true}).waitFor();
  await page.getByLabel('Table QR link or code',{exact:true}).fill(tableCode);
  await page.getByRole('radio',{name:'Cash after the meal',exact:true}).check();
  await page.getByRole('button',{name:'Review order',exact:true}).click();
  await page.getByRole('button',{name:/^Confirm order/}).waitFor();
}
async function login(page,id){
  await page.getByLabel('Username',{exact:true}).fill(id);
  await page.getByLabel('Password',{exact:true}).fill('synthetic-password-only');
  await page.locator('form').getByRole('button',{name:'Sign in',exact:true}).last().click();
  await page.getByRole('heading',{name:customer(id).displayName,exact:true}).waitFor();
}

export async function checkStorefrontRecovery({browser,root,evidence}){
  await scenario(browser,root,evidence,'tracking-newer-lookup',{},async({page,context,origin,fixture})=>{
    const first=fixture.orders.get('R00000001').receipt, second=fixture.orders.get('R00000002').receipt;
    const delayed=fixture.hold('GET',`/orders/${first.order.number}`);
    // Deliberately ignore cancellation for this one synthetic GET, proving the
    // generation fence even for transports that deliver a response after abort.
    await context.addInitScript(({origin,number})=>{
      const original=window.fetch.bind(window);
      window.fetch=(input,init)=>{
        const url=new URL(typeof input==='string'?input:input.url,location.href);
        return original(input,url.origin===origin&&url.pathname===`/storefront-api/orders/${number}`?{...init,signal:undefined}:init);
      };
    },{origin,number:first.order.number});
    await page.goto(`${origin}/track?order=${first.order.number}#token=${first.trackingToken}`);
    await entered(delayed);
    await page.getByLabel('Order number',{exact:true}).fill(second.order.number);
    await page.getByLabel('Access code',{exact:true}).fill(second.accessCode);
    await page.getByRole('button',{name:'Find my order',exact:true}).click();
    await page.getByRole('heading',{name:`Order number ${second.order.number}`,exact:true}).waitFor();
    const late=page.waitForResponse(response=>new URL(response.url()).pathname===`/storefront-api/orders/${first.order.number}`);
    delayed.release();await(await late).finished();await settled(page);
    assert.equal(await page.getByRole('heading',{name:`Order number ${first.order.number}`,exact:true}).count(),0);
    assert.equal(await page.getByRole('heading',{name:`Order number ${second.order.number}`,exact:true}).isVisible(),true);
    assert.equal(new URL(page.url()).searchParams.get('order'),second.order.number);
    assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('token'),second.trackingToken);
    assert.equal(originalPosts(fixture).length,0);
  });

  await scenario(browser,root,evidence,'late-success-new-cart',{},async({page,origin,fixture})=>{
    let dismiss=true, dialogs=0;
    page.on('dialog',dialog=>{dialogs++;return dismiss?dialog.dismiss():dialog.accept();});
    await startCheckout(page,origin);
    const delayed=fixture.hold('POST','/orders');
    await page.getByRole('button',{name:/^Confirm order/}).click();await entered(delayed);
    const before=await storage(page,pendingKey), request=originalPosts(fixture)[0];
    assert.equal(before.key,request.headers['idempotency-key']);assert.deepEqual(before.input,request.body);
    await page.locator('a.rs-brand').click();
    assert.equal(new URL(page.url()).pathname,'/order','cancelled navigation stays in checkout');
    dismiss=false;await page.locator('a.rs-brand').click();
    await addDish(page,'Synthetic dish B');await settled(page);
    const changed=await cart(page);assert.deepEqual(changed.map(line=>line.itemId),['dish-A','dish-B']);
    const accepted=page.waitForResponse(response=>new URL(response.url()).pathname==='/storefront-api/orders'&&response.request().method()==='POST');
    delayed.release();await(await accepted).finished();
    await page.waitForFunction(key=>!!JSON.parse(sessionStorage.getItem(key)??'null')?.receipt,pendingKey);
    await settled(page);
    assert.equal(new URL(page.url()).pathname,'/');assert.deepEqual(await cart(page),changed);
    await mkdir(evidence,{recursive:true});await page.screenshot({path:resolve(evidence,'recovery-late-success-cart.png'),fullPage:true});
    assert.ok(dialogs>=2);
    const known=await storage(page,pendingKey);assert.deepEqual(known.input,before.input);assert.equal(known.key,before.key);
    await page.goBack();
    await page.getByText('Your order was received. Open its tracking page to view the receipt; it will not be submitted again.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Follow your order',exact:true}).click();
    await page.getByRole('heading',{name:`Order number ${known.receipt.number}`,exact:true}).waitFor();
    assert.equal(originalPosts(fixture).length,1);assert.equal(fixture.submissions.size,1);
    assert.equal(await storage(page,pendingKey),null);assert.deepEqual(await cart(page),changed);
    await page.goBack();await page.getByRole('heading',{name:'Complete your order',exact:true}).waitFor();
    await page.goForward();await page.getByRole('heading',{name:`Order number ${known.receipt.number}`,exact:true}).waitFor();
    assert.equal(originalPosts(fixture).length,1,'Back/Forward must not replay checkout');
  });

  for(const lateStatus of [200,401])await scenario(browser,root,evidence,`late-${lateStatus}-account-switch`,{initialCustomer:customer('customer-A')},async({page,origin,fixture})=>{
    page.on('dialog',dialog=>dialog.accept());
    await startCheckout(page,origin);
    const delayed=fixture.hold('POST','/orders');
    await page.getByRole('button',{name:/^Confirm order/}).click();await entered(delayed);
    const original=await storage(page,pendingKey), firstPost=originalPosts(fixture)[0];
    await page.getByRole('button',{name:'My account',exact:true}).click();
    await page.getByRole('heading',{name:'Customer A',exact:true}).waitFor();
    await page.getByRole('button',{name:'Sign out',exact:true}).click();
    await login(page,'customer-B');
    const result=page.waitForResponse(response=>new URL(response.url()).pathname==='/storefront-api/orders'&&response.request().method()==='POST');
    delayed.release(lateStatus===401?{status:401,body:{error:'session_expired'}}:undefined);await(await result).finished();await settled(page);
    assert.equal(new URL(page.url()).pathname,'/account');
    assert.equal(await page.getByRole('heading',{name:'Customer B',exact:true}).isVisible(),true);
    await mkdir(evidence,{recursive:true});await page.screenshot({path:resolve(evidence,`recovery-late-${lateStatus}-account-B.png`),fullPage:true});
    const retained=await storage(page,pendingKey);assert.equal(retained.customerId,'customer-A');assert.equal(retained.key,original.key);assert.deepEqual(retained.input,original.input);
    assert.equal(!!retained.receipt,lateStatus===200);
    await page.getByRole('button',{name:'Your order',exact:true}).click();
    await page.getByRole('button',{name:lateStatus===200?'Follow your order':'Try again',exact:true}).click();
    await page.getByText('Please sign in again to continue.',{exact:true}).waitFor();
    assert.equal(originalPosts(fixture).length,1,'foreign account must not replay the old submission');
    assert.equal(fixture.requests.filter(request=>request.method==='GET'&&/^\/orders\/R00000011$/.test(request.path)).length,0,'foreign account must not read the retained receipt');
    await page.getByRole('button',{name:'My account',exact:true}).click();
    await page.getByRole('button',{name:'Sign out',exact:true}).click();await login(page,'customer-A');
    await page.getByRole('button',{name:'Your order',exact:true}).click();
    await page.getByRole('button',{name:lateStatus===200?'Follow your order':'Try again',exact:true}).click();
    await page.getByRole('heading',{name:'Order number R00000011',exact:true}).waitFor();
    const posts=originalPosts(fixture);assert.equal(posts.length,lateStatus===200?1:2);
    for(const post of posts){assert.equal(post.headers['idempotency-key'],firstPost.headers['idempotency-key']);assert.deepEqual(post.body,firstPost.body);}
    assert.equal(fixture.submissions.size,1);assert.equal(await storage(page,pendingKey),null);
  });
}
