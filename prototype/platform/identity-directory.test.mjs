import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createIdentityDirectory, RESTAURANT_PERMISSIONS } from './identity-directory.mjs';
import { createAuth, hash } from './auth.mjs';
import { createOidcLogin } from './oidc.mjs';

const issuer = 'https://identity.example/';
test('persistent identity refuses unverified fixture mode and insecure issuers', () => {
  const pool = { query() {}, connect() {} };
  assert.throws(() => createIdentityDirectory({ pool, trustedIssuers: ['http://identity.example/'] }));
  assert.throws(() => createAuth({ pool, baseUrl: 'https://app.example', principalResolver() {} }), /verified_login/);
});

function issuerTrustFixture() {
  const currentIssuer = 'https://current-identity.example/';
  const retired = { id: randomUUID(), issuer, subject: 'same-subject', enabled: true, platform_admin: true };
  const current = { ...retired, id: randomUUID(), issuer: currentIssuer };
  const distinct = { ...current, id: randomUUID(), subject: 'distinct-subject' };
  const nearMatch = { ...current, id: randomUUID(), issuer: currentIssuer.slice(0, -1) };
  const disabled = { ...current, id: randomUUID(), enabled: false };
  const identities = [retired, current, distinct, nearMatch, disabled];
  const memberships = identities.map(identity => ({ principal_id: identity.id, tenant_id: 'trusted-tenant',
    role: 'owner', permissions: [...RESTAURANT_PERMISSIONS], enabled: true, version: 1,
    tenant_status: 'active', tenant_name: 'Synthetic tenant' }));
  const queries = [];
  const pool = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      if (sql.includes('FROM platform_identities WHERE id=$1')) {
        assert.match(sql, /SELECT id,issuer(?:,platform_admin)? FROM/);
        return { rows: identities.filter(identity => identity.id === values[0] && identity.enabled) };
      }
      if (sql.includes('FROM platform_memberships m')) {
        return { rows: memberships.filter(member => member.principal_id === values[0]
          && (values[1] === undefined || member.tenant_id === values[1])) };
      }
      if (sql === 'SELECT status FROM platform_tenants WHERE id=$1 FOR UPDATE') return { rows: [{ status: 'active' }] };
      throw new Error(`Unexpected fixture query: ${sql}`);
    },
    async connect() { return { query: pool.query, release() {} }; },
  };
  return { currentIssuer, retired, current, distinct, nearMatch, disabled, identities, memberships, queries, pool };
}

test('stored principals must match a currently trusted issuer exactly without linking subjects or rewriting history', async () => {
  const fixture = issuerTrustFixture();
  const { pool, currentIssuer, retired, current, distinct, nearMatch, disabled, identities, memberships, queries } = fixture;
  const before = structuredClone({ identities, memberships });
  const former = createIdentityDirectory({ pool, trustedIssuers: [issuer, currentIssuer] });
  assert.equal((await former.resolve(retired.id)).id, retired.id);
  await former.authorize(retired.id, 'trusted-tenant', 'orders:read');

  const directory = createIdentityDirectory({ pool, trustedIssuers: [currentIssuer] });
  for (const identity of [retired, nearMatch]) {
    queries.length = 0;
    assert.equal(await directory.resolve(identity.id), null);
    await assert.rejects(directory.authorize(identity.id, 'trusted-tenant', 'orders:read'), { status: 403, code: 'untrusted_issuer' });
    assert.equal(queries.some(query => query.sql.includes('platform_memberships')), false);
    await assert.rejects(directory.verifiedIdentity({ issuer: identity.issuer, subject: identity.subject }), { code: 'untrusted_issuer' });
  }
  for (const identity of [current, distinct]) {
    assert.equal((await directory.resolve(identity.id)).id, identity.id);
    assert.equal((await directory.authorize(identity.id, 'trusted-tenant', 'orders:read')).principalId, identity.id);
  }
  for (const principalId of [disabled.id, randomUUID()]) {
    assert.equal(await directory.resolve(principalId), null);
    await assert.rejects(directory.authorize(principalId, 'trusted-tenant', 'orders:read'), { code: 'identity_disabled' });
  }
  await assert.rejects(directory.verifiedIdentity({ issuer: currentIssuer, subject: current.subject, email: 'same@example.invalid' }), { code: 'invalid_request' });
  assert.deepEqual({ identities, memberships }, before);
});

