import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { createNativeStaff } from './native-staff.mjs';
import { createStaffApi } from './staff-api.mjs';
import { createIdentityDirectory } from './identity-directory.mjs';
import { hash, NATIVE_CLIENT_ID, NATIVE_SCOPE } from './auth.mjs';

// Handler-level regression only. The database is a bounded in-memory double;
// this does not establish PostgreSQL transaction or real HTTP acceptance.
// The actual native authentication, native transport, membership authorization,
// token-family revocation and shared staff router run unchanged.
async function fixture() {
  const baseUrl = 'https://platform.example', issuer = 'https://identity.example/';
  const owner = { id: randomUUID(), issuer, enabled: true, platform_admin: false };
  const member = { principal_id: owner.id, tenant_id: 'a', role: 'manager',
    permissions: ['settings:read', 'settings:update', 'menu:read', 'menu:update'],
    enabled: true, version: 1, tenant_status: 'active', tenant_name: 'Synthetic tenant' };
  const families = new Map(), sessions = new Map(), registrations = new Map();
  const hooks = {}, membershipWrites = [];
  let authenticationReads = 0;
  const addSession = () => {
    const token = randomBytes(32).toString('base64url'), id = randomBytes(32).toString('base64url');
    const family = { id, principal_id: owner.id, client_id: NATIVE_CLIENT_ID,
      resource: baseUrl + '/native/api', scopes: [NATIVE_SCOPE], revoked: false,
      expires_at: new Date(Date.now() + 3600_000).toISOString() };
    families.set(id, family);
    sessions.set(hash(token), { principal_id: owner.id, scopes: [NATIVE_SCOPE],
      session_kind: 'oauth', issuer: baseUrl + '/native', audience: family.resource,
      expires_at: new Date(Date.now() + 900_000).toISOString(), oauth_family_id: id });
    return { token, familyId: id };
  };
  const pool = {
    async query(sql, values = []) {
      const statement = sql.trim();
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(statement)) return { rows: [] };
      if (statement.startsWith('CREATE TABLE IF NOT EXISTS demo_identities')) return { rows: [] };
      if (statement.startsWith('INSERT INTO demo_oauth_clients')) {
        registrations.set(values[0], { redirect_uris: JSON.parse(values[1]), grant_types: JSON.parse(values[2]) });
        return { rows: [] };
      }
      if (statement === 'SELECT redirect_uris,grant_types FROM demo_oauth_clients WHERE id=$1') {
        return { rows: registrations.has(values[0]) ? [registrations.get(values[0])] : [] };
      }
      if (statement.startsWith('SELECT s.principal_id,s.scopes,s.session_kind,s.expires_at')) {
        authenticationReads++;
        const session = sessions.get(values[0]), family = families.get(session?.oauth_family_id);
        const valid = session && session.issuer === values[1] && session.audience === values[2]
          && Date.parse(session.expires_at) > Date.now() && family && !family.revoked
          && Date.parse(family.expires_at) > Date.now();
        return { rows: valid ? [{ ...session, grant_id: family.id,
          grant_expires_at: family.expires_at, grant_client_id: family.client_id }] : [] };
      }
      if (statement.startsWith('SELECT s.principal_id FROM demo_sessions s')) {
        assert.match(statement, /s\.expires_at>clock_timestamp\(\)/);
        assert.match(statement, /g\.expires_at>clock_timestamp\(\)/);
        const [tokenHash, principalId, familyId, boundIssuer, resource, clientId, scope] = values;
        const session = sessions.get(tokenHash), family = families.get(familyId);
        const valid = session && session.principal_id === principalId && session.oauth_family_id === familyId
          && session.issuer === boundIssuer && session.audience === resource && session.session_kind === 'oauth'
          && Date.parse(session.expires_at) > Date.now() && session.scopes.includes(scope)
          && family && family.principal_id === principalId && family.resource === resource
          && family.client_id === clientId && !family.revoked && Date.parse(family.expires_at) > Date.now()
          && family.scopes.includes(scope);
        return { rows: valid ? [{ principal_id: principalId }] : [] };
      }
      if (statement === 'SELECT enabled FROM demo_identities WHERE id=$1') {
        return { rows: values[0] === owner.id ? [{ enabled: true }] : [] };
      }
      if (/^SELECT id,issuer(?:,platform_admin)? FROM platform_identities WHERE id=\$1 AND enabled=TRUE$/.test(statement)) {
        return { rows: values[0] === owner.id && owner.enabled ? [{ ...owner }] : [] };
      }
      if (statement.includes('FROM platform_memberships m')) {
        return { rows: member.enabled && ['active', 'suspended'].includes(member.tenant_status) && values[0] === owner.id
          && (values[1] === undefined || values[1] === member.tenant_id) ? [{ ...member }] : [] };
      }
      if (statement === 'SELECT status FROM platform_tenants WHERE id=$1 FOR UPDATE') {
        await hooks.tenantLock?.();
        return { rows: values[0] === member.tenant_id ? [{ status: member.tenant_status }] : [] };
      }
      if (statement === 'SELECT role,permissions FROM platform_memberships WHERE tenant_id=$1 AND principal_id=$2 AND enabled=TRUE'
        || statement === 'SELECT * FROM platform_memberships WHERE tenant_id=$1 AND principal_id=$2') {
        return { rows: values[0] === member.tenant_id && values[1] === owner.id && member.enabled ? [{ ...member }] : [] };
      }
      if (statement.startsWith('INSERT INTO platform_memberships(tenant_id,principal_id,role,permissions,enabled,display_name)')) {
        membershipWrites.push([...values]);
        return { rows: [{ ...member, role: values[2], permissions: JSON.parse(values[3]), enabled: values[4], version: 2 }] };
      }
      if (statement.startsWith('INSERT INTO platform_identity_audit')) return { rows: [] };
      if (statement.startsWith('SELECT * FROM demo_oauth_grants WHERE principal_id=$1')) {
        return { rows: [...families.values()].filter(row => row.principal_id === values[0]
          && row.resource === values[1] && (values[2] === 'all' || row.id === values[2])).map(row => ({ ...row })) };
      }
      if (statement === 'UPDATE demo_oauth_grants SET revoked=TRUE WHERE id=$1') {
        families.get(values[0]).revoked = true;
        return { rows: [] };
      }
      if (statement === 'DELETE FROM demo_sessions WHERE oauth_family_id=$1') {
        for (const [key, session] of sessions) if (session.oauth_family_id === values[0]) sessions.delete(key);
        return { rows: [] };
      }
      throw new Error('Unexpected in-memory fixture SQL: ' + statement);
    },
    async connect() { return { query: pool.query, release() {} }; },
  };
  const directory = createIdentityDirectory({ pool, trustedIssuers: [issuer] });
  const writes = [], bodyReads = [];
  const body = async req => {
    bodyReads.push(req);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  const json = (_, status, data) => ({ status, data });
  const orderClient = Object.fromEntries(['patchProfile', 'patchMenuItem'].map(method => [method, async (...args) => {
    writes.push({ method, args }); return { version: 2 };
  }]));
  orderClient.menuItem = async () => { await hooks.menuRead?.(); return { version: 1 }; };
  orderClient.uploadImage = async (...args) => {
    writes.push({ method: 'uploadImage', args }); await hooks.imageUpload?.();
    return { url: '/restaurant-media/' + 'a'.repeat(64) + '.png' };
  };
  const staffApi = createStaffApi({ directory, orderClient, body, json });
  const native = await createNativeStaff({ pool, baseUrl, csrfKey: randomBytes(32).toString('base64'),
    directory, browserAuth: {}, staffApi, body, json,
    htmlHeaders() { assert.fail('Unexpected HTML response'); }, redirect() { assert.fail('Unexpected redirect'); } });
  const origin = addSession(), other = addSession();
  const input = { expectedVersion: 1, name: 'Synthetic renamed item' };
  function delayedRequest(token, path, { method = 'POST', payload = input, image = false } = {}) {
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const req = Readable.from((async function* () {
      entered(); await gate; yield Buffer.from(JSON.stringify(payload));
    })());
    req.method = method; req.headers = { authorization: 'Bearer ' + token,
      'content-type': image ? 'application/octet-stream' : 'application/json', ...(image ? { 'x-menu-version': '1' } : {}) };
    const outcome = native.handle(req, { setHeader() {} }, new URL(baseUrl + path))
      .then(value => ({ value }), error => ({ error }));
    return { ready, release, outcome, req };
  }
  return { owner, member, native, origin, other, writes, bodyReads, delayedRequest, input, hooks, membershipWrites,
    session: value => sessions.get(hash(value.token)), family: value => families.get(value.familyId),
    authenticationReads: () => authenticationReads,
    valid: token => native.auth.authenticate({ headers: { authorization: 'Bearer ' + token } }, { bearerOnly: true }) };
}

