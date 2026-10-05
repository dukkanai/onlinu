import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import pg from 'pg';
import { createControlPlane } from './control-plane.mjs';
import { pkceChallenge } from './auth.mjs';

test('control-plane HTTP enforces subject identity, browser CSRF and tenant authority', {
  skip: !process.env.IDENTITY_TEST_DATABASE_URL,
}, async t => {
  const url = new URL(process.env.IDENTITY_TEST_DATABASE_URL);
  assert.equal(url.pathname, '/astracalls_identity_test'); assert.equal(url.searchParams.has('dbname'), false);
  const schema = `control_test_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: url.href }); await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: url.href, options: `-c search_path=${schema}` });
  const baseUrl = 'https://platform.example', issuer = 'https://identity.example/';
  const app = await createControlPlane({ pool, baseUrl, csrfKey: randomBytes(32).toString('base64'),
    oidc: { issuer, clientId: 'control-test', clientSecret: 'synthetic-secret-never-production' },
    redirectAllowlist: ['https://client.example/callback'],
    restaurants: [{ id: 'a', name: 'Config A', cuisine: 'saudi', baseUrl: 'http://127.0.0.1:9' }],
  }, { oidcClientAdapter: { async authorizationUrl() { return `${issuer}authorize`; }, async exchange() { throw Error('unused'); } } });
  const server = createServer(app.handle); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const make = async (subject, operator = false) => {
    const person = await app.directory.verifiedIdentity({ issuer, subject });
    if (operator) await pool.query('UPDATE platform_identities SET platform_admin=TRUE WHERE id=$1', [person.id]);
    const session = await app.auth.issue(person.id, undefined, { kind: 'browser' });
    const cookie = `__Host-platform_session=${session.accessToken}`;
    return { ...person, cookie, csrf: app.auth.csrfToken({ headers: { cookie } }) };
  };
  const root = await make('operator', true), owner = await make('owner'), other = await make('other');
  async function request(path, { method = 'GET', who, body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const request = httpRequest(local + path, { method, headers: {
        host: 'platform.example', ...(who ? { cookie: who.cookie, 'x-csrf-token': who.csrf } : {}),
        ...(method !== 'GET' ? { origin: baseUrl } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers,
      } }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8'); let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: response.statusCode, headers: new Headers(response.headers), data });
        });
      });
      request.on('error', reject); request.end(body ? JSON.stringify(body) : undefined);
    });
  }

  await t.test('no fixture login, fake actor headers or OAuth staff escalation', async () => {
    assert.equal((await request('/dev/session', { method: 'POST', body: { identity: 'merchant-a' } })).status, 404);
    assert.equal((await request('/api/me', { headers: { 'x-actor-id': root.id, 'x-actor-role': 'owner' } })).status, 401);
    const token = await app.auth.issue(root.id, ['orders:read']);
    assert.equal((await request('/api/me', { headers: { authorization: `Bearer ${token.accessToken}` } })).status, 403);
    assert.equal((await request('/api/me', { who: owner })).data.principal.id, owner.id);
  });

  await t.test('mutation requires matching Origin and session CSRF before effects', async () => {
    const input = { id: 'a', name: 'Restaurant A', ownerId: owner.id };
    assert.equal((await request('/api/platform/restaurants', { method: 'POST', who: root, body: input, headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request('/api/platform/restaurants', { method: 'POST', who: root, body: input, headers: { 'x-csrf-token': '' } })).status, 403);
    assert.equal((await request('/api/platform/restaurants', { method: 'POST', who: owner, body: input })).status, 403);
    assert.equal((await request('/api/platform/restaurants', { method: 'POST', who: root, body: input })).status, 201);
    assert.deepEqual(await app.core.listRestaurants({}), [], 'Draft restaurant is not publicly discoverable');
    await assert.rejects(app.core.getMenu('a'), { code: 'restaurant_not_found' });
    assert.equal((await request('/api/platform/restaurants/a/status', { method: 'PATCH', who: root,
      body: { status: 'active', expectedVersion: 1 } })).status, 200);
    assert.deepEqual(await app.core.listRestaurants({}), [{ id: 'a', name: 'Restaurant A', cuisine: 'saudi' }]);
  });

  await t.test('owner manages only their restaurant with versioned granular permissions', async () => {
    const input = { role: 'kitchen', permissions: ['orders:read'], enabled: true, expectedVersion: null };
    const path = `/api/restaurants/a/members/${other.id}`;
    assert.equal((await request(path, { method: 'PUT', who: other, body: input })).status, 403);
    assert.equal((await request(path, { method: 'PUT', who: owner, body: input })).status, 200);
    assert.equal((await request(path, { method: 'PUT', who: owner, body: input })).status, 409);
    assert.equal((await request('/api/restaurants/a/members', { who: other })).status, 403);
    const response = await request('/api/restaurants/a/members', { who: owner });
    assert.equal(response.status, 200); assert.equal(response.data.members.length, 2);
    assert.equal(JSON.stringify(response.data).includes('subject'), false);
    await app.directory.authorize(other.id, 'a', 'orders:read');
    await assert.rejects(app.directory.authorize(other.id, 'a', 'orders:update'), { code: 'forbidden' });
  });

  await t.test('staff member forms preserve identity binding, granular permissions and last-owner safety',async()=>{
    const fresh=await make('new-staff');
    const memberPath='/manage/a/members';
    const login=await request(memberPath);assert.equal(login.status,302);assert.match(login.headers.get('location'),/returnTo=/);
    assert.equal((await request(login.headers.get('location'))).status,302);
    assert.match((await request('/manage',{who:fresh})).data,new RegExp(fresh.id));
    assert.equal((await request(memberPath,{who:other})).status,403);
    const create={csrf:owner.csrf,expectedVersion:'',principalId:fresh.id,role:'kitchen',enabled:'false',permissionsMode:'role',displayName:'<Chef>'};
    assert.equal((await request(memberPath,{who:owner,method:'POST',body:{...create,csrf:'bad'}})).status,403);
    assert.equal((await request(memberPath,{who:owner,method:'POST',body:create})).status,303);
    assert.equal((await request(memberPath,{who:owner,method:'POST',body:create})).status,409);
    await assert.rejects(app.directory.authorize(fresh.id,'a','orders:read'),{code:'forbidden'});
    assert.match((await request(memberPath,{who:owner})).data,/&lt;Chef&gt;/);
    const edit={csrf:owner.csrf,expectedVersion:'1',role:'kitchen',enabled:'true',permissionsMode:'custom',displayName:'<Chef>','perm:orders:read':'yes'};
    const target=memberPath+'/'+fresh.id;
    assert.equal((await request(target,{who:owner,method:'POST',body:edit})).status,303);
    assert.equal((await request(target,{who:owner,method:'POST',body:edit})).status,409);
    await app.directory.authorize(fresh.id,'a','orders:read');
    await assert.rejects(app.directory.authorize(fresh.id,'a','orders:update'),{code:'forbidden'});
    const preserved=await app.directory.setMembership(owner.id,'a',fresh.id,{role:'kitchen',enabled:true,permissions:['orders:read'],expectedVersion:2});
    assert.equal(preserved.displayName,'<Chef>');
    const audit=(await pool.query("SELECT details FROM platform_identity_audit WHERE target_id=$1 AND action='membership_changed' ORDER BY id DESC LIMIT 1",[fresh.id])).rows[0].details;
    assert.equal(audit.before.version,2);assert.equal(audit.after.version,3);assert.deepEqual(audit.after.permissions,['orders:read']);assert.equal(JSON.stringify(audit).includes('<Chef>'),false);
    const blocked=await request(memberPath+'/'+owner.id,{who:owner,method:'POST',headers:{accept:'text/html'},body:{csrf:owner.csrf,expectedVersion:'1',role:'owner',enabled:'false',permissionsMode:'role',displayName:'Owner'}});
    assert.equal(blocked.status,409);assert.match(blocked.data,/آخر مالك نشط/);
    const oauth=await app.auth.issue(owner.id,['orders:read']);
    assert.equal((await request(memberPath,{headers:{authorization:'Bearer '+oauth.accessToken}})).status,403);
  });

  await t.test('OAuth consent and PKCE work for actual directory identity', async () => {
    const registration = await request('/oauth/register', { method: 'POST', body: {
      redirect_uris: ['https://client.example/callback'], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code','refresh_token'], response_types: ['code'],
    } });
    assert.equal(registration.status, 201);
    const verifier = randomBytes(32).toString('base64url');
    const grant = { client_id: registration.data.client_id, redirect_uri: 'https://client.example/callback',
      response_type: 'code', resource: `${baseUrl}/mcp`, scope: 'orders:read', state: 'test-state',
      code_challenge_method: 'S256', code_challenge: pkceChallenge(verifier) };
    const consent = await request('/oauth/authorize?' + new URLSearchParams(grant), { who: owner });
    assert.equal(consent.status, 200); assert.match(consent.data, /<form/);
    assert.equal(consent.headers.get('referrer-policy'),'same-origin');
    assert.match(consent.headers.get('content-security-policy'),/form-action 'self' https:\/\/client\.example;/);
    assert.equal((await request('/oauth/authorize', { method: 'POST', who: owner, body: { ...grant, approve: 'yes', csrf: 'bad' } })).status, 403);
    const approved = await request('/oauth/authorize', { method: 'POST', who: owner, body: { ...grant, approve: 'yes', csrf: owner.csrf } });
    assert.equal(approved.status, 302);
    assert.equal(approved.headers.get('referrer-policy'),'no-referrer');
    const callback = new URL(approved.headers.get('location'));
    const exchanged = await request('/oauth/token', { method: 'POST', body: {
      grant_type: 'authorization_code', client_id: grant.client_id, redirect_uri: grant.redirect_uri,
      code: callback.searchParams.get('code'), code_verifier: verifier, resource: grant.resource,
    } });
    assert.equal(exchanged.status, 200);
    const who = await app.auth.authenticate({ headers: { authorization: `Bearer ${exchanged.data.access_token}` } }, { bearerOnly: true });
    assert.equal(who.id, owner.id); assert.deepEqual(who.scopes, ['orders:read']);
    assert.equal((await request('/api/me', { headers: { authorization: `Bearer ${exchanged.data.access_token}` } })).status, 403);
  });

  await t.test('logout revokes browser access and wrong hosts cannot read', async () => {
    assert.equal((await request('/api/me', { who: owner, headers: { host: 'evil.example' } })).status, 403);
    assert.equal((await request('/auth/logout', { method: 'POST', who: other })).status, 200);
    assert.equal((await request('/api/me', { who: other })).status, 401);
  });
});
