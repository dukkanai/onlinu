import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { configuration } from './src.mjs';

function valid() {
  return {
    PROTOTYPE_SYNTHETIC_ONLY:'1', PROTOTYPE_ALLOW_REMOTE:'1', AUTH_MODE:'oidc',
    PUBLIC_BASE_URL:'https://almujeeb.info', DATABASE_URL:'postgres://unused/test',
    EVENTS_ENCRYPTION_KEY:randomBytes(32).toString('base64'),
    SESSION_CSRF_KEY:randomBytes(32).toString('base64'),
    TENANT_A_TOKEN:randomBytes(32).toString('base64url'), TENANT_B_TOKEN:randomBytes(32).toString('base64url'),
    TENANT_A_URL:'http://tenant-a:8080', TENANT_B_URL:'http://tenant-b:8080',
    OIDC_ISSUER:'https://almujeeb.info/identity', OIDC_CLIENT_ID:'restaurant-staging-web',
    OIDC_CLIENT_SECRET:randomBytes(32).toString('base64url'),
    OIDC_IDENTITY_MAP:JSON.stringify({'customer-alice@staging.invalid':'customer-alice'}),
  };
}

test('remote exposure cannot use synthetic identity selection, HTTP, or public fixture keys', () => {
  const env=valid();
  assert.equal(configuration(env).authMode,'oidc');
  assert.throws(()=>configuration({...env,AUTH_MODE:'synthetic'}),/verified OIDC/);
  assert.throws(()=>configuration({...env,PROTOTYPE_ALLOW_REMOTE:'0'}),/Remote synthetic demo disabled/);
  assert.throws(()=>configuration({...env,PUBLIC_BASE_URL:'http://almujeeb.info'}),/Remote synthetic demo disabled/);
  assert.throws(()=>configuration({...env,TENANT_A_TOKEN:`demo-${'x'.repeat(40)}`}),/fixture credentials/);
  assert.throws(()=>configuration({...env,EVENTS_ENCRYPTION_KEY:Buffer.alloc(32).toString('base64')}),/fixture credentials/);
});

test('protected staging requires local trusted issuer, synthetic allowlist, and independent secrets', () => {
  const env=valid();
  assert.throws(()=>configuration({...env,OIDC_ISSUER:'https://untrusted.example/identity'}),/trusted issuer/);
  assert.throws(()=>configuration({...env,OIDC_IDENTITY_MAP:'{}'}),/allowlist/);
  assert.throws(()=>configuration({...env,OIDC_IDENTITY_MAP:JSON.stringify({'real@example.com':'customer-alice'})}),/allowlist/);
  assert.throws(()=>configuration({...env,OIDC_IDENTITY_MAP:JSON.stringify({'owner@staging.invalid':'administrator'})}),/allowlist/);
  assert.throws(()=>configuration({...env,SESSION_CSRF_KEY:'short'}),/secure OIDC/);
  assert.throws(()=>configuration({...env,TENANT_B_TOKEN:env.TENANT_A_TOKEN}),/distinct/);
  assert.throws(()=>configuration({...env,DATABASE_URL_FILE:'/unused'}),/ambiguous DATABASE_URL/);
});

test('local fixture mode remains available only on the explicit loopback demo', () => {
  const env=valid();
  const local=configuration({...env,AUTH_MODE:'synthetic',PUBLIC_BASE_URL:'http://127.0.0.1:18787',PROTOTYPE_ALLOW_REMOTE:'0'});
  assert.equal(local.authMode,'synthetic');
  assert.equal(local.redirects[0],'http://127.0.0.1:18787/dev/oauth-callback');
});
