import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import pg from 'pg';
import { createOidcLogin, createOidcClientAdapter, validateReturnTo } from './oidc.mjs';

const issuer = 'https://login.example/identity';
const baseUrl = 'https://restaurant.example';
const clientId = 'restaurant-staging-web';
const clientSecret = 'synthetic-client-secret-do-not-use-outside-tests';
const identityMap = { 'customer-alice@staging.invalid': 'customer-alice', 'customer-bob@staging.invalid': 'customer-bob' };
const settings = { issuer, baseUrl, clientId, clientSecret, identityMap };
const callback = state => `${baseUrl}/auth/callback?code=test-code&state=${state}`;
const stateOf = flow => new URL(flow.authorizationUrl).searchParams.get('state');

test('return destinations are constrained to approved local views', () => {
  for (const path of ['/', '/manage', '/manage/restaurant-a/orders', '/manage/restaurant-a/orders/R2026000001', '/manage/restaurant-a/channels', '/manage/restaurant-a/stock', '/manage/restaurant-a/members', '/native/sessions', '/native/oauth/authorize?client_id=onlinu-native-windows-v1', '/manage/restaurant-a/menu', '/manage/restaurant-a/menu/items/rice', '/checkout/check_123', '/oauth/authorize?client_id=x&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fcallback']) {
    assert.equal(validateReturnTo(path, baseUrl), path);
  }
  for (const path of ['https://evil.example/', '//evil.example/', '/\\evil.example/', '/%5cevil.example/',
    '/%2f%2fevil.example/', '/\nevil.example/', '/oauth/authorize#other', '/admin', '/checkout/',
    '/checkout/x?next=https://evil.example/', '/?redirect=https://evil.example/', '/oauth/authorize?state=%0d%0aHeader']) {
    assert.throws(() => validateReturnTo(path, baseUrl), error => error.code === 'oidc_invalid_flow', path);
  }
});

function provider() {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' };
  const control = { requests: [], changes: {}, invalidSignature: false, wrongEndpoint: false, unavailable: false };
  function jwt() {
    const now = Math.floor(Date.now() / 1000);
    const payload = { iss: issuer, sub: 'opaque-provider-subject', aud: clientId, iat: now, exp: now + 300,
      nonce: 'expected-nonce', email: 'customer-alice@staging.invalid', email_verified: true, ...control.changes };
    const encoded = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    const signature = sign('RSA-SHA256', Buffer.from(encoded), keys.privateKey);
    if (control.invalidSignature) signature[0] ^= 0xff;
    return `${encoded}.${signature.toString('base64url')}`;
  }
  const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  control.fetch = async (url, options) => {
    control.requests.push({ url, options });
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    if (control.unavailable) throw new Error('private network detail that must not escape');
    if (url.endsWith('/.well-known/openid-configuration')) return json({ issuer,
      authorization_endpoint: `${issuer}/auth`, token_endpoint: control.wrongEndpoint ? 'https://evil.example/token' : `${issuer}/token`,
      jwks_uri: `${issuer}/keys`, response_types_supported: ['code'], subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_basic'],
      code_challenge_methods_supported: ['S256'] });
    if (url === `${issuer}/token`) {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('code_verifier'), 'expected-verifier');
      assert.equal(body.get('redirect_uri'), `${baseUrl}/auth/callback`);
      assert.equal(body.get('code'), 'test-code');
      assert.match(new Headers(options.headers).get('authorization'), /^Basic /);
      return json({ token_type: 'Bearer', access_token: 'private-access-token', expires_in: 300, id_token: jwt() });
    }
    if (url === `${issuer}/keys`) return json({ keys: [jwk] });
    assert.fail('Unexpected provider request');
  };
  return control;
}

const exchange = adapter => adapter.exchange({ callbackUrl: callback('expected-state'), state: 'expected-state',
  nonce: 'expected-nonce', codeVerifier: 'expected-verifier' });

test('actual openid-client uses PKCE/state/nonce and verifies the ID-token signature against issuer JWKS', async () => {
  const fake = provider();
  const adapter = createOidcClientAdapter({ ...settings, fetchImpl: fake.fetch });
  assert.equal(fake.requests.length, 0);
  const authorization = new URL(await adapter.authorizationUrl({ state: 'expected-state', nonce: 'expected-nonce',
    redirectUri: `${baseUrl}/auth/callback`, codeChallenge: 'expected-challenge' }));
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.get('scope'), 'openid email');
  assert.equal(authorization.searchParams.get('state'), 'expected-state');
  assert.equal(authorization.searchParams.get('nonce'), 'expected-nonce');
  const claims = await exchange(adapter);
  assert.equal(claims.sub, 'opaque-provider-subject');
  assert.equal(Object.hasOwn(claims, 'access_token'), false);
  assert.ok(fake.requests.some(request => request.url === `${issuer}/keys`));
});

