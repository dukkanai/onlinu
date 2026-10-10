// Synthetic database recovery acceptance. No deployed database, provider,
// signing key, login credential, external message or payment is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import pg from 'pg';
import { createControlPlane } from './control-plane.mjs';
import { pkceChallenge } from './auth.mjs';
import { ARCHIVE_LIMIT, TABLES, fixtureDatabase, fixtureIdentifier, archiveFingerprint,
  clientEnvironment, clientCommand, verifyClients, clientArguments, createRestoreDatabase,
  verifyRestoreOwner, createSourceSchema, cleanupAll, boundedCleanup, abortCheckedPool, logicalFingerprint } from './integration/control-recovery-fixture.mjs';

const issuer = 'https://identity.recovery.example.invalid/';
const baseUrl = 'https://platform.recovery.example.invalid';
const redirectUri = 'https://client.recovery.example.invalid/callback';
const resource = baseUrl + '/mcp';
const testDatabase = 'postgres://onlinu_fixture:synthetic-password-only@127.0.0.1:55439/astracalls_identity_test?sslmode=disable';
const bearer = token => ({ headers: { authorization: 'Bearer ' + token } });
const browser = token => ({ headers: { cookie: '__Host-platform_session=' + token } });
const random = () => randomBytes(32).toString('base64url');

test('control recovery refuses remote, ambiguous and inherited database settings', () => {
  assert.equal(fixtureDatabase(testDatabase).href, testDatabase);
  for (const value of [undefined, '', testDatabase.replace('127.0.0.1', 'localhost'),
    testDatabase.replace('127.0.0.1', 'db.example.invalid'), testDatabase.replace('127.0.0.1', '127.0.0.2'),
    testDatabase.replace('astracalls_identity_test', 'production'), testDatabase + '#fragment', testDatabase + '#',
    testDatabase.replace(':synthetic-password-only@', '@'), ' ' + testDatabase, testDatabase + '\n',
    testDatabase + '&dbname=production', testDatabase + '&host=elsewhere', testDatabase + '&options=other',
    testDatabase.replace('?sslmode=disable', ''), testDatabase + '&sslmode=disable',
    testDatabase.replace('55439', '12'), testDatabase.replace('onlinu_fixture', '%70ostgres')]) {
    assert.throws(() => fixtureDatabase(value), /fixture_database_not_allowed/);
  }
  for (const key of ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS', 'PGPASSWORD', 'PGPASSFILE']) {
    assert.throws(() => fixtureDatabase(testDatabase, { [key]: 'test-only' }), /fixture_pg_override/);
  }
  assert.deepEqual(Object.keys(clientEnvironment('/private-fixture', new URL(testDatabase))).sort(),
    ['HOME', 'LANG', 'LC_ALL', 'PATH', 'PGCONNECT_TIMEOUT', 'PGPASSWORD', 'TZ']);
});

test('control recovery bounds archive bytes and generated ownership identifiers', async () => {
  for (const value of ['public', 'control_recovery_a', 'control_recovery_' + 'a'.repeat(24) + ';DROP', 'other.' + 'a'.repeat(24)]) {
    assert.throws(() => fixtureIdentifier(value, 'schema'), /fixture_identifier_not_allowed/);
    assert.throws(() => fixtureIdentifier(value, 'database'), /fixture_identifier_not_allowed/);
  }
  for (const bytes of [null, 'PGDMP', Buffer.alloc(5), Buffer.alloc(32), Buffer.alloc(ARCHIVE_LIMIT + 1)]) {
    assert.throws(() => archiveFingerprint(bytes), /fixture_archive_invalid/);
  }
  const sample = Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(20)]);
  assert.equal(archiveFingerprint(sample).bytes, 25);
  let calls = 0;
  const admin = { async query(sql) { calls++; assert.equal(sql, 'SELECT oid FROM pg_database WHERE datname=$1'); return { rows: [{ oid: 42 }] }; } };
  await assert.rejects(createRestoreDatabase(admin, 'control_recovery_restore_' + 'a'.repeat(24),
    'onlinu-control-recovery:' + randomUUID()), /fixture_target_exists/);
  assert.equal(calls, 1, 'collision must not create, restore, overwrite or drop anything');
  await assert.rejects(verifyRestoreOwner({ async query() { return { rows: [{ oid: 43, marker: 'different' }] }; } },
    { name: 'control_recovery_restore_' + 'a'.repeat(24), oid: 42, marker: 'original' }), /fixture_target_ownership_changed/);
  await assert.rejects(verifyClients(undefined, {}), /fixture_pg_bin_required/);
});

