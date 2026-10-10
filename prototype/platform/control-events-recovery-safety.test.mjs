// Staged source proof only: generated authority, owned loopback databases and a
// real synthetic archive. No live listener, worker, provider or callback traffic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { createControlPlane } from './control-plane.mjs';
import { createAuth, pkceChallenge } from './auth.mjs';
import { canonicalJson, createEvents } from './events.mjs';
import { createCoreEventWorker } from './core-events.mjs';
import { CONTROL_RECOVERY_POLICY, controlRecoveryBinding, prepareControlRecovery, verifyControlRecoveryReceipt } from './control-recovery.mjs';
import { ARCHIVE_LIMIT, TABLES, fixtureDatabase, fixtureIdentifier, archiveFingerprint, clientEnvironment,
  clientCommand, verifyClients, clientArguments, createRestoreDatabase, verifyRestoreOwner, createSourceSchema,
  cleanupAll, boundedCleanup, digest } from './integration/control-recovery-fixture.mjs';

const random = () => randomBytes(32).toString('base64url');
const configuration = { baseUrl: 'https://events-safety.example.invalid',
  oidc: { issuer: 'https://identity.events-safety.example.invalid/', clientId: 'synthetic-events-safety-client' },
  nativeStaffEnabled: false, nativeMobileEnabled: false,
  redirectAllowlist: ['https://client.events-safety.example.invalid/callback'], eventsEnabled: false, eventsStorage: 'installed' };
