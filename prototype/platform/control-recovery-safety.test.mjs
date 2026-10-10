// Staged source proof only: generated authority, owned loopback databases and a
// real synthetic archive. No production restore, Dex, Events or process fence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { createControlPlane } from './control-plane.mjs';
import { createAuth, NATIVE_CLIENT_ID, NATIVE_SCOPE, pkceChallenge } from './auth.mjs';
import { CONTROL_RECOVERY_POLICY, controlRecoveryBinding, prepareControlRecovery, verifyControlRecoveryReceipt } from './control-recovery.mjs';
import { ARCHIVE_LIMIT, TABLES, fixtureDatabase, fixtureIdentifier, archiveFingerprint, clientEnvironment,
  clientCommand, verifyClients, clientArguments, createRestoreDatabase, verifyRestoreOwner, createSourceSchema,
  cleanupAll, boundedCleanup, logicalFingerprint, digest } from './integration/control-recovery-fixture.mjs';

const random = () => randomBytes(32).toString('base64url');
const configuration = { baseUrl: 'https://safety.example.invalid',
  oidc: { issuer: 'https://identity.safety.example.invalid/', clientId: 'synthetic-safety-client' },
  nativeStaffEnabled: true, nativeMobileEnabled: false,
  redirectAllowlist: ['https://client.safety.example.invalid/callback'], eventsEnabled: false };
const syntheticTarget = { database: 'control_recovery_restore_' + 'a'.repeat(24), databaseOid: 123,
  databaseOwnerOid: 10, marker: 'onlinu-control-recovery:' + randomUUID(),
  schema: 'control_recovery_' + 'a'.repeat(24), schemaOid: 124, schemaOwnerOid: 10 };
const expectationFor = target => ({ recoveryId: randomUUID(), policy: CONTROL_RECOVERY_POLICY, target,
  binding: controlRecoveryBinding(configuration), operatorReference: 'synthetic-operator',
  authorityReview: { outcome: 'reviewed', reference: 'synthetic-review', evidenceSha256: digest('synthetic-only-no-live-review') },
  coldFence: { reference: 'synthetic-stopped-fixture', evidenceSha256: digest('no-live-process-fence-proved') } });
const copy = value => structuredClone(value);
const bearer = token => ({ headers: { authorization: 'Bearer ' + token } });
const browser = token => ({ headers: { cookie: '__Host-platform_session=' + token } });

test('staged recovery refuses incomplete assertions, unsupported scope and configuration mismatch before connecting', async () => {
  let connections = 0;
  const pool = { connect() { connections++; throw new Error('must not connect'); } };
  const expected = expectationFor(syntheticTarget);
  for (const change of [{ policy: 'future' }, { recoveryId: '' }, { operatorReference: 'secret\nvalue' },
    { target: { ...syntheticTarget, schema: 'public;DROP' } }, { authorityReview: { ...expected.authorityReview, outcome: 'pending' } },
    { coldFence: null }, { unexpected: true }]) {
    await assert.rejects(prepareControlRecovery({ pool, expectation: { ...expected, ...change }, configuration }), /recovery_input_invalid/);
  }
  for (const change of [{ baseUrl: 'http://safety.example.invalid' }, { eventsEnabled: true },
    { nativeStaffEnabled: false }, { nativeMobileEnabled: true }, { redirectAllowlist: [] },
    { oidc: { ...configuration.oidc, issuer: 'https://replacement.example.invalid/' } },
    { oidc: { ...configuration.oidc, clientId: 'replacement' } }, { baseUrl: 'https://other.example.invalid' }]) {
    await assert.rejects(verifyControlRecoveryReceipt({ pool, expectation: expected, configuration: { ...configuration, ...change } }), /recovery_(input_invalid|configuration)/);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareControlRecovery({ pool, expectation: expected, configuration, signal: controller.signal }), /recovery_cancelled/);
  assert.equal(connections, 0);
});