test('actual library rejects wrong issuer/audience/nonce, expiry, state, and tampered signatures', async () => {
  const fake = provider();
  const adapter = createOidcClientAdapter({ ...settings, fetchImpl: fake.fetch });
  for (const changes of [{ iss: 'https://other.example' }, { aud: 'different-client' }, { nonce: 'wrong-nonce' },
    { exp: Math.floor(Date.now() / 1000) - 600 }]) {
    fake.changes = changes;
    await assert.rejects(exchange(adapter), error => error.code === 'oidc_verification_failed' && error.status === 403);
  }
  fake.changes = {}; fake.invalidSignature = true;
  await assert.rejects(exchange(adapter), error => error.code === 'oidc_verification_failed');
  fake.invalidSignature = false;
  const before = fake.requests.filter(request => request.url === `${issuer}/token`).length;
  await assert.rejects(adapter.exchange({ callbackUrl: callback('other-state'), state: 'expected-state',
    nonce: 'expected-nonce', codeVerifier: 'expected-verifier' }), error => error.code === 'oidc_verification_failed');
  assert.equal(fake.requests.filter(request => request.url === `${issuer}/token`).length, before);
});

test('discovery is lazy/retryable, rejects other-origin endpoints, and does not reveal provider errors', async () => {
  const fake = provider();
  const adapter = createOidcClientAdapter({ ...settings, fetchImpl: fake.fetch });
  const request = { state: 's', nonce: 'n', redirectUri: `${baseUrl}/auth/callback`, codeChallenge: 'c' };
  fake.unavailable = true;
  await assert.rejects(adapter.authorizationUrl(request), error => error.message === 'oidc_unavailable' && error.status === 503);
  fake.unavailable = false; fake.wrongEndpoint = true;
  await assert.rejects(adapter.authorizationUrl(request), error => error.code === 'oidc_unavailable');
  assert.ok(fake.requests.every(item => new URL(item.url).origin === new URL(issuer).origin));
  fake.wrongEndpoint = false;
  assert.equal(new URL(await adapter.authorizationUrl(request)).origin, new URL(issuer).origin);
});

test('configuration requires HTTPS and a unique server-owned identity allowlist', () => {
  const pool = { query() {}, connect() {} };
  for (const changes of [{ issuer: 'http://login.example/identity' }, { baseUrl: 'http://restaurant.example' },
    { identityMap: { 'alice@example.com': 'same', 'bob@example.com': 'same' } }, { identityMap: {} }, { clientSecret: '' }]) {
    assert.throws(() => createOidcLogin({ ...settings, pool, ...changes }));
  }
});

test('database connection errors are sanitized before a token exchange', async () => {
  const login = createOidcLogin({ ...settings,
    pool: { query() {}, connect: async () => { throw new Error('private-database-host-and-credential'); } },
    clientAdapter: { exchange: () => assert.fail('Must not exchange tokens') },
  });
  await assert.rejects(login.complete(callback(randomBytes(32).toString('base64url')), randomBytes(32).toString('base64url')),
    error => error.message === 'oidc_unavailable' && error.status === 503);
});

