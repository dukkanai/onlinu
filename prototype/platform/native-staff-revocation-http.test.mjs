import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import pg from 'pg';
import { createControlPlane } from './control-plane.mjs';
import { hash, NATIVE_CLIENT_ID, NATIVE_SCOPE, pkceChallenge } from './auth.mjs';

// Actual loopback HTTP and isolated PostgreSQL, with an injected restaurant
// transport. No provider, deployed restaurant, account or payment is contacted.
test('native HTTP mutations bind the originating family across delayed bodies on PostgreSQL', {
  skip: !process.env.IDENTITY_TEST_DATABASE_URL,
  timeout: 30_000,
}, async t => {
  const database = new URL(process.env.IDENTITY_TEST_DATABASE_URL);
  assert.equal(database.pathname, '/astracalls_identity_test');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname));
  for (const key of database.searchParams.keys()) assert.equal(key, 'sslmode', 'Only the explicit disposable database may be used');
  const schema = 'native_revocation_http_' + randomBytes(12).toString('hex');
  const options = { connectionString: database.href, connectionTimeoutMillis: 5000, query_timeout: 5000 };
  const admin = new pg.Pool({ ...options, max: 2 });
  let pool, app, server, schemaCreated = false;
  const clients = new Set();
  t.after(async () => {
    for (const client of clients) client.destroy();
    try {
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      await app?.stopWorkers();
    } finally {
      try { await pool?.end(); }
      finally {
        try { if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
        finally { await admin.end(); }
      }
    }
  });
  await admin.query(`CREATE SCHEMA ${schema}`); schemaCreated = true;
  pool = new pg.Pool({ ...options, max: 6, options: `-c search_path=${schema}` });

  const baseUrl = 'https://platform.example', issuer = 'https://identity.example/';
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const dispatched = [], transportErrors = [];
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    try {
      const url = new URL(target);
      assert.equal(url.origin, 'http://127.0.0.1:9');
      assert.ok(['/platform-api/staff/profile', '/platform-api/staff/menu/items/rice'].includes(url.pathname));
      assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
      const [payload, signature] = options.headers.authorization.slice('Platform '.length).split('.');
      const bytes = Buffer.from(payload, 'base64url');
      assert.equal(verify(null, bytes, publicKey, Buffer.from(signature, 'base64url')), true);
      const claims = JSON.parse(bytes), input = JSON.parse(options.body);
      assert.equal(claims.issuer, baseUrl); assert.equal(claims.audience, 'a');
      assert.equal(claims.method, 'POST'); assert.equal(claims.path, url.pathname);
      assert.equal(claims.bodySha256, createHash('sha256').update(options.body).digest('hex'));
      assert.equal(claims.scope, url.pathname.endsWith('/profile') ? 'staff:settings:update' : 'staff:menu:update');
      assert.deepEqual(input, { expectedVersion: 1, name: 'Synthetic renamed item' });
      dispatched.push({ path: url.pathname, subject: claims.subject, input });
      const data = url.pathname.endsWith('/profile')
        ? { version: 2, name: input.name, description: '', address: '', phone: '', openingHours: '', pickupInstructions: '' }
        : { version: 2, currency: 'SAR', categories: [{ id: 'main', name: 'Synthetic', sort: 0 }],
          item: { id: 'rice', categoryId: 'main', name: input.name, description: '', priceMinor: 100,
            imageUrl: '', available: true, sort: 0, options: [] } };
      return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    } catch (error) { transportErrors.push(error.message); throw error; }
  });
  app = await createControlPlane({ pool, baseUrl, csrfKey: randomBytes(32).toString('base64'),
    serviceSigningKey: privateKey, nativeStaffEnabled: true,
    oidc: { issuer, clientId: 'synthetic-test', clientSecret: 'synthetic-secret-never-production' },
    restaurants: [{ id: 'a', name: 'Synthetic A', cuisine: 'fixture', baseUrl: 'http://127.0.0.1:9' }],
  }, { oidcClientAdapter: {
    async authorizationUrl() { assert.fail('No upstream identity call is permitted'); },
    async exchange() { assert.fail('No upstream identity call is permitted'); },
  } });

  const bodyObservers = new Map();
  server = createServer((req, res) => {
    const observer = bodyObservers.get(req.headers['x-test-body-gate']);
    if (observer) {
      const iterator = req[Symbol.asyncIterator].bind(req);
      // Observe the genuine IncomingMessage consumption boundary. Preserve its
      // iterator and bytes; authentication and body parsing remain production code.
      req[Symbol.asyncIterator] = function () { observer(); return iterator(); };
    }
    void app.handle(req, res);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const local = 'http://127.0.0.1:' + server.address().port;

  function beginRequest(path, { method = 'GET', token, browser, input, headers = {} } = {}) {
    let request;
    const response = new Promise((resolve, reject) => {
      request = httpRequest(local + path, { method, signal: t.signal, headers: {
        host: 'platform.example', accept: 'application/json',
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(browser ? { cookie: browser.cookie, ...(method !== 'GET' ? { origin: baseUrl } : {}) } : {}),
        ...(input ? { 'content-type': 'application/json' } : {}), ...headers,
      } }, incoming => {
        const chunks = []; let size = 0;
        incoming.on('data', chunk => { size += chunk.length; if (size > 32768) incoming.destroy(Error('Oversized fixture response')); else chunks.push(chunk); });
        incoming.on('error', reject);
        incoming.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8'); let data;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: incoming.statusCode, headers: incoming.headers, data });
        });
      });
      clients.add(request);
      request.once('close', () => clients.delete(request));
      request.on('error', reject);
      request.setTimeout(5000, () => request.destroy(Error('Synthetic HTTP request timed out')));
    });
    // Attach a rejection handler immediately while callers coordinate a paused body.
    response.catch(() => {});
    return { request, response };
  }
  async function send(path, options = {}) {
    const pending = beginRequest(path, options);
    pending.request.end(options.input ? JSON.stringify(options.input) : undefined);
    return pending.response;
  }
  const owner = await app.directory.verifiedIdentity({ issuer, subject: 'native-revocation-owner' });
  await pool.query('UPDATE platform_identities SET platform_admin=TRUE WHERE id=$1', [owner.id]);
  await app.directory.createTenant(owner.id, { id: 'a', name: 'Synthetic A', ownerId: owner.id });
  await app.directory.setTenantStatus(owner.id, 'a', { status: 'active', expectedVersion: 1 });
  const session = await app.auth.issue(owner.id, undefined, { kind: 'browser' });
  const browser = { cookie: '__Host-platform_session=' + session.accessToken };
  browser.csrf = app.auth.csrfToken({ headers: { cookie: browser.cookie } });
  async function nativeLogin() {
    const verifier = randomBytes(32).toString('base64url');
    const grant = { client_id: NATIVE_CLIENT_ID, redirect_uri: 'http://127.0.0.1:43123/oauth/callback',
      resource: baseUrl + '/native/api', response_type: 'code', scope: NATIVE_SCOPE,
      state: randomBytes(24).toString('base64url'), code_challenge_method: 'S256', code_challenge: pkceChallenge(verifier) };
    const consent = await send('/native/oauth/authorize', { method: 'POST', browser,
      input: { ...grant, csrf: browser.csrf, approve: 'yes' } });
    assert.equal(consent.status, 303);
    const callback = new URL(consent.headers.location);
    assert.equal(callback.searchParams.get('state'), grant.state);
    const exchanged = await send('/native/oauth/token', { method: 'POST', input: {
      grant_type: 'authorization_code', client_id: NATIVE_CLIENT_ID, redirect_uri: grant.redirect_uri,
      resource: grant.resource, code: callback.searchParams.get('code'), code_verifier: verifier,
    } });
    assert.equal(exchanged.status, 200);
    const row = (await pool.query('SELECT oauth_family_id FROM demo_sessions WHERE token_hash=$1',
      [hash(exchanged.data.access_token)])).rows[0];
    assert.ok(row?.oauth_family_id);
    return { ...exchanged.data, familyId: row.oauth_family_id };
  }
  async function delayedMutation(path, token) {
    const marker = randomBytes(12).toString('hex');
    let entered;
    const bodyEntered = new Promise(resolve => { entered = resolve; });
    bodyObservers.set(marker, entered);
    const bytes = Buffer.from(JSON.stringify({ expectedVersion: 1, name: 'Synthetic renamed item' }));
    const pending = beginRequest(path, { method: 'POST', token, input: true,
      headers: { 'content-length': String(bytes.length), 'x-test-body-gate': marker } });
    pending.request.write(bytes.subarray(0, 1));
    try {
      await Promise.race([bodyEntered, pending.response.then(() => assert.fail('Request returned before consuming its body'))]);
    } catch (error) { pending.request.destroy(); throw error; }
    finally { bodyObservers.delete(marker); }
    return { ...pending, finish() { if (!pending.request.writableEnded) pending.request.end(bytes.subarray(1)); } };
  }

  for (const [path, corePath] of [
    ['/native/api/restaurants/a/staff/profile', '/platform-api/staff/profile'],
    ['/native/api/restaurants/a/staff/menu/items/rice', '/platform-api/staff/menu/items/rice'],
  ]) for (const revokeOrigin of [true, false]) {
    await t.test(`${corePath}: ${revokeOrigin ? 'originating family revoked, other family active' : 'other family revoked, originating family active'}`,
      { timeout: 6000 }, async () => {
        const origin = await nativeLogin(), other = await nativeLogin();
        assert.notEqual(origin.familyId, other.familyId);
        const before = dispatched.length, pending = await delayedMutation(path, origin.access_token);
        try {
          assert.equal(dispatched.length, before, 'No dispatch occurs before the full body arrives');
          const revoked = revokeOrigin ? origin : other, retained = revokeOrigin ? other : origin;
          const reply = await send('/native/oauth/revoke', { method: 'POST', input: {
            client_id: NATIVE_CLIENT_ID, token: revoked.refresh_token,
          } });
          assert.equal(reply.status, 200);
          assert.equal((await pool.query('SELECT revoked FROM demo_oauth_grants WHERE id=$1', [revoked.familyId])).rows[0].revoked, true);
          assert.equal((await pool.query('SELECT revoked FROM demo_oauth_grants WHERE id=$1', [retained.familyId])).rows[0].revoked, false);
          assert.equal((await send('/native/api/me', { token: revoked.access_token })).status, 401);
          assert.equal((await send('/native/api/me', { token: retained.access_token })).status, 200);
          assert.equal((await app.directory.authorize(owner.id, 'a', path.endsWith('/profile') ? 'settings:update' : 'menu:update')).enabled, true);
        } finally { pending.finish(); }
        const result = await pending.response;
        assert.deepEqual(transportErrors, []);
        assert.equal(result.status, revokeOrigin ? 401 : 200);
        assert.equal(dispatched.length, before + (revokeOrigin ? 0 : 1));
        if (revokeOrigin) assert.equal(result.data.error, 'authentication_required');
        else { assert.equal(dispatched.at(-1).path, corePath); assert.equal(dispatched.at(-1).subject, owner.id); }
      });
  }
});