const AUTH = ['demo_sessions', 'demo_oauth_grants', 'demo_oauth_refresh_tokens', 'demo_oauth_codes', 'oidc_login_states'];
const EVENTS = ['event_owner_epochs', 'event_subscriptions', 'event_deliveries', 'event_callback_verifications'];
const CURSOR = 'platform_core_event_cursors';
const ALL = [...TABLES, ...EVENTS, CURSOR].sort();
const bearer = token => ({ headers: { authorization: 'Bearer ' + token } });
const browser = token => ({ headers: { cookie: '__Host-platform_session=' + token } });
const deniedGrant = operation => assert.rejects(operation, error => error.status === 403 || error.code === -32001);
const fingerprint = value => digest(canonicalJson(value));
const receiptInsert = sql => /^INSERT INTO "control_recovery_[a-f0-9]{24}"\."platform_control_recovery_receipts"\(/.test(sql);

// Object-form rollback remains usable after timeout/cancellation. A destroyed
// client is forwarded faithfully; fixture cleanup uses the separate raw pool.
function checkedPool(raw, signal) {
  const checkpoint = () => signal.throwIfAborted();
  return {
    query(...args) { checkpoint(); return raw.query(...args); },
    async connect() {
      checkpoint(); const db = await raw.connect();
      return { query(input, ...rest) {
        if ((typeof input === 'string' ? input : input.text) !== 'ROLLBACK') checkpoint();
        return db.query(input, ...rest);
      }, release(destroy) { db.release(destroy); } };
    },
  };
}
function interceptedPool(pool, intercept) {
  return { async connect() {
    const db = await pool.connect();
    return { async query(input, values) {
      const sql = typeof input === 'string' ? input : input.text;
      const result = await db.query(input, values);
      await intercept(sql, result); return result;
    }, release(destroy) { db.release(destroy); } };
  } };
}
async function checkedCase(parent, name, operation) {
  let finished = false;
  await parent.test(name, async () => { await operation(); finished = true; });
  assert.equal(finished, true, 'failed or unfinished case cannot continue to a success report');
}
async function rows(pool, schema, name) {
  const result = (await pool.query('SELECT row_to_json(t) AS value FROM ' + fixtureIdentifier(schema, 'schema') + '.' + fixtureIdentifier(name) + ' t LIMIT 1001')).rows.map(row => row.value);
  assert.ok(result.length <= 1000, 'fixture rows remain bounded');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1024 * 1024, 'fixture bytes remain bounded');
  return result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
async function tableFingerprints(pool, schema, names = ALL) {
  const result = {};
  for (const name of names) {
    const data = await rows(pool, schema, name);
    result[name] = { count: data.length, sha256: fingerprint(data) };
  }
  return result;
}
async function snapshot(pool, schema) {
  const relations = (await pool.query(`SELECT c.relname,c.relkind,c.relpersistence FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p','S') ORDER BY c.relname`, [schema])).rows;
  assert.deepEqual(relations.filter(row => row.relkind !== 'S').map(row => row.relname), ALL);
  assert.ok(relations.every(row => row.relpersistence === 'p'));
  assert.deepEqual(relations.filter(row => row.relkind === 'S').map(row => row.relname), ['platform_identity_audit_id_seq']);
  return { tables: await tableFingerprints(pool, schema), sequence: (await pool.query('SELECT last_value::text,is_called FROM ' + fixtureIdentifier(schema, 'schema') + '.platform_identity_audit_id_seq')).rows[0] };
}
async function preserved(pool, schema) {
  return { tables: await tableFingerprints(pool, schema, ALL.filter(name => !AUTH.includes(name) && !EVENTS.includes(name))),
    sequence: (await pool.query('SELECT last_value::text,is_called FROM ' + fixtureIdentifier(schema, 'schema') + '.platform_identity_audit_id_seq')).rows[0] };
}
async function code(auth, principal, clientId) {
  const verifier = random(), resource = auth.resourceMetadata.resource, redirect = configuration.redirectAllowlist[0];
  const callback = await auth.authorize({ client_id: clientId, redirect_uri: redirect, resource,
    response_type: 'code', state: random(), scope: 'orders:read events:read',
    code_challenge_method: 'S256', code_challenge: pkceChallenge(verifier) }, principal);
  return { grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirect, resource,
    code: new URL(callback).searchParams.get('code'), code_verifier: verifier };
}
function expectedFor(target, config = configuration) {
  return { recoveryId: randomUUID(), policy: CONTROL_RECOVERY_POLICY, target, binding: controlRecoveryBinding(config),
    operatorReference: 'synthetic-events-operator', authorityReview: { outcome: 'reviewed', reference: 'synthetic-events-review',
      evidenceSha256: digest('synthetic-only-no-live-authority-review') },
    coldFence: { reference: 'synthetic-events-stopped-fixture', evidenceSha256: digest('no-live-process-fence-proved') } };
}

test('Events archive fault discovery stops at the receipt INSERT, never the earlier owner INSERT', () => {
  const schema = 'control_recovery_' + 'a'.repeat(24);
  assert.equal(receiptInsert(`INSERT INTO "${schema}"."event_owner_epochs"(owner_id) SELECT owner_id FROM source`), false);
  assert.equal(receiptInsert(`INSERT INTO "${schema}"."platform_control_recovery_receipts"(recovery_id,receipt) VALUES($1,$2)`), true);
});

test('actual Events archive preparation fences storage, preserves history and requires explicit new subscription; activation remains unsupported', {
  skip: process.env.TEST_CONTROL_EVENTS_RECOVERY_SAFETY !== '1', timeout: 180000,
}, async t => {
  const database = fixtureDatabase(process.env.IDENTITY_TEST_DATABASE_URL, process.env);
  const bin = process.env.TEST_CONTROL_RECOVERY_PG_BIN;
  const root = await mkdtemp(join(tmpdir(), 'onlinu-events-recovery-safety-'));
  const environment = clientEnvironment(root, database), nonce = randomBytes(12).toString('hex');
  const schema = 'control_recovery_' + nonce, marker = 'onlinu-control-recovery:' + randomUUID();
  const targetName = 'control_recovery_restore_' + nonce;
  let admin, source, target, owner, schemaOwner, sourceClosed = false, report;
  const options = connectionString => ({ connectionString, max: 5, connectionTimeoutMillis: 5000,
    statement_timeout: 5000, query_timeout: 8000, idleTimeoutMillis: 1000, options: '-c timezone=UTC' });
  function pool(config) {
    const raw = new pg.Pool(config);
    return { ...checkedPool(raw, t.signal), cleanupQuery: (...args) => raw.query(...args), end: () => boundedCleanup(() => raw.end()) };
  }
  const sourcePool = () => pool({ ...options(database.href), options: '-c timezone=UTC -c search_path=' + schema });
  let outbound = 0, exchanges = 0, challenges = 0, deliveries = 0;
  t.mock.method(globalThis, 'fetch', async () => { outbound++; throw new Error('external_request_forbidden'); });
  const encryptionKey = randomBytes(32), flows = new Map();
  const adapter = { async authorizationUrl(args) { flows.set(args.state, args); return configuration.oidc.issuer + 'authorize?state=' + args.state; },
    async exchange({ callbackUrl, nonce }) {
      exchanges++; const flow = flows.get(new URL(callbackUrl).searchParams.get('state'));
      assert.equal(flow.nonce, nonce);
      return { iss: configuration.oidc.issuer, aud: configuration.oidc.clientId, sub: flow.subject, nonce };
    } };
  const appConfig = { ...configuration, csrfKey: randomBytes(32).toString('base64'), oidc: { ...configuration.oidc, clientSecret: random() } };
  async function application(pool, initializeEvents = false) {
    // The control plane has no Events configuration, signing key, listener or
    // timer. The separate directly-called Events object uses simulated transport.
    const app = await createControlPlane({ ...appConfig, pool }, { oidcClientAdapter: adapter });
    let events;
    const auth = createAuth({ pool, baseUrl: configuration.baseUrl, redirectAllowlist: configuration.redirectAllowlist,
      cookieName: '__Host-platform_session', csrfKey: appConfig.csrfKey, allowSyntheticAuthorization: false,
      principalResolver: app.directory.resolve, onGrantRevoked: (id, transaction) => events.revokeAll(id, transaction) });
    await auth.init();
    events = createEvents({ pool, encryptionKey, authorizeGrant: auth.authorizeEventGrant,
      authorizeOrder: async (identity, args) => {
        assert.ok(await app.directory.resolve(identity.id));
        assert.equal(args.tenantId, 'events-safety');
        assert.equal(args.orderId, 'synthetic-order');
        return { id: args.orderId };
      }, webhookFetch: async (_url, request) => {
        const body = JSON.parse(request.body);
        if (body.type === 'verification') challenges++; else deliveries++;
        return { ok: true, status: 200, json: async () => ({ challenge: body.challenge }) };
      } });
    if (initializeEvents) {
      await events.init();
      // Only schema initialization; neither ingestion nor tick is called.
      await createCoreEventWorker({ pool, events, resolvePrincipal: app.directory.resolve,
        orderClient: { events: async () => { throw new Error('business_provider_forbidden'); } } }).init();
    }
    return { ...app, auth, events };
  }
  async function begin(app, subject) {
    const flow = await app.login.begin('/manage'), state = new URL(flow.authorizationUrl).searchParams.get('state');
    flows.get(state).subject = subject;
    return { callback: configuration.baseUrl + '/auth/callback?code=synthetic&state=' + state, cookie: flow.bindingCookie };
  }
  async function login(app, subject) { const flow = await begin(app, subject); return app.login.complete(flow.callback, flow.cookie); }
  const event = (id, ownerId, occurredAt = new Date().toISOString()) => ({ eventId: id, ownerId, tenantId: 'events-safety',
    orderId: 'synthetic-order', status: 'accepted', paymentStatus: 'paid', version: 2, occurredAt });
  try {
    const clientVersion = await verifyClients(bin, environment, t.signal);
    admin = pool(options(database.href));
    const serverVersion = Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num);
    assert.ok([16, 17].includes(Math.floor(serverVersion / 10000)) && +clientVersion.split('.')[0] >= Math.floor(serverVersion / 10000));
    schemaOwner = await createSourceSchema(admin, schema, marker);
    source = sourcePool(); let app = await application(source, true);
    const owners = {};
    for (const kind of ['family', 'session']) {
      const identity = await login(app, 'synthetic-events-' + kind);
      owners[kind] = { id: identity.principalId, role: 'customer' };
    }
    await source.query('UPDATE platform_identities SET platform_admin=TRUE WHERE id=$1', [owners.family.id]);
    await app.directory.createTenant(owners.family.id, { id: 'events-safety', name: 'Synthetic Events recovery fixture', ownerId: owners.family.id });
    await app.directory.setTenantStatus(owners.family.id, 'events-safety', { status: 'active', expectedVersion: 1 });
    const origins = {}, inputs = {}, subscriptions = {}, clients = {};
    for (const kind of ['family', 'session']) {
      clients[kind] = await app.auth.register({ redirect_uris: configuration.redirectAllowlist,
        ...(kind === 'family' ? { grant_types: ['authorization_code', 'refresh_token'] } : {}) });
      const tokens = await app.auth.exchange(await code(app.auth, owners[kind], clients[kind].client_id));
      origins[kind] = { ...tokens, principal: await app.auth.authenticate(bearer(tokens.access_token), { bearerOnly: true }) };
      assert.equal(origins[kind].principal.eventGrant.kind, kind);
      inputs[kind] = { name: 'order.status_changed', arguments: { tenantId: 'events-safety', orderId: 'synthetic-order' },
        delivery: { mode: 'webhook', url: 'https://receiver.events-safety.example.invalid/' + kind,
          secret: 'whsec_' + randomBytes(32).toString('base64') } };
      subscriptions[kind] = await app.events.subscribe(origins[kind].principal, inputs[kind]);
      // A prior successful delivery, terminal/error history and two pending
      // deliveries distinguish selective cancellation from history rewriting.
      await app.events.enqueue(event('history-delivered-' + kind, owners[kind].id));
      assert.equal((await app.events.dispatchOnce()).delivered, 1);
      await app.events.enqueue(event('history-terminal-' + kind, owners[kind].id));
      await source.query("UPDATE event_deliveries SET status='terminal',attempts=5,last_status=400,finished_at=now() WHERE event_id=$1", ['history-terminal-' + kind]);
      await source.query('INSERT INTO platform_core_event_cursors(owner_id,tenant_id,sequence) VALUES($1,$2,$3)', [owners[kind].id, 'events-safety', kind === 'family' ? 41 : 73]);
    }
    // Queue only after each owner's successful delivery was observed, so a due
    // delivery belonging to the first owner cannot consume the second's probe.
    for (const kind of ['family', 'session']) for (let n = 1; n <= 2; n++) {
      assert.equal((await app.events.enqueue(event('pending-' + kind + '-' + n, owners[kind].id))).enqueued, 1);
    }
    const inactiveInput = { ...inputs.family, delivery: { ...inputs.family.delivery,
      url: 'https://receiver.events-safety.example.invalid/already-inactive' } };
    const inactiveSubscription = await app.events.subscribe(origins.family.principal, inactiveInput);
    const { secret: inactiveSecret, ...inactiveDelivery } = inactiveInput.delivery;
    await app.events.unsubscribe(origins.family.principal, { ...inactiveInput, delivery: inactiveDelivery });
    assert.equal((await source.query('SELECT active FROM event_subscriptions WHERE id=$1', [inactiveSubscription.id])).rows[0].active, false);
    // Missing rows must be inserted before the fence. Include owners known only
    // by cache, and an existing epoch with no subscription, to cover every union.
    await source.query('DELETE FROM event_owner_epochs WHERE owner_id=$1', [owners.session.id]);
    await source.query('INSERT INTO event_owner_epochs(owner_id,epoch) VALUES($1,9)', ['synthetic-epoch-only']);
    await source.query('INSERT INTO event_callback_verifications(owner_id,callback_url,secret_hash,verified_until) VALUES($1,$2,$3,now()+interval \'5 minutes\')',
      ['synthetic-cache-only', 'https://receiver.events-safety.example.invalid/cache-only', digest(random())]);
    const oldBrowser = await app.auth.issue(owners.family.id, undefined, { kind: 'browser' });
    const pendingCode = await code(app.auth, owners.family, clients.family.client_id);
    const pendingLogin = await begin(app, 'synthetic-events-family');
    const t0 = await snapshot(source, schema);
    assert.equal(t0.tables.event_callback_verifications.count, 4);
    assert.equal(t0.tables.event_owner_epochs.count, 2);
    await source.end(); sourceClosed = true;
    const archivePath = join(root, 'synthetic-events-safety.pgdump');
    const bytes = await clientCommand(bin, 'pg_dump', [...clientArguments(database), '--format=custom', '--no-owner', '--no-acl', '--strict-names', '--schema=' + schema], environment, { limit: ARCHIVE_LIMIT, signal: t.signal });
    const archive = archiveFingerprint(bytes); await writeFile(archivePath, bytes, { flag: 'wx', mode: 0o600 });
    source = sourcePool(); sourceClosed = false; app = await application(source);
    for (const kind of ['family', 'session']) {
      assert.equal((await source.query('SELECT 1 FROM event_callback_verifications WHERE owner_id=$1', [owners[kind].id])).rowCount, kind === 'family' ? 2 : 1);
      await app.auth.revoke(origins[kind].access_token);
      assert.equal((await source.query('SELECT 1 FROM event_callback_verifications WHERE owner_id=$1', [owners[kind].id])).rowCount, 0, 'T1 OAuth revocation really deletes owner verification cache');
      assert.equal(await app.auth.authenticate(bearer(origins[kind].access_token), { bearerOnly: true }), null);
    }
    await app.auth.revoke(oldBrowser.accessToken);
    assert.equal((await source.query("SELECT 1 FROM event_deliveries WHERE status='pending'")).rowCount, 0);
    const t1 = await snapshot(source, schema); assert.notEqual(fingerprint(t1), fingerprint(t0));
    await source.end(); sourceClosed = true;
    await createRestoreDatabase(admin, targetName, marker, value => { owner = value; });
    await verifyRestoreOwner(admin, owner);
    const targetDatabase = new URL(database); targetDatabase.pathname = '/' + targetName;
    await clientCommand(bin, 'pg_restore', [...clientArguments(targetDatabase), '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', archivePath], environment, { signal: t.signal });
    target = pool({ ...options(targetDatabase.href), options: '-c timezone=UTC -c search_path=' + schema });
    assert.deepEqual(await snapshot(target, schema), t0);
    const recovered = await application(target);
    for (const kind of ['family', 'session']) {
      assert.ok(await recovered.auth.authenticate(bearer(origins[kind].access_token), { bearerOnly: true }), 'T0 restore revives T1-revoked authority before preparation');
      await recovered.auth.authorizeEventGrant(origins[kind].principal);
      assert.equal((await target.query('SELECT 1 FROM event_callback_verifications WHERE owner_id=$1 AND verified_until>now()', [owners[kind].id])).rowCount, kind === 'family' ? 2 : 1);
      assert.equal((await target.query('SELECT 1 FROM event_subscriptions WHERE owner_id=$1 AND active', [owners[kind].id])).rowCount, 1);
    }
    assert.ok(await recovered.auth.authenticate(browser(oldBrowser.accessToken), { cookieOnly: true }));
    const catalog = (await target.query(`SELECT d.oid AS database_oid,d.datdba AS database_owner_oid,n.oid AS schema_oid,n.nspowner AS schema_owner_oid
      FROM pg_database d CROSS JOIN pg_namespace n WHERE d.datname=current_database() AND n.nspname=$1`, [schema])).rows[0];
    const expected = expectedFor({ database: targetName, databaseOid: catalog.database_oid, databaseOwnerOid: catalog.database_owner_oid,
      marker, schema, schemaOid: catalog.schema_oid, schemaOwnerOid: catalog.schema_owner_oid });
    const args = { pool: target, expectation: expected, configuration, signal: t.signal };
    const before = await tableFingerprints(target, schema), preservedBefore = await preserved(target, schema);
    const priorEpochs = await rows(target, schema, 'event_owner_epochs');
    const priorSubscriptions = await rows(target, schema, 'event_subscriptions');
    const priorDeliveries = await rows(target, schema, 'event_deliveries');
    const priorCache = await rows(target, schema, 'event_callback_verifications');
    const noReceipt = async () => assert.equal((await target.query('SELECT to_regclass($1) AS relation', [schema + '.platform_control_recovery_receipts'])).rows[0].relation, null);
    const unchanged = async () => {
      assert.deepEqual(await tableFingerprints(target, schema), before);
      assert.deepEqual(await preserved(target, schema), preservedBefore); await noReceipt();
    };
    await checkedCase(t, 'absent declaration, missing/partial and unsupported Events relation sets fail closed before mutation', async () => {
      const absentConfig = { ...configuration, eventsStorage: 'absent' };
      const absent = { ...args, configuration: absentConfig, expectation: expectedFor(expected.target, absentConfig) };
      for (const action of [prepareControlRecovery, verifyControlRecoveryReceipt]) await assert.rejects(action(absent), /recovery_events_storage_mismatch/);
      await unchanged();
      const renamed = [];
      try {
        for (const name of EVENTS) {
          await target.query('ALTER TABLE ' + fixtureIdentifier(name) + ' RENAME TO ' + fixtureIdentifier('hidden_' + name)); renamed.push(name);
          for (const action of [prepareControlRecovery, verifyControlRecoveryReceipt]) await assert.rejects(action(args), /recovery_events_storage_mismatch/);
          if (renamed.length !== EVENTS.length) for (const action of [prepareControlRecovery, verifyControlRecoveryReceipt]) await assert.rejects(action(absent), /recovery_events_storage_mismatch/);
          await noReceipt();
        }
      } finally {
        for (const name of renamed.reverse()) await target.query('ALTER TABLE ' + fixtureIdentifier('hidden_' + name) + ' RENAME TO ' + fixtureIdentifier(name));
      }
      await unchanged();
      for (const definition of ['CREATE TABLE event_fixture_unexpected(id integer)', 'CREATE UNLOGGED TABLE event_fixture_unexpected(id integer)',
        'CREATE VIEW event_fixture_unexpected AS SELECT 1 AS id']) {
        try {
          await target.query(definition);
          for (const action of [prepareControlRecovery, verifyControlRecoveryReceipt]) await assert.rejects(action(args), /recovery_events_storage_mismatch/);
          await noReceipt();
        } finally { await target.query('DROP ' + (definition.includes('VIEW') ? 'VIEW' : 'TABLE') + ' event_fixture_unexpected'); }
        await unchanged();
      }
      try {
        await target.query('ALTER TABLE event_callback_verifications SET UNLOGGED');
        for (const action of [prepareControlRecovery, verifyControlRecoveryReceipt]) await assert.rejects(action(args), /recovery_events_storage_mismatch/);
      } finally { await target.query('ALTER TABLE event_callback_verifications SET LOGGED'); }
      await unchanged();
    });
    await checkedCase(t, 'inherited descendants, row security, rewrite rules and user triggers cannot widen or intercept fencing', async () => {
      const changes = [
        ['CREATE TABLE hidden_epoch_child () INHERITS (event_owner_epochs)', 'DROP TABLE hidden_epoch_child'],
        ['ALTER TABLE event_owner_epochs ENABLE ROW LEVEL SECURITY', 'ALTER TABLE event_owner_epochs DISABLE ROW LEVEL SECURITY'],
        ['ALTER TABLE event_owner_epochs FORCE ROW LEVEL SECURITY', 'ALTER TABLE event_owner_epochs NO FORCE ROW LEVEL SECURITY'],
        ['CREATE RULE synthetic_events_skip AS ON UPDATE TO event_owner_epochs DO INSTEAD NOTHING', 'DROP RULE synthetic_events_skip ON event_owner_epochs'],
        [`CREATE FUNCTION synthetic_events_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_trigger_must_never_run'; END $$;
          CREATE TRIGGER synthetic_events_trigger BEFORE UPDATE ON event_owner_epochs FOR EACH ROW EXECUTE FUNCTION synthetic_events_trigger()`,
        'DROP TRIGGER synthetic_events_trigger ON event_owner_epochs; DROP FUNCTION synthetic_events_trigger()'],
      ];
      for (const [setup, teardown] of changes) {
        try {
          await target.query(setup);
          for (const action of [prepareControlRecovery, verifyControlRecoveryReceipt]) await assert.rejects(action(args), /recovery_events_storage_mismatch/);
          await noReceipt();
        } finally { await target.query(teardown); }
        await unchanged();
      }
    });
    let statements = [];
    await checkedCase(t, 'fault after every statement through final receipt insertion rolls back all auth, Events and DDL', async () => {
      await assert.rejects(prepareControlRecovery({ ...args, pool: interceptedPool(target, sql => {
        statements.push(sql); if (receiptInsert(sql)) throw new Error('synthetic_failure');
      }) }), /recovery_operation_failed_closed/);
      statements = statements.filter(sql => sql !== 'ROLLBACK');
      assert.equal(receiptInsert(statements.at(-1)), true);
      assert.ok(statements.some(sql => /^INSERT INTO .*"event_owner_epochs"/.test(sql)), 'owner insert is covered before final receipt insertion');
      assert.equal(statements.filter(sql => /^UPDATE .*"event_/.test(sql)).length, 4);
      await unchanged();
      for (let at = 1; at <= statements.length; at++) {
        let n = 0;
        await assert.rejects(prepareControlRecovery({ ...args, pool: interceptedPool(target, sql => {
          if (sql !== 'ROLLBACK' && ++n === at) throw new Error('synthetic_failure');
        }) }), /recovery_operation_failed_closed/);
        assert.equal(n, at); await unchanged();
      }
      const controller = new AbortController();
      await assert.rejects(prepareControlRecovery({ ...args, signal: controller.signal, pool: interceptedPool(target, sql => {
        if (/^UPDATE .*"event_subscriptions"/.test(sql)) controller.abort();
      }) }), /recovery_cancelled/);
      await unchanged();
    });
    await checkedCase(t, 'malformed installed schema and bigint fence overflows cannot partially invalidate authority', async () => {
      try {
        await target.query('ALTER TABLE event_subscriptions RENAME COLUMN generation TO malformed_generation');
        const malformed = await tableFingerprints(target, schema);
        await assert.rejects(prepareControlRecovery(args), /recovery_operation_failed_closed/);
        assert.deepEqual(await tableFingerprints(target, schema), malformed); await noReceipt();
      } finally { await target.query('ALTER TABLE event_subscriptions RENAME COLUMN malformed_generation TO generation'); }
      await unchanged();
      for (const [table, column, key, id] of [
        ['event_owner_epochs', 'epoch', 'owner_id', owners.family.id],
        ['event_subscriptions', 'generation', 'id', subscriptions.family.id],
      ]) {
        const original = (await target.query(`SELECT ${column}::text AS value FROM ${table} WHERE ${key}=$1`, [id])).rows[0].value;
        try {
          await target.query(`UPDATE ${table} SET ${column}=9223372036854775807 WHERE ${key}=$1`, [id]);
          const overflowing = await tableFingerprints(target, schema);
          await assert.rejects(prepareControlRecovery(args), /recovery_operation_failed_closed/);
          assert.deepEqual(await tableFingerprints(target, schema), overflowing); await noReceipt();
        } finally { await target.query(`UPDATE ${table} SET ${column}=$2 WHERE ${key}=$1`, [id, original]); }
        await unchanged();
      }
    });
    let receipt;
    await checkedCase(t, 'one atomic preparation fences every owner/generation/cache and pending delivery while preserving historical evidence', async () => {
      const challengesBefore = challenges, deliveriesBefore = deliveries;
      // A lost acknowledgment must stay closed, but retry must verify the single
      // committed receipt without fencing again.
      await assert.rejects(prepareControlRecovery({ ...args, pool: interceptedPool(target, sql => {
        if (sql === 'COMMIT') throw new Error('synthetic_lost_commit_acknowledgment');
      }) }), /recovery_commit_uncertain/);
      receipt = await prepareControlRecovery(args);
      assert.equal(receipt.eventsCoverage, 'fenced-storage-only');
      assert.equal(receipt.scope, 'authentication-events-preparation-only');
      for (const field of ['servingAuthorized', 'eventsSupported', 'processFencingVerified', 'authorityReconciliationVerified']) assert.equal(receipt[field], false);
      for (const name of AUTH) assert.equal(receipt.counts[name], before[name].count);
      assert.equal(receipt.counts.event_owner_epochs_inserted, 2);
      assert.equal(receipt.counts.event_owner_epochs, priorEpochs.length + 2);
      assert.equal(receipt.counts.event_subscriptions, priorSubscriptions.length);
      assert.equal(receipt.counts.event_deliveries, priorDeliveries.filter(row => row.status === 'pending').length);
      assert.equal(receipt.counts.event_callback_verifications, priorCache.length);
      const epochs = await rows(target, schema, 'event_owner_epochs');
      for (const row of epochs) assert.equal(String(row.epoch), String(BigInt(priorEpochs.find(before => before.owner_id === row.owner_id)?.epoch ?? 0) + 1n));
      assert.equal(epochs.length, 4);
      const afterSubscriptions = await rows(target, schema, 'event_subscriptions');
      for (const row of afterSubscriptions) {
        const original = priorSubscriptions.find(value => value.id === row.id);
        assert.equal(row.active, false); assert.equal(BigInt(row.generation), BigInt(original.generation) + 1n);
        const { active, generation, updated_at, ...kept } = row;
        const { active: oldActive, generation: oldGeneration, updated_at: oldUpdatedAt, ...oldKept } = original;
        assert.equal(fingerprint(kept), fingerprint(oldKept), 'owner, original grant, URL, secrets and history remain intact');
      }
      const afterDeliveries = await rows(target, schema, 'event_deliveries');
      for (const row of afterDeliveries) {
        const original = priorDeliveries.find(value => value.subscription_id === row.subscription_id && value.event_id === row.event_id);
        if (original.status !== 'pending') assert.equal(fingerprint(row), fingerprint(original), 'terminal history is unchanged');
        else {
          assert.equal(row.status, 'revoked');
          assert.equal(row.finished_at, afterSubscriptions[0].updated_at, 'all fences share the transaction timestamp');
          const { status, finished_at, ...kept } = row;
          const { status: oldStatus, finished_at: oldFinishedAt, ...oldKept } = original;
          assert.equal(fingerprint(kept), fingerprint(oldKept), 'body, generation, attempts and timing history are preserved');
        }
      }
      for (const row of afterSubscriptions) assert.equal(row.updated_at, afterSubscriptions[0].updated_at);
      for (const row of await rows(target, schema, 'event_callback_verifications')) {
        const original = priorCache.find(value => value.owner_id === row.owner_id && value.callback_url === row.callback_url && value.secret_hash === row.secret_hash);
        assert.ok(Number.isFinite(Date.parse(row.verified_until)) && Date.parse(row.verified_until) <= Date.now());
        const { verified_until, ...kept } = row, { verified_until: oldExpiry, ...oldKept } = original;
        assert.equal(fingerprint(kept), fingerprint(oldKept));
      }
      assert.deepEqual(await preserved(target, schema), preservedBefore);
      assert.deepEqual(await verifyControlRecoveryReceipt(args), receipt);
      assert.equal(challenges, challengesBefore); assert.equal(deliveries, deliveriesBefore);
    });
    await checkedCase(t, 'restored authority is rejected before any callback or provider exchange', async () => {
      const frozen = await tableFingerprints(target, schema), previousExchanges = exchanges;
      const previousChallenges = challenges, previousDeliveries = deliveries;
      assert.equal(await recovered.auth.authenticate(browser(oldBrowser.accessToken), { cookieOnly: true }), null);
      for (const kind of ['family', 'session']) {
        assert.equal(await recovered.auth.authenticate(bearer(origins[kind].access_token), { bearerOnly: true }), null);
        await deniedGrant(recovered.auth.authorizeEventGrant(origins[kind].principal));
        await deniedGrant(recovered.events.subscribe(origins[kind].principal, inputs[kind]));
        assert.equal((await recovered.events.enqueue(event('post-reset-' + kind, owners[kind].id))).enqueued, 0);
      }
      await assert.rejects(recovered.auth.exchange({ grant_type: 'refresh_token', client_id: clients.family.client_id,
        refresh_token: origins.family.refresh_token, resource: recovered.auth.resourceMetadata.resource }), { code: 'invalid_grant' });
      await assert.rejects(recovered.auth.exchange(pendingCode), { code: 'invalid_grant' });
      await assert.rejects(recovered.login.complete(pendingLogin.callback, pendingLogin.cookie));
      assert.equal((await recovered.events.dispatchOnce()).attempted, 0);
      assert.equal(exchanges, previousExchanges); assert.equal(challenges, previousChallenges); assert.equal(deliveries, previousDeliveries);
      assert.deepEqual(await tableFingerprints(target, schema), frozen);
    });
    await checkedCase(t, 'fresh verified login and consent stay inert until explicit same-URL/secret subscription verifies anew', async () => {
      const fresh = {}, beforeEvents = await tableFingerprints(target, schema, EVENTS);
      const previousChallenges = challenges, previousDeliveries = deliveries;
      for (const kind of ['family', 'session']) {
        const identity = await login(recovered, 'synthetic-events-' + kind);
        assert.equal(identity.principalId, owners[kind].id);
        const freshBrowser = await recovered.auth.issue(identity.principalId, undefined, { kind: 'browser' });
        assert.ok(await recovered.auth.authenticate(browser(freshBrowser.accessToken), { cookieOnly: true }));
        const tokens = await recovered.auth.exchange(await code(recovered.auth, owners[kind], clients[kind].client_id));
        fresh[kind] = { ...tokens, browserAccessToken: freshBrowser.accessToken,
          principal: await recovered.auth.authenticate(bearer(tokens.access_token), { bearerOnly: true }) };
        assert.ok(fresh[kind].principal);
      }
      assert.deepEqual(await tableFingerprints(target, schema, EVENTS), beforeEvents, 'new authentication alone cannot reactivate Events');
      for (const kind of ['family', 'session']) {
        assert.equal((await recovered.events.enqueue(event('fresh-consent-without-subscribe-' + kind, owners[kind].id))).enqueued, 0);
      }
      assert.equal((await recovered.events.dispatchOnce()).attempted, 0);
      assert.equal(challenges, previousChallenges); assert.equal(deliveries, previousDeliveries);
      for (const kind of ['family', 'session']) {
        const beforeRow = (await rows(target, schema, 'event_subscriptions')).find(row => row.id === subscriptions[kind].id);
        const next = await recovered.events.subscribe(fresh[kind].principal, inputs[kind]);
        assert.equal(next.id, subscriptions[kind].id, 'explicit re-subscribe uses identical owner, URL, arguments and secret');
        const afterRow = (await rows(target, schema, 'event_subscriptions')).find(row => row.id === next.id);
        assert.equal(BigInt(afterRow.generation), BigInt(beforeRow.generation) + 1n); assert.equal(afterRow.active, true);
        assert.equal(fingerprint(afterRow.principal.eventGrant), fingerprint(fresh[kind].principal.eventGrant));
        assert.equal(fingerprint(afterRow.secret_hash), fingerprint(beforeRow.secret_hash));
        assert.equal(challenges, previousChallenges + (kind === 'family' ? 1 : 2), 'restored cache cannot bypass fresh callback verification');
        assert.equal((await recovered.events.dispatchOnce()).attempted, 0, 'old queues remain revoked after new consent and subscribe');
        assert.equal(deliveries, previousDeliveries);
        const original = priorDeliveries.find(row => row.subscription_id === next.id && row.status === 'pending');
        // A late enqueue holding the archived generation is modeled directly;
        // existing event-grants tests cover the real concurrent enqueue barrier.
        await target.query(`INSERT INTO event_deliveries(subscription_id,event_id,body,next_attempt_at,created_at,subscription_generation)
          VALUES($1,$2,$3,now()-interval '1 second',now(),$4)`, [next.id, 'late-old-generation-' + kind, original.body, original.subscription_generation]);
        assert.equal((await recovered.events.dispatchOnce()).revoked, 1);
        assert.equal(deliveries, previousDeliveries, 'stale data cannot borrow the newly bound origin');
        assert.equal((await target.query('SELECT active FROM event_subscriptions WHERE id=$1', [next.id])).rows[0].active, true);
        assert.equal((await recovered.events.enqueue(event('historical-new-id-' + kind, owners[kind].id, '2000-01-01T00:00:00.000Z'))).enqueued, 0, 'historical replay is not reopened');
        await deniedGrant(recovered.events.subscribe(origins[kind].principal, inputs[kind]));
      }
      for (const kind of ['family', 'session']) {
        assert.equal((await recovered.events.enqueue(event('fresh-current-generation-' + kind, owners[kind].id))).enqueued, 1);
        assert.equal((await recovered.events.dispatchOnce()).delivered, 1, 'only new data under the explicit fresh binding can dispatch');
      }
      const afterFresh = await tableFingerprints(target, schema);
      const mutations = [];
      for (const action of [prepareControlRecovery, verifyControlRecoveryReceipt]) assert.deepEqual(await action({ ...args, pool: interceptedPool(target, sql => {
        if (/^(INSERT|UPDATE|DELETE|TRUNCATE)\b/.test(sql)) mutations.push(sql.split(' ')[0]);
      }) }), receipt);
      assert.deepEqual(mutations, []); assert.deepEqual(await tableFingerprints(target, schema), afterFresh);
      for (const kind of ['family', 'session']) {
        assert.ok(await recovered.auth.authenticate(bearer(fresh[kind].access_token), { bearerOnly: true }));
        assert.ok(await recovered.auth.authenticate(browser(fresh[kind].browserAccessToken), { cookieOnly: true }));
      }
      assert.deepEqual(await preserved(target, schema), preservedBefore, 'business cursors and identity/audit history remain unchanged');
      try {
        await target.query('ALTER TABLE event_callback_verifications RENAME TO hidden_event_callback_verifications');
        for (const action of [prepareControlRecovery, verifyControlRecoveryReceipt]) await assert.rejects(action(args), /recovery_events_storage_mismatch/);
      } finally { await target.query('ALTER TABLE hidden_event_callback_verifications RENAME TO event_callback_verifications'); }
      assert.deepEqual(await tableFingerprints(target, schema), afterFresh, 'a matching receipt cannot hide changed Events storage');
      const oldReceipt = structuredClone(receipt); oldReceipt.implementation = 'control-recovery-v1'; oldReceipt.expectation.policy = 'cold-authentication-preparation-v1';
      try {
        await target.query('UPDATE platform_control_recovery_receipts SET receipt=$2 WHERE recovery_id=$1', [expected.recoveryId, JSON.stringify(oldReceipt)]);
        for (const action of [prepareControlRecovery, verifyControlRecoveryReceipt]) await assert.rejects(action(args), /recovery_receipt_invalid/);
      } finally { await target.query('UPDATE platform_control_recovery_receipts SET receipt=$2 WHERE recovery_id=$1', [expected.recoveryId, JSON.stringify(receipt)]); }
      assert.deepEqual(await tableFingerprints(target, schema), afterFresh);
    });
    source = sourcePool(); sourceClosed = false;
    assert.deepEqual(await snapshot(source, schema), t1, 'newer T1 source remains unchanged');
    assert.deepEqual(archiveFingerprint(await readFile(archivePath)), archive);
    assert.equal(outbound, 0); await verifyRestoreOwner(admin, owner);
    report = { scope: 'synthetic-authentication-events-storage-preparation-only', clientVersion, serverVersion,
      preparationStatementsFaultTested: statements.length, sourceT1Unchanged: true, archiveUnchanged: true,
      callbackCacheRevocationAndRestorationObserved: true, freshSameSecretChallengeRequired: true,
      preservedBusinessCursorsAndHistory: true, externalRequests: outbound, simulatedProviderExchanges: exchanges,
      simulatedCallbackChallenges: challenges, simulatedDeliveries: deliveries, eventsActivationVerified: false,
      dexRecoveryVerified: false, processFencingVerified: false, servingAuthorized: false };
  } finally {
    const cleanup = { query: (...args) => admin.cleanupQuery(...args) };
    await cleanupAll([
      async () => { if (target) await target.end(); },
      async () => { if (source && !sourceClosed) await source.end(); },
      async () => { if (owner) {
        await verifyRestoreOwner(cleanup, owner);
        await cleanup.query('DROP DATABASE ' + fixtureIdentifier(owner.name, 'database'));
        assert.equal((await cleanup.query('SELECT oid FROM pg_database WHERE datname=$1', [owner.name])).rows.length, 0);
      } },
      async () => { if (schemaOwner) {
        const row = (await cleanup.query("SELECT oid,obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname=$1", [schema])).rows[0];
        assert.ok(row && row.oid === schemaOwner && row.marker === marker);
        await cleanup.query('DROP SCHEMA ' + fixtureIdentifier(schema, 'schema') + ' CASCADE');
        assert.equal((await cleanup.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [schema])).rows.length, 0);
      } },
      async () => { if (admin) await admin.end(); },
      () => rm(root, { recursive: true }),
    ]);
  }
  if (report) t.diagnostic(JSON.stringify({ ...report, cleanupVerified: true }));
});
