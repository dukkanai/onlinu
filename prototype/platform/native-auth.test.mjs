import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {createAuth,NATIVE_CLIENT_ID,NATIVE_SCOPE,pkceChallenge,hash} from './auth.mjs';
import {createIdentityDirectory} from './identity-directory.mjs';
import {ANDROID_CLIENT_ID,IOS_CLIENT_ID,mobileRedirects} from './native-client-policy.mjs';

test('native profile refuses fixture identity and exposes only bounded loopback PKCE metadata',async()=>{
 const config={pool:{query(){}},baseUrl:'https://platform.example/native',profile:'native_staff',csrfKey:randomBytes(32).toString('base64')};
 assert.throws(()=>createAuth(config),/invalid_native_auth_configuration/);
 assert.throws(()=>createAuth({...config,allowSyntheticAuthorization:false,principalResolver:async()=>null,redirectAllowlist:['https://evil.example']}),/invalid_native_auth_configuration/);
 const auth=createAuth({...config,allowSyntheticAuthorization:false,principalResolver:async()=>null});
 assert.equal(auth.metadata.registration_endpoint,undefined);assert.equal(auth.resourceMetadata.resource,'https://platform.example/native/api');assert.deepEqual(auth.metadata.scopes_supported,[NATIVE_SCOPE]);
 await assert.rejects(auth.register({redirect_uris:['http://127.0.0.1:12345/oauth/callback']}),{code:'registration_disabled'});
});

