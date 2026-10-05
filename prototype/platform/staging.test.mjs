import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { configuration, createPlatform } from './src.mjs';
import { hash, pkceChallenge } from './auth.mjs';

const baseUrl = 'https://almujeeb.info';
const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
const cookie = token => `__Host-restaurant_session=${token}`;

test('protected staging HTTP authorization and tenant isolation', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const schema = `staging_test_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 8 });
  let app, server;
  try {
    const config = configuration({
      PROTOTYPE_SYNTHETIC_ONLY: '1', PROTOTYPE_ALLOW_REMOTE: '1', AUTH_MODE: 'oidc', PUBLIC_BASE_URL: baseUrl,
      DATABASE_URL: process.env.TEST_DATABASE_URL, EVENTS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      SESSION_CSRF_KEY: randomBytes(32).toString('base64'),
      TENANT_A_URL: 'http://127.0.0.1:9', TENANT_B_URL: 'http://127.0.0.1:10',
      TENANT_A_TOKEN: randomBytes(32).toString('base64url'), TENANT_B_TOKEN: randomBytes(32).toString('base64url'),
      OIDC_ISSUER: `${baseUrl}/identity`, OIDC_CLIENT_ID: 'restaurant-staging-web',
      OIDC_CLIENT_SECRET: randomBytes(32).toString('base64url'),
      OIDC_IDENTITY_MAP: JSON.stringify(Object.fromEntries(['customer-alice', 'customer-bob', 'merchant-a', 'merchant-b'].map(id => [`${id}@staging.invalid`, id]))),
      OAUTH_REDIRECT_URIS: redirectUri, PAYMENT_MODE: 'local-simulator', BIND_ADDRESS: '127.0.0.1', PORT: '0',
    });
    app = await createPlatform(config, { pool, webhookFetch: async () => assert.fail('No webhook should be sent by these tests') });
    // Direct issuance is an isolated test fixture for identities verified by
    // OIDC in deployment. No public login route is bypassed or invoked here.
    const sessions = {};
    for (const id of ['customer-alice', 'customer-bob', 'merchant-a', 'merchant-b']) {
      sessions[id] = await app.auth.issue(id, undefined, { kind: 'browser' });
    }
    const oauthSession = await app.auth.issue('customer-bob', ['orders:read', 'events:read']);
    server = http.createServer(app.handle);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = server.address().port;

    async function request(path, { method = 'GET', token, bearer, origin, headers = {}, body, form = false } = {}) {
      const payload = body === undefined ? undefined : form ? new URLSearchParams(body).toString() : JSON.stringify(body);
      return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path, method,
          headers: { Host: 'almujeeb.info', ...(token ? { Cookie: cookie(token) } : {}),
            ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(origin ? { Origin: origin } : {}),
            ...(payload === undefined ? {} : { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
            ...headers },
        }, res => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('error', reject);
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString();
            resolve({ status: res.statusCode, headers: res.headers, text,
              json: res.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : undefined });
          });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('loopback_test_timeout')));
        req.end(payload);
      });
    }
    const tokenOf = id => sessions[id].accessToken;
    const csrfFor = async id => {
      const result = await request('/api/session', { token: tokenOf(id) });
      assert.equal(result.status, 200);
      return result.json.csrfToken;
    };

    await t.test('public fixture selector is absent and anonymous APIs are protected', async () => {
      assert.equal((await request('/dev/session', { method: 'POST', origin: baseUrl, body: { identity: 'merchant-a' } })).status, 404);
      assert.equal((await request('/dev/oauth-callback')).status, 404);
      for (const path of ['/api/session', '/api/restaurants', '/api/merchant/restaurants', '/api/merchant/restaurants/demo-a/channels']) {
        assert.equal((await request(path)).status, 401, path);
      }
      const page = await request('/');
      assert.equal(page.status, 200);
      assert.doesNotMatch(page.text, /<select[^>]*name=["']identity["']/i);
      assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
      assert.equal((await request('/api/session', { token: tokenOf('customer-alice'), headers: { Host: 'evil.example' } })).status, 421);
      assert.equal((await request('/api/session', { token: tokenOf('customer-alice'), origin: 'https://evil.example' })).status, 403);
    });

    await t.test('browser cookie and OAuth token kinds stay separated, including duplicate cookies', async () => {
      const browserView = await request('/api/session', { token: tokenOf('customer-alice') });
      assert.equal(browserView.status, 200); assert.equal(browserView.json.principal.id, 'customer-alice');
      assert.equal(browserView.json.authMode, 'oidc');
      assert.equal((await request('/api/session', { token: oauthSession.accessToken })).status, 401);
      assert.equal((await request('/api/session', { bearer: oauthSession.accessToken })).status, 401);
      assert.equal((await request('/api/restaurants', { bearer: oauthSession.accessToken })).status, 200);
      assert.equal((await request('/api/restaurants', { bearer: tokenOf('customer-alice') })).status, 401);
      const mixed = await request('/api/session', { token: tokenOf('customer-alice'), bearer: oauthSession.accessToken });
      assert.equal(mixed.json.principal.id, 'customer-alice');
      assert.equal((await request('/api/session', { headers: { Cookie: `${cookie(tokenOf('customer-alice'))}; ${cookie(tokenOf('customer-bob'))}` } })).status, 401);
      const stored = await pool.query('SELECT session_kind FROM demo_sessions WHERE token_hash=$1', [hash(oauthSession.accessToken)]);
      assert.equal(stored.rows[0].session_kind, 'oauth');
      const browserStored = await pool.query('SELECT session_kind FROM demo_sessions WHERE token_hash=$1', [hash(tokenOf('customer-alice'))]);
      assert.equal(browserStored.rows[0].session_kind, 'browser');
    });

    await t.test('browser writes require same-origin and a CSRF token bound to that browser session', async () => {
      const target = '/api/merchant/restaurants/demo-a/channels';
      const merchant = tokenOf('merchant-a');
      const csrf = await csrfFor('merchant-a');
      const body = { enabled: true, connectionMode: 'cloud_api', expectedVersion: 1 };
      assert.equal((await request(target, { method: 'POST', token: merchant, origin: baseUrl, body })).status, 403);
      assert.equal((await request(target, { method: 'POST', token: merchant, origin: baseUrl, body, headers: { 'X-CSRF-Token': randomBytes(32).toString('base64url') } })).status, 403);
      const otherCsrf = await csrfFor('merchant-b');
      assert.equal((await request(target, { method: 'POST', token: merchant, origin: baseUrl, body, headers: { 'X-CSRF-Token': otherCsrf } })).status, 403);
      assert.equal((await request(target, { method: 'POST', token: merchant, body, headers: { 'X-CSRF-Token': csrf } })).status, 403);
      assert.equal((await request(target, { method: 'POST', token: merchant, origin: 'https://evil.example', body, headers: { 'X-CSRF-Token': csrf } })).status, 403);
      const untouched = await request(target, { token: merchant });
      assert.equal(untouched.json.version, 1); assert.equal(untouched.json.whatsapp.enabled, false);
      const changed = await request(target, { method: 'POST', token: merchant, origin: baseUrl, body, headers: { 'X-CSRF-Token': csrf } });
      assert.equal(changed.status, 200); assert.equal(changed.json.version, 2);
      assert.equal(changed.json.whatsapp.enabled, true);
      assert.equal(changed.json.whatsapp.operational, false); // Configuration only; no external channel activation.
    });

    let authorization;
    const verifier = randomBytes(32).toString('base64url');
    await t.test('observed ChatGPT DCR request and refresh work through the protected HTTP endpoints', async () => {
      const registered=await request('/oauth/register',{method:'POST',body:{redirect_uris:[redirectUri],token_endpoint_auth_method:'none',
        grant_types:['authorization_code','refresh_token'],response_types:['code']}});
      assert.equal(registered.status,201);assert.deepEqual(registered.json.grant_types,['authorization_code','refresh_token']);
      const verifier=randomBytes(32).toString('base64url');
      const target=new URL(await app.auth.authorize({client_id:registered.json.client_id,redirect_uri:redirectUri,resource:`${baseUrl}/mcp`,
        response_type:'code',code_challenge_method:'S256',code_challenge:pkceChallenge(verifier),scope:'orders:read',state:'http-refresh-test'},
      {id:'customer-alice'}));
      const exchanged=await request('/oauth/token',{method:'POST',form:true,body:{grant_type:'authorization_code',client_id:registered.json.client_id,
        redirect_uri:redirectUri,resource:`${baseUrl}/mcp`,code:target.searchParams.get('code'),code_verifier:verifier}});
      assert.equal(exchanged.status,200);assert.equal(typeof exchanged.json.refresh_token,'string');
      const renewed=await request('/oauth/token',{method:'POST',form:true,body:{grant_type:'refresh_token',client_id:registered.json.client_id,
        resource:`${baseUrl}/mcp`,refresh_token:exchanged.json.refresh_token}});
      assert.equal(renewed.status,200);assert.equal(renewed.json.scope,'orders:read');
      assert.equal((await request('/api/restaurants',{bearer:renewed.json.access_token})).status,200);
      const revoked=await request('/oauth/revoke',{method:'POST',form:true,body:{token:renewed.json.refresh_token}});
      assert.equal(revoked.status,200);
      assert.equal((await request('/api/restaurants',{bearer:renewed.json.access_token})).status,401);
    });

    await t.test('unauthenticated OAuth authorization redirects to verified login with no identity selector', async () => {
      const registered = await request('/oauth/register', { method: 'POST', body: { redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' } });
      assert.equal(registered.status, 201);
      authorization = { client_id: registered.json.client_id, redirect_uri: redirectUri, resource: `${baseUrl}/mcp`,
        response_type: 'code', code_challenge_method: 'S256', code_challenge: pkceChallenge(verifier),
        state: 'staging-http-test-state', scope: 'orders:read events:read' };
      const path = `/oauth/authorize?${new URLSearchParams(authorization)}`;
      const result = await request(path);
      assert.equal(result.status, 302);
      const login = new URL(result.headers.location, baseUrl);
      assert.equal(login.origin, baseUrl); assert.equal(login.pathname, '/auth/login');
      assert.equal(login.searchParams.get('returnTo'), path);
      assert.doesNotMatch(result.text, /name=["']identity["']/i);
      const oauthCookie = await request(path, { token: oauthSession.accessToken });
      assert.equal(oauthCookie.status, 302); assert.match(oauthCookie.headers.location, /^\/auth\/login\?/);
      const selectorAttempt = await request(`${path}&identity=customer-bob`, { token: tokenOf('customer-alice') });
      assert.equal(selectorAttempt.status, 400); assert.equal(selectorAttempt.json.error, 'identity_parameter_forbidden');
    });

    await t.test('consent uses the verified browser principal; CSRF and identity overrides cannot switch it', async () => {
      const token = tokenOf('customer-alice');
      const csrf = await csrfFor('customer-alice');
      const page = await request(`/oauth/authorize?${new URLSearchParams(authorization)}`, { token });
      assert.equal(page.status, 200); assert.match(page.text, /customer-alice/);
      assert.doesNotMatch(page.text, /<select|name=["']identity["']/i);
      assert.match(page.text, /name="_csrf"/);
      assert.equal(page.headers['referrer-policy'], 'same-origin');
      assert.match(page.text, /<meta name="referrer" content="same-origin">/);
      assert.equal(page.headers['content-security-policy'].split(';').map(value => value.trim()).find(value => value.startsWith('form-action ')),
        `form-action 'self' ${redirectUri}`);
      const base = { method: 'POST', token, origin: baseUrl, form: true };
      const nullOrigin = await request('/oauth/authorize', { ...base, origin: 'null',
        body: { ...authorization, decision: 'allow', _csrf: csrf } });
      assert.equal(nullOrigin.status, 403); assert.equal(nullOrigin.json.error, 'origin_rejected');
      assert.equal((await request('/oauth/authorize', { ...base, body: { ...authorization, decision: 'allow' } })).status, 403);
      assert.equal((await request('/oauth/authorize', { ...base, body: { ...authorization, decision: 'allow', _csrf: await csrfFor('customer-bob') } })).status, 403);
      const override = await request('/oauth/authorize', { ...base, body: { ...authorization, decision: 'allow', _csrf: csrf, identity: 'customer-bob' } });
      assert.equal(override.status, 400); assert.equal(override.json.error, 'identity_parameter_forbidden');
      // A bearer for Bob must not change the cookie-authenticated Alice consent.
      const approved = await request('/oauth/authorize', { ...base, bearer: oauthSession.accessToken,
        body: { ...authorization, decision: 'allow', _csrf: csrf } });
      assert.equal(approved.status, 302);
      assert.equal(approved.headers['content-security-policy'].split(';').map(value => value.trim()).find(value => value.startsWith('form-action ')),
        `form-action 'self' ${redirectUri}`);
      const destination = new URL(approved.headers.location);
      assert.equal(`${destination.origin}${destination.pathname}`, redirectUri);
      assert.equal(destination.searchParams.get('iss'), baseUrl);
      assert.equal(destination.searchParams.get('state'), authorization.state);
      const exchanged = await request('/oauth/token', { method: 'POST', form: true, body: {
        grant_type: 'authorization_code', client_id: authorization.client_id, redirect_uri: redirectUri,
        resource: `${baseUrl}/mcp`, code: destination.searchParams.get('code'), code_verifier: verifier,
      } });
      assert.equal(exchanged.status, 200);
      const identity = await app.auth.authenticate({ headers: { authorization: `Bearer ${exchanged.json.access_token}` } }, { bearerOnly: true });
      assert.equal(identity.id, 'customer-alice');
      assert.deepEqual(identity.scopes, ['orders:read', 'events:read']);
      assert.equal((await request('/api/session', { token: exchanged.json.access_token })).status, 401);
      const denied = await request('/oauth/authorize', { ...base, body: { ...authorization, decision: 'deny', _csrf: csrf } });
      assert.equal(denied.status, 302);
      assert.equal(denied.headers['content-security-policy'].split(';').map(value => value.trim()).find(value => value.startsWith('form-action ')),
        `form-action 'self' ${redirectUri}`);
      const deniedTarget = new URL(denied.headers.location);
      assert.equal(deniedTarget.searchParams.get('error'), 'access_denied');
      assert.equal(deniedTarget.searchParams.get('iss'), baseUrl);
      assert.equal(deniedTarget.searchParams.get('state'), authorization.state);
      assert.equal(deniedTarget.searchParams.has('code'), false);
    });

    await t.test('merchant channels are isolated and customers cannot read or modify them', async () => {
      const channelsA = '/api/merchant/restaurants/demo-a/channels';
      const channelsB = '/api/merchant/restaurants/demo-b/channels';
      assert.equal((await request(channelsA, { token: tokenOf('merchant-a') })).status, 200);
      assert.equal((await request(channelsB, { token: tokenOf('merchant-a') })).status, 403);
      assert.equal((await request(channelsA, { token: tokenOf('merchant-b') })).status, 403);
      assert.equal((await request(channelsA, { token: tokenOf('customer-alice') })).status, 403);
      const body = { enabled: true, connectionMode: 'qr', expectedVersion: 1 };
      assert.equal((await request(channelsB, { method: 'POST', token: tokenOf('merchant-a'), origin: baseUrl,
        headers: { 'X-CSRF-Token': await csrfFor('merchant-a') }, body })).status, 403);
      assert.equal((await request(channelsA, { method: 'POST', token: tokenOf('customer-alice'), origin: baseUrl,
        headers: { 'X-CSRF-Token': await csrfFor('customer-alice') }, body })).status, 403);
      const untouched = await request(channelsB, { token: tokenOf('merchant-b') });
      assert.equal(untouched.json.version, 1); assert.equal(untouched.json.whatsapp.enabled, false);
      assert.equal((await request(`/oauth/authorize?${new URLSearchParams(authorization)}`, { token: tokenOf('merchant-a') })).status, 403);
    });

    await t.test('disabled identities lose existing browser access and logout requires its own CSRF', async () => {
      const token = tokenOf('customer-bob');
      const csrf = await csrfFor('customer-bob');
      assert.equal((await request('/auth/logout', { method: 'POST', token, origin: baseUrl, body: {} })).status, 403);
      assert.equal((await request('/api/session', { token })).status, 200);
      await pool.query("UPDATE demo_identities SET enabled=false WHERE id='customer-bob'");
      assert.equal((await request('/api/session', { token })).status, 401);
      await pool.query("UPDATE demo_identities SET enabled=true WHERE id='customer-bob'");
      const loggedOut = await request('/auth/logout', { method: 'POST', token, origin: baseUrl, body: {}, headers: { 'X-CSRF-Token': csrf } });
      assert.equal(loggedOut.status, 200);
      assert.match(loggedOut.headers['set-cookie'][0], /__Host-restaurant_session=;/);
      assert.match(loggedOut.headers['set-cookie'][0], /HttpOnly/); assert.match(loggedOut.headers['set-cookie'][0], /Secure/);
      assert.equal((await request('/api/session', { token })).status, 401);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (app) await app.close(); else await pool.end();
    // This randomly named schema belongs exclusively to this test execution.
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