for (const [path, method] of [
  ['/native/api/restaurants/a/staff/profile', 'patchProfile'],
  ['/native/api/restaurants/a/staff/menu/items/rice', 'patchMenuItem'],
]) {
  test('native non-courier active family survives body wait: ' + method, { timeout: 5000 }, async () => {
    const f = await fixture(), pending = f.delayedRequest(f.origin.token, path);
    await pending.ready;
    await f.native.auth.revokeNativeGrant(f.owner.id, f.other.familyId);
    assert.equal(await f.valid(f.other.token), null);
    assert.ok(await f.valid(f.origin.token));
    pending.release();
    const result = await pending.outcome;
    assert.equal(result.error, undefined); assert.equal(result.value.status, 200);
    assert.equal(f.writes.length, 1); assert.equal(f.writes[0].method, method);
    assert.deepEqual(f.writes[0].args.at(-1), f.input);
  });

  test('native non-courier originating family revocation during body wait prevents dispatch: ' + method,
    { timeout: 5000 }, async () => {
      const f = await fixture(), pending = f.delayedRequest(f.origin.token, path);
      await pending.ready;
      assert.equal(f.authenticationReads(), 1);
      await f.native.auth.revokeNativeGrant(f.owner.id, f.origin.familyId);
      assert.equal(await f.valid(f.origin.token), null, 'The originating token is actually revoked');
      assert.ok(await f.valid(f.other.token), 'A different family for the same owner stays valid');
      pending.release();
      const result = await pending.outcome;
      assert.equal(f.writes.length, 0, 'Revoked originating family reached the core mutation boundary');
      assert.ok([401, 403].includes(result.error?.status), 'The pending request must fail authentication');
    });
}