test('recovery binding is canonical, bounded and includes enabled native/client policy', () => {
  const binding = controlRecoveryBinding(configuration);
  assert.deepEqual(binding.customer, { issuer: configuration.baseUrl, resource: configuration.baseUrl + '/mcp' });
  assert.deepEqual(binding.native, { issuer: configuration.baseUrl + '/native', resource: configuration.baseUrl + '/native/api', mobileEnabled: false });
  assert.equal(binding.events, 'disabled');
  assert.equal(controlRecoveryBinding({ ...configuration, nativeStaffEnabled: false }).native, null);
  assert.deepEqual(controlRecoveryBinding({ ...configuration, redirectAllowlist: [...configuration.redirectAllowlist, ...configuration.redirectAllowlist] }), binding);
  for (const change of [{ baseUrl: configuration.baseUrl + '/' }, { oidc: { ...configuration.oidc, issuer: 'https://id.example.invalid' } },
    { nativeStaffEnabled: false, nativeMobileEnabled: true }, { redirectAllowlist: ['https://x:y@client.example.invalid/callback'] }]) {
    assert.throws(() => controlRecoveryBinding({ ...configuration, ...change }), /recovery_configuration_invalid/);
  }
});

async function checkedCase(parent, name, operation) {
  let finished = false;
  await parent.test(name, async () => { await operation(); finished = true; });
  assert.equal(finished, true, 'failed or unfinished case cannot continue to a success report');
}
async function code(auth, principal, clientId, native = false, scope) {
  const verifier = random(), resource = auth.resourceMetadata.resource;
  const redirect = native ? 'http://127.0.0.1:43123/oauth/callback' : configuration.redirectAllowlist[0];
  const callback = await auth.authorize({ client_id: clientId, redirect_uri: redirect, resource,
    response_type: 'code', state: random(), scope: scope ?? (native ? NATIVE_SCOPE : 'orders:read events:read'),
    code_challenge_method: 'S256', code_challenge: pkceChallenge(verifier) }, principal);
  return { grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirect, resource,
    code: new URL(callback).searchParams.get('code'), code_verifier: verifier };
}
const refresh = (auth, clientId, token, scope) => auth.exchange({ grant_type: 'refresh_token', client_id: clientId,
  refresh_token: token, resource: auth.resourceMetadata.resource, ...(scope ? { scope } : {}) });

function recoveryFixturePool(raw, signal) {
  const checkpoint = () => signal.throwIfAborted();
  return {
    query(...args) { checkpoint(); return raw.query(...args); },
    async connect() {
      checkpoint(); const db = await raw.connect();
      return {
        query(input, ...rest) {
          // Rollback remains available when the test itself, not just the
          // operation-specific controller, has been canceled.
          if (input !== 'ROLLBACK' && input?.text !== 'ROLLBACK') checkpoint();
          return db.query(input, ...rest);
        },
        release(destroy) { db.release(destroy); },
      };
    },
  };
}

test('safety fixture cancellation permits object rollback and forwards client destruction', async () => {
  const controller = new AbortController(), calls = [], releases = [];
  const raw = { async query(input) { calls.push(input); return { rows: [] }; },
    async connect() { return { query: raw.query, release: value => releases.push(value) }; } };
  const checked = recoveryFixturePool(raw, controller.signal), client = await checked.connect();
  controller.abort();
  assert.throws(() => checked.query('SELECT forbidden'), { name: 'AbortError' });
  assert.throws(() => client.query({ text: 'SELECT forbidden' }), { name: 'AbortError' });
  await client.query({ text: 'ROLLBACK', query_timeout: 8000 });
  client.release(true);
  assert.deepEqual(calls, [{ text: 'ROLLBACK', query_timeout: 8000 }]);
  assert.deepEqual(releases, [true]);
});

// Wrap only the selected client; never inject faults into fixture cleanup.
function interceptedPool(pool, intercept) {
  return { async connect() {
    const db = await pool.connect();
    return { async query(input, values) {
      const sql = typeof input === 'string' ? input : input.text;
      const result = await db.query(input, values);
      await intercept(sql, result);
      return result;
    }, release(destroy) { db.release(destroy); } };
  } };
}

