// Synthetic display-only evidence; no remote account, payment, or order mutation.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {writeFile} from 'node:fs/promises';
import {createCoreAdapter} from '../core-adapter.mjs';
import {createMcpHandler,MCP_PROTOCOL_VERSION} from '../mcp.mjs';
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
  'MCP-Protocol-Version':MCP_PROTOCOL_VERSION,'Mcp-Method':method,...(params.name?{'Mcp-Name':params.name}:{})},
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
  quotes.push({scenario:scenario.id,input:{mode:'pickup',items:scenario.items},quote:result.structuredContent});
 }
 const denied=await rpc('tools/call',{name:'quote_cart',arguments:{tenantId,mode:'pickup',items:[{itemId:'unavailable',quantity:1}]}});
 assert.equal(denied.isError,true);
 const pack={schemaVersion:1,synthetic:true,displayOnly:true,ordersEnabled:false,paymentsEnabled:false,
  currency:'SAR',budgetMinor:8000,moneyUnit:'100 minor units = 1 SAR',
  note:'Static verified snapshots from an isolated real-core test, not a live merchant or live connection. Modified selections require a fresh authoritative quote before any purchase.',
  menu,quotes};
 const serialized=JSON.stringify(pack,null,2)+'\n';
 assert.ok(!/restaurant-test-master|postgres:\/\/|127\.0\.0\.1|trackingToken|accessCode|customerName|nationalAddress/.test(serialized));
 if(process.env.INTELLIGENT_UI_EVIDENCE_FILE)await writeFile(process.env.INTELLIGENT_UI_EVIDENCE_FILE,serialized,{flag:'wx',mode:0o600});
 console.log('Synthetic menu and four authoritative MCP quote snapshots verified; unavailable item denied.');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