test('native PKCE grants, rotating refresh and customer-audience isolation on PostgreSQL',{skip:!process.env.IDENTITY_TEST_DATABASE_URL},async t=>{
 const url=new URL(process.env.IDENTITY_TEST_DATABASE_URL);assert.equal(url.pathname,'/astracalls_identity_test');assert.equal(url.searchParams.has('dbname'),false);
 const schema='native_auth_'+randomBytes(8).toString('hex'),admin=new pg.Pool({connectionString:url.href});await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new pg.Pool({connectionString:url.href,options:`-c search_path=${schema}`,max:10});
 t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
 const base='https://platform.example',issuer='https://identity.example/',csrfKey=randomBytes(32).toString('base64');
 const directory=createIdentityDirectory({pool,trustedIssuers:[issuer]});await directory.init();
 const owner=await directory.verifiedIdentity({issuer,subject:'native-owner'}),outsider=await directory.verifiedIdentity({issuer,subject:'no-memberships'});
 await pool.query('UPDATE platform_identities SET platform_admin=TRUE WHERE id=$1',[owner.id]);
 await directory.createTenant(owner.id,{id:'a',name:'A',ownerId:owner.id});await directory.setTenantStatus(owner.id,'a',{status:'active',expectedVersion:1});
 const customer=createAuth({pool,baseUrl:base,csrfKey,allowSyntheticAuthorization:false,principalResolver:directory.resolve,redirectAllowlist:['https://client.example/callback']});await customer.init();
 const resolveStaff=async id=>{const who=await directory.resolve(id);return who?.memberships.length?who:null;};
 const native=createAuth({pool,baseUrl:base+'/native',profile:'native_staff',csrfKey,allowSyntheticAuthorization:false,principalResolver:resolveStaff});await native.init();await native.init();
 const resource=base+'/native/api',redirect='http://127.0.0.1:43123/oauth/callback';
 const prepare=()=>{const verifier=randomBytes(32).toString('base64url');return{verifier,input:{client_id:NATIVE_CLIENT_ID,redirect_uri:redirect,resource,response_type:'code',code_challenge_method:'S256',code_challenge:pkceChallenge(verifier),state:randomBytes(24).toString('base64url'),scope:NATIVE_SCOPE}};};
 const pending=async()=>{const {input,verifier}=prepare();const callback=new URL(await native.authorize(input,owner));assert.equal(callback.searchParams.get('state'),input.state);assert.equal(callback.searchParams.get('iss'),base+'/native');return{grant_type:'authorization_code',client_id:NATIVE_CLIENT_ID,redirect_uri:redirect,resource,code:callback.searchParams.get('code'),code_verifier:verifier};};
 const grant=async()=>native.exchange(await pending());
 const who=(auth,token)=>auth.authenticate({headers:{authorization:'Bearer '+token}},{bearerOnly:true});
 const refresh=token=>native.exchange({grant_type:'refresh_token',client_id:NATIVE_CLIENT_ID,resource,refresh_token:token});
 await t.test('registered loopback varies only its non-privileged port',async()=>{
  const {input}=prepare();for(const uri of ['http://127.0.0.1:1024/oauth/callback','http://127.0.0.1:65535/oauth/callback'])await native.validateAuthorization({...input,redirect_uri:uri});
  for(const uri of ['http://127.0.0.1/oauth/callback','http://127.0.0.1:80/oauth/callback','http://127.0.0.1:65536/oauth/callback','http://127.0.0.1:04312/oauth/callback','http://localhost:43123/oauth/callback','http://127.1:43123/oauth/callback','http://127.0.0.1.evil.example:43123/oauth/callback','http://127.0.0.1:43123/other','http://127.0.0.1:43123/oauth/callback?extra=x','https://evil.example/callback'])await assert.rejects(native.validateAuthorization({...input,redirect_uri:uri}),{code:'invalid_redirect_uri'});
  await assert.rejects(native.validateAuthorization({...input,scope:'orders:write'}),{code:'invalid_scope'});
  await assert.rejects(native.authorize(input,outsider),{code:'staff_membership_required'});
 });
 await t.test('code binds exact callback port, resource and verifier; tokens cannot enter another audience',async()=>{
  const code=await pending();await assert.rejects(native.exchange({...code,redirect_uri:'http://127.0.0.1:43124/oauth/callback'}),{code:'invalid_grant'});
  await assert.rejects(native.exchange({...code,code_verifier:randomBytes(32).toString('base64url')}),{code:'invalid_grant'});
  await assert.rejects(customer.exchange({...code,resource:base+'/mcp'}),{code:'invalid_grant'});
  const session=await native.exchange(code);assert.equal(session.expires_in,900);assert.equal(session.scope,NATIVE_SCOPE);assert.equal((await who(native,session.access_token)).id,owner.id);
  assert.equal(await who(customer,session.access_token),null);assert.equal(await who(native,session.refresh_token),null);
  assert.equal(await native.authenticate({headers:{cookie:'prototype_session='+session.access_token}}),null);
  await assert.rejects(native.issue(owner.id,undefined,{kind:'browser'}),{code:'invalid_session_kind'});
  await assert.rejects(native.exchange(code),{code:'invalid_grant'});
  const family=(await pool.query('SELECT g.* FROM demo_oauth_grants g JOIN demo_oauth_refresh_tokens r ON r.family_id=g.id WHERE r.token_hash=$1',[hash(session.refresh_token)])).rows[0];
  assert.ok(new Date(family.expires_at)-Date.now()<=8*3600000);assert.ok(new Date(family.expires_at)-Date.now()>7.9*3600000);assert.equal(JSON.stringify(family).includes(session.refresh_token),false);
 });
 await t.test('revocation cannot cross customer/native resources and refresh reuse revokes only its family',async()=>{
  const customerClient=await customer.register({redirect_uris:['https://client.example/callback'],grant_types:['authorization_code','refresh_token']});
  const {input,verifier}=prepare();const callback=new URL(await customer.authorize({...input,client_id:customerClient.client_id,redirect_uri:'https://client.example/callback',resource:base+'/mcp',scope:'orders:read'},owner));
  const other=await customer.exchange({grant_type:'authorization_code',client_id:customerClient.client_id,redirect_uri:'https://client.example/callback',resource:base+'/mcp',code:callback.searchParams.get('code'),code_verifier:verifier});
  const session=await grant();assert.equal(await who(native,other.access_token),null);
  await native.revoke(other.access_token);await native.revoke(other.refresh_token);assert.ok(await who(customer,other.access_token));
  await customer.revoke(session.access_token);await customer.revoke(session.refresh_token);assert.ok(await who(native,session.access_token));
  const rotated=await refresh(session.refresh_token);assert.ok(await who(native,rotated.access_token));
  await assert.rejects(refresh(session.refresh_token),{code:'invalid_grant'});assert.equal(await who(native,rotated.access_token),null);assert.ok(await who(customer,other.access_token));
 });
 await t.test('browser-owned grant listing/revocation exposes no tokens and cannot cross an account',async()=>{
  const otherStaff=await directory.verifiedIdentity({issuer,subject:'other-staff'});await directory.createTenant(owner.id,{id:'b',name:'B',ownerId:otherStaff.id});await directory.setTenantStatus(owner.id,'b',{status:'active',expectedVersion:1});
  const {input,verifier}=prepare();const callback=new URL(await native.authorize(input,otherStaff));
  const other=await native.exchange({grant_type:'authorization_code',client_id:NATIVE_CLIENT_ID,redirect_uri:redirect,resource,code:callback.searchParams.get('code'),code_verifier:verifier});
  const own=await grant(),otherGrant=(await native.nativeGrants(otherStaff.id))[0];
  const listed=await native.nativeGrants(owner.id);assert.ok(listed.length);assert.equal(listed.some(row=>row.id===otherGrant.id),false);assert.equal(JSON.stringify(listed).includes(own.access_token),false);
  await assert.rejects(native.revokeNativeGrant(owner.id,otherGrant.id),{code:'not_found'});
  await native.revokeNativeGrant(owner.id,'all');assert.equal(await who(native,own.access_token),null);assert.ok(await who(native,other.access_token));
  await native.revokeNativeGrant(otherStaff.id,otherGrant.id);assert.equal(await who(native,other.access_token),null);
 });
 await t.test('opt-in mobile grants bind client and callback; disabled mobile cannot authenticate or refresh',async()=>{
  const mobile=createAuth({pool,baseUrl:base+'/native',profile:'native_staff',csrfKey,allowSyntheticAuthorization:false,principalResolver:resolveStaff,nativeMobileEnabled:true});
  await mobile.init();await mobile.init();
  const redirects=mobileRedirects(base);
  for(const [clientId,callbackUri] of [[ANDROID_CLIENT_ID,redirects.android],[IOS_CLIENT_ID,redirects.ios]]){
   const {input,verifier}=prepare();const request={...input,client_id:clientId,redirect_uri:callbackUri};
   for(const wrong of [redirect,callbackUri+'?x=1',callbackUri+'#x',callbackUri.replace(':/','://'),clientId===IOS_CLIENT_ID?redirects.android:redirects.ios]){
    await assert.rejects(mobile.validateAuthorization({...request,redirect_uri:wrong}),{code:'invalid_redirect_uri'});
   }
   await assert.rejects(native.validateAuthorization(request),{code:'invalid_client_metadata'});
   const callback=new URL(await mobile.authorize(request,owner));
   assert.equal(callback.searchParams.get('state'),input.state);assert.equal(callback.searchParams.get('iss'),base+'/native');
   const exchange={grant_type:'authorization_code',client_id:clientId,redirect_uri:callbackUri,resource,code:callback.searchParams.get('code'),code_verifier:verifier};
   await assert.rejects(native.exchange(exchange),{code:'invalid_grant'});
   await assert.rejects(mobile.exchange({...exchange,client_id:NATIVE_CLIENT_ID}),{code:'invalid_grant'});
   await assert.rejects(mobile.exchange({...exchange,redirect_uri:callbackUri+'/'}),{code:'invalid_grant'});
   const session=await mobile.exchange(exchange);assert.ok(await who(mobile,session.access_token));
   assert.equal(await who(native,session.access_token),null);assert.equal(await who(customer,session.access_token),null);
   const refreshInput={grant_type:'refresh_token',client_id:clientId,resource,refresh_token:session.refresh_token};
   await assert.rejects(native.exchange(refreshInput),{code:'invalid_grant'});
   await assert.rejects(mobile.exchange({...refreshInput,client_id:NATIVE_CLIENT_ID}),{code:'invalid_grant'});
   const rotated=await mobile.exchange(refreshInput);assert.ok(await who(mobile,rotated.access_token));
   await mobile.revoke(rotated.refresh_token);assert.equal(await who(mobile,rotated.access_token),null);
  }
  await pool.query('UPDATE demo_oauth_clients SET redirect_uris=$2 WHERE id=$1',[IOS_CLIENT_ID,JSON.stringify(['evil:/oauth/callback'])]);
  await assert.rejects(mobile.init(),/native_client_registration_mismatch/);
  await pool.query('UPDATE demo_oauth_clients SET redirect_uris=$2 WHERE id=$1',[IOS_CLIENT_ID,JSON.stringify([redirects.ios])]);
 });
 await t.test('live identity/membership resolution still controls every native request',async()=>{
  const session=await grant();await pool.query('UPDATE platform_memberships SET enabled=FALSE WHERE tenant_id=$1 AND principal_id=$2',['a',owner.id]);
  assert.equal(await who(native,session.access_token),null);await assert.rejects(refresh(session.refresh_token),{code:'invalid_grant'});
  await pool.query('UPDATE platform_memberships SET enabled=TRUE WHERE tenant_id=$1 AND principal_id=$2',['a',owner.id]);
  assert.equal(await who(native,session.access_token),null,'Revoked refresh family stays revoked after membership returns');
 });
});
