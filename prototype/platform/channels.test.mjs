import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createChannels } from './channels.mjs';

const merchantA = { id: 'merchant-a', role: 'merchant', tenantIds: ['demo-a'] };
const merchantB = { id: 'merchant-b', role: 'merchant', tenantIds: ['demo-b'] };
const updateInput = (overrides = {}) => ({ enabled: true, connectionMode: 'qr', expectedVersion: 1, ...overrides });
const rejects = (promise, status, code) => assert.rejects(promise, error => error.status === status && error.code === code);

test('channel configuration requires exact merchant membership before touching a database', async () => {
  const channels = createChannels({ pool: {
    query: () => assert.fail('Unauthorized read'), connect: () => assert.fail('Unauthorized write'),
  }, tenants: ['demo-a', 'demo-b'] });
  for (const method of [() => channels.get(null, 'demo-a'), () => channels.update(null, 'demo-a', updateInput())]) {
    await rejects(method(), 401, 'unauthorized');
  }
  const principals = [merchantB, { id: 'customer-alice', role: 'customer', tenantIds: ['demo-a'] },
    { id: 'service', role: 'service', tenantIds: ['demo-a'] },
    { ...merchantA, tenantIds: 'demo-a' }, { ...merchantA, tenantIds: ['demo-ab'] },
    { role: 'merchant', tenantIds: ['demo-a'] }];
  for (const principal of principals) {
    await rejects(channels.get(principal, 'demo-a'), 403, 'forbidden');
    await rejects(channels.update(principal, 'demo-a', updateInput()), 403, 'forbidden');
  }
  const unknown = { ...merchantA, tenantIds: ['missing'] };
  await rejects(channels.get(unknown, 'missing'), 404, 'restaurant_not_found');
});

test('channel writes accept only boolean, supported mode and current numeric version; never credentials', async () => {
  const channels = createChannels({ pool: { query() {}, connect: () => assert.fail('Invalid write reached database') }, tenants: ['demo-a'] });
  for (const body of [null, [], {}, updateInput({ enabled: 'true' }), updateInput({ connectionMode: 'meta' }),
    updateInput({ connectionMode: 'https://untrusted.example/' }), updateInput({ expectedVersion: '1' }),
    updateInput({ expectedVersion: 0 }), updateInput({ expectedVersion: 1.5 }),
    updateInput({ expectedVersion: Number.MAX_SAFE_INTEGER }), updateInput({ tenantId: 'demo-b' }),
    updateInput({ token: 'must-not-store' }), updateInput({ apiKey: 'must-not-store' }),
    updateInput({ configured: true }), updateInput({ operational: true })]) {
    await rejects(channels.update(merchantA, 'demo-a', body), 400, 'invalid_channel_configuration');
  }
});

test('channel failures redact database messages and configuration cannot silently invent a tenant', async () => {
  const channels = createChannels({ pool: {
    query: async () => { throw new Error('private database host password and SQL details'); },
    connect: async () => { throw new Error('private database connection'); },
  }, tenants: ['demo-a'] });
  await rejects(channels.get(merchantA, 'demo-a'), 503, 'channel_configuration_unavailable');
  await rejects(channels.update(merchantA, 'demo-a', updateInput()), 503, 'channel_configuration_unavailable');
  await rejects(channels.init(), 503, 'channel_configuration_unavailable');
  assert.throws(() => createChannels({ pool: { query() {}, connect() {} }, tenants: ['demo-a', 'demo-a'] }));
  assert.throws(() => createChannels({ pool: { query() {}, connect() {} }, tenants: ['demo-a;DROP TABLE'] }));
});

