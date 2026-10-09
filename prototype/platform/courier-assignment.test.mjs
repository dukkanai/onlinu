import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import pg from 'pg';
import { createControlPlane } from './control-plane.mjs';

test('browser courier assignment rechecks both grants after body consumption', {
  skip: !process.env.IDENTITY_TEST_DATABASE_URL,
  timeout: 15000,
}, async t => {
  const database = new URL(process.env.IDENTITY_TEST_DATABASE_URL);
  assert.equal(database.pathname, '/astracalls_identity_test');
  assert.equal(database.searchParams.has('dbname'), false);
  const schema = `courier_assignment_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: database.href });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: database.href, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ number: 'R00000001', version: 2, status: 'new',
      paymentStatus: 'unpaid', totalMinor: 100, currency: 'SAR', mode: 'delivery',
      courierId: 'a'.repeat(32), courierName: 'Synthetic courier', deliveryStatus: 'assigned',
      updatedAt: new Date().toISOString() }));
  });
  const baseUrl = 'https://platform.example', issuer = 'https://identity.example/';
  const app = await createControlPlane({ pool, baseUrl, csrfKey: randomBytes(32).toString('base64'),
    serviceSigningKey: generateKeyPairSync('ed25519').privateKey,
    oidc: { issuer, clientId: 'fixture', clientSecret: 'synthetic-test-only' },
    restaurants: [{ id: 'a', name: 'Synthetic A', cuisine: 'fixture', baseUrl: 'http://127.0.0.1:9' }],
  }, { oidcClientAdapter: { async authorizationUrl() { throw Error('unused'); }, async exchange() { throw Error('unused'); } } });
  const owner = await app.directory.verifiedIdentity({ issuer, subject: 'owner' });
  const staff = await app.directory.verifiedIdentity({ issuer, subject: 'staff' });
  await pool.query('UPDATE platform_identities SET platform_admin=TRUE WHERE id=$1', [owner.id]);
  await app.directory.createTenant(owner.id, { id: 'a', name: 'Synthetic A', ownerId: owner.id });
  await app.directory.setTenantStatus(owner.id, 'a', { status: 'active', expectedVersion: 1 });
  let version = null;
  const grants = ['orders:read', 'delivery:assign'];
  const setGrants = async permissions => {
    const member = await app.directory.setMembership(owner.id, 'a', staff.id,
      { role: 'manager', enabled: true, permissions, expectedVersion: version });
    version = member.version;
  };
  const session = await app.auth.issue(staff.id, undefined, { kind: 'browser' });
  const cookie = `__Host-platform_session=${session.accessToken}`;
  const csrf = app.auth.csrfToken({ headers: { cookie } });
  const authorize = app.directory.authorize;
  let checks = [];
  app.directory.authorize = async (...args) => { checks.push(args[2]); return authorize(...args); };
  async function request(onBody = async () => {}, submittedCsrf = csrf) {
    checks = [];
    const req = Readable.from((async function* () {
      assert.deepEqual(checks, grants, 'Both grants must be checked before consuming the body');
      await onBody();
      yield Buffer.from(JSON.stringify({ csrf: submittedCsrf, version: '1', courierId: 'a'.repeat(32), reviewed: 'yes' }));
    })());
    Object.assign(req, { method: 'POST', url: '/manage/a/orders/R00000001/courier',
      headers: { host: 'platform.example', origin: baseUrl, cookie, 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' } });
    const res = { setHeader() {}, writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }, end(body) { this.body = body; } };
    await app.handle(req, res);
    return res;
  }
  for (const revoked of grants) await t.test(`revoked ${revoked} blocks signed dispatch`, async () => {
    calls.length = 0;
    await setGrants(grants);
    const response = await request(() => setGrants(grants.filter(permission => permission !== revoked)));
    assert.equal(response.status, 403);
    assert.equal(calls.length, 0, 'No signed core mutation may be dispatched after revocation');
  });
  await t.test('valid authority dispatches once and CSRF remains required', async () => {
    calls.length = 0;
    await setGrants(grants);
    assert.equal((await request(undefined, 'invalid')).status, 403);
    assert.equal(calls.length, 0);
    const response = await request();
    assert.equal(response.status, 303);
    assert.deepEqual(checks, [...grants, ...grants]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method, 'POST');
  });
});
