import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {createAuth,hash,pkceChallenge} from './auth.mjs';
import {createEvents} from './events.mjs';

test('rotating OAuth refresh and event revocation on isolated PostgreSQL', {skip:!process.env.TEST_DATABASE_URL}, async t=>{
  const databaseUrl=new URL(process.env.TEST_DATABASE_URL);
  assert.equal(databaseUrl.pathname,'/astracalls_oauth_refresh_test','Only the disposable OAuth test database is allowed');
  const schema=`oauth_refresh_${randomBytes(8).toString('hex')}`;
  const admin=new pg.Pool({connectionString:databaseUrl.href});
  const pool=new pg.Pool({connectionString:databaseUrl.href,options:`-c search_path=${schema}`,max:8});
  const baseUrl='https://almujeeb.info', resource=`${baseUrl}/mcp`;
  const redirect='https://chatgpt.com/connector_platform_oauth_redirect';
  let events;
  const auth=createAuth({pool,baseUrl,redirectAllowlist:[redirect],allowSyntheticAuthorization:false,
    csrfKey:randomBytes(32).toString('base64'),onGrantRevoked:(id,transaction)=>events.revokeAll(id,transaction)});
  const who=token=>auth.authenticate({headers:{authorization:`Bearer ${token}`}},{bearerOnly:true});
  let created=false;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);created=true;
    await auth.init();
    events=createEvents({pool,encryptionKey:randomBytes(32).toString('base64'),authorizeOrder:async()=>({id:'order-1'}),
      webhookFetch:async(url,options)=>new Response(JSON.stringify({challenge:JSON.parse(options.body).challenge}),{status:200})});
    await events.init();
    const client=await auth.register({redirect_uris:[redirect],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']});
    const otherClient=await auth.register({redirect_uris:[redirect],grant_types:['authorization_code','refresh_token']});
    const authorize=async(clientId=client.client_id,scopes='orders:read orders:write events:read')=>{
      const verifier=randomBytes(32).toString('base64url');
      const input={client_id:clientId,redirect_uri:redirect,resource,response_type:'code',scope:scopes,
        code_challenge_method:'S256',code_challenge:pkceChallenge(verifier),state:randomBytes(24).toString('base64url')};
      const location=new URL(await auth.authorize(input,{id:'customer-alice'}));
      return {input,exchange:{grant_type:'authorization_code',client_id:clientId,redirect_uri:redirect,resource,
        code:location.searchParams.get('code'),code_verifier:verifier}};
    };
    const grant=async(clientId)=>auth.exchange((await authorize(clientId)).exchange);
    const refresh=(token,overrides={})=>auth.exchange({grant_type:'refresh_token',client_id:client.client_id,resource,refresh_token:token,...overrides});
    const denied=operation=>assert.rejects(operation,error=>error.code==='invalid_grant');

    await t.test('migration preserves existing clients and code-only grants do not issue refresh tokens',async()=>{
      // Simulate a pre-migration client by dropping only the new, empty
      // tables/columns inside this disposable schema, then run the migration.
      await pool.query('ALTER TABLE demo_sessions DROP COLUMN oauth_family_id; DROP TABLE demo_oauth_refresh_tokens; DROP TABLE demo_oauth_grants; ALTER TABLE demo_oauth_clients DROP COLUMN grant_types');
      await pool.query('INSERT INTO demo_oauth_clients(id,redirect_uris) VALUES($1,$2)',['legacy-existing',JSON.stringify([redirect])]);
      await auth.init();await auth.init();
      assert.deepEqual((await pool.query('SELECT grant_types FROM demo_oauth_clients WHERE id=$1',['legacy-existing'])).rows[0].grant_types,['authorization_code']);
      const issued=await grant('legacy-existing');
      assert.equal(issued.refresh_token,undefined);
      assert.equal((await who(issued.access_token)).id,'customer-alice');
      // The earlier fresh clients were also present during migration: opt
      // them back into refresh exactly as the observed registration requests.
      await pool.query('UPDATE demo_oauth_clients SET grant_types=$1 WHERE id=ANY($2::text[])',[JSON.stringify(['authorization_code','refresh_token']),[client.client_id,otherClient.client_id]]);
    });

    await t.test('PKCE, code replay, hashed storage and access/refresh token separation',async()=>{
      const pending=await authorize();
      await denied(auth.exchange({...pending.exchange,code_verifier:randomBytes(32).toString('base64url')}));
      const issued=await auth.exchange(pending.exchange);
      assert.match(issued.refresh_token,/^[A-Za-z0-9_-]{43}$/);
      assert.equal(issued.expires_in,1800);
      await denied(auth.exchange(pending.exchange));
      assert.equal(await who(issued.refresh_token),null);
      const stored=(await pool.query('SELECT * FROM demo_oauth_refresh_tokens WHERE token_hash=$1',[hash(issued.refresh_token)])).rows[0];
      assert.ok(stored);assert.equal(JSON.stringify(stored).includes(issued.refresh_token),false);
      const family=(await pool.query('SELECT * FROM demo_oauth_grants WHERE id=$1',[stored.family_id])).rows[0];
      assert.equal(family.client_id,client.client_id);assert.equal(family.resource,resource);
    });

    await t.test('binding and scope checks do not consume a valid token; rotation invalidates its predecessor',async()=>{
      const issued=await grant();
      await denied(refresh(issued.refresh_token,{client_id:otherClient.client_id}));
      await denied(refresh(issued.refresh_token,{resource:'https://unapproved.invalid/mcp'}));
      await denied(refresh(issued.access_token));
      await assert.rejects(refresh(issued.refresh_token,{scope:'admin:write'}),error=>error.code==='invalid_scope');
      const renewed=await refresh(issued.refresh_token);
      assert.notEqual(renewed.refresh_token,issued.refresh_token);
      assert.equal((await who(renewed.access_token)).id,'customer-alice');
      assert.equal((await pool.query('SELECT consumed FROM demo_oauth_refresh_tokens WHERE token_hash=$1',[hash(issued.refresh_token)])).rows[0].consumed,true);
    });

    await t.test('replay revokes the entire family and atomically cancels owned event subscriptions',async()=>{
      const issued=await grant();
      const principal=await who(issued.access_token);
      const subscription=await events.subscribe(principal,{name:'order.status_changed',arguments:{tenantId:'demo-a',orderId:'order-1'},
        delivery:{mode:'webhook',url:'https://receiver.example/callback',secret:`whsec_${randomBytes(32).toString('base64')}`}});
      await events.enqueue({sequence:1,eventId:'evt-revocation-test',tenantId:'demo-a',orderId:'order-1',ownerId:principal.id,
        status:'accepted',paymentStatus:'paid',version:2,occurredAt:new Date().toISOString()});
      const renewed=await refresh(issued.refresh_token);
      await denied(refresh(issued.refresh_token));
      assert.equal(await who(issued.access_token),null);assert.equal(await who(renewed.access_token),null);
      await denied(refresh(renewed.refresh_token));
      assert.equal((await pool.query('SELECT active FROM event_subscriptions WHERE id=$1',[subscription.id])).rows[0].active,false);
      assert.equal((await pool.query('SELECT status FROM event_deliveries WHERE subscription_id=$1',[subscription.id])).rows[0].status,'revoked');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM event_callback_verifications')).rows[0].n,0);
    });

    await t.test('scope narrowing cannot later expand the grant or keep older broader access tokens',async()=>{
      const issued=await grant();
      const renewed=await refresh(issued.refresh_token,{scope:'orders:read'});
      assert.equal(renewed.scope,'orders:read');assert.equal(await who(issued.access_token),null);
      assert.deepEqual((await who(renewed.access_token)).scopes,['orders:read']);
      await assert.rejects(refresh(renewed.refresh_token,{scope:'orders:read orders:write'}),error=>error.code==='invalid_scope');
      const next=await refresh(renewed.refresh_token);assert.equal(next.scope,'orders:read');
    });

    await t.test('access or refresh revocation cancels the family without cancelling browser sessions or another connection',async()=>{
      for(const kind of ['access_token','refresh_token']) {
        const issued=await grant(),other=await grant(otherClient.client_id);
        const browser=await auth.issue('customer-alice',undefined,{kind:'browser'});
        assert.equal(await auth.revoke(issued[kind]),'customer-alice');
        assert.equal(await who(issued.access_token),null);await denied(refresh(issued.refresh_token));
        assert.equal((await who(other.access_token)).id,'customer-alice');
        assert.equal((await auth.authenticate({headers:{cookie:`prototype_session=${browser.accessToken}`}},{cookieOnly:true})).id,'customer-alice');
        await auth.revoke(browser.accessToken);assert.equal((await who(other.access_token)).id,'customer-alice');
      }
      assert.equal(await auth.revoke(randomBytes(32).toString('base64url')),null);
    });

    await t.test('idle expiry, absolute expiry and disabled identities cannot renew a grant',async()=>{
      const idle=await grant();
      await pool.query("UPDATE demo_oauth_refresh_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[hash(idle.refresh_token)]);
      await denied(refresh(idle.refresh_token));
      const absolute=await grant();
      await pool.query("UPDATE demo_oauth_grants SET expires_at=now()-interval '1 second' WHERE id=(SELECT family_id FROM demo_oauth_refresh_tokens WHERE token_hash=$1)",[hash(absolute.refresh_token)]);
      await denied(refresh(absolute.refresh_token));assert.equal(await who(absolute.access_token),null);
      const disabled=await grant();
      await pool.query('UPDATE demo_identities SET enabled=FALSE WHERE id=$1',['customer-alice']);
      assert.equal(await who(disabled.access_token),null);await denied(refresh(disabled.refresh_token));
      await pool.query('UPDATE demo_identities SET enabled=TRUE WHERE id=$1',['customer-alice']);
      await denied(refresh(disabled.refresh_token));
    });

    await t.test('rotation does not extend the absolute seven-day lifetime and survives restart',async()=>{
      const issued=await grant();
      const before=(await pool.query('SELECT g.expires_at FROM demo_oauth_grants g JOIN demo_oauth_refresh_tokens r ON r.family_id=g.id WHERE r.token_hash=$1',[hash(issued.refresh_token)])).rows[0].expires_at;
      const renewed=await refresh(issued.refresh_token);
      const after=(await pool.query('SELECT g.expires_at,r.expires_at AS idle FROM demo_oauth_grants g JOIN demo_oauth_refresh_tokens r ON r.family_id=g.id WHERE r.token_hash=$1',[hash(renewed.refresh_token)])).rows[0];
      assert.equal(after.expires_at.getTime(),before.getTime());assert.ok(after.idle<after.expires_at);
      const restarted=createAuth({pool,baseUrl,redirectAllowlist:[redirect]});await restarted.init();
      const next=await restarted.exchange({grant_type:'refresh_token',resource,client_id:client.client_id,refresh_token:renewed.refresh_token});
      assert.equal((await who(next.access_token)).id,'customer-alice');
    });

    await t.test('parallel reuse produces at most one successor then revokes that family',async()=>{
      const issued=await grant();
      const outcomes=await Promise.allSettled([refresh(issued.refresh_token),refresh(issued.refresh_token)]);
      assert.equal(outcomes.filter(value=>value.status==='fulfilled').length,1);
      assert.equal(outcomes.filter(value=>value.status==='rejected' && value.reason.code==='invalid_grant').length,1);
      const winner=outcomes.find(value=>value.status==='fulfilled').value;
      assert.equal(await who(winner.access_token),null);await denied(refresh(winner.refresh_token));
    });

    await t.test('failed mint rolls back authorization code consumption and cannot leave a partial grant',async()=>{
      const pending=await authorize();
      const before=(await pool.query('SELECT count(*)::int AS n FROM demo_oauth_grants')).rows[0].n;
      await pool.query('ALTER TABLE demo_oauth_refresh_tokens ADD CONSTRAINT reject_test_mint CHECK (FALSE) NOT VALID');
      await assert.rejects(auth.exchange(pending.exchange),error=>error.code==='23514');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM demo_oauth_grants')).rows[0].n,before);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM demo_oauth_codes WHERE code_hash=$1',[hash(pending.exchange.code)])).rows[0].n,1);
      await pool.query('ALTER TABLE demo_oauth_refresh_tokens DROP CONSTRAINT reject_test_mint');
      const issued=await auth.exchange(pending.exchange);assert.equal((await who(issued.access_token)).id,'customer-alice');
    });
  } finally {
    await pool.end();
    if(created)await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