test('control recovery records acknowledged creation and attempts independent cleanup after failure', async () => {
  const name = 'control_recovery_restore_' + 'a'.repeat(24);
  const marker = 'onlinu-control-recovery:' + randomUUID();
  for (const failure of ['CREATE DATABASE', 'identity query', 'COMMENT ON DATABASE']) {
    const calls = [];
    let owned;
    const admin = { async query(sql) {
      calls.push(sql);
      if (sql.startsWith(failure) || (failure === 'identity query' && calls.length === 3)) throw new Error('synthetic_database_failure');
      return { rows: calls.length === 1 ? [] : [{ oid: 42 }] };
    } };
    await assert.rejects(createRestoreDatabase(admin, name, marker, value => { owned = value; }), /synthetic_database_failure/);
    assert.equal(calls.some(sql => /DROP|CLEAN/.test(sql)), false);
    if (failure === 'CREATE DATABASE') assert.equal(owned, undefined, 'unknown creation is never adopted');
    else {
      assert.equal(owned.name, name, 'acknowledged creation is retained before any later query can fail');
      assert.equal(owned.oid, failure === 'identity query' ? null : 42);
      await assert.rejects(verifyRestoreOwner(admin, owned), /fixture_target_ownership_(unverified|changed)/);
    }
  }
  const statements = [];
  let released = false;
  const db = { async query(sql) {
    statements.push(sql);
    if (sql.startsWith('COMMENT')) throw new Error('synthetic_schema_failure');
    return { rows: [] };
  }, release() { released = true; } };
  await assert.rejects(createSourceSchema({ async connect() { return db; } }, 'control_recovery_' + 'a'.repeat(24), marker), /synthetic_schema_failure/);
  assert.equal(statements.at(-1), 'ROLLBACK'); assert.equal(released, true);
  assert.equal(statements.includes('COMMIT'), false, 'schema creation and ownership marker roll back together');
  const cleaned = [];
  await assert.rejects(cleanupAll([
    async () => { cleaned.push('target'); throw new Error('synthetic_target_cleanup_failure'); },
    async () => { cleaned.push('source'); throw new Error('synthetic_source_cleanup_failure'); },
    async () => { cleaned.push('archive'); },
  ]), error => error instanceof AggregateError && error.errors.length === 2);
  assert.deepEqual(cleaned, ['target', 'source', 'archive']);
  await assert.rejects(boundedCleanup(() => new Promise(() => {}), 10), /fixture_cleanup_timeout/);
});

test('control recovery cancellation cannot resume application SQL when cleanup starts', async () => {
  const controller = new AbortController(), calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const raw = { async query(sql) { calls.push(sql); if (sql === 'SELECT gate') await gate; return { rows: [] }; },
    async connect() { return { query: raw.query, release() {} }; } };
  const pool = abortCheckedPool(raw, controller.signal);
  const client = await pool.connect();
  const interrupted = (async () => { await pool.query('SELECT gate'); await pool.query('SELECT forbidden_after_cancel'); })();
  controller.abort();
  await raw.query('fixture cleanup'); // The fixture's separate cleanup-only path.
  release();
  await assert.rejects(interrupted, { name: 'AbortError' });
  assert.throws(() => client.query('SELECT forbidden_client_query'), { name: 'AbortError' });
  await client.query('ROLLBACK'); client.release();
  assert.deepEqual(calls, ['SELECT gate', 'fixture cleanup', 'ROLLBACK']);
});