for (const [name, invalidate] of [
  ['access token expires', f => { f.session(f.origin).expires_at = new Date(0).toISOString(); }],
  ['originating family expires', f => { f.family(f.origin).expires_at = new Date(0).toISOString(); }],
  ['originating family loses staff scope', f => { f.family(f.origin).scopes = []; }],
  ['same-owner family is substituted in stored session', f => { f.session(f.origin).oauth_family_id = f.other.familyId; }],
  ['identity is disabled', f => { f.owner.enabled = false; }],
  ['restaurant membership is removed', f => { f.member.enabled = false; }],
  ['restaurant write permission is removed', f => { f.member.permissions = ['settings:read']; }],
  ['restaurant is suspended', f => { f.member.tenant_status = 'suspended'; }],
  ['restaurant is closed', f => { f.member.tenant_status = 'closed'; }],
]) test('native profile blocks invalidated authority during body wait: ' + name, { timeout: 5000 }, async () => {
  const f = await fixture(), pending = f.delayedRequest(f.origin.token, '/native/api/restaurants/a/staff/profile');
  await pending.ready;
  invalidate(f); pending.release();
  const result = await pending.outcome;
  assert.equal(f.writes.length, 0);
  assert.ok([401, 403].includes(result.error?.status));
});

test('native mutation guard cannot adopt a later replacement bearer header', { timeout: 5000 }, async () => {
  const f = await fixture(), pending = f.delayedRequest(f.origin.token, '/native/api/restaurants/a/staff/profile');
  await pending.ready;
  await f.native.auth.revokeNativeGrant(f.owner.id, f.origin.familyId);
  pending.req.headers.authorization = 'Bearer ' + f.other.token;
  assert.ok(await f.valid(f.other.token));
  pending.release();
  const result = await pending.outcome;
  assert.equal(result.error?.status, 401); assert.equal(f.writes.length, 0);
});

