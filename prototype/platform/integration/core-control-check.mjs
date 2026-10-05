import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import pg from 'pg';
import { createControlPlane } from '../control-plane.mjs';
import { MCP_PROTOCOL_VERSION } from '../mcp.mjs';

const fixture=JSON.parse(process.env.CORE_ORDER_FIXTURE);
const database=new URL(process.env.IDENTITY_TEST_DATABASE_URL);
assert.equal(database.pathname,'/astracalls_identity_test');assert.equal(database.searchParams.has('dbname'),false);
const schema=`core_flow_${randomBytes(8).toString('hex')}`;
const admin=new pg.Pool({connectionString:database.href});await admin.query(`CREATE SCHEMA ${schema}`);
const pool=new pg.Pool({connectionString:database.href,options:`-c search_path=${schema}`});
const baseUrl='https://platform.example',issuer='https://identity.example/';
let server;
try {
  const app=await createControlPlane({pool,baseUrl,csrfKey:randomBytes(32).toString('base64'),serviceSigningKey:fixture.privateKey,
    oidc:{issuer,clientId:'integration-test',clientSecret:'synthetic-client-secret-only'},
    restaurants:[{id:'restaurant-a',name:'Actual Go fixture',cuisine:'saudi',baseUrl:fixture.baseUrl}],
  },{oidcClientAdapter:{async authorizationUrl(){return `${issuer}authorize`;},async exchange(){throw Error('unused');}}});
  const make=async subject=>{
    const {id}=await app.directory.verifiedIdentity({issuer,subject});
    const browser=await app.auth.issue(id,undefined,{kind:'browser'}),oauth=await app.auth.issue(id,['orders:read','orders:write']);
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
  console.log('Verified MCP preview -> owned handoff -> CSRF-protected browser confirmation -> signed original Go order -> private MCP status; duplicate confirmation stays one order');
} finally {
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
}
