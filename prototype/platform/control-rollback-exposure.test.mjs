// A passing test records rollback exposure, NOT rollback-resistant revocation.
// All authority and archive bytes are generated in an owned disposable fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createControlPlane } from './control-plane.mjs';
import { hash, pkceChallenge } from './auth.mjs';
import { ARCHIVE_LIMIT, TABLES, fixtureDatabase, fixtureIdentifier, archiveFingerprint,
  clientEnvironment, clientCommand, verifyClients, clientArguments, createRestoreDatabase,
  verifyRestoreOwner, createSourceSchema, cleanupAll, boundedCleanup, abortCheckedPool,
  logicalFingerprint } from './integration/control-recovery-fixture.mjs';

const issuer = 'https://identity.rollback.example.invalid/';
const baseUrl = 'https://platform.rollback.example.invalid';
const redirectUri = 'https://client.rollback.example.invalid/callback';
const resource = baseUrl + '/mcp';
const random = () => randomBytes(32).toString('base64url');
const bearer = token => ({ headers: { authorization: 'Bearer ' + token } });
const browser = token => ({ headers: { cookie: '__Host-platform_session=' + token } });
const refresh = (clientId, token, extra = {}) => ({ grant_type: 'refresh_token',
  client_id: clientId, refresh_token: token, resource, ...extra });

async function authorizeCode(app, principalId, clientId, scope = 'orders:read events:read') {
  const verifier = random();
  const callback = await app.auth.authorize({ client_id: clientId, redirect_uri: redirectUri,
    response_type: 'code', resource, scope, state: random(), code_challenge_method: 'S256',
    code_challenge: pkceChallenge(verifier) }, { id: principalId });
  return { grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri,
    code: new URL(callback).searchParams.get('code'), code_verifier: verifier, resource };
}

async function checkedCase(parent, name, operation) {
  // node:test records an awaited child failure without rejecting parent.test().
  // Do not continue a dependent timeline or issue a success-shaped report then.
  let passed = false;
  await parent.test(name, async () => { await operation(); passed = true; });
  assert.equal(passed, true, 'fixture case must finish successfully before continuing');
}

test('rollback exposure evidence cannot continue after a failed or unfinished child', async () => {
  let calls = 0;
  const successful = { async test(_name, operation) { await operation(); } };
  await checkedCase(successful, 'synthetic success', async () => { calls++; });
  assert.equal(calls, 1);
  const failed = { async test(_name, operation) { try { await operation(); } catch { /* Runner records child failure. */ } } };
  await assert.rejects(checkedCase(failed, 'synthetic failure', async () => { throw new Error('synthetic_case_failure'); }),
    /fixture case must finish successfully/);
  const unfinished = { async test() {} };
  await assert.rejects(checkedCase(unfinished, 'synthetic cancellation', async () => { calls++; }),
    /fixture case must finish successfully/);
  assert.equal(calls, 1);
});

