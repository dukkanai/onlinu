import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,generateKeyPairSync} from 'node:crypto';
import {createServer,request as httpRequest} from 'node:http';
import pg from 'pg';
import {createControlPlane} from './control-plane.mjs';
import {NATIVE_CLIENT_ID,NATIVE_SCOPE,pkceChallenge} from './auth.mjs';

test('native HTTP consent, audience isolation, membership limits and own-device revocation',{skip:!process.env.IDENTITY_TEST_DATABASE_URL},async t=>{
 const url=new URL(process.env.IDENTITY_TEST_DATABASE_URL);assert.equal(url.pathname,'/astracalls_identity_test');assert.equal(url.searchParams.has('dbname'),false);
 const schema='native_http_'+randomBytes(8).toString('hex'),admin=new pg.Pool({connectionString:url.href});await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new pg.Pool({connectionString:url.href,options:`-c search_path=${schema}`,max:12}),base='https://platform.example',issuer='https://identity.example/';
 let server;
 t.after(async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
 const {privateKey}=generateKeyPairSync('ed25519');
 const app=await createControlPlane({pool,baseUrl:base,csrfKey:randomBytes(32).toString('base64'),serviceSigningKey:privateKey,nativeStaffEnabled:true,trustedProxyCidrs:['127.0.0.1/32'],
  oidc:{issuer,clientId:'test',clientSecret:'synthetic-secret-never-production'},restaurants:[{id:'a',name:'A',cuisine:'saudi',baseUrl:'http://127.0.0.1:9'},{id:'b',name:'B',cuisine:'saudi',baseUrl:'http://127.0.0.1:10'}]},
  {oidcClientAdapter:{async authorizationUrl(){return issuer+'authorize';},async exchange(){throw Error('unused');}}});
 server=createServer(app.handle);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const local='http://127.0.0.1:'+server.address().port;
 const make=async subject=>{const identity=await app.directory.verifiedIdentity({issuer,subject});const session=await app.auth.issue(identity.id,undefined,{kind:'browser'}),cookie='__Host-platform_session='+session.accessToken;return{...identity,cookie,csrf:app.auth.csrfToken({headers:{cookie}})};};
 const alice=await make('alice'),bob=await make('bob'),outsider=await make('outsider'),limited=await make('limited-operator');
 await pool.query('UPDATE platform_identities SET platform_admin=TRUE WHERE id=$1',[alice.id]);
 await app.directory.createTenant(alice.id,{id:'a',name:'A',ownerId:alice.id});await app.directory.setTenantStatus(alice.id,'a',{status:'active',expectedVersion:1});
 await app.directory.createTenant(alice.id,{id:'b',name:'B',ownerId:bob.id});await app.directory.setTenantStatus(alice.id,'b',{status:'active',expectedVersion:1});
 await app.directory.setMembership(alice.id,'a',limited.id,{role:'kitchen',enabled:true,expectedVersion:null});
 await pool.query('UPDATE platform_identities SET platform_admin=TRUE WHERE id=$1',[limited.id]);
 const send=(path,{method='GET',who,token,body,headers={}}={})=>new Promise((resolve,reject)=>{
  const request=httpRequest(local+path,{method,headers:{host:'platform.example',accept:'application/json',...(who?{cookie:who.cookie}:{}),...(token?{authorization:'Bearer '+token}:{}),...(body?{'content-type':'application/json'}:{}),...(method!=='GET'&&who?{origin:base}:{}),...headers}},response=>{
   const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{const raw=Buffer.concat(chunks).toString('utf8');let data;try{data=JSON.parse(raw);}catch{data=raw;}resolve({status:response.statusCode,data,headers:response.headers});});
  });request.on('error',reject);request.end(body?JSON.stringify(body):undefined);
 });
 const input=()=>{const verifier=randomBytes(32).toString('base64url');return{verifier,grant:{client_id:NATIVE_CLIENT_ID,redirect_uri:'http://127.0.0.1:43123/oauth/callback',resource:base+'/native/api',response_type:'code',scope:NATIVE_SCOPE,state:randomBytes(24).toString('base64url'),code_challenge_method:'S256',code_challenge:pkceChallenge(verifier)}};};
 const authorize=async who=>{const pending=input();const reply=await send('/native/oauth/authorize',{method:'POST',who,body:{...pending.grant,csrf:who.csrf,approve:'yes'}});assert.equal(reply.status,303,JSON.stringify(reply.data));const callback=new URL(reply.headers.location);assert.equal(callback.searchParams.get('state'),pending.grant.state);return{...pending,code:callback.searchParams.get('code')};};
 const tokenBody=pending=>({grant_type:'authorization_code',client_id:NATIVE_CLIENT_ID,redirect_uri:pending.grant.redirect_uri,resource:pending.grant.resource,code:pending.code,code_verifier:pending.verifier});
 const login=async who=>{const pending=await authorize(who),reply=await send('/native/oauth/token',{method:'POST',body:tokenBody(pending)});assert.equal(reply.status,200,JSON.stringify(reply.data));return reply.data;};
 const customerToken=(await app.auth.issue(alice.id,['orders:read'])).accessToken;
 await t.test('metadata and consent require the registered browser flow, not customer bearer access',async()=>{
  const meta=await send('/.well-known/oauth-authorization-server/native');assert.equal(meta.status,200);assert.equal(meta.data.issuer,base+'/native');assert.equal(meta.data.registration_endpoint,undefined);assert.equal((await send('/.well-known/oauth-protected-resource/native/api')).data.resource,base+'/native/api');
  assert.equal((await send('/native/oauth/register',{method:'POST',body:{}})).status,404);
  const {grant}=input(),path='/native/oauth/authorize?'+new URLSearchParams(grant);
  const missing=await send(path);assert.equal(missing.status,302);assert.equal((await send(missing.headers.location)).status,302);
  assert.equal((await send(path,{token:customerToken})).status,403);
  assert.equal((await send(path,{who:outsider})).status,403);
  const consent=await send(path,{who:alice});assert.equal(consent.status,200);assert.match(consent.data,/ربط تطبيق الإدارة/);assert.match(consent.headers['content-security-policy'],/http:\/\/127\.0\.0\.1:43123/);
  assert.equal((await send('/native/oauth/authorize',{method:'POST',who:alice,body:{...grant,csrf:'bad',approve:'yes'}})).status,403);
  const denied=await send('/native/oauth/authorize',{method:'POST',who:alice,body:{...grant,csrf:alice.csrf,approve:'no'}});assert.equal(denied.status,303);assert.equal(new URL(denied.headers.location).searchParams.get('error'),'access_denied');
 });
 const pending=await authorize(alice);
 await t.test('native token exchange excludes ambient browser credentials and is single-use',async()=>{
  assert.equal((await send('/native/oauth/token',{method:'POST',who:alice,body:tokenBody(pending)})).status,403);
  assert.equal((await send('/native/oauth/token',{method:'POST',body:tokenBody(pending),headers:{origin:base}})).status,403);
 });
 const exchanged=await send('/native/oauth/token',{method:'POST',body:tokenBody(pending)});assert.equal(exchanged.status,200);const session=exchanged.data;
 await t.test('native API uses current restaurant membership even for platform operators',async()=>{
  assert.equal((await send('/native/oauth/token',{method:'POST',body:tokenBody(pending)})).status,400);
  const me=await send('/native/api/me',{token:session.access_token});assert.equal(me.status,200);assert.equal(me.data.principal.id,alice.id);assert.equal(me.data.principal.memberships[0].tenantName,'A');assert.equal(me.data.csrfToken,undefined);
  assert.equal((await send('/native/api/me',{who:alice})).status,403);assert.equal((await send('/native/api/me',{token:customerToken})).status,401);
  assert.equal((await send('/api/me',{token:session.access_token})).status,403);
  assert.equal((await send('/native/api/restaurants/a/members',{token:session.access_token})).status,200);
  assert.equal((await send('/native/api/restaurants/b/members',{token:session.access_token})).status,403);
  assert.equal((await send('/native/api/platform/restaurants',{method:'POST',token:session.access_token,body:{}})).status,403);
  const limitedSession=await login(limited);assert.equal((await send('/native/api/restaurants/a/members',{token:limitedSession.access_token})).status,403,'Native membership cannot inherit unrelated platform-admin authority');
 });
 await t.test('browser can revoke only its own native grants, including after staff access is removed',async()=>{
  const listed=await send('/native/sessions',{who:alice});assert.equal(listed.status,200);assert.equal(listed.data.includes(session.access_token),false);
  const grant=(await app.nativeStaff.auth.nativeGrants(alice.id))[0];
  assert.equal((await send('/native/sessions/'+grant.id,{method:'POST',who:bob,body:{csrf:bob.csrf}})).status,404);
  assert.equal((await send('/native/sessions/'+grant.id,{method:'POST',who:alice,body:{csrf:'bad'}})).status,403);
  await pool.query('UPDATE platform_memberships SET enabled=FALSE WHERE tenant_id=$1 AND principal_id=$2',['a',alice.id]);
  assert.equal((await send('/native/api/me',{token:session.access_token})).status,401);
  assert.equal((await send('/native/sessions/all',{method:'POST',who:alice,body:{csrf:alice.csrf}})).status,303);
  await pool.query('UPDATE platform_memberships SET enabled=TRUE WHERE tenant_id=$1 AND principal_id=$2',['a',alice.id]);
  assert.equal((await send('/native/api/me',{token:session.access_token})).status,401);assert.equal((await send('/api/me',{who:alice})).status,200);
 });
 await t.test('HTTP proxy rate budgets isolate clients and return bounded retry advice',async()=>{
  const path='/.well-known/oauth-authorization-server/native';
  for(let i=0;i<240;i++)assert.equal((await send(path,{headers:{'x-forwarded-for':'198.51.100.40'}})).status,200);
  const limited=await send(path,{headers:{'x-forwarded-for':'203.0.113.80, 198.51.100.40'}});
  assert.equal(limited.status,429);assert.equal(limited.data.error,'rate_limited');
  assert.ok(Number(limited.headers['retry-after'])>=1&&Number(limited.headers['retry-after'])<=60);
  assert.equal((await send(path,{headers:{'x-forwarded-for':'198.51.100.41'}})).status,200);
  assert.equal((await send(path,{headers:{'x-forwarded-for':'invalid'}})).status,400);
 });

});