// This suite refuses arbitrary databases and removes only its randomly named
// schema in the explicitly disposable channels test database.
test('PostgreSQL channel preferences persist with optimistic concurrency and atomic audit', {
  skip: !process.env.CHANNELS_TEST_DATABASE_URL,
}, async t => {
  const url = new URL(process.env.CHANNELS_TEST_DATABASE_URL);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.pathname, '/astracalls_channels_prototype_test', 'Refuse a non-disposable database');
  assert.equal(url.searchParams.has('dbname'), false);
  const schema = `channel_test_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: url.href });
  const pool = new pg.Pool({ connectionString: url.href, options: `-c search_path=${schema}` });
  let created = false;
  try {
    assert.equal((await admin.query('SELECT current_database() AS name')).rows[0].name, 'astracalls_channels_prototype_test');
    await admin.query(`CREATE SCHEMA ${schema}`);
    created = true;
    const channels = createChannels({ pool, tenants: ['demo-a', 'demo-b'] });
    await channels.init();
    await pool.query(`CREATE TABLE untouched_orders(id TEXT PRIMARY KEY,status TEXT NOT NULL);
      INSERT INTO untouched_orders VALUES('existing-order','preparing')`);

    await t.test('defaults are disabled and never claim configured or operational', async () => {
      assert.deepEqual(await channels.get(merchantA, 'demo-a'), {
        tenantId: 'demo-a', version: 1,
        whatsapp: { enabled: false, connectionMode: 'qr', configured: false, operational: false },
        scope: 'synthetic_configuration_only',
      });
      assert.equal((await channels.get(merchantB, 'demo-b')).whatsapp.enabled, false);
      await rejects(channels.update(merchantB, 'demo-a', updateInput()), 403, 'forbidden');
    });

    await t.test('two concurrent saves cannot overwrite each other or duplicate audit', async () => {
      const results = await Promise.allSettled([
        channels.update(merchantA, 'demo-a', updateInput()),
        channels.update(merchantA, 'demo-a', updateInput({ connectionMode: 'cloud_api' })),
      ]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      const rejected = results.find(result => result.status === 'rejected');
      assert.equal(rejected.reason.status, 409);
      assert.equal(rejected.reason.code, 'channel_version_conflict');
      const saved = await channels.get(merchantA, 'demo-a');
      assert.equal(saved.version, 2);
      assert.equal(saved.whatsapp.enabled, true);
      assert.equal(saved.whatsapp.configured, false);
      assert.equal(saved.whatsapp.operational, false);
      assert.equal(saved.scope, 'synthetic_configuration_only');
      const { rows } = await pool.query('SELECT * FROM demo_tenant_channel_audit');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].tenant_id, 'demo-a');
      assert.equal(rows[0].actor_id, 'merchant-a');
      assert.equal(rows[0].action, 'whatsapp_configuration_updated');
      assert.deepEqual(rows[0].before_state, { version: 1, enabled: false, connectionMode: 'qr' });
      assert.deepEqual(rows[0].after_state, { version: 2, enabled: true, connectionMode: saved.whatsapp.connectionMode });
    });

    await t.test('restart preserves saved preference; no-op save creates no extra audit', async () => {
      const restarted = createChannels({ pool, tenants: ['demo-a', 'demo-b'] });
      await restarted.init();
      const saved = await restarted.get(merchantA, 'demo-a');
      assert.equal(saved.version, 2);
      const unchanged = await restarted.update(merchantA, 'demo-a', {
        enabled: saved.whatsapp.enabled, connectionMode: saved.whatsapp.connectionMode, expectedVersion: saved.version,
      });
      assert.deepEqual(unchanged, saved);
      assert.equal((await pool.query('SELECT count(*) AS count FROM demo_tenant_channel_audit')).rows[0].count, '1');
    });

    await t.test('disabling preferences changes neither tenant B nor existing orders', async () => {
      const saved = await channels.get(merchantA, 'demo-a');
      const disabled = await channels.update(merchantA, 'demo-a', {
        enabled: false, connectionMode: saved.whatsapp.connectionMode, expectedVersion: saved.version,
      });
      assert.equal(disabled.version, 3);
      assert.equal(disabled.whatsapp.enabled, false);
      assert.equal((await channels.get(merchantB, 'demo-b')).version, 1);
      assert.deepEqual((await pool.query('SELECT * FROM untouched_orders')).rows, [{ id: 'existing-order', status: 'preparing' }]);
    });

    await t.test('audit failure rolls back preference/version and returns a safe error', async () => {
      await pool.query(`ALTER TABLE demo_tenant_channel_audit
        ADD CONSTRAINT deliberate_test_failure CHECK(false) NOT VALID`);
      await rejects(channels.update(merchantB, 'demo-b', updateInput({ connectionMode: 'cloud_api' })),
        503, 'channel_configuration_unavailable');
      const unchanged = await channels.get(merchantB, 'demo-b');
      assert.equal(unchanged.version, 1);
      assert.equal(unchanged.whatsapp.enabled, false);
      assert.equal(unchanged.whatsapp.connectionMode, 'qr');
      assert.equal((await pool.query('SELECT count(*) AS count FROM demo_tenant_channel_audit')).rows[0].count, '2');
    });
  } finally {
    await pool.end();
    if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