test('actual control archive exposes post-snapshot browser and customer OAuth rollback', {
  skip: process.env.TEST_CONTROL_ROLLBACK_EXPOSURE !== '1', timeout: 120000,
}, async t => {
  // Reuse the strict loopback/database/client/ownership guards. Setting a URL or
  // opting into the older recovery fixture does not enable this separate test.
  const database = fixtureDatabase(process.env.IDENTITY_TEST_DATABASE_URL, process.env);
  const bin = process.env.TEST_CONTROL_RECOVERY_PG_BIN;
  const root = await mkdtemp(join(tmpdir(), 'onlinu-control-rollback-'));
  const environment = clientEnvironment(root, database);
  const nonce = randomBytes(12).toString('hex');
  const schema = 'control_recovery_' + nonce;
  const quotedSchema = fixtureIdentifier(schema, 'schema');
  const targetName = 'control_recovery_restore_' + nonce;
  const marker = 'onlinu-control-recovery:' + randomUUID();
  let admin, source, target, owner, schemaOwner, sourceClosed = false;
  const pools = connectionString => ({ connectionString, max: 4, connectionTimeoutMillis: 5000,
    statement_timeout: 5000, query_timeout: 7000, idleTimeoutMillis: 1000, options: '-c timezone=UTC' });
  function pool(options) {
    const raw = new pg.Pool(options);
    return { ...abortCheckedPool(raw, t.signal),
      cleanupQuery(...args) { return raw.query(...args); },
      end() { return boundedCleanup(() => raw.end()); } };
  }
  const sourcePool = () => pool({ ...pools(database.href), options: '-c timezone=UTC -c search_path=' + schema });
  let outbound = 0, providerCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { outbound++; throw new Error('fixture_external_request_forbidden'); });
  // Identity rows are seeded directly below. No OIDC flow is simulated, and no
  // Dex/provider code consumption or signature verification is claimed.
  const unusedProvider = {
    async authorizationUrl() { providerCalls++; throw new Error('fixture_provider_forbidden'); },
    async exchange() { providerCalls++; throw new Error('fixture_provider_forbidden'); },
  };
  const config = { baseUrl, csrfKey: randomBytes(32).toString('base64'),
    oidc: { issuer, clientId: 'synthetic-rollback-client', clientSecret: random() },
    redirectAllowlist: [redirectUri] };
  const application = activePool => createControlPlane({ ...config, pool: activePool }, { oidcClientAdapter: unusedProvider });
  let report;
  try {
    const clientVersion = await verifyClients(bin, environment, t.signal);
    admin = pool(pools(database.href));
    const serverVersion = Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num);
    assert.ok([16, 17].includes(Math.floor(serverVersion / 10000)), 'reviewed PostgreSQL server required');
    assert.ok(+clientVersion.split('.')[0] >= Math.floor(serverVersion / 10000), 'dump client cannot be older than server');
    schemaOwner = await createSourceSchema(admin, schema, marker);
    source = sourcePool();
    let app = await application(source);
    const people = {};
    for (const name of ['browser', 'revokedFamily', 'rotatedFamily', 'code', 'control']) {
      // Test data only, at the same trusted internal boundary other auth tests
      // seed. This does not exercise or replace the production OIDC verifier.
      people[name] = (await app.directory.verifiedIdentity({ issuer, subject: 'synthetic-' + name + '-' + random() })).id;
    }
    assert.equal(new Set(Object.values(people)).size, 5, 'exposure cases have independent identities');
    const client = await app.auth.register({ redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    const issueFamily = who => authorizeCode(app, who, client.client_id).then(code => app.auth.exchange(code));
    const session = await app.auth.issue(people.browser, undefined, { kind: 'browser' });
    const revokedFamily = await issueFamily(people.revokedFamily);
    const rotatedFamily = await issueFamily(people.rotatedFamily);
    const pendingCode = await authorizeCode(app, people.code, client.client_id, 'orders:read');

    // Negative controls are already revoked/expired at T0, so a faithful archive
    // must preserve those limits. They use different families from all cases.
    const revokedAtSnapshot = await issueFamily(people.control);
    await app.auth.revoke(revokedAtSnapshot.refresh_token);
    const expiredSession = await app.auth.issue(people.control, undefined,
      { kind: 'browser', expiresAt: '2000-01-01T00:00:00.000Z' });
    const expiredCode = await authorizeCode(app, people.control, client.client_id);
    await source.query("UPDATE demo_oauth_codes SET expires_at='2000-01-01T00:00:00Z' WHERE code_hash=$1", [hash(expiredCode.code)]);
    const expiredFamily = await issueFamily(people.control);
    await source.query(`UPDATE demo_oauth_grants SET expires_at='2000-01-01T00:00:00Z'
      WHERE id=(SELECT family_id FROM demo_oauth_refresh_tokens WHERE token_hash=$1)`, [hash(expiredFamily.refresh_token)]);

    const snapshot = await logicalFingerprint(source, schema);
    assert.equal(snapshot.tables.length, TABLES.length);
    assert.equal((await app.auth.authenticate(browser(session.accessToken), { cookieOnly: true })).id, people.browser);
    assert.equal((await app.auth.authenticate(bearer(revokedFamily.access_token), { bearerOnly: true })).id, people.revokedFamily);
    assert.equal((await app.auth.authenticate(bearer(rotatedFamily.access_token), { bearerOnly: true })).id, people.rotatedFamily);
    await source.end(); sourceClosed = true;

    // T0 is a real, quiesced, complete schema archive, not row reinsertion.
    const bytes = await clientCommand(bin, 'pg_dump', [...clientArguments(database), '--format=custom',
      '--no-owner', '--no-acl', '--strict-names', '--schema=' + schema], environment, { limit: ARCHIVE_LIMIT, signal: t.signal });
    const archive = archiveFingerprint(bytes);
    const archivePath = join(root, 'synthetic-rollback.pgdump');
    await writeFile(archivePath, bytes, { flag: 'wx', mode: 0o600 });
    const file = await lstat(archivePath);
    assert.ok(file.isFile() && !file.isSymbolicLink()); assert.equal(file.mode & 0o777, 0o600);
    assert.deepEqual(archiveFingerprint(await readFile(archivePath)), archive);

    // T1 changes happen only after the immutable archive exists. No source row
    // is restored or edited back; the source stays at its later security state.
    source = sourcePool(); sourceClosed = false; app = await application(source);
    assert.deepEqual(await logicalFingerprint(source, schema), snapshot);
    let rotatedAtT1, consumedAtT1;
    await checkedCase(t, 'T1 source enforces logout, family revocation, consumed refresh replay and consumed code', async () => {
      await app.auth.revoke(session.accessToken);
      assert.equal(await app.auth.authenticate(browser(session.accessToken), { cookieOnly: true }), null);
      await app.auth.revoke(revokedFamily.refresh_token);
      assert.equal(await app.auth.authenticate(bearer(revokedFamily.access_token), { bearerOnly: true }), null);
      await assert.rejects(app.auth.exchange(refresh(client.client_id, revokedFamily.refresh_token)), { code: 'invalid_grant' });

      rotatedAtT1 = await app.auth.exchange(refresh(client.client_id, rotatedFamily.refresh_token, { scope: 'orders:read' }));
      assert.equal(rotatedAtT1.scope, 'orders:read');
      assert.equal(await app.auth.authenticate(bearer(rotatedFamily.access_token), { bearerOnly: true }), null);
      assert.equal((await app.auth.authenticate(bearer(rotatedAtT1.access_token), { bearerOnly: true })).id, people.rotatedFamily);
      await assert.rejects(app.auth.exchange(refresh(client.client_id, rotatedFamily.refresh_token)), { code: 'invalid_grant' });
      assert.equal(await app.auth.authenticate(bearer(rotatedAtT1.access_token), { bearerOnly: true }), null);
      await assert.rejects(app.auth.exchange(refresh(client.client_id, rotatedAtT1.refresh_token)), { code: 'invalid_grant' });

      consumedAtT1 = await app.auth.exchange(pendingCode);
      assert.equal((await app.auth.authenticate(bearer(consumedAtT1.access_token), { bearerOnly: true })).id, people.code);
      await assert.rejects(app.auth.exchange(pendingCode), { code: 'invalid_grant' });
    });
    const afterT1 = await logicalFingerprint(source, schema);
    assert.notEqual(afterT1.sha256, snapshot.sha256, 'T1 must materially differ from the archived T0');
    await source.end(); sourceClosed = true;

    await createRestoreDatabase(admin, targetName, marker, created => { owner = created; });
    await verifyRestoreOwner(admin, owner);
    const targetDatabase = new URL(database); targetDatabase.pathname = '/' + targetName;
    await clientCommand(bin, 'pg_restore', [...clientArguments(targetDatabase), '--exit-on-error',
      '--single-transaction', '--no-owner', '--no-acl', archivePath], environment, { signal: t.signal });
    target = pool({ ...pools(targetDatabase.href), options: '-c timezone=UTC -c search_path=' + schema });
    assert.deepEqual(await logicalFingerprint(target, schema), snapshot, 'every archived row and sequence restores to T0');
    const restoredSchemas = (await target.query("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname NOT IN ('public','information_schema') ORDER BY nspname")).rows;
    assert.deepEqual(restoredSchemas, [{ nspname: schema }]);
    const restored = await application(target);
    assert.deepEqual(await logicalFingerprint(target, schema), snapshot, 'startup must not silently alter the restored authority');

    await checkedCase(t, 'restored T0 preserves snapshot revocation, expiry, PKCE and channel boundaries', async () => {
      assert.equal(await restored.auth.authenticate(bearer(revokedAtSnapshot.access_token), { bearerOnly: true }), null);
      await assert.rejects(restored.auth.exchange(refresh(client.client_id, revokedAtSnapshot.refresh_token)), { code: 'invalid_grant' });
      assert.equal(await restored.auth.authenticate(browser(expiredSession.accessToken), { cookieOnly: true }), null);
      assert.equal(await restored.auth.authenticate(bearer(expiredFamily.access_token), { bearerOnly: true }), null);
      await assert.rejects(restored.auth.exchange(refresh(client.client_id, expiredFamily.refresh_token)), { code: 'invalid_grant' });
      await assert.rejects(restored.auth.exchange(expiredCode), { code: 'invalid_grant' });
      for (const change of [{ code_verifier: random() }, { client_id: 'synthetic-other-client' },
        { resource: baseUrl + '/other' }, { redirect_uri: 'https://other.example.invalid/callback' }]) {
        await assert.rejects(restored.auth.exchange({ ...pendingCode, ...change }), { code: 'invalid_grant' });
      }
      for (const change of [{ client_id: 'synthetic-other-client' }, { resource: baseUrl + '/other' }]) {
        await assert.rejects(restored.auth.exchange(refresh(client.client_id, revokedFamily.refresh_token, change)), { code: 'invalid_grant' });
      }
      assert.equal(await restored.auth.authenticate(bearer(session.accessToken), { bearerOnly: true }), null);
      assert.equal(await restored.auth.authenticate(browser(revokedFamily.access_token), { cookieOnly: true }), null);
      assert.deepEqual(await logicalFingerprint(target, schema), snapshot, 'rejected controls cannot change restored state');
    });

    await checkedCase(t, 'observed exposure: a browser session logged out after T0 authenticates again', async () => {
      assert.equal((await restored.auth.authenticate(browser(session.accessToken), { cookieOnly: true })).id, people.browser);
      await restored.auth.revoke(session.accessToken);
      assert.equal(await restored.auth.authenticate(browser(session.accessToken), { cookieOnly: true }), null);
    });

    await checkedCase(t, 'observed exposure: a family revoked after T0 regains both access and refresh authority', async () => {
      assert.equal((await restored.auth.authenticate(bearer(revokedFamily.access_token), { bearerOnly: true })).id, people.revokedFamily);
      const successor = await restored.auth.exchange(refresh(client.client_id, revokedFamily.refresh_token));
      assert.equal((await restored.auth.authenticate(bearer(successor.access_token), { bearerOnly: true })).id, people.revokedFamily);
      assert.equal(successor.scope, 'orders:read events:read');
      await restored.auth.revoke(successor.refresh_token);
      assert.equal(await restored.auth.authenticate(bearer(revokedFamily.access_token), { bearerOnly: true }), null);
      assert.equal(await restored.auth.authenticate(bearer(successor.access_token), { bearerOnly: true }), null);
      await assert.rejects(restored.auth.exchange(refresh(client.client_id, successor.refresh_token)), { code: 'invalid_grant' });
    });

    await checkedCase(t, 'observed exposure: post-T0 consumption, scope narrowing and replay revocation roll back together', async () => {
      assert.equal(await restored.auth.authenticate(bearer(rotatedAtT1.access_token), { bearerOnly: true }), null, 'a token minted only at T1 is absent at T0');
      await assert.rejects(restored.auth.exchange(refresh(client.client_id, rotatedAtT1.refresh_token)), { code: 'invalid_grant' });
      const resurrected = await restored.auth.authenticate(bearer(rotatedFamily.access_token), { bearerOnly: true });
      assert.equal(resurrected.id, people.rotatedFamily);
      assert.deepEqual(resurrected.scopes, ['orders:read', 'events:read']);
      const successor = await restored.auth.exchange(refresh(client.client_id, rotatedFamily.refresh_token));
      assert.equal(successor.scope, 'orders:read events:read', 'T0 restores the broader grant, not its later narrowed scope');
      assert.equal((await restored.auth.authenticate(bearer(successor.access_token), { bearerOnly: true })).id, people.rotatedFamily);
      await assert.rejects(restored.auth.exchange(refresh(client.client_id, rotatedFamily.refresh_token)), { code: 'invalid_grant' });
      assert.equal(await restored.auth.authenticate(bearer(successor.access_token), { bearerOnly: true }), null, 'new replay still revokes the recovered family');
      await assert.rejects(restored.auth.exchange(refresh(client.client_id, successor.refresh_token)), { code: 'invalid_grant' });
    });

    await checkedCase(t, 'observed exposure: an authorization code consumed after T0 exchanges once again', async () => {
      assert.equal(await restored.auth.authenticate(bearer(consumedAtT1.access_token), { bearerOnly: true }), null, 'a post-snapshot grant is not present in the archive');
      await assert.rejects(restored.auth.exchange(refresh(client.client_id, consumedAtT1.refresh_token)), { code: 'invalid_grant' });
      const successor = await restored.auth.exchange(pendingCode);
      assert.equal(successor.scope, 'orders:read');
      assert.equal((await restored.auth.authenticate(bearer(successor.access_token), { bearerOnly: true })).id, people.code);
      await assert.rejects(restored.auth.exchange(pendingCode), { code: 'invalid_grant' }, 'within the recovered timeline the code is still single-use');
      await restored.auth.revoke(successor.refresh_token);
      assert.equal(await restored.auth.authenticate(bearer(successor.access_token), { bearerOnly: true }), null);
    });

    source = sourcePool(); sourceClosed = false;
    assert.deepEqual(await logicalFingerprint(source, schema), afterT1, 'restore and target checks must leave the T1 source unchanged');
    assert.deepEqual(archiveFingerprint(await readFile(archivePath)), archive, 'the T0 archive remains unchanged');
    assert.equal(outbound, 0); assert.equal(providerCalls, 0);
    await verifyRestoreOwner(admin, owner);
    report = { scope: 'synthetic-control-rollback-exposure-only', clientVersion, serverVersion,
      tables: TABLES.length, sequences: 1, archive, snapshotSha256: snapshot.sha256, sourceT1Sha256: afterT1.sha256,
      sourceT1Unchanged: true, externalRequests: outbound, providerCalls,
      observedExposures: ['browser_logout', 'oauth_family_revocation', 'refresh_consumption_scope_and_replay', 'authorization_code_consumption'],
      dexRestoreVerified: false, nativeRecoveryVerified: false, postSnapshotRevocationProtected: false };
  } finally {
    const cleanupAdmin = { query: (...args) => admin.cleanupQuery(...args) };
    await cleanupAll([
      async () => { if (target) await target.end(); },
      async () => { if (source && !sourceClosed) await source.end(); },
      async () => {
        if (owner) {
          await verifyRestoreOwner(cleanupAdmin, owner);
          await cleanupAdmin.query('DROP DATABASE ' + fixtureIdentifier(owner.name, 'database'));
          assert.equal((await cleanupAdmin.query('SELECT oid FROM pg_database WHERE datname=$1', [owner.name])).rows.length, 0);
        }
      },
      async () => {
        if (schemaOwner) {
          const row = (await cleanupAdmin.query("SELECT oid,obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname=$1", [schema])).rows[0];
          assert.ok(row && row.oid === schemaOwner && row.marker === marker, 'source ownership must match before cleanup');
          await cleanupAdmin.query('DROP SCHEMA ' + quotedSchema + ' CASCADE');
          assert.equal((await cleanupAdmin.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [schema])).rows.length, 0);
        }
      },
      async () => { if (admin) await admin.end(); },
      () => rm(root, { recursive: true }),
    ]);
  }
  // Emit only after verified cleanup, and never print tokens, rows or archives.
  if (report) t.diagnostic(JSON.stringify({ ...report, cleanupVerified: true }));
});