async function authFingerprint(pool, schema) {
  const names = ['demo_sessions', 'demo_oauth_grants', 'demo_oauth_refresh_tokens', 'demo_oauth_codes', 'oidc_login_states'];
  const result = {};
  for (const name of names) {
    const rows = (await pool.query('SELECT row_to_json(t)::text AS value FROM ' + fixtureIdentifier(schema, 'schema') + '.' + name + ' t')).rows.map(row => row.value).sort();
    assert.ok(rows.length < 1000); result[name] = { count: rows.length, digest: digest(rows.join('\n')) };
  }
  return result;
}

async function preservedFingerprint(pool, schema) {
  const excluded = new Set(['demo_sessions', 'demo_oauth_grants', 'demo_oauth_refresh_tokens', 'demo_oauth_codes', 'oidc_login_states']);
  const result = {};
  for (const name of TABLES.filter(name => !excluded.has(name))) {
    const rows = (await pool.query('SELECT row_to_json(t)::text AS value FROM ' + fixtureIdentifier(schema, 'schema') + '.' + name + ' t')).rows.map(row => row.value).sort();
    assert.ok(rows.length < 1000); result[name] = digest(rows.join('\n'));
  }
  result.auditSequence = (await pool.query('SELECT last_value::text,is_called FROM ' + fixtureIdentifier(schema, 'schema') + '.platform_identity_audit_id_seq')).rows[0];
  return result;
}

