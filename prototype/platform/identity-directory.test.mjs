import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createIdentityDirectory, RESTAURANT_PERMISSIONS } from './identity-directory.mjs';
import { createAuth } from './auth.mjs';
import { createOidcLogin } from './oidc.mjs';

const issuer = 'https://identity.example/';
test('persistent identity refuses unverified fixture mode and insecure issuers', () => {
  const pool = { query() {}, connect() {} };
  assert.throws(() => createIdentityDirectory({ pool, trustedIssuers: ['http://identity.example/'] }));
  assert.throws(() => createAuth({ pool, baseUrl: 'https://app.example', principalResolver() {} }), /verified_login/);
});

test('persistent tenant identity, roles, concurrency and OAuth revocation', {
  skip: !process.env.IDENTITY_TEST_DATABASE_URL,
}, async t => {
  const url = new URL(process.env.IDENTITY_TEST_DATABASE_URL);
  assert.equal(url.pathname, '/astracalls_identity_test', 'Only dedicated disposable database allowed');
  assert.equal(url.searchParams.has('dbname'), false);
  const schema = `identity_test_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: url.href });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: url.href, options: `-c search_path=${schema}`, max: 8 });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const directory = createIdentityDirectory({ pool, trustedIssuers: [issuer, 'https://other.example/'] });
  await directory.init();
  const make = subject => directory.verifiedIdentity({ issuer, subject });
  const root = await make('operator');
  // Test-only offline bootstrap; production has no public promotion endpoint.
  await pool.query('UPDATE platform_identities SET platform_admin=TRUE WHERE id=$1', [root.id]);
  const ownerA = await make('owner-a'), ownerB = await make('owner-b'), worker = await make('worker');
  const request = { role: 'kitchen', enabled: true, expectedVersion: null };

  await t.test('issuer/subject is the identity, no email linking or role input', async () => {
    assert.deepEqual(await make('owner-a'), ownerA);
    assert.notEqual((await directory.verifiedIdentity({ issuer: 'https://other.example/', subject: 'owner-a' })).id, ownerA.id);
    await assert.rejects(directory.verifiedIdentity({ issuer: 'https://evil.example/', subject: 'owner-a' }), { code: 'untrusted_issuer' });
    await assert.rejects(directory.verifiedIdentity({ issuer, subject: 'owner-a', role: 'owner' }), { code: 'invalid_request' });
    const duplicates = await Promise.all([make('concurrent'), make('concurrent')]);
    assert.equal(duplicates[0].id, duplicates[1].id);
  });

  await t.test('only trusted operator can create tenant and ownership is audited', async () => {
    await assert.rejects(directory.createTenant(ownerA.id, { id: 'a', name: 'A', ownerId: ownerA.id }), { code: 'forbidden' });
    for (const [id, owner] of [['a', ownerA], ['b', ownerB]]) {
      assert.equal((await directory.createTenant(root.id, { id, name: `Restaurant ${id}`, ownerId: owner.id })).status, 'draft');
      await directory.setTenantStatus(root.id, id, { status: 'active', expectedVersion: 1 });
    }
    await assert.rejects(directory.createTenant(root.id, { id: 'a', name: 'duplicate', ownerId: ownerA.id }), { code: 'tenant_exists' });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM platform_identity_audit WHERE action='tenant_created'")).rows[0].n, 2);
  });

  await t.test('cross-tenant and nonexistent identities cannot gain memberships', async () => {
    await assert.rejects(directory.setMembership(ownerA.id, 'b', worker.id, request), { code: 'forbidden' });
    await assert.rejects(directory.setMembership(ownerA.id, 'a', randomUUID(), request), { code: 'identity_disabled' });
    const member = await directory.setMembership(ownerA.id, 'a', worker.id, request);
    assert.equal(member.version, 1);
    await directory.authorize(worker.id, 'a', 'orders:read');
    await assert.rejects(directory.authorize(worker.id, 'b', 'orders:read'), { code: 'forbidden' });
    await assert.rejects(directory.authorize(worker.id, 'a', 'refunds:manage'), { code: 'forbidden' });
  });

  await t.test('stale and concurrent edits cannot silently overwrite permissions', async () => {
    await assert.rejects(directory.setMembership(ownerA.id, 'a', worker.id, { ...request, expectedVersion: null }), { code: 'version_conflict' });
    const result = await Promise.allSettled(['cashier', 'supervisor'].map(role => directory.setMembership(ownerA.id, 'a', worker.id, { role, enabled: true, expectedVersion: 1 })));
    assert.equal(result.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(result.find(item => item.status === 'rejected').reason.code, 'version_conflict');
  });

  await t.test('delegated membership management cannot escalate or change owner', async () => {
    const limited = ['orders:read', 'members:manage'];
    await directory.setMembership(ownerA.id, 'a', worker.id, { role: 'manager', permissions: limited, enabled: true, expectedVersion: 2 });
    const target = await make('target');
    await directory.setMembership(worker.id, 'a', target.id, { role: 'kitchen', permissions: ['orders:read'], enabled: true, expectedVersion: null });
    await assert.rejects(directory.setMembership(worker.id, 'a', target.id, { role: 'owner', enabled: true, expectedVersion: 1 }), { code: 'forbidden' });
    await assert.rejects(directory.setMembership(worker.id, 'a', target.id, { role: 'manager', permissions: ['refunds:manage'], enabled: true, expectedVersion: 1 }), { code: 'forbidden' });
    await assert.rejects(directory.setMembership(worker.id, 'a', ownerA.id, { ...request, expectedVersion: 1 }), { code: 'forbidden' });
  });

  await t.test('last owner cannot be removed, including concurrent owner removals', async () => {
    await assert.rejects(directory.setMembership(root.id, 'a', ownerA.id, { role: 'owner', enabled: false, expectedVersion: 1 }), { code: 'last_owner_required' });
    await assert.rejects(directory.setMembership(ownerA.id, 'a', ownerA.id, { role: 'owner', permissions: ['orders:read'], enabled: true, expectedVersion: 1 }), { code: 'invalid_owner_permissions' });
    const second = await make('second-owner');
    await directory.setMembership(ownerA.id, 'a', second.id, { role: 'owner', enabled: true, expectedVersion: null });
    const results = await Promise.allSettled([ownerA, second].map(person => directory.setMembership(root.id, 'a', person.id, { role: 'owner', enabled: false, expectedVersion: 1 })));
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(results.find(item => item.status === 'rejected').reason.code, 'last_owner_required');
  });

  await t.test('audit failure rolls back membership and version atomically', async () => {
    await pool.query(`CREATE FUNCTION reject_membership_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='membership_changed' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_membership_audit BEFORE INSERT ON platform_identity_audit FOR EACH ROW EXECUTE FUNCTION reject_membership_audit()`);
    await assert.rejects(directory.setMembership(root.id, 'a', worker.id, { role: 'cashier', enabled: true, expectedVersion: 3 }));
    const stored = (await pool.query('SELECT version,role FROM platform_memberships WHERE tenant_id=$1 AND principal_id=$2', ['a', worker.id])).rows[0];
    assert.equal(Number(stored.version), 3); assert.equal(stored.role, 'manager');
    await pool.query('DROP TRIGGER reject_membership_audit ON platform_identity_audit');
  });

  await t.test('suspension retains settlement access without reopening business settings', async () => {
    await directory.setTenantStatus(root.id, 'b', { status: 'suspended', expectedVersion: 2 });
    await directory.authorize(ownerB.id, 'b', 'refunds:manage');
    await assert.rejects(directory.authorize(ownerB.id, 'b', 'channels:manage'), { code: 'tenant_suspended' });
    assert.equal((await directory.resolve(ownerB.id)).memberships[0].tenantStatus, 'suspended');
    await assert.rejects(directory.setTenantStatus(ownerB.id, 'b', { status: 'active', expectedVersion: 3 }), { code: 'forbidden' });
    await directory.setTenantStatus(root.id, 'b', { status: 'active', expectedVersion: 3 });
  });

  await t.test('real resolver issues OAuth sessions without seeding fixture users', async () => {
    const auth = createAuth({ pool, baseUrl: 'https://platform.example', allowSyntheticAuthorization: false,
      csrfKey: randomBytes(32).toString('base64'), principalResolver: directory.resolve });
    await auth.init();
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM demo_identities')).rows[0].n, 0);
    const session = await auth.issue(worker.id, ['orders:read']);
    const req = { headers: { authorization: `Bearer ${session.accessToken}` } };
    assert.equal((await auth.authenticate(req, { bearerOnly: true })).id, worker.id);
    await assert.rejects(auth.issue('customer-alice'), { code: 'identity_disabled' });
    await assert.rejects(auth.issue(worker.id, ['platform:admin']), { code: 'identity_disabled' });
    await pool.query('UPDATE platform_identities SET enabled=FALSE WHERE id=$1', [worker.id]);
    assert.equal(await auth.authenticate(req, { bearerOnly: true }), null);
    await assert.rejects(make('worker'), { code: 'identity_disabled' });
  });

  await t.test('closing tenants preserves data and cannot silently reactivate', async () => {
    await directory.setTenantStatus(root.id, 'b', { status: 'closed', expectedVersion: 4 });
    await assert.rejects(directory.setTenantStatus(root.id, 'b', { status: 'active', expectedVersion: 5 }), { code: 'invalid_tenant_transition' });
    await assert.rejects(directory.authorize(ownerB.id, 'b', 'orders:read'), { code: 'forbidden' });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM platform_memberships WHERE tenant_id=$1', ['b'])).rows[0].n, 1);
    assert.ok(RESTAURANT_PERMISSIONS.includes('channels:manage'));
  });

  await t.test('OIDC resolves issuer/subject only after validating the bound flow', async () => {
    let nonce, state, overrides = {}, resolutions = 0;
    const login = createOidcLogin({ pool, issuer, clientId: 'test-client', clientSecret: 'synthetic-client-secret-only',
      baseUrl: 'https://platform.example', identityResolver: async value => { resolutions++; return directory.verifiedIdentity(value); },
      clientAdapter: {
        async authorizationUrl(args) { nonce = args.nonce; state = args.state; return `${issuer}authorize?state=${args.state}`; },
        async exchange() { return { iss: issuer, aud: 'test-client', sub: 'oidc-human', nonce, email: 'irrelevant@example.com', ...overrides }; },
      } });
    await login.init();
    let flow = await login.begin('/');
    overrides = { nonce: 'wrong' };
    await assert.rejects(login.complete(`https://platform.example/auth/callback?state=${state}&code=test`, flow.bindingCookie));
    assert.equal(resolutions, 0);
    overrides = {};
    flow = await login.begin('/');
    const first = await login.complete(`https://platform.example/auth/callback?state=${state}&code=test`, flow.bindingCookie);
    assert.equal(resolutions, 1);
    assert.equal(first.principalId, (await make('oidc-human')).id);
    overrides = { email: 'changed-email@example.com' };
    flow = await login.begin('/');
    const second = await login.complete(`https://platform.example/auth/callback?state=${state}&code=test`, flow.bindingCookie);
    assert.equal(first.principalId, second.principalId);
    overrides = { iss: 'https://evil.example/' };
    flow = await login.begin('/');
    await assert.rejects(login.complete(`https://platform.example/auth/callback?state=${state}&code=test`, flow.bindingCookie));
    assert.equal(resolutions, 2);
  });
});