test('retired issuers cannot exercise administrator or membership authority, or receive new ownership', async () => {
  const { pool, currentIssuer, retired, current } = issuerTrustFixture();
  const directory = createIdentityDirectory({ pool, trustedIssuers: [currentIssuer] });
  const change = { role: 'kitchen', enabled: true, expectedVersion: null };
  for (const operation of [
    () => directory.createTenant(retired.id, { id: 'new-tenant', name: 'Synthetic tenant', ownerId: current.id }),
    () => directory.createTenant(current.id, { id: 'new-tenant', name: 'Synthetic tenant', ownerId: retired.id }),
    () => directory.setTenantStatus(retired.id, 'trusted-tenant', { status: 'suspended', expectedVersion: 1 }),
    () => directory.members(retired.id, 'trusted-tenant'),
    () => directory.setMembership(retired.id, 'trusted-tenant', current.id, change),
    () => directory.setMembership(current.id, 'trusted-tenant', retired.id, change),
  ]) await assert.rejects(operation(), { status: 403, code: 'untrusted_issuer' });
});

test('last-owner protection counts only enabled owners from currently trusted issuers', async t => {
  for (const replacementTrusted of [false, true]) {
    for (const change of [{ role: 'owner', enabled: false }, { role: 'kitchen', enabled: true }]) {
      await t.test(`${replacementTrusted ? 'trusted' : 'retired'} replacement when owner ${change.enabled ? 'demotes' : 'disables'} themselves`, async () => {
        const { pool, currentIssuer, current, retired, distinct, identities, memberships } = issuerTrustFixture();
        const replacement = replacementTrusted ? distinct : retired;
        const ownerRows = memberships.filter(member => [current.id, replacement.id].includes(member.principal_id));
        const readQuery = pool.query;
        let writes = 0, audits = 0;
        pool.query = async (sql, values) => {
          if (sql.startsWith('SELECT * FROM platform_memberships WHERE tenant_id=$1')) {
            return { rows: ownerRows.filter(member => member.tenant_id === values[0] && member.principal_id === values[1]) };
          }
          if (sql.startsWith('SELECT 1 FROM platform_memberships m JOIN platform_identities i')) {
            assert.match(sql, /i\.issuer=ANY\(\$3::text\[\]\)/);
            assert.deepEqual(values, ['trusted-tenant', current.id, [currentIssuer]]);
            return { rows: ownerRows.filter(member => member.tenant_id === values[0]
              && member.principal_id !== values[1] && member.role === 'owner' && member.enabled
              && identities.some(identity => identity.id === member.principal_id && identity.enabled
                && values[2].includes(identity.issuer))).map(() => ({ exists: 1 })) };
          }
          if (sql.startsWith('INSERT INTO platform_memberships(')) {
            writes++;
            return { rows: [{ tenant_id: values[0], principal_id: values[1], role: values[2],
              permissions: JSON.parse(values[3]), enabled: values[4], display_name: values[5], version: 2 }] };
          }
          if (sql.startsWith('INSERT INTO platform_identity_audit(')) { audits++; return { rows: [] }; }
          return readQuery(sql, values);
        };
        const directory = createIdentityDirectory({ pool, trustedIssuers: [currentIssuer] });
        const operation = directory.setMembership(current.id, 'trusted-tenant', current.id, { ...change, expectedVersion: 1 });
        if (replacementTrusted) {
          const updated = await operation;
          assert.equal(updated.role, change.role);
          assert.equal(updated.enabled, change.enabled);
          assert.equal(writes, 1);
          assert.equal(audits, 1);
        } else {
          await assert.rejects(operation, { status: 409, code: 'last_owner_required' });
          assert.equal(writes, 0);
          assert.equal(audits, 0);
        }
      });
    }
  }
});

