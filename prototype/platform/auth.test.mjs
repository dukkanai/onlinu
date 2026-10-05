import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createAuth, hash, pkceChallenge, verifyPkce, FIXTURES } from './auth.mjs';

test('PKCE S256 official RFC7636 vector and malformed verifiers', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(pkceChallenge(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.equal(verifyPkce(verifier, pkceChallenge(verifier)), true);
  assert.equal(verifyPkce('wrong', pkceChallenge(verifier)), false);
  assert.equal(verifyPkce(undefined, 'anything'), false);
});
test('fixture merchant memberships never span both restaurants', () => {
  assert.deepEqual(FIXTURES['merchant-a'].tenantIds, ['demo-a']);
  assert.deepEqual(FIXTURES['merchant-b'].tenantIds, ['demo-b']);
  assert.equal(FIXTURES['customer-alice'].role, 'customer');
});

function fixtureAuth() {
  const browser = randomBytes(32).toString('base64url');
  const oauth = randomBytes(32).toString('base64url');
  const sessions = new Map([
    [hash(browser), { principal_id: 'customer-alice', scopes: ['orders:read'], session_kind: 'browser' }],
    [hash(oauth), { principal_id: 'customer-bob', scopes: ['orders:read'], session_kind: 'oauth' }],
  ]);
  const auth = createAuth({ baseUrl: 'https://almujeeb.info', allowSyntheticAuthorization: false,
    cookieName: '__Host-restaurant_session', csrfKey: randomBytes(32).toString('base64'),
    pool: { query: async (sql, values) => ({ rows: sql.includes('FROM demo_sessions')
      ? sessions.has(values[0]) ? [sessions.get(values[0])] : [] : [{ enabled: true }] }) },
  });
  return { auth, browser, oauth, cookie: token => `__Host-restaurant_session=${token}` };
}

test('verified browser sessions and OAuth bearer tokens cannot substitute for each other', async () => {
  const { auth, browser, oauth, cookie } = fixtureAuth();
  assert.equal((await auth.authenticate({ headers: { cookie: cookie(browser) } }, { cookieOnly: true })).id, 'customer-alice');
  assert.equal(await auth.authenticate({ headers: { cookie: cookie(oauth) } }, { cookieOnly: true }), null);
  assert.equal((await auth.authenticate({ headers: { authorization: `Bearer ${oauth}` } }, { bearerOnly: true })).id, 'customer-bob');
  assert.equal(await auth.authenticate({ headers: { authorization: `Bearer ${browser}` } }, { bearerOnly: true }), null);
  assert.equal(await auth.authenticate({ headers: { cookie: cookie(browser) } }, { bearerOnly: true }), null);
});

test('explicit auth channel has deterministic identity with mixed bearer and browser credentials', async () => {
  const { auth, browser, oauth, cookie } = fixtureAuth();
  const req = { headers: { cookie: cookie(browser), authorization: `Bearer ${oauth}` } };
  assert.equal((await auth.authenticate(req, { cookieOnly: true })).id, 'customer-alice');
  assert.equal((await auth.authenticate(req, { bearerOnly: true })).id, 'customer-bob');
  assert.equal(await auth.authenticate({ headers: { cookie: cookie(browser), authorization: 'Bearer malformed' } }), null);
});

test('CSRF is bound to one unambiguous browser cookie, rejecting missing/wrong/cross-session values', () => {
  const { auth, browser, cookie } = fixtureAuth();
  const req = { headers: { cookie: cookie(browser) } };
  const csrf = auth.csrfToken(req);
  assert.doesNotThrow(() => auth.verifyCsrf(req, csrf));
  assert.throws(() => auth.verifyCsrf(req), error => error.status === 403);
  assert.throws(() => auth.verifyCsrf(req, randomBytes(32).toString('base64url')), error => error.status === 403);
  const other = { headers: { cookie: cookie(randomBytes(32).toString('base64url')) } };
  assert.throws(() => auth.verifyCsrf(other, csrf), error => error.status === 403);
  const duplicate = { headers: { cookie: `${cookie(browser)}; ${cookie(browser)}` } };
  assert.equal(auth.browserToken(duplicate), null);
  assert.throws(() => auth.verifyCsrf(duplicate, csrf), error => error.status === 403);
});

test('DCR rejection reports exact incompatible fields using only fixed non-sensitive labels', async () => {
  const reports = [];
  let writes = 0;
  const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';
  const auth = createAuth({ baseUrl:'https://almujeeb.info', redirectAllowlist:[callback],
    pool:{query:async()=>{writes++;return {rows:[]};}}, onRegistrationRejected:report=>reports.push(report) });
  await assert.rejects(auth.register({ redirect_uris:['https://chatgpt.com/connector/oauth/privateCallbackId'], token_endpoint_auth_method:'client_secret_post',
    grant_types:['authorization_code','refresh_token'], response_types:['private-response'], client_secret:'never-log-this', client_name:'private-client-name' }), error=>error.status===400 && error.code==='invalid_client_metadata');
  assert.deepEqual(reports,[{fields:['redirect_uris','token_endpoint_auth_method','response_types'], authMethod:'client_secret_post',
    grantTypes:['authorization_code','refresh_token'], redirectKinds:['chatgpt_connection_specific']}]);
  assert.doesNotMatch(JSON.stringify(reports),/private|never-log|https|callbackId/i);
  assert.equal(writes,0);
  const registered = await auth.register({redirect_uris:[callback], token_endpoint_auth_method:'none', grant_types:['authorization_code'], response_types:['code']});
  assert.equal(registered.token_endpoint_auth_method,'none');
  assert.equal(writes,1);
  assert.equal(reports.length,1);
});

test('DCR accepts the observed ChatGPT grant request but rejects unsupported grants and duplicates', async () => {
  const callback='https://chatgpt.com/connector_platform_oauth_redirect';
  const auth=createAuth({baseUrl:'https://almujeeb.info',redirectAllowlist:[callback],pool:{query:async()=>({rows:[]})}});
  assert.deepEqual(auth.metadata.grant_types_supported,['authorization_code','refresh_token']);
  for(const grants of [['authorization_code','refresh_token'],['refresh_token','authorization_code'],['authorization_code']]) {
    assert.deepEqual((await auth.register({redirect_uris:[callback],token_endpoint_auth_method:'none',grant_types:grants,response_types:['code']})).grant_types,grants);
  }
  for(const grants of [[],['refresh_token'],['authorization_code','client_credentials'],['authorization_code','authorization_code'],'authorization_code']) {
    await assert.rejects(auth.register({redirect_uris:[callback],grant_types:grants}),error=>error.code==='invalid_client_metadata');
  }
});

test('DCR reporter failures cannot permit invalid redirects or change the rejection', async () => {
  let writes = 0;
  const auth = createAuth({baseUrl:'https://almujeeb.info', redirectAllowlist:['https://chatgpt.com/connector_platform_oauth_redirect'],
    pool:{query:async()=>{writes++;return {rows:[]};}}, onRegistrationRejected:()=>{throw new Error('reporter-failure');}});
  for(const input of [null,{}, {redirect_uris:['https://chatgpt.com.evil.invalid/connector_platform_oauth_redirect']},
    {redirect_uris:['https://chatgpt.com/connector_platform_oauth_redirect?next=private']},
    {redirect_uris:['https://chatgpt.com/connector_platform_oauth_redirect'],token_endpoint_auth_method:'unsupported-secret'}]) {
    await assert.rejects(auth.register(input),error=>error.status===400 && error.code==='invalid_client_metadata');
  }
  assert.equal(writes,0);
});
