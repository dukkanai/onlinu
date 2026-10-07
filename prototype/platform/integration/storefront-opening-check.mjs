// Original compiled React UI with isolated synthetic, read-only HTTP responses.
// This proves renderer/control behavior, not a real provider or production site.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {effectiveBrand} from '../../../client/src/restaurant/brand.ts';
const root=fileURLToPath(new URL('../../../client/dist/',import.meta.url));
const evidence=fileURLToPath(new URL('../../../artifacts/storefront-opening/',import.meta.url));
const settings={name:'Synthetic hours restaurant',description:'',address:'',phone:'',logoUrl:'',coverUrl:'',currency:'SAR',country:'SA',defaultLanguage:'en',menuLanguage:'en',demo:true,acceptingOrders:true,deliveryEnabled:true,pickupEnabled:true,tableEnabled:true,deliveryPricingMode:'flat',deliveryZones:[],deliveryFeeMinor:0,deliveryMinimumMinor:0,deliveryAreas:[],deliveryRadiusKm:0,latitude:null,longitude:null,requireDeliveryLocation:false,pickupInstructions:'',paymentInstructions:'',openingHours:'Informational text only',taxEnabled:false,taxRateBps:0,taxNumber:'',paymentMethods:{table:['cash_after'],delivery:['cash_on_delivery'],pickup:['card']}};
const brand=effectiveBrand(settings);
const catalog={version:1,settings,categories:[{id:'main',name:'Synthetic dishes',sort:0}],items:[{id:'rice',categoryId:'main',name:'Synthetic rice',description:'Test only',priceMinor:1000,imageUrl:'',available:true,sort:0,options:[]}],tables:[]};
let mode='closed',publicReads=0;const unexpected=[];
const json=(res,value,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1');
  if(req.method!=='GET'){unexpected.push('non-read request '+url.pathname);return json(res,{error:'not_found'},404);}
  if(url.pathname.startsWith('/storefront-api/')){
   publicReads++;if(req.headers['x-api-key'])unexpected.push('public credential leak');
   if(url.pathname==='/storefront-api/catalog')return json(res,catalog);
   if(url.pathname==='/storefront-api/account')return json(res,{customer:null});
   if(url.pathname==='/storefront-api/opening-status')return mode==='error'?json(res,{error:'temporary'},503):json(res,{version:1,scheduleEnabled:true,withinHours:mode==='open',acceptingOrders:mode==='open',timeZone:'Asia/Riyadh',evaluatedAt:new Date().toISOString()});
   if(url.pathname==='/storefront-api/payments')return json(res,{providers:[]});
   unexpected.push('unexpected public route '+url.pathname);return json(res,{error:'not_found'},404);
  }
  const asset=url.pathname.startsWith('/assets/')||url.pathname.startsWith('/fonts/')||url.pathname.startsWith('/icons/');
  const file=asset?resolve(root,'.'+decodeURIComponent(url.pathname)):resolve(root,'index.html');
  if(!file.startsWith(root.endsWith(sep)?root:root+sep))throw Error('outside fixture');
  const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png'}[extname(file)]??'application/octet-stream';
  const bytes=await readFile(file);res.writeHead(200,{'content-type':mime,'cache-control':'no-store'});res.end(bytes);
 }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
let browser;
try{
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking']});
 const context=await browser.newContext({viewport:{width:390,height:844},locale:'en-US'});
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():(unexpected.push('external request'),route.abort()));
 await context.addInitScript(()=>{if(!localStorage.getItem('restaurant.locale'))localStorage.setItem('restaurant.locale','en');});
 const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>unexpected.push(error.message));
 const unknown='Order acceptance could not be verified. You can browse and track existing orders; retry before placing a new order.';
 const closed='The restaurant is not accepting new orders right now.';
 for(const template of ['classic','bistro','editorial','compact','showcase']){
  settings.brand={...brand,storefrontTemplate:template};mode='closed';await page.goto(origin);
  await page.getByText(closed,{exact:true}).waitFor();
  await page.getByRole('button',{name:'Synthetic rice',exact:true}).click();
  let dialog=page.getByRole('dialog',{name:'Synthetic rice',exact:true});
  assert.equal(await dialog.getByRole('button',{name:/^Add to order/}).isDisabled(),true,template+' ignores scheduled closure');
  await dialog.getByRole('button',{name:'Close',exact:true}).click();
  mode='error';await page.reload();await page.getByText(unknown,{exact:true}).waitFor();
  assert.equal(await page.getByText(closed,{exact:true}).count(),0,'unknown must not be called closed');
  mode='open';await page.getByRole('button',{name:'Try again',exact:true}).click();await page.getByText(unknown,{exact:true}).waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Synthetic rice',exact:true}).click();dialog=page.getByRole('dialog',{name:'Synthetic rice',exact:true});
  assert.equal(await dialog.getByRole('button',{name:/^Add to order/}).isEnabled(),true);
  if(template==='classic'){
   mode='closed';await page.getByText(closed,{exact:true}).waitFor({timeout:40000});
   assert.equal(await dialog.getByRole('button',{name:/^Add to order/}).isDisabled(),true,'live closing poll must update an open dish dialog');
  }
  await dialog.getByRole('button',{name:'Close',exact:true}).click();
  const width=await page.evaluate(()=>({viewport:innerWidth,content:document.documentElement.scrollWidth}));assert.ok(width.content<=width.viewport+2,template+' overflow');
 }
 mode='closed';await page.locator('.restaurant-language select').first().selectOption('ar');await page.reload();
 await page.getByText('المطعم لا يستقبل طلبات جديدة حاليًا.',{exact:true}).waitFor();
 assert.equal(await page.locator('.restaurant-storefront').getAttribute('dir'),'rtl');
 await mkdir(evidence,{recursive:true});await page.screenshot({path:resolve(evidence,'arabic-closed.png'),fullPage:true});
 assert.ok(publicReads>15);assert.deepEqual(unexpected,[]);
 console.log('Verified five compiled React templates: scheduled closure, unknown read, explicit retry, live closing, Arabic RTL, no writes or external requests.');
 await context.close();
}finally{
 await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