function oidcFixture() {
  const flows = new Map();
  let exchanges = 0;
  const adapter = {
    async authorizationUrl(args) {
      flows.set(args.state, { ...args });
      return issuer + 'authorize?state=' + args.state;
    },
    async exchange({ callbackUrl, nonce }) {
      exchanges++;
      const state = new URL(callbackUrl).searchParams.get('state');
      const flow = flows.get(state);
      assert.ok(flow && flow.subject && flow.nonce === nonce, 'only locally generated OIDC fixtures are allowed');
      return { iss: issuer, aud: 'synthetic-recovery-client', sub: flow.subject, nonce,
        email: 'same-synthetic-address@example.invalid', email_verified: true };
    },
  };
  async function begin(app, subject) {
    const flow = await app.login.begin('/manage');
    const state = new URL(flow.authorizationUrl).searchParams.get('state');
    flows.get(state).subject = subject;
    return { callback: baseUrl + '/auth/callback?state=' + state + '&code=synthetic-only', cookie: flow.bindingCookie };
  }
  async function login(app, subject) {
    const flow = await begin(app, subject);
    const completed = await app.login.complete(flow.callback, flow.cookie);
    return { id: completed.principalId, flow };
  }
  return { adapter, begin, login, exchanges: () => exchanges };
}

async function authorizeCode(app, principalId, clientId, scopes = 'orders:read events:read') {
  const verifier = random();
  const callback = await app.auth.authorize({ client_id: clientId, redirect_uri: redirectUri,
    response_type: 'code', resource, scope: scopes, state: random(),
    code_challenge_method: 'S256', code_challenge: pkceChallenge(verifier) }, { id: principalId });
  return { grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri,
    code: new URL(callback).searchParams.get('code'), code_verifier: verifier, resource };
}
const refresh = (clientId, token, extra = {}) => ({ grant_type: 'refresh_token', client_id: clientId,
  refresh_token: token, resource, ...extra });