test('PostgreSQL one-use browser binding and identity pinning', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const schema = `oidc_test_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  let now = Date.now();
  let overrides = {};
  let exchanges = [];
  let failExchange = false;
  const clientAdapter = {
    async authorizationUrl(args) {
      const url = new URL(`${issuer}/auth`);
      for (const [key, value] of Object.entries(args)) url.searchParams.set(key, value);
      return url.href;
    },
    async exchange(args) {
      exchanges.push(args);
      if (failExchange) throw new Error('raw-token-or-provider-secret');
      return { iss: issuer, sub: 'opaque-alice-subject', aud: clientId, email: 'customer-alice@staging.invalid',
        email_verified: true, nonce: args.nonce, ...overrides };
    },
  };
  const options = { ...settings, pool, clientAdapter, now: () => now };
  let login = createOidcLogin(options);
  async function reset() {
    await pool.query('TRUNCATE oidc_login_states,oidc_identity_bindings');
    now = Date.now(); overrides = {}; exchanges = []; failExchange = false; login = createOidcLogin(options);
  }
  try {
    await login.init();
    await t.test('raw state/cookie are not stored and a restarted service completes and consumes the flow once', async () => {
      const flow = await login.begin('/checkout/check_1');
      const state = stateOf(flow);
      const rows = (await pool.query('SELECT * FROM oidc_login_states')).rows;
      assert.equal(rows.length, 1);
      assert.equal(JSON.stringify(rows).includes(flow.bindingCookie), false);
      assert.equal(JSON.stringify(rows).includes(state), false);
      assert.equal(new Date(rows[0].expires_at) - new Date(rows[0].created_at), 600_000);
      assert.equal(createHash('sha256').update(rows[0].pkce_verifier).digest('base64url'), new URL(flow.authorizationUrl).searchParams.get('codeChallenge'));
      login = createOidcLogin(options);
      assert.deepEqual(await login.complete(callback(state), flow.bindingCookie), { principalId: 'customer-alice', returnTo: '/checkout/check_1' });
      assert.equal((await pool.query('SELECT * FROM oidc_login_states')).rowCount, 0);
      await assert.rejects(login.complete(callback(state), flow.bindingCookie), error => error.code === 'oidc_invalid_flow');
      assert.equal(exchanges.length, 1);
      assert.deepEqual((await pool.query('SELECT issuer,subject,principal_id FROM oidc_identity_bindings')).rows,
        [{ issuer, subject: 'opaque-alice-subject', principal_id: 'customer-alice' }]);
    });

    await t.test('swapped browser bindings, malformed callbacks and expired state cannot exchange tokens', async () => {
      await reset(); const first = await login.begin(); const second = await login.begin();
      await assert.rejects(login.complete(callback(stateOf(first)), second.bindingCookie), error => error.code === 'oidc_invalid_flow');
      await assert.rejects(login.complete(`${callback(stateOf(first))}&state=duplicate`, first.bindingCookie), error => error.code === 'oidc_invalid_flow');
      await assert.rejects(login.complete(callback(stateOf(first)).replace(baseUrl, 'https://other.example'), first.bindingCookie), error => error.code === 'oidc_invalid_flow');
      assert.equal(exchanges.length, 0);
      assert.equal((await login.complete(callback(stateOf(first)), first.bindingCookie)).principalId, 'customer-alice');
      now += 600_001;
      await assert.rejects(login.complete(callback(stateOf(second)), second.bindingCookie), error => error.code === 'oidc_invalid_flow');
      assert.equal(exchanges.length, 1);
    });

    await t.test('unverified or unmapped emails and mismatched claims never establish a binding', async () => {
      for (const claims of [{ email_verified: false }, { email_verified: 'true' }, { email: 'someone@staging.invalid' },
        { email: 'Customer-Alice@staging.invalid' }, { iss: 'https://other.example' }, { aud: 'other-client' }, { nonce: 'wrong' }]) {
        await reset(); overrides = claims; const flow = await login.begin();
        await assert.rejects(login.complete(callback(stateOf(flow)), flow.bindingCookie), error => error.code === 'oidc_identity_not_allowed');
        assert.equal((await pool.query('SELECT * FROM oidc_identity_bindings')).rowCount, 0);
        assert.equal((await pool.query('SELECT * FROM oidc_login_states')).rowCount, 0);
      }
    });

    await t.test('opaque issuer/subject binding prevents both email reassignment and identity switching', async () => {
      await reset(); let flow = await login.begin(); await login.complete(callback(stateOf(flow)), flow.bindingCookie);
      overrides = { sub: 'new-subject-with-same-email' }; flow = await login.begin();
      await assert.rejects(login.complete(callback(stateOf(flow)), flow.bindingCookie), error => error.code === 'oidc_identity_not_allowed');
      overrides = { email: 'customer-bob@staging.invalid' }; flow = await login.begin();
      await assert.rejects(login.complete(callback(stateOf(flow)), flow.bindingCookie), error => error.code === 'oidc_identity_not_allowed');
      overrides = { sub: 'opaque-bob-subject', email: 'customer-bob@staging.invalid', role: 'admin' }; flow = await login.begin();
      assert.deepEqual(await login.complete(callback(stateOf(flow)), flow.bindingCookie), { principalId: 'customer-bob', returnTo: '/' });
    });

    await t.test('failed exchange consumes state without leaking errors; concurrent callbacks exchange only once', async () => {
      await reset(); let flow = await login.begin(); failExchange = true;
      await assert.rejects(login.complete(callback(stateOf(flow)), flow.bindingCookie), error => error.message === 'oidc_verification_failed');
      await assert.rejects(login.complete(callback(stateOf(flow)), flow.bindingCookie), error => error.code === 'oidc_invalid_flow');
      assert.equal(exchanges.length, 1);
      failExchange = false; flow = await login.begin();
      const results = await Promise.allSettled([login.complete(callback(stateOf(flow)), flow.bindingCookie), login.complete(callback(stateOf(flow)), flow.bindingCookie)]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(exchanges.length, 2);
    });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