test('existing browser and OAuth sessions lose access when their stored issuer leaves current trust', async () => {
  const { pool, currentIssuer, retired, current } = issuerTrustFixture();
  const sessions = [retired, current].flatMap(identity => ['browser', 'oauth'].map(kind => ({
    token: randomBytes(32).toString('base64url'), principal_id: identity.id, scopes: ['orders:read'],
    session_kind: kind, expires_at: new Date(Date.now() + 60_000).toISOString(),
  })));
  const before = structuredClone(sessions);
  const sessionPool = { ...pool, async query(sql, values) {
    if (sql.includes('FROM demo_sessions s')) return { rows: sessions.filter(session => hash(session.token) === values[0]) };
    if (sql === 'SELECT enabled FROM demo_identities WHERE id=$1') return { rows: [{ enabled: true }] };
    return pool.query(sql, values);
  } };
  const authFor = trustedIssuers => createAuth({ pool: sessionPool, baseUrl: 'https://platform.example',
    allowSyntheticAuthorization: false, csrfKey: randomBytes(32).toString('base64'),
    principalResolver: createIdentityDirectory({ pool, trustedIssuers }).resolve });
  const former = authFor([issuer, currentIssuer]), currentAuth = authFor([currentIssuer]);
  for (const session of sessions) {
    const browser = session.session_kind === 'browser';
    const request = { headers: browser ? { cookie: `prototype_session=${session.token}` }
      : { authorization: `Bearer ${session.token}` } };
    const channel = browser ? { cookieOnly: true } : { bearerOnly: true };
    assert.equal((await former.authenticate(request, channel)).id, session.principal_id);
    const principal = await currentAuth.authenticate(request, channel);
    if (session.principal_id === retired.id) assert.equal(principal, null);
    else assert.equal(principal.id, current.id);
  }
  for (const kind of ['browser', 'oauth']) {
    await assert.rejects(currentAuth.issue(retired.id, ['orders:read'], { kind }), { code: 'identity_disabled' });
  }
  assert.deepEqual(sessions, before);
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

  await t.test('native restaurant-only membership authority never inherits operator escalation', async () => {
    const nativeOperator=await make('native-limited-operator'),target=await make('native-target');
    await pool.query('UPDATE platform_identities SET platform_admin=TRUE WHERE id=$1',[nativeOperator.id]);
    const restricted={allowPlatformAdmin:false};
    await assert.rejects(directory.members(nativeOperator.id,'a',restricted),{code:'forbidden'});
    await directory.setMembership(ownerA.id,'a',nativeOperator.id,{role:'manager',permissions:['members:manage','orders:read'],enabled:true,expectedVersion:null});
    await directory.setMembership(nativeOperator.id,'a',target.id,{role:'kitchen',permissions:['orders:read'],enabled:true,expectedVersion:null},restricted);
    await assert.rejects(directory.setMembership(nativeOperator.id,'a',target.id,{role:'owner',enabled:true,expectedVersion:1},restricted),{code:'forbidden'});
    await assert.rejects(directory.setMembership(nativeOperator.id,'a',target.id,{role:'manager',permissions:['refunds:manage'],enabled:true,expectedVersion:1},restricted),{code:'forbidden'});
    await assert.rejects(directory.setMembership(nativeOperator.id,'a',ownerA.id,{role:'kitchen',enabled:true,expectedVersion:1},restricted),{code:'forbidden'});

  });

  await t.test('courier candidates require explicit local grant and independently enabled identities',async()=>{
    const courier=await make('candidate-courier'),manager=await make('candidate-manager'),foreign=await make('candidate-foreign');
    await directory.setMembership(ownerA.id,'a',courier.id,{role:'courier',enabled:true,expectedVersion:null,displayName:'Same name'});
    await directory.setMembership(ownerA.id,'a',manager.id,{role:'manager',enabled:true,expectedVersion:null,displayName:'Same name'});
    await directory.setMembership(ownerB.id,'b',foreign.id,{role:'courier',enabled:true,expectedVersion:null});
    await directory.authorize(courier.id,'a','courier:read');
    for(const permission of ['orders:read','couriers:link','delivery:assign'])await assert.rejects(directory.authorize(courier.id,'a',permission),{code:'forbidden'});
    for(const person of [courier,manager,root])await assert.rejects(directory.courierCandidates(person.id,'a'),{code:'forbidden'});
    const candidates=await directory.courierCandidates(ownerA.id,'a');assert.equal(candidates.find(v=>v.principalId===courier.id).eligible,true);assert.equal(candidates.find(v=>v.principalId===manager.id).eligible,false);assert.equal(candidates.some(v=>v.principalId===foreign.id),false);
    await directory.setTenantStatus(root.id,'a',{status:'suspended',expectedVersion:2});
    await directory.authorize(ownerA.id,'a','couriers:link');
    assert.equal((await directory.courierCandidates(ownerA.id,'a')).some(v=>v.eligible),false);
    await directory.authorize(courier.id,'a','courier:read');
    await directory.setTenantStatus(root.id,'a',{status:'active',expectedVersion:3});
    await pool.query('UPDATE platform_identities SET enabled=FALSE WHERE id=$1',[courier.id]);
    assert.equal((await directory.courierCandidates(ownerA.id,'a')).find(v=>v.principalId===courier.id).eligible,false);
    await assert.rejects(directory.authorize(courier.id,'a','courier:read'));
    await pool.query('UPDATE platform_identities SET enabled=TRUE WHERE id=$1',[courier.id]);
    await directory.setMembership(ownerA.id,'a',courier.id,{role:'courier',enabled:false,expectedVersion:1});
    assert.equal((await directory.courierCandidates(ownerA.id,'a')).find(v=>v.principalId===courier.id).eligible,false);
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
    await assert.rejects(directory.members(ownerB.id,'b',{allowPlatformAdmin:false}),{code:'tenant_suspended'});
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
    const before=(await pool.query('SELECT count(*)::int AS n FROM platform_memberships WHERE tenant_id=$1',['b'])).rows[0].n;
    await directory.setTenantStatus(root.id, 'b', { status: 'closed', expectedVersion: 4 });
    await assert.rejects(directory.setTenantStatus(root.id, 'b', { status: 'active', expectedVersion: 5 }), { code: 'invalid_tenant_transition' });
    await assert.rejects(directory.authorize(ownerB.id, 'b', 'orders:read'), { code: 'forbidden' });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM platform_memberships WHERE tenant_id=$1', ['b'])).rows[0].n, before);
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

test('support management is explicit and old memberships never expand during initialization',{skip:!process.env.IDENTITY_TEST_DATABASE_URL},async t=>{
 const url=new URL(process.env.IDENTITY_TEST_DATABASE_URL);assert.equal(url.pathname,'/astracalls_identity_test');assert.equal(url.searchParams.has('dbname'),false);
 const schema='support_grants_'+randomBytes(8).toString('hex'),admin=new pg.Pool({connectionString:url.href});await admin.query(`CREATE SCHEMA ${schema}`);
 const pool=new pg.Pool({connectionString:url.href,options:`-c search_path=${schema}`});t.after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
 const directory=createIdentityDirectory({pool,trustedIssuers:[issuer]});await directory.init();
 const owner=await directory.verifiedIdentity({issuer,subject:'owner'}),kitchen=await directory.verifiedIdentity({issuer,subject:'kitchen'});
 await pool.query('UPDATE platform_identities SET platform_admin=TRUE WHERE id=$1',[owner.id]);await directory.createTenant(owner.id,{id:'support-test',name:'Synthetic',ownerId:owner.id});await directory.setTenantStatus(owner.id,'support-test',{status:'active',expectedVersion:1});
 await directory.setMembership(owner.id,'support-test',kitchen.id,{role:'kitchen',enabled:true,expectedVersion:null});
 await directory.authorize(kitchen.id,'support-test','orders:update');await assert.rejects(directory.authorize(kitchen.id,'support-test','support:manage'),{code:'forbidden'});
 await pool.query('UPDATE platform_memberships SET permissions=$1 WHERE principal_id=$2',[JSON.stringify(RESTAURANT_PERMISSIONS.filter(v=>v!=='support:manage')),owner.id]);await directory.init();
 await assert.rejects(directory.authorize(owner.id,'support-test','support:manage'),{code:'forbidden'});
 await directory.setMembership(owner.id,'support-test',owner.id,{role:'owner',permissions:[...RESTAURANT_PERMISSIONS],enabled:true,expectedVersion:1});await directory.authorize(owner.id,'support-test','support:manage');
 await directory.setTenantStatus(owner.id,'support-test',{status:'suspended',expectedVersion:2});await directory.authorize(owner.id,'support-test','support:manage');
 await directory.setTenantStatus(owner.id,'support-test',{status:'closed',expectedVersion:3});await assert.rejects(directory.authorize(owner.id,'support-test','support:manage'),{code:'forbidden'});
});
