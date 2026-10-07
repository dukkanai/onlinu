import test from 'node:test';
import assert from 'node:assert/strict';
import { ANDROID_CLIENT_ID, IOS_CLIENT_ID, WINDOWS_CLIENT_ID,
  WINDOWS_REDIRECT_TEMPLATE, mobileRedirects, nativeClientPolicy,
  windowsRedirectAllowed } from './native-client-policy.mjs';
import { createAuth, NATIVE_CLIENT_ID } from './auth.mjs';

test('Windows loopback policy preserves exact spelling and bounded ports', () => {
  assert.equal(NATIVE_CLIENT_ID, WINDOWS_CLIENT_ID);
  for (const port of [1024, 43123, 65535]) {
    assert.equal(windowsRedirectAllowed(`http://127.0.0.1:${port}/oauth/callback`), true);
  }
  for (const value of [undefined, null, 123, {}, WINDOWS_REDIRECT_TEMPLATE,
    'http://127.0.0.1:1023/oauth/callback', 'http://127.0.0.1:65536/oauth/callback',
    'http://127.0.0.1:043123/oauth/callback', 'http://localhost:43123/oauth/callback',
    'http://127.1:43123/oauth/callback', 'http://[::1]:43123/oauth/callback',
    'https://127.0.0.1:43123/oauth/callback', 'HTTP://127.0.0.1:43123/oauth/callback',
    'http://user@127.0.0.1:43123/oauth/callback', 'http://127.0.0.1:43123/oauth/callback/',
    'http://127.0.0.1:43123/oauth/callback?code=x', 'http://127.0.0.1:43123/oauth/callback#x',
    'http://127.0.0.1:43123/oauth/%63allback', 'http://127.0.0.1:43123/oauth/callback\n']) {
    assert.equal(windowsRedirectAllowed(value), false, String(value));
  }
});

test('mobile policy is opt-in, immutable, and does not normalize callback input', () => {
  const windowsOnly = nativeClientPolicy();
  assert.equal(windowsOnly.registrations.length, 1);
  assert.equal(windowsOnly.get(ANDROID_CLIENT_ID), null);
  assert.equal(windowsOnly.redirectAllowed(IOS_CLIENT_ID, 'example.platform.onlinu.ios:/oauth/callback'), false);
  for (const mobileEnabled of ['true', 1, null]) {
    assert.throws(() => nativeClientPolicy({mobileEnabled}), /invalid_mobile_enabled/);
  }
  const policy = nativeClientPolicy({origin:'https://platform.example', mobileEnabled:true});
  assert.equal(policy.registrations.length, 3);
  assert.throws(() => policy.registrations.push({id:'evil'}), TypeError);
  assert.throws(() => { policy.get(IOS_CLIENT_ID).redirect = 'evil:/'; }, TypeError);
  for (const [id, platform] of [[ANDROID_CLIENT_ID,'android'], [IOS_CLIENT_ID,'ios']]) {
    const redirect = `example.platform.onlinu.${platform}:/oauth/callback`;
    assert.equal(policy.redirectAllowed(id, redirect), true);
    for (const value of [redirect + '?x=1', redirect + '#x', redirect + '/',
      redirect.replace(':/', '://'), redirect.toUpperCase(),
      redirect.replace('/callback', '/%63allback'), redirect + '\n',
      ' ' + redirect, new URL(redirect), 'http://127.0.0.1:43123/oauth/callback']) {
      assert.equal(policy.redirectAllowed(id, value), false);
    }
    assert.equal(policy.redirectAllowed(WINDOWS_CLIENT_ID, redirect), false);
    assert.equal(policy.redirectAllowed(id === IOS_CLIENT_ID ? ANDROID_CLIENT_ID : IOS_CLIENT_ID, redirect), false);
  }
  assert.equal(policy.redirectAllowed('unknown', policy.get(IOS_CLIENT_ID).redirect), false);
});

test('mobile schemes derive only from canonical public-shaped HTTPS DNS origins', () => {
  assert.deepEqual(mobileRedirects('https://auth.platform.example'), {
    android:'example.platform.auth.onlinu.android:/oauth/callback',
    ios:'example.platform.auth.onlinu.ios:/oauth/callback',
  });
  for (const origin of [undefined, null, {}, new URL('https://platform.example'),
    'https://platform.example/', 'https://platform.example:443', 'https://platform.example:8443',
    'http://platform.example', 'https://PLATFORM.example', 'https://platform.example/path',
    'https://user:password@platform.example', 'https://platform.example?x=1',
    'https://platform.example#x', 'https://platform.example.', 'https://localhost',
    'https://platform.localhost', 'https://platform.local', 'https://platform.internal',
    'https://127.0.0.1', 'https://[::1]', 'https://one.123', 'https://one.1com',
    'https://bad_label.example', 'https://-bad.example', 'https://bad-.example',
    'https://a..example', `https://${'a'.repeat(64)}.example`]) {
    assert.throws(() => mobileRedirects(origin), /invalid_mobile_origin/, String(origin));
  }
});

test('policy preparation does not enable mobile authorization in the existing broker', async () => {
  let queries = 0;
  const auth = createAuth({pool:{query(){queries++;}}, baseUrl:'https://platform.example/native',
    profile:'native_staff', csrfKey:Buffer.alloc(32,1).toString('base64'),
    allowSyntheticAuthorization:false, principalResolver:async()=>null});
  for (const client_id of [ANDROID_CLIENT_ID, IOS_CLIENT_ID]) {
    await assert.rejects(auth.validateAuthorization({client_id}), {code:'invalid_client_metadata'});
  }
  assert.equal(queries, 0, 'Mobile clients are rejected before database access');
});