test('native principal response never serializes captured mutation authority', { timeout: 5000 }, async () => {
  const f = await fixture();
  const result = await f.native.handle({ method: 'GET', headers: { authorization: 'Bearer ' + f.origin.token } },
    { setHeader() {} }, new URL('https://platform.example/native/api/me'));
  assert.equal(result.status, 200); assert.equal(result.data.principal.id, f.owner.id);
  const raw = JSON.stringify(result.data);
  for (const hidden of [f.origin.token, hash(f.origin.token), f.origin.familyId, 'authorizeMutation', 'nativeAuthority']) {
    assert.equal(raw.includes(hidden), false);
  }
});

for (const stage of ['menuRead', 'imageUpload']) {
  test('native image write rejects originating-family revocation after ' + stage, { timeout: 5000 }, async () => {
    const f = await fixture();
    f.hooks[stage] = () => f.native.auth.revokeNativeGrant(f.owner.id, f.origin.familyId);
    const pending = f.delayedRequest(f.origin.token, '/native/api/restaurants/a/staff/menu/items/rice/image', { image: true });
    await pending.ready; pending.release();
    const result = await pending.outcome;
    assert.equal(result.error?.status, 401);
    assert.deepEqual(f.writes.map(write => write.method), stage === 'menuRead' ? [] : ['uploadImage']);
    assert.ok(await f.valid(f.other.token));
  });
}

for (const revoke of [false, true]) {
  test('native membership transaction rechecks family after tenant-lock wait (revoke=' + revoke + ')',
    { timeout: 5000 }, async () => {
      const f = await fixture();
      f.member.permissions.push('members:manage');
      let reachedLock = 0;
      f.hooks.tenantLock = async () => {
        reachedLock++;
        if (revoke) await f.native.auth.revokeNativeGrant(f.owner.id, f.origin.familyId);
      };
      const pending = f.delayedRequest(f.origin.token, '/native/api/restaurants/a/members/' + f.owner.id,
        { method: 'PUT', payload: { role: 'manager', permissions: ['settings:read'], enabled: true, expectedVersion: 1 } });
      await pending.ready; pending.release();
      const result = await pending.outcome;
      assert.equal(reachedLock, 1);
      assert.equal(f.membershipWrites.length, revoke ? 0 : 1);
      if (revoke) assert.equal(result.error?.status, 401);
      else { assert.equal(result.error, undefined); assert.equal(result.value.status, 200); }
      assert.ok(await f.valid(f.other.token));
    });
}

test('native non-courier request revoked before authentication never consumes the body', { timeout: 5000 }, async () => {
  const f = await fixture();
  await f.native.auth.revokeNativeGrant(f.owner.id, f.origin.familyId);
  const pending = f.delayedRequest(f.origin.token, '/native/api/restaurants/a/staff/profile');
  pending.release();
  const result = await pending.outcome;
  assert.equal(result.error?.status, 401); assert.equal(f.bodyReads.length, 0); assert.equal(f.writes.length, 0);
  assert.ok(await f.valid(f.other.token));
});
