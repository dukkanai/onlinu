// Synthetic display-only evidence; no remote account, payment, or order mutation.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createCoreAdapter} from '../core-adapter.mjs';
import {createMcpHandler,MCP_PROTOCOL_VERSION} from '../mcp.mjs';
import {CORE_MENU_UI_RESOURCE_URI} from '../core-menu-ui.mjs';
const fixture=JSON.parse(process.env.INTELLIGENT_UI_CORE_FIXTURE);
const adapter=createCoreAdapter({restaurants:[{id:'intelligent-ui-demo',name:'مطعم تجربة الواجهة الذكية',cuisine:'synthetic',baseUrl:fixture.baseUrl}]});
let handler;
const server=createServer((req,res)=>handler(req,res));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
handler=createMcpHandler({baseUrl:base,authenticate:async()=>null,coreAdapter:adapter});
let id=0;
async function rpc(method,params={}) {
 const response=await fetch(`${base}/mcp`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',
  'MCP-Protocol-Version':MCP_PROTOCOL_VERSION,'Mcp-Method':method,...(params.name||params.uri?{'Mcp-Name':params.name??params.uri}:{})},
  body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':MCP_PROTOCOL_VERSION,
   'io.modelcontextprotocol/clientInfo':{name:'intelligent-ui-readonly-experiment',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}})});
 assert.equal(response.status,200);
 const result=await response.json();assert.equal(result.error,undefined);return result.result;
}
try {
 const tools=(await rpc('tools/list')).tools;
 assert.ok(tools.every(t=>t.annotations.readOnlyHint));
 assert.ok(!tools.some(t=>t.name==='prepare_checkout'||t.name==='create_order'));
 const tenantId='intelligent-ui-demo';
 const menu=(await rpc('tools/call',{name:'get_restaurant_menu',arguments:{tenantId}})).structuredContent;
 assert.equal(menu.settings.demo,true);assert.equal(menu.settings.currency,'SAR');
 assert.equal(menu.items.some(item=>item.id==='unavailable'),false);
 const scenarios=[
  {id:'two-meals',items:[{itemId:'chicken',quantity:1},{itemId:'beef',quantity:1}],expectedTotalMinor:7000},
  {id:'two-meals-extras',items:[{itemId:'chicken',quantity:1,optionIds:['extra-rice']},{itemId:'beef',quantity:1,optionIds:['extra-rice']}],expectedTotalMinor:8000},
  {id:'three-chicken-over-budget',items:[{itemId:'chicken',quantity:3}],expectedTotalMinor:9600},
  {id:'cheaper-choice',items:[{itemId:'chicken',quantity:1},{itemId:'vegetable',quantity:1}],expectedTotalMinor:5800},
 ];
 const quotes=[];
 for(const scenario of scenarios){
  const result=await rpc('tools/call',{name:'quote_cart',arguments:{tenantId,mode:'pickup',items:scenario.items}});
  assert.ok(!result.isError);assert.equal(result.structuredContent.totalMinor,scenario.expectedTotalMinor);
  assert.equal(result.structuredContent.currency,'SAR');
  assert.deepEqual(result.structuredContent.paymentMethods,[], 'Price previews do not promise checkout readiness');
  quotes.push({scenario:scenario.id,input:{mode:'pickup',items:scenario.items},quote:result.structuredContent});
 }
 const denied=await rpc('tools/call',{name:'quote_cart',arguments:{tenantId,mode:'pickup',items:[{itemId:'unavailable',quantity:1}]}});
 assert.equal(denied.isError,true);
 // The resource and callbacks below come through the real local MCP server and
 // Go/PostgreSQL fixture. Only ChatGPT's outer iframe host is simulated.
 assert.equal(tools.find(tool=>tool.name==='get_restaurant_menu')._meta.ui.resourceUri,CORE_MENU_UI_RESOURCE_URI);
 const resource=(await rpc('resources/read',{uri:CORE_MENU_UI_RESOURCE_URI})).contents[0];
 assert.equal(resource.mimeType,'text/html;profile=mcp-app');
 if(process.env.CORE_BROWSER_TEST==='1'){
  const {chromium}=await import('playwright-core');
  const {openCoreMenuHarness}=await import('./core-menu-browser-harness.mjs');
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH??'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking']});
  try{
   const h=await openCoreMenuHarness({browser,html:resource.text,initialResult:{structuredContent:menu},callTool:async(name,args)=>{
    assert.ok(['quote_cart','get_restaurant_menu'].includes(name),'Preview must never invoke checkout or a write tool');
    return rpc('tools/call',{name,arguments:args});
   }});
   try{
    const f=h.frame;
    await f.getByRole('button',{name:'زيادة وجبة دجاج',exact:true}).click();
    await f.getByRole('button',{name:'زيادة وجبة لحم',exact:true}).click();
    await f.locator('#quote[data-total-minor="7000"]').waitFor();
    await f.locator('[data-item-id="chicken"] [data-option-id="extra-rice"]').check();
    await f.locator('[data-item-id="beef"] [data-option-id="extra-rice"]').check();
    await f.locator('#quote[data-total-minor="8000"]').waitFor();
    assert.match(await f.locator('#quote').textContent(),/لا توجد وسيلة دفع/);
    if(process.env.CORE_MENU_SCREENSHOT){await mkdir(dirname(process.env.CORE_MENU_SCREENSHOT),{recursive:true});await h.page.screenshot({path:process.env.CORE_MENU_SCREENSHOT,fullPage:true});}
    await f.locator('#reset').click();
    assert.equal(await f.locator('#quote').getAttribute('data-total-minor'),null);
    assert.ok(h.calls.length>=2);assert.ok(h.calls.every(call=>call.name==='quote_cart'));
    assert.deepEqual(h.errors,[]);assert.deepEqual(h.requests,[]);
    console.log('Real Go/PostgreSQL → MCP → sandboxed browser menu/quote path passed; actual ChatGPT host rendering is still a separate deployment check.');
   }finally{await h.close();}
  }finally{await browser.close();}
 }
 const pack={schemaVersion:1,synthetic:true,displayOnly:true,ordersEnabled:false,paymentsEnabled:false,
  currency:'SAR',budgetMinor:8000,moneyUnit:'100 minor units = 1 SAR',
  note:'Static verified snapshots from an isolated real-core test, not a live merchant or live connection. Modified selections require a fresh authoritative quote before any purchase.',
  menu,quotes};
 const serialized=JSON.stringify(pack,null,2)+'\n';
 assert.ok(!/restaurant-test-master|postgres:\/\/|127\.0\.0\.1|trackingToken|accessCode|customerName|nationalAddress/.test(serialized));
 if(process.env.INTELLIGENT_UI_EVIDENCE_FILE)await writeFile(process.env.INTELLIGENT_UI_EVIDENCE_FILE,serialized,{flag:'wx',mode:0o600});
 console.log('Synthetic menu, versioned MCP Apps resource and four authoritative MCP quote snapshots verified; unavailable item denied.');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
