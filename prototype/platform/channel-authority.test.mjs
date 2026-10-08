import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,generateKeyPairSync} from 'node:crypto';
import {createServer,request as httpRequest} from 'node:http';
import pg from 'pg';
import {createControlPlane} from './control-plane.mjs';

test('browser and staff management writes reject authority revoked during streamed bodies', {
 skip:!process.env.IDENTITY_TEST_DATABASE_URL, timeout:30000,
},async t=>{
 const url=new URL(process.env.IDENTITY_TEST_DATABASE_URL);
 assert.equal(url.pathname,'/astracalls_identity_test');assert.equal(url.searchParams.has('dbname'),false);
 const schema='channel_authority_'+randomBytes(8).toString('hex');
 const admin=new pg.Pool({connectionString:url.href});await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new pg.Pool({connectionString:url.href,options:`-c search_path=${schema}`,max:8});
 let server,coreServer,writes=0,menuReads=0,mediaUploads=0,menuWrites=0;
 let coreHook=async()=>{};
 const menu={version:4,currency:'SAR',categories:[{id:'main',name:'Main',sort:0}],item:{id:'rice',categoryId:'main',name:'Rice',description:'',priceMinor:1000,imageUrl:'',available:true,sort:0,options:[]}};
 t.after(async()=>{
  for(const s of [server,coreServer])if(s){s.closeAllConnections();await new Promise(resolve=>s.close(resolve));}
  await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
 });
 coreServer=createServer(async(req,res)=>{
  for await(const unused of req){};
  res.setHeader('content-type','application/json');
  if(req.method==='GET'&&req.url==='/platform-api/staff/menu/items/rice'){menuReads++;await coreHook('read');res.end(JSON.stringify(menu));return;}
  if(req.method==='POST'&&req.url==='/platform-api/staff/images'){mediaUploads++;await coreHook('upload');res.end(JSON.stringify({url:'/restaurant-media/'+'a'.repeat(64)+'.png'}));return;}
  if(req.method==='POST'&&req.url==='/platform-api/staff/menu/items/rice'){menuWrites++;await coreHook('patch');res.end(JSON.stringify({...menu,version:5}));return;}
  writes++;
  assert.equal(req.url,'/platform-api/staff/channels/web');
  assert.match(req.headers.authorization,/^Platform /);
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({channel:'web',newOrdersEnabled:true,adapterImplemented:true,version:2,updatedAt:new Date().toISOString()}));
 });
 await new Promise(resolve=>coreServer.listen(0,'127.0.0.1',resolve));
 const base='https://platform.example',issuer='https://identity.example/';
 const {privateKey}=generateKeyPairSync('ed25519');
 const app=await createControlPlane({pool,baseUrl:base,csrfKey:randomBytes(32).toString('base64'),serviceSigningKey:privateKey,
  oidc:{issuer,clientId:'channel-test',clientSecret:'synthetic-secret-never-production'},
  restaurants:[{id:'a',name:'A',cuisine:'saudi',baseUrl:'http://127.0.0.1:'+coreServer.address().port}],
 },{oidcClientAdapter:{async authorizationUrl(){return issuer+'authorize';},async exchange(){throw Error('unused');}}});
 const root=await app.directory.verifiedIdentity({issuer,subject:'operator'});
 await pool.query('UPDATE platform_identities SET platform_admin=TRUE WHERE id=$1',[root.id]);
 const owner=await app.directory.verifiedIdentity({issuer,subject:'owner'});
 const staff=await app.directory.verifiedIdentity({issuer,subject:'staff'});
 await app.directory.createTenant(root.id,{id:'a',name:'A',ownerId:owner.id});
 let tenantVersion=(await app.directory.setTenantStatus(root.id,'a',{status:'active',expectedVersion:1})).version;
 const cases=[
  {path:'channels/web',permission:'channels:manage',browser:{newOrdersEnabled:'true'},api:{newOrdersEnabled:true}},
  {path:'service',permission:'settings:update',browser:{reviewed:'yes',acceptingOrders:'true',deliveryEnabled:'true',pickupEnabled:'true',tableEnabled:'false'},api:{acceptingOrders:true,deliveryEnabled:true,pickupEnabled:true,tableEnabled:false}},
  {path:'profile',permission:'settings:update',browser:{reviewed:'yes',name:'A',description:'',address:'',phone:'',openingHours:'',pickupInstructions:''},api:{name:'A',description:'',address:'',phone:'',openingHours:'',pickupInstructions:''}},
 ];
 let memberVersion=null,permission='channels:manage';
 const membership=async enabled=>{memberVersion=(await app.directory.setMembership(owner.id,'a',staff.id,{role:'manager',permissions:[permission],enabled,expectedVersion:memberVersion})).version;};
 const session=await app.auth.issue(staff.id,undefined,{kind:'browser'}),cookie='__Host-platform_session='+session.accessToken;
 const csrf=app.auth.csrfToken({headers:{cookie}});
 let observed;
 const authorize=app.directory.authorize;
 app.directory.authorize=async(...args)=>{const result=await authorize(...args);if(observed){const resolve=observed;observed=undefined;resolve();}return result;};
 server=createServer(app.handle);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const local='http://127.0.0.1:'+server.address().port;
 function slowRequest(surface,spec=cases[0]){
  const browser=surface==='browser';let request;
  const full=browser?new URLSearchParams({...spec.browser,csrf,expectedVersion:'1'}).toString():JSON.stringify({...spec.api,expectedVersion:1});
  const suffix=browser?'1':'1}';assert.ok(full.endsWith(suffix));
  const response=new Promise((resolve,reject)=>{
   request=httpRequest(local+(browser?'/manage/a/'+spec.path:'/api/restaurants/a/staff/'+spec.path),{method:'POST',headers:{host:'platform.example',origin:base,cookie,'x-csrf-token':csrf,'content-type':browser?'application/x-www-form-urlencoded':'application/json'}},res=>{
    const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const text=Buffer.concat(chunks).toString();resolve({status:res.statusCode,data:text?JSON.parse(text):null});});
   });
   request.on('error',reject);request.setTimeout(8000,()=>request.destroy(Error('fixture request timeout')));
   request.write(full.slice(0,-suffix.length));
  });
  return{response,finish:()=>request.end(suffix)};
 }
 for(const spec of cases){
 permission=spec.permission;
 for(const surface of ['browser','staff-api']){
  for(const change of ['permission','suspension'])await t.test(spec.path+' '+surface+' '+change,async()=>{
   await membership(true);
   const authorized=new Promise(resolve=>{observed=resolve;});
   const pending=slowRequest(surface,spec);
   await Promise.race([authorized,pending.response.then(()=>{throw Error('request completed before body was released');})]);
   if(change==='permission')await membership(false);
   else tenantVersion=(await app.directory.setTenantStatus(root.id,'a',{status:'suspended',expectedVersion:tenantVersion})).version;
   const before=writes;pending.finish();const result=await pending.response;
   assert.equal(result.status,403);assert.equal(result.data.error,change==='permission'?'forbidden':'tenant_suspended');assert.equal(writes,before);
   if(change==='suspension')tenantVersion=(await app.directory.setTenantStatus(root.id,'a',{status:'active',expectedVersion:tenantVersion})).version;
  });
 }
 }
 assert.equal(writes,0);
 permission='channels:manage';await membership(true);
 for(const surface of ['browser','staff-api']){
  const pending=slowRequest(surface);pending.finish();const result=await pending.response;
  assert.equal(result.status,surface==='browser'?303:200);
 }
 assert.equal(writes,2);

 function managementRequest(path,bytes,contentType,hold=false){
  let request;
  const response=new Promise((resolve,reject)=>{
   request=httpRequest(local+path,{method:'POST',headers:{host:'platform.example',origin:base,cookie,'content-type':contentType}},res=>{
    const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const text=Buffer.concat(chunks).toString();resolve({status:res.statusCode,data:text?JSON.parse(text):null});});
   });
   request.on('error',reject);request.setTimeout(8000,()=>request.destroy(Error('fixture request timeout')));
   if(hold)request.write(bytes.subarray(0,-4));else request.end(bytes);
  });
  return{response,finish:()=>request.end(bytes.subarray(-4))};
 }
 const form=new FormData();form.set('csrf',csrf);form.set('expectedVersion','4');form.set('image',new Blob([Buffer.from([137,80,78,71])],{type:'image/png'}),'fixture.png');
 const encoded=new Response(form),imageBytes=Buffer.from(await encoded.arrayBuffer()),imageType=encoded.headers.get('content-type');
 permission='menu:update';
 for(const stage of ['body','read','upload','allowed'])await t.test('browser image '+stage,async()=>{
  await membership(true);const before={reads:menuReads,uploads:mediaUploads,writes:menuWrites};
  coreHook=async at=>{if(at===stage)await membership(false);};
  let authorized;
  if(stage==='body')authorized=new Promise(resolve=>{observed=resolve;});
  const pending=managementRequest('/manage/a/menu/items/rice/image',imageBytes,imageType,stage==='body');
  if(stage==='body'){
   await Promise.race([authorized,pending.response.then(()=>{throw Error('image completed before body released');})]);
   await membership(false);pending.finish();
  }
  const result=await pending.response;
  assert.equal(result.status,stage==='allowed'?303:403);
  assert.equal(menuReads-before.reads,stage==='body'?0:1);
  assert.equal(mediaUploads-before.uploads,['upload','allowed'].includes(stage)?1:0);
  assert.equal(menuWrites-before.writes,stage==='allowed'?1:0);
 });
 for(const revoked of [true,false])await t.test('browser option metadata authority '+revoked,async()=>{
  await membership(true);const before=menuWrites;
  coreHook=async stage=>{if(revoked&&stage==='read')await membership(false);};
  const bytes=Buffer.from(new URLSearchParams({csrf,expectedVersion:'4',id:'extra',name:'Extra',price:'1.00',available:'true'}).toString());
  const result=await managementRequest('/manage/a/menu/items/rice/options',bytes,'application/x-www-form-urlencoded').response;
  assert.equal(result.status,revoked?403:303);assert.equal(menuWrites-before,revoked?0:1);
 });
 coreHook=async()=>{};
});