test('actual archive authentication preparation is atomic, target-bound and retry-safe; activation remains unsupported', {
  skip: process.env.TEST_CONTROL_RECOVERY_SAFETY !== '1', timeout: 180000,
}, async t => {
  const database = fixtureDatabase(process.env.IDENTITY_TEST_DATABASE_URL, process.env);
  const bin = process.env.TEST_CONTROL_RECOVERY_PG_BIN;
  const root = await mkdtemp(join(tmpdir(), 'onlinu-recovery-safety-'));
  const environment = clientEnvironment(root, database), nonce = randomBytes(12).toString('hex');
  const schema = 'control_recovery_' + nonce, marker = 'onlinu-control-recovery:' + randomUUID();
  const targetName = 'control_recovery_restore_' + nonce;
  let admin, source, target, owner, repeatTarget, repeatOwner, schemaOwner, sourceClosed = false, report;
  const options = connectionString => ({ connectionString, max: 5, connectionTimeoutMillis: 5000,
    statement_timeout: 5000, query_timeout: 8000, idleTimeoutMillis: 1000, options: '-c timezone=UTC' });
  function pool(config) {
    const raw = new pg.Pool(config);
    return { ...recoveryFixturePool(raw, t.signal), cleanupQuery: (...args) => raw.query(...args), end: () => boundedCleanup(() => raw.end()) };
  }
  const sourcePool = () => pool({ ...options(database.href), options: '-c timezone=UTC -c search_path=' + schema });
  let outbound = 0, exchanges = 0;
  t.mock.method(globalThis, 'fetch', async () => { outbound++; throw new Error('external_request_forbidden'); });
  const flows = new Map();
  const adapter = { async authorizationUrl(args) { flows.set(args.state, args); return configuration.oidc.issuer + 'authorize?state=' + args.state; },
    async exchange({ callbackUrl, nonce }) {
      exchanges++; const flow = flows.get(new URL(callbackUrl).searchParams.get('state'));
      assert.equal(flow.nonce, nonce);
      return { iss: configuration.oidc.issuer, aud: configuration.oidc.clientId, sub: 'synthetic-owner', nonce };
    } };
  const appConfig = { ...configuration, csrfKey: randomBytes(32).toString('base64'),
    oidc: { ...configuration.oidc, clientSecret: random() } };
  const application = async pool => {
    // Exercise native authority in the shared tables without enabling signed
    // business APIs or creating unrelated business queues. Native HTTP and
    // complete native recovery acceptance remain separate.
    const app = await createControlPlane({ ...appConfig, pool, nativeStaffEnabled: false }, { oidcClientAdapter: adapter });
    const native = createAuth({ pool, baseUrl: configuration.baseUrl + '/native', profile: 'native_staff',
      csrfKey: appConfig.csrfKey, allowSyntheticAuthorization: false,
      principalResolver: async id => { const who = await app.directory.resolve(id); return who?.memberships.length ? who : null; } });
    await native.init();
    return { ...app, nativeStaff: { auth: native } };
  };
  async function begin(app) {
    const flow = await app.login.begin('/manage');
    return { callback: configuration.baseUrl + '/auth/callback?code=synthetic&state=' + new URL(flow.authorizationUrl).searchParams.get('state'), cookie: flow.bindingCookie };
  }
  try {
    const clientVersion = await verifyClients(bin, environment, t.signal);
    admin = pool(options(database.href));
    const serverVersion = Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num);
    assert.ok([16, 17].includes(Math.floor(serverVersion / 10000)) && +clientVersion.split('.')[0] >= Math.floor(serverVersion / 10000));
    schemaOwner = await createSourceSchema(admin, schema, marker);
    source = sourcePool(); let app = await application(source);
    const firstFlow = await begin(app), signedIn = await app.login.complete(firstFlow.callback, firstFlow.cookie);
    const principal = { id: signedIn.principalId };
    await source.query('UPDATE platform_identities SET platform_admin=TRUE WHERE id=$1', [principal.id]);
    await app.directory.createTenant(principal.id, { id: 'safety', name: 'Synthetic safety fixture', ownerId: principal.id });
    await app.directory.setTenantStatus(principal.id, 'safety', { status: 'active', expectedVersion: 1 });
    const client = await app.auth.register({ redirect_uris: configuration.redirectAllowlist, grant_types: ['authorization_code', 'refresh_token'] });
    const codeOnly = await app.auth.register({ redirect_uris: configuration.redirectAllowlist });
    const browserSession = await app.auth.issue(principal.id, undefined, { kind: 'browser' });
    const browserNeverRevoked = await app.auth.issue(principal.id, undefined, { kind: 'browser' });
    const families = {};
    for (const name of ['revokedLater', 'rotatedLater', 'neverRevoked', 'alreadyRevoked']) families[name] = await app.auth.exchange(await code(app.auth, principal, client.client_id));
    await app.auth.revoke(families.alreadyRevoked.refresh_token);
    const codeSession = await app.auth.exchange(await code(app.auth, principal, codeOnly.client_id));
    const pendingCode = await code(app.auth, principal, client.client_id), pendingNeverConsumed = await code(app.auth, principal, client.client_id);
    const nativeGrant = await app.nativeStaff.auth.exchange(await code(app.nativeStaff.auth, principal, NATIVE_CLIENT_ID, true));
    const nativeCode = await code(app.nativeStaff.auth, principal, NATIVE_CLIENT_ID, true);
    const oidcPending = await begin(app);
    const snapshot = await logicalFingerprint(source, schema);
    await source.end(); sourceClosed = true;
    const archivePath = join(root, 'synthetic-safety.pgdump');
    const bytes = await clientCommand(bin, 'pg_dump', [...clientArguments(database), '--format=custom', '--no-owner', '--no-acl', '--strict-names', '--schema=' + schema], environment, { limit: ARCHIVE_LIMIT, signal: t.signal });
    const archive = archiveFingerprint(bytes); await writeFile(archivePath, bytes, { flag: 'wx', mode: 0o600 });
    source = sourcePool(); sourceClosed = false; app = await application(source);
    await app.auth.revoke(browserSession.accessToken);
    await app.auth.revoke(families.revokedLater.refresh_token);
    const narrowed = await refresh(app.auth, client.client_id, families.rotatedLater.refresh_token, 'orders:read');
    assert.equal(narrowed.scope, 'orders:read');
    await assert.rejects(refresh(app.auth, client.client_id, families.rotatedLater.refresh_token), { code: 'invalid_grant' });
    await app.auth.exchange(pendingCode);
    const afterT1 = await logicalFingerprint(source, schema);
    assert.notEqual(afterT1.sha256, snapshot.sha256);
    await source.end(); sourceClosed = true;
    await createRestoreDatabase(admin, targetName, marker, value => { owner = value; });
    await verifyRestoreOwner(admin, owner);
    const targetDatabase = new URL(database); targetDatabase.pathname = '/' + targetName;
    await clientCommand(bin, 'pg_restore', [...clientArguments(targetDatabase), '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', archivePath], environment, { signal: t.signal });
    target = pool({ ...options(targetDatabase.href), options: '-c timezone=UTC -c search_path=' + schema });
    assert.deepEqual(await logicalFingerprint(target, schema), snapshot);
    const recovered = await application(target);
    assert.ok(await recovered.auth.authenticate(browser(browserSession.accessToken), { cookieOnly: true }));
    assert.ok(await recovered.auth.authenticate(bearer(families.revokedLater.access_token), { bearerOnly: true }));
    assert.deepEqual((await recovered.auth.authenticate(bearer(families.rotatedLater.access_token), { bearerOnly: true })).scopes, ['orders:read', 'events:read']);
    const catalog = (await target.query(`SELECT d.oid AS database_oid,d.datdba AS database_owner_oid,n.oid AS schema_oid,n.nspowner AS schema_owner_oid
      FROM pg_database d CROSS JOIN pg_namespace n WHERE d.datname=current_database() AND n.nspname=$1`, [schema])).rows[0];
    const expected = expectationFor({ database: targetName, databaseOid: catalog.database_oid, databaseOwnerOid: catalog.database_owner_oid,
      marker, schema, schemaOid: catalog.schema_oid, schemaOwnerOid: catalog.schema_owner_oid });
    const args = { pool: target, expectation: expected, configuration, signal: t.signal };
    const before = await authFingerprint(target, schema), preserved = await preservedFingerprint(target, schema);
    await checkedCase(t, 'missing receipt, wrong target and incomplete authority review cannot mutate or permit serving', async () => {
      await assert.rejects(verifyControlRecoveryReceipt(args), /recovery_operation_failed_closed/);
      for (const change of [{ database: 'unknown_target' }, { databaseOid: catalog.database_oid + 1 },
        { databaseOwnerOid: catalog.database_owner_oid + 1 }, { marker: 'onlinu-control-recovery:' + randomUUID() },
        { schemaOid: catalog.schema_oid + 1 }, { schemaOwnerOid: catalog.schema_owner_oid + 1 }]) {
        await assert.rejects(prepareControlRecovery({ ...args, expectation: { ...expected, target: { ...expected.target, ...change } } }), /recovery_target_mismatch/);
      }
      assert.deepEqual(await authFingerprint(target, schema), before);
      assert.deepEqual(await preservedFingerprint(target, schema), preserved);
    });
    let statements = [];
    await checkedCase(t, 'failure after every preparation statement before commit rolls back all changes and receipt DDL', async () => {
      // First observe the entire transaction while forcing rollback before COMMIT.
      await assert.rejects(prepareControlRecovery({ ...args, pool: interceptedPool(target, sql => {
        statements.push(sql); if (sql.startsWith('INSERT INTO')) throw new Error('synthetic_failure');
      }) }), /recovery_operation_failed_closed/);
      statements = statements.filter(sql => sql !== 'ROLLBACK');
      for (let at = 1; at <= statements.length; at++) {
        let n = 0;
        await assert.rejects(prepareControlRecovery({ ...args, pool: interceptedPool(target, sql => {
          if (sql !== 'ROLLBACK' && ++n === at) throw new Error('synthetic_failure');
        }) }), /recovery_operation_failed_closed/);
        assert.deepEqual(await authFingerprint(target, schema), before);
        assert.deepEqual(await preservedFingerprint(target, schema), preserved);
        assert.equal((await target.query('SELECT to_regclass($1) AS relation', [schema + '.platform_control_recovery_receipts'])).rows[0].relation, null);
      }
    });
    await checkedCase(t, 'changed target ownership marker during preparation rolls back instead of recording success', async () => {
      const changedMarker = 'onlinu-control-recovery:' + randomUUID();
      let changed = false;
      try {
        await assert.rejects(prepareControlRecovery({ ...args, pool: interceptedPool(target, async sql => {
          if (!changed && sql.startsWith('UPDATE')) {
            await verifyRestoreOwner(admin, owner);
            await admin.query('COMMENT ON DATABASE ' + fixtureIdentifier(owner.name, 'database') + " IS '" + changedMarker + "'");
            changed = true;
          }
        }) }), /recovery_target_mismatch/);
        assert.deepEqual(await authFingerprint(target, schema), before);
      } finally {
        if (changed) {
          // Revert only our own known synthetic mutation, verified independently.
          await verifyRestoreOwner(admin, { ...owner, marker: changedMarker });
          await admin.query('COMMENT ON DATABASE ' + fixtureIdentifier(owner.name, 'database') + " IS '" + marker + "'");
        }
      }
    });
    await checkedCase(t, 'cancellation after invalidation rolls back and cannot resume ordinary SQL', async () => {
      const controller = new AbortController();
      await assert.rejects(prepareControlRecovery({ ...args, signal: controller.signal, pool: interceptedPool(target, sql => {
        if (sql.startsWith('UPDATE')) controller.abort();
      }) }), /recovery_cancelled/);
      assert.deepEqual(await authFingerprint(target, schema), before);
    });
    let receipt;
    await checkedCase(t, 'uncertain commit is closed; exact concurrent retries verify the committed operation', async () => {
      let invalidationStatements = 0;
      const intercepted = loseCommit => interceptedPool(target, sql => {
        if (sql.startsWith('UPDATE')) invalidationStatements++;
        if (loseCommit && sql === 'COMMIT') throw new Error('synthetic_connection_loss_after_commit');
      });
      // Both calls begin before a receipt exists. Exactly one invalidation may
      // commit, even if its COMMIT acknowledgment is lost to its caller.
      const outcomes = await Promise.allSettled([
        prepareControlRecovery({ ...args, pool: intercepted(true) }),
        prepareControlRecovery({ ...args, pool: intercepted(false) }),
      ]);
      assert.equal(outcomes[0].status, 'rejected');
      assert.equal(outcomes[0].reason.code, 'recovery_commit_uncertain');
      assert.equal(outcomes[1].status, 'fulfilled'); receipt = outcomes[1].value;
      assert.equal(invalidationStatements, 5, 'concurrent duplicate cannot invalidate twice');
      assert.deepEqual(await prepareControlRecovery(args), receipt);
      assert.equal(receipt.scope, 'authentication-preparation-only');
      for (const field of ['servingAuthorized', 'eventsSupported', 'processFencingVerified', 'authorityReconciliationVerified']) assert.equal(receipt[field], false);
      for (const [name, value] of Object.entries(before)) assert.equal(receipt.counts[name], value.count);
      assert.deepEqual(await verifyControlRecoveryReceipt(args), receipt);
      assert.deepEqual(await preservedFingerprint(target, schema), preserved);
    });
    await checkedCase(t, 'all restored customer/native browser, access, refresh, code-only and pending-flow authority is rejected', async () => {
      const frozen = await authFingerprint(target, schema), previousExchanges = exchanges;
      for (const token of [browserSession.accessToken, browserNeverRevoked.accessToken]) assert.equal(await recovered.auth.authenticate(browser(token), { cookieOnly: true }), null);
      for (const family of Object.values(families)) {
        assert.equal(await recovered.auth.authenticate(bearer(family.access_token), { bearerOnly: true }), null);
        await assert.rejects(refresh(recovered.auth, client.client_id, family.refresh_token), { code: 'invalid_grant' });
      }
      assert.equal(await recovered.auth.authenticate(bearer(codeSession.access_token), { bearerOnly: true }), null);
      for (const pending of [pendingCode, pendingNeverConsumed]) await assert.rejects(recovered.auth.exchange(pending), { code: 'invalid_grant' });
      assert.equal(await recovered.nativeStaff.auth.authenticate(bearer(nativeGrant.access_token), { bearerOnly: true }), null);
      await assert.rejects(refresh(recovered.nativeStaff.auth, NATIVE_CLIENT_ID, nativeGrant.refresh_token), { code: 'invalid_grant' });
      await assert.rejects(recovered.nativeStaff.auth.exchange(nativeCode), { code: 'invalid_grant' });
      for (const cookie of [oidcPending.cookie, random(), oidcPending.cookie]) await assert.rejects(recovered.login.complete(oidcPending.callback, cookie));
      assert.equal(exchanges, previousExchanges, 'expired finite OIDC state must fail before provider exchange');
      assert.deepEqual(await authFingerprint(target, schema), frozen, 'rejected authority cannot mint successors or mutate state');
    });
    await checkedCase(t, 'fresh verified login and consent work; same-ID retry preserves new sessions and strict bindings', async () => {
      const flow = await begin(recovered), freshIdentity = await recovered.login.complete(flow.callback, flow.cookie);
      assert.equal(freshIdentity.principalId, principal.id);
      const freshBrowser = await recovered.auth.issue(principal.id, undefined, { kind: 'browser' });
      const fresh = await recovered.auth.exchange(await code(recovered.auth, principal, client.client_id));
      const freshNative = await recovered.nativeStaff.auth.exchange(await code(recovered.nativeStaff.auth, principal, NATIVE_CLIENT_ID, true));
      const afterNew = await authFingerprint(target, schema);
      assert.deepEqual(await prepareControlRecovery(args), receipt);
      assert.deepEqual(await verifyControlRecoveryReceipt(args), receipt);
      assert.deepEqual(await authFingerprint(target, schema), afterNew);
      assert.ok(await recovered.auth.authenticate(browser(freshBrowser.accessToken), { cookieOnly: true }));
      assert.ok(await recovered.auth.authenticate(bearer(fresh.access_token), { bearerOnly: true }));
      assert.ok(await recovered.nativeStaff.auth.authenticate(bearer(freshNative.access_token), { bearerOnly: true }));
      assert.equal(await recovered.auth.authenticate(bearer(freshNative.access_token), { bearerOnly: true }), null);
      assert.equal(await recovered.auth.authenticate(bearer(freshBrowser.accessToken), { bearerOnly: true }), null);
      for (const modify of [value => { value.recoveryId = randomUUID(); }, value => { value.operatorReference = 'other-operator'; },
        value => { value.authorityReview.evidenceSha256 = digest('different-review'); }]) {
        const changed = copy(expected); modify(changed);
        await assert.rejects(verifyControlRecoveryReceipt({ ...args, expectation: changed }), /recovery_receipt_(missing|mismatch)/);
      }
      const changed = copy(expected); changed.operatorReference = 'other-operator';
      await assert.rejects(prepareControlRecovery({ ...args, expectation: changed }), /recovery_receipt_mismatch/);
      assert.deepEqual(await authFingerprint(target, schema), afterNew);
    });
    await checkedCase(t, 'restoring a receipt-bearing archive cannot satisfy a fresh external recovery ID', async () => {
      const beforeRepeat = await authFingerprint(target, schema);
      const repeatedArchivePath = join(root, 'synthetic-receipt-bearing.pgdump');
      const repeatedBytes = await clientCommand(bin, 'pg_dump', [...clientArguments(targetDatabase), '--format=custom',
        '--no-owner', '--no-acl', '--strict-names', '--schema=' + schema], environment, { limit: ARCHIVE_LIMIT, signal: t.signal });
      const repeatedArchive = archiveFingerprint(repeatedBytes);
      await writeFile(repeatedArchivePath, repeatedBytes, { flag: 'wx', mode: 0o600 });
      const repeatedName = 'control_recovery_restore_' + randomBytes(12).toString('hex');
      const repeatedMarker = 'onlinu-control-recovery:' + randomUUID();
      await createRestoreDatabase(admin, repeatedName, repeatedMarker, value => { repeatOwner = value; });
      await verifyRestoreOwner(admin, repeatOwner);
      const repeatedDatabase = new URL(database); repeatedDatabase.pathname = '/' + repeatedName;
      await clientCommand(bin, 'pg_restore', [...clientArguments(repeatedDatabase), '--exit-on-error', '--single-transaction',
        '--no-owner', '--no-acl', repeatedArchivePath], environment, { signal: t.signal });
      repeatTarget = pool({ ...options(repeatedDatabase.href), options: '-c timezone=UTC -c search_path=' + schema });
      assert.deepEqual(await authFingerprint(repeatTarget, schema), beforeRepeat);
      assert.equal((await repeatTarget.query('SELECT count(*)::int AS n FROM platform_control_recovery_receipts')).rows[0].n, 1);
      const newCatalog = (await repeatTarget.query(`SELECT d.oid AS database_oid,d.datdba AS database_owner_oid,n.oid AS schema_oid,n.nspowner AS schema_owner_oid
        FROM pg_database d CROSS JOIN pg_namespace n WHERE d.datname=current_database() AND n.nspname=$1`, [schema])).rows[0];
      const repeatedExpected = expectationFor({ database: repeatedName, databaseOid: newCatalog.database_oid,
        databaseOwnerOid: newCatalog.database_owner_oid, marker: repeatedMarker, schema,
        schemaOid: newCatalog.schema_oid, schemaOwnerOid: newCatalog.schema_owner_oid });
      const repeatedArgs = { ...args, pool: repeatTarget, expectation: repeatedExpected };
      await assert.rejects(verifyControlRecoveryReceipt(repeatedArgs), /recovery_receipt_missing/);
      await assert.rejects(verifyControlRecoveryReceipt({ ...repeatedArgs,
        expectation: { ...repeatedExpected, recoveryId: expected.recoveryId } }), /recovery_receipt_mismatch/);
      await prepareControlRecovery(repeatedArgs);
      assert.equal((await verifyControlRecoveryReceipt(repeatedArgs)).expectation.recoveryId, repeatedExpected.recoveryId);
      assert.equal((await repeatTarget.query('SELECT count(*)::int AS n FROM platform_control_recovery_receipts')).rows[0].n, 2, 'older receipt remains as evidence');
      assert.equal((await repeatTarget.query('SELECT count(*)::int AS n FROM demo_sessions WHERE expires_at>now()')).rows[0].n, 0);
      assert.deepEqual(await preservedFingerprint(repeatTarget, schema), await preservedFingerprint(target, schema));
      assert.deepEqual(await authFingerprint(target, schema), beforeRepeat, 'a repeated restore never alters its newer source');
      assert.deepEqual(archiveFingerprint(await readFile(repeatedArchivePath)), repeatedArchive);
    });
    source = sourcePool(); sourceClosed = false;
    assert.deepEqual(await logicalFingerprint(source, schema), afterT1);
    assert.deepEqual(archiveFingerprint(await readFile(archivePath)), archive);
    assert.equal(outbound, 0); await verifyRestoreOwner(admin, owner);
    report = { scope: 'synthetic-authentication-preparation-only', clientVersion, serverVersion,
      preparationStatementsFaultTested: statements.length, sourceT1Unchanged: true, archiveUnchanged: true,
      preservedBindingAndAuditRecords: true, externalRequests: outbound, simulatedProviderExchanges: exchanges,
      eventsRecoveryVerified: false, dexRecoveryVerified: false, processFencingVerified: false, servingAuthorized: false };
  } finally {
    const cleanup = { query: (...args) => admin.cleanupQuery(...args) };
    await cleanupAll([
      async () => { if (target) await target.end(); },
      async () => { if (repeatTarget) await repeatTarget.end(); },
      async () => { if (repeatOwner) {
        await verifyRestoreOwner(cleanup, repeatOwner);
        await cleanup.query('DROP DATABASE ' + fixtureIdentifier(repeatOwner.name, 'database'));
        assert.equal((await cleanup.query('SELECT oid FROM pg_database WHERE datname=$1', [repeatOwner.name])).rows.length, 0);
      } },
      async () => { if (source && !sourceClosed) await source.end(); },
      async () => { if (owner) {
        await verifyRestoreOwner(cleanup, owner);
        await cleanup.query('DROP DATABASE ' + fixtureIdentifier(owner.name, 'database'));
        assert.equal((await cleanup.query('SELECT oid FROM pg_database WHERE datname=$1', [owner.name])).rows.length, 0);
      } },
      async () => {
        if (schemaOwner) {
          const row = (await cleanup.query("SELECT oid,obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname=$1", [schema])).rows[0];
          assert.ok(row && row.oid === schemaOwner && row.marker === marker);
          await cleanup.query('DROP SCHEMA ' + fixtureIdentifier(schema, 'schema') + ' CASCADE');
          assert.equal((await cleanup.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [schema])).rows.length, 0);
        }
      },
      async () => { if (admin) await admin.end(); },
      () => rm(root, { recursive: true }),
    ]);
  }
  if (report) t.diagnostic(JSON.stringify({ ...report, cleanupVerified: true }));
});