async function httpFixture(app, operation) {
  const server = createServer(app.handle);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  async function get(path, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path,
        headers: { host: new URL(baseUrl).host, ...headers }, timeout: 5000 }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('fixture_http_timeout')));
      req.on('error', reject); req.end();
    });
  }
  try { await operation(get); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('synthetic control schema archive restores identity, tenant authority and OAuth state', {
  skip: process.env.TEST_CONTROL_RECOVERY !== '1', timeout: 120000,
}, async t => {
  // All checks below happen before a connection. Configuring a test database
  // alone never opts in to backup or database creation.
  const database = fixtureDatabase(process.env.IDENTITY_TEST_DATABASE_URL, process.env);
  const bin = process.env.TEST_CONTROL_RECOVERY_PG_BIN;
  const root = await mkdtemp(join(tmpdir(), 'onlinu-control-recovery-'));
  const environment = clientEnvironment(root, database);
  let admin, source, target, owner, schemaOwner, sourceClosed = false;
  const nonce = randomBytes(12).toString('hex');
  const schema = 'control_recovery_' + nonce;
  const quotedSchema = fixtureIdentifier(schema, 'schema');
  const targetName = 'control_recovery_restore_' + nonce;
  const marker = 'onlinu-control-recovery:' + randomUUID();
  const pools = connectionString => ({ connectionString, max: 4, connectionTimeoutMillis: 5000,
    statement_timeout: 5000, query_timeout: 7000, idleTimeoutMillis: 1000, options: '-c timezone=UTC' });
  function pool(options) {
    const raw = new pg.Pool(options);
    // A test timeout blocks new operations, aborts client subprocesses, and
    // leaves in-flight SQL bounded on both the server and client. Cleanup still
    // runs after cancellation; no unrelated backend is forcibly terminated.
    return {
      ...abortCheckedPool(raw, t.signal),
      cleanupQuery(...args) { return raw.query(...args); },
      end() { return boundedCleanup(() => raw.end()); },
    };
  }
  let outbound = 0;
  t.mock.method(globalThis, 'fetch', async () => { outbound++; throw new Error('fixture_external_request_forbidden'); });
  try {
    const clientVersion = await verifyClients(bin, environment, t.signal);
    admin = pool(pools(database.href));
    const serverVersion = Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num);
    assert.ok([16, 17].includes(Math.floor(serverVersion / 10000)), 'reviewed PostgreSQL server required');
    assert.ok(+clientVersion.split('.')[0] >= Math.floor(serverVersion / 10000), 'dump client cannot be older than server');
    schemaOwner = await createSourceSchema(admin, schema, marker);
    source = pool({ ...pools(database.href), options: '-c timezone=UTC -c search_path=' + schema });
    const provider = oidcFixture();
    const config = { baseUrl, csrfKey: randomBytes(32).toString('base64'),
      oidc: { issuer, clientId: 'synthetic-recovery-client', clientSecret: random() },
      redirectAllowlist: [redirectUri], restaurants: ['a', 'b', 'suspended', 'closed', 'draft'].map((id, index) => ({
        id, name: 'Configured synthetic ' + id, cuisine: 'synthetic', baseUrl: 'http://127.0.0.1:' + (10 + index),
      })) };
    const app = await createControlPlane({ ...config, pool: source }, { oidcClientAdapter: provider.adapter });
    const subjects = Object.fromEntries(['operator', 'ownerA', 'ownerB', 'worker', 'disabled', 'removed'].map(name => [name, 'synthetic-' + name + '-' + random()]));
    const people = {};
    for (const [name, subject] of Object.entries(subjects)) people[name] = await provider.login(app, subject);
    await source.query('UPDATE platform_identities SET platform_admin=TRUE WHERE id=$1', [people.operator.id]);
    for (const id of ['a', 'b', 'suspended', 'closed', 'draft']) {
      await app.directory.createTenant(people.operator.id, { id, name: 'Recovered synthetic ' + id,
        ownerId: id === 'a' ? people.ownerA.id : people.ownerB.id });
      if (id !== 'draft') await app.directory.setTenantStatus(people.operator.id, id, { status: 'active', expectedVersion: 1 });
      if (['suspended', 'closed'].includes(id)) await app.directory.setTenantStatus(people.operator.id, id, { status: id, expectedVersion: 2 });
    }
    for (const [name, enabled] of [['worker', true], ['disabled', true], ['removed', false]]) {
      await app.directory.setMembership(people.ownerA.id, 'a', people[name].id, {
        role: 'manager', permissions: ['orders:read'], enabled, expectedVersion: null, displayName: 'Synthetic ' + name,
      });
    }
    const ownerBrowser = await app.auth.issue(people.ownerA.id, undefined, { kind: 'browser' });
    const disabledBrowser = await app.auth.issue(people.disabled.id, undefined, { kind: 'browser' });
    await source.query('UPDATE platform_identities SET enabled=FALSE WHERE id=$1', [people.disabled.id]);
    const client = await app.auth.register({ redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    const consumedCode = await authorizeCode(app, people.ownerA.id, client.client_id);
    const initial = await app.auth.exchange(consumedCode);
    const rotated = await app.auth.exchange(refresh(client.client_id, initial.refresh_token));
    const revoked = await app.auth.exchange(await authorizeCode(app, people.ownerB.id, client.client_id));
    await app.auth.revoke(revoked.refresh_token);
    const pendingCode = await authorizeCode(app, people.ownerB.id, client.client_id, 'orders:read');
    const pendingLogin = await provider.begin(app, subjects.ownerA);
    const before = await logicalFingerprint(source, schema);
    assert.equal(before.tables.length, 12);
    assert.ok(before.tables.every(table => table.count > 0), 'every archived table contains generated fixture data');
    assert.equal((await app.auth.authenticate(bearer(rotated.access_token), { bearerOnly: true })).id, people.ownerA.id);
    assert.equal(await app.auth.authenticate(bearer(revoked.access_token), { bearerOnly: true }), null);
    await source.end(); sourceClosed = true; // Quiesce our fixture before its archive.

    const bytes = await clientCommand(bin, 'pg_dump', [...clientArguments(database), '--format=custom',
      '--no-owner', '--no-acl', '--strict-names', '--schema=' + schema], environment, { limit: ARCHIVE_LIMIT, signal: t.signal });
    const archive = archiveFingerprint(bytes);
    const archivePath = join(root, 'synthetic-control.pgdump');
    await writeFile(archivePath, bytes, { flag: 'wx', mode: 0o600 });
    const file = await lstat(archivePath);
    assert.ok(file.isFile() && !file.isSymbolicLink()); assert.equal(file.mode & 0o777, 0o600);
    assert.deepEqual(archiveFingerprint(await readFile(archivePath)), archive);
    await createRestoreDatabase(admin, targetName, marker, created => { owner = created; });
    await assert.rejects(createRestoreDatabase(admin, targetName, marker), /fixture_target_exists/);
    await verifyRestoreOwner(admin, owner);
    const targetDatabase = new URL(database); targetDatabase.pathname = '/' + targetName;
    await clientCommand(bin, 'pg_restore', [...clientArguments(targetDatabase), '--exit-on-error',
      '--single-transaction', '--no-owner', '--no-acl', archivePath], environment, { signal: t.signal });
    target = pool({ ...pools(targetDatabase.href), options: '-c timezone=UTC -c search_path=' + schema });
    assert.deepEqual(await logicalFingerprint(target, schema), before, 'all table rows and audit sequence must restore exactly');
    const restoredSchemas = (await target.query("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname NOT IN ('public','information_schema') ORDER BY nspname")).rows;
    assert.deepEqual(restoredSchemas, [{ nspname: schema }], 'dump must exclude neighboring fixture schemas');
    const restored = await createControlPlane({ ...config, pool: target }, { oidcClientAdapter: provider.adapter });
    assert.deepEqual(await logicalFingerprint(target, schema), before, 'application reinitialization cannot widen or rewrite restored authority');

    await t.test('directory, subject bindings, granular roles and tenant lifecycle survive', async () => {
      assert.deepEqual(await restored.core.listRestaurants({}), ['a', 'b'].map(id => ({ id, name: 'Recovered synthetic ' + id, cuisine: 'synthetic' })));
      assert.equal((await provider.login(restored, subjects.ownerA)).id, people.ownerA.id);
      const stranger = await provider.login(restored, 'synthetic-new-subject-' + random());
      assert.notEqual(stranger.id, people.ownerA.id, 'matching email never rebinds a restored owner');
      await assert.rejects(restored.directory.authorize(stranger.id, 'a', 'orders:read'), { code: 'forbidden' });
      await assert.rejects(restored.directory.verifiedIdentity({ issuer: 'https://different.example.invalid/', subject: subjects.ownerA }), { code: 'untrusted_issuer' });
      await assert.rejects(restored.directory.verifiedIdentity({ issuer, subject: subjects.disabled }), { code: 'identity_disabled' });
      await restored.directory.authorize(people.ownerA.id, 'a', 'members:manage');
      await assert.rejects(restored.directory.authorize(people.ownerA.id, 'b', 'members:manage'), { code: 'forbidden' });
      assert.deepEqual((await restored.directory.authorize(people.worker.id, 'a', 'orders:read')).permissions, ['orders:read']);
      await assert.rejects(restored.directory.authorize(people.worker.id, 'a', 'orders:update'), { code: 'forbidden' });
      await assert.rejects(restored.directory.authorize(people.removed.id, 'a', 'orders:read'), { code: 'forbidden' });
      await assert.rejects(restored.directory.setMembership(people.ownerA.id, 'a', people.ownerA.id,
        { role: 'owner', enabled: false, expectedVersion: 1 }), { code: 'last_owner_required' });
      await assert.rejects(restored.directory.setMembership(people.ownerA.id, 'a', people.worker.id,
        { role: 'manager', permissions: ['orders:read'], enabled: true, expectedVersion: 2 }), { code: 'version_conflict' });
      await restored.directory.authorize(people.ownerB.id, 'suspended', 'orders:read');
      await assert.rejects(restored.directory.authorize(people.ownerB.id, 'suspended', 'settings:update'), { code: 'tenant_suspended' });
      await assert.rejects(restored.directory.authorize(people.ownerB.id, 'closed', 'orders:read'), { code: 'forbidden' });
      await assert.rejects(restored.directory.setTenantStatus(people.operator.id, 'closed', { status: 'active', expectedVersion: 3 }), { code: 'invalid_tenant_transition' });
      const previous = before.sequence.last_value;
      await restored.directory.setMembership(people.ownerA.id, 'a', people.worker.id,
        { role: 'manager', permissions: ['orders:read'], enabled: true, expectedVersion: 1 });
      const audit = (await target.query('SELECT max(id)::text AS id FROM platform_identity_audit')).rows[0].id;
      assert.equal(BigInt(audit), BigInt(previous) + 1n, 'restored audit sequence must advance without a duplicate key');
    });

    await t.test('restored constraints reject orphaned memberships and duplicate subject bindings', async () => {
      await assert.rejects(target.query("INSERT INTO platform_memberships(tenant_id,principal_id,role,permissions) VALUES('a',$1,'kitchen','[]')", [randomUUID()]), { code: '23503' });
      await assert.rejects(target.query('INSERT INTO platform_identities(id,issuer,subject) VALUES($1,$2,$3)', [randomUUID(), issuer, subjects.ownerA]), { code: '23505' });
      await assert.rejects(target.query('INSERT INTO oidc_identity_bindings(issuer,subject,principal_id,created_at) VALUES($1,$2,$3,now())',
        [issuer, 'synthetic-binding-collision', people.ownerA.id]), { code: '23505' });
    });

    await t.test('restored browser and OAuth sessions retain separate authority and disabled-account checks', async () => {
      assert.equal((await restored.auth.authenticate(browser(ownerBrowser.accessToken), { cookieOnly: true })).id, people.ownerA.id);
      assert.equal(await restored.auth.authenticate(bearer(ownerBrowser.accessToken), { bearerOnly: true }), null);
      assert.equal(await restored.auth.authenticate(browser(rotated.access_token), { cookieOnly: true }), null);
      assert.equal(await restored.auth.authenticate(browser(disabledBrowser.accessToken), { cookieOnly: true }), null);
      await httpFixture(restored, async get => {
        assert.equal((await get('/api/me', bearer(rotated.access_token).headers)).status, 403);
        assert.equal((await get('/api/me', browser(ownerBrowser.accessToken).headers)).body.principal.id, people.ownerA.id);
        assert.equal((await get('/api/restaurants/a/members', browser(ownerBrowser.accessToken).headers)).status, 200);
        assert.equal((await get('/api/restaurants/b/members', browser(ownerBrowser.accessToken).headers)).status, 403);
        assert.equal((await get('/api/me', browser(disabledBrowser.accessToken).headers)).status, 401);
      });
    });

    await t.test('OAuth rotation, revocation, PKCE and consumed codes survive restoration', async () => {
      assert.equal((await restored.auth.authenticate(bearer(rotated.access_token), { bearerOnly: true })).id, people.ownerA.id);
      assert.equal(await restored.auth.authenticate(bearer(revoked.access_token), { bearerOnly: true }), null);
      await assert.rejects(restored.auth.exchange(refresh(client.client_id, revoked.refresh_token)), { code: 'invalid_grant' });
      await assert.rejects(restored.auth.exchange(consumedCode), { code: 'invalid_grant' });
      for (const change of [{ client_id: 'synthetic-other-client' }, { resource: baseUrl + '/other' }, { code_verifier: random() }]) {
        await assert.rejects(restored.auth.exchange({ ...pendingCode, ...change }), { code: 'invalid_grant' });
      }
      const pending = await restored.auth.exchange(pendingCode);
      assert.equal((await restored.auth.authenticate(bearer(pending.access_token), { bearerOnly: true })).id, people.ownerB.id);
      await assert.rejects(restored.auth.exchange(pendingCode), { code: 'invalid_grant' });
      await assert.rejects(restored.auth.exchange(refresh(client.client_id, rotated.refresh_token, { scope: 'orders:write' })), { code: 'invalid_scope' });
      const successor = await restored.auth.exchange(refresh(client.client_id, rotated.refresh_token, { scope: 'orders:read' }));
      assert.equal(successor.scope, 'orders:read');
      assert.equal(await restored.auth.authenticate(bearer(rotated.access_token), { bearerOnly: true }), null);
      await assert.rejects(restored.auth.exchange(refresh(client.client_id, initial.refresh_token)), { code: 'invalid_grant' });
      assert.equal(await restored.auth.authenticate(bearer(successor.access_token), { bearerOnly: true }), null, 'pre-backup consumed-token replay must revoke the recovered family');
      await assert.rejects(restored.auth.exchange(refresh(client.client_id, successor.refresh_token)), { code: 'invalid_grant' });
    });

    await t.test('pending OIDC state is browser-bound and remains single-use after restore', async () => {
      const beforeExchange = provider.exchanges();
      await assert.rejects(restored.login.complete(pendingLogin.callback, random()), { code: 'oidc_invalid_flow' });
      assert.equal(provider.exchanges(), beforeExchange);
      assert.equal((await restored.login.complete(pendingLogin.callback, pendingLogin.cookie)).principalId, people.ownerA.id);
      await assert.rejects(restored.login.complete(pendingLogin.callback, pendingLogin.cookie), { code: 'oidc_invalid_flow' });
      await assert.rejects(restored.login.complete(people.ownerA.flow.callback, people.ownerA.flow.cookie), { code: 'oidc_invalid_flow' });
    });

    await t.test('documented limitation: restoring an older session row can undo a later revocation', async () => {
      // Deliberately demonstrate the unresolved production gate using only one
      // generated row from the restored snapshot. This is not an invalidation
      // procedure or a claim that snapshot recovery preserves later revocations.
      const captured = (await target.query("SELECT row_to_json(s) AS value FROM demo_sessions s WHERE principal_id=$1 AND session_kind='browser'", [people.ownerA.id])).rows;
      assert.equal(captured.length, 1);
      await restored.auth.revoke(ownerBrowser.accessToken);
      assert.equal(await restored.auth.authenticate(browser(ownerBrowser.accessToken), { cookieOnly: true }), null);
      await target.query('INSERT INTO demo_sessions SELECT (json_populate_record(NULL::demo_sessions,$1)).*', [JSON.stringify(captured[0].value)]);
      assert.equal((await restored.auth.authenticate(browser(ownerBrowser.accessToken), { cookieOnly: true })).id, people.ownerA.id,
        'unexpired snapshot session reauthenticates; independent post-restore invalidation remains required');
      await restored.auth.revoke(ownerBrowser.accessToken);
      assert.equal(await restored.auth.authenticate(browser(ownerBrowser.accessToken), { cookieOnly: true }), null);
    });

    source = pool({ ...pools(database.href), options: '-c timezone=UTC -c search_path=' + schema }); sourceClosed = false;
    assert.deepEqual(await logicalFingerprint(source, schema), before, 'source must remain unchanged through target restore and recovery tests');
    assert.equal(outbound, 0, 'no external HTTP, identity-provider, payment or messaging calls');
    await verifyRestoreOwner(admin, owner);
    t.diagnostic(JSON.stringify({ scope: 'synthetic-control-schema-only', clientVersion,
      tables: TABLES.length, sequences: 1, archive, logicalSha256: before.sha256,
      sourceUnchanged: true, externalRequests: outbound, dexRestoreVerified: false, postSnapshotRevocationProtected: false }));
  } finally {
    const cleanupAdmin = { query: (...args) => admin.cleanupQuery(...args) };
    await cleanupAll([
      async () => { if (target) await target.end(); },
      async () => { if (source && !sourceClosed) await source.end(); },
      async () => {
        if (owner) {
          await verifyRestoreOwner(cleanupAdmin, owner);
          await cleanupAdmin.query('DROP DATABASE ' + fixtureIdentifier(owner.name, 'database'));
        }
      },
      async () => {
        if (schemaOwner) {
          const row = (await cleanupAdmin.query("SELECT oid,obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname=$1", [schema])).rows[0];
          assert.ok(row && row.oid === schemaOwner && row.marker === marker, 'owned source schema must match before cleanup');
          await cleanupAdmin.query('DROP SCHEMA ' + quotedSchema + ' CASCADE');
        }
      },
      async () => { if (admin) await admin.end(); },
      () => rm(root, { recursive: true }), // Only this call's fresh private directory.
    ]);
  }
});
