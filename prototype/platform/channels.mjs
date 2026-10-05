import { problem } from './auth.mjs';

const scope = 'synthetic_configuration_only';
const tenantPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const actorPattern = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const unavailable = () => problem(503, 'channel_configuration_unavailable');

// Configuration groundwork only. No WhatsApp client, merchant keys, checkout,
// live account settings, or order services are dependencies of this module.
// In the synthetic identity model, each assigned merchant represents its owner.
export function createChannels({ pool, tenants }) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function'
    || !Array.isArray(tenants) || tenants.length === 0
    || tenants.some(id => typeof id !== 'string' || !tenantPattern.test(id))
    || new Set(tenants).size !== tenants.length) {
    throw new Error('Invalid channel configuration dependencies');
  }
  const tenantIds = new Set(tenants);

  function authorize(principal, tenantId) {
    if (!principal) throw problem(401, 'unauthorized');
    if (principal.role !== 'merchant' || typeof principal.id !== 'string'
      || !actorPattern.test(principal.id) || !Array.isArray(principal.tenantIds)
      || !principal.tenantIds.includes(tenantId)) throw problem(403, 'forbidden');
    if (!tenantIds.has(tenantId)) throw problem(404, 'restaurant_not_found');
  }

  function input(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 3
      || Object.keys(value).some(key => !['enabled', 'connectionMode', 'expectedVersion'].includes(key))
      || typeof value.enabled !== 'boolean'
      || !['qr', 'cloud_api'].includes(value.connectionMode)
      || !Number.isSafeInteger(value.expectedVersion)
      || value.expectedVersion < 1 || value.expectedVersion >= Number.MAX_SAFE_INTEGER) {
      throw problem(400, 'invalid_channel_configuration');
    }
    return value;
  }

  function snapshot(row) {
    const version = Number(row.version);
    if (!Number.isSafeInteger(version) || version < 1
      || typeof row.whatsapp_enabled !== 'boolean'
      || !['qr', 'cloud_api'].includes(row.connection_mode)) throw unavailable();
    return { version, enabled: row.whatsapp_enabled, connectionMode: row.connection_mode };
  }

  function view(row) {
    const state = snapshot(row);
    return {
      tenantId: row.tenant_id,
      version: state.version,
      whatsapp: {
        enabled: state.enabled,
        connectionMode: state.connectionMode,
        configured: false,
        operational: false,
      },
      scope,
    };
  }

  async function init() {
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(706836454139)');
      await client.query(`
        CREATE TABLE IF NOT EXISTS demo_tenant_channels (
          tenant_id TEXT PRIMARY KEY,
          version BIGINT NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740991),
          whatsapp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
          connection_mode TEXT NOT NULL DEFAULT 'qr' CHECK(connection_mode IN ('qr','cloud_api')),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS demo_tenant_channel_audit (
          id BIGSERIAL PRIMARY KEY,
          tenant_id TEXT NOT NULL REFERENCES demo_tenant_channels(tenant_id),
          actor_id TEXT NOT NULL,
          action TEXT NOT NULL CHECK(action='whatsapp_configuration_updated'),
          before_state JSONB NOT NULL,
          after_state JSONB NOT NULL,
          occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS demo_tenant_channel_audit_tenant
          ON demo_tenant_channel_audit(tenant_id,id);
      `);
      for (const tenantId of tenantIds) {
        await client.query('INSERT INTO demo_tenant_channels(tenant_id) VALUES($1) ON CONFLICT DO NOTHING', [tenantId]);
      }
      await client.query('COMMIT');
    } catch {
      if (client) await client.query('ROLLBACK').catch(() => {});
      throw unavailable();
    } finally { client?.release(); }
  }

  async function get(principal, tenantId) {
    authorize(principal, tenantId);
    try {
      const { rows } = await pool.query('SELECT * FROM demo_tenant_channels WHERE tenant_id=$1', [tenantId]);
      if (!rows[0]) throw unavailable();
      return view(rows[0]);
    } catch { throw unavailable(); }
  }

  async function update(principal, tenantId, values) {
    authorize(principal, tenantId);
    const desired = input(values);
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT * FROM demo_tenant_channels WHERE tenant_id=$1 FOR UPDATE', [tenantId]);
      if (!rows[0]) throw unavailable();
      const before = snapshot(rows[0]);
      if (before.version !== desired.expectedVersion) throw problem(409, 'channel_version_conflict');
      if (before.enabled === desired.enabled && before.connectionMode === desired.connectionMode) {
        await client.query('COMMIT');
        return view(rows[0]);
      }
      const updated = await client.query(`UPDATE demo_tenant_channels
        SET whatsapp_enabled=$2,connection_mode=$3,version=version+1,updated_at=now()
        WHERE tenant_id=$1 AND version=$4 RETURNING *`,
      [tenantId, desired.enabled, desired.connectionMode, desired.expectedVersion]);
      if (updated.rows.length !== 1) throw problem(409, 'channel_version_conflict');
      const after = snapshot(updated.rows[0]);
      await client.query(`INSERT INTO demo_tenant_channel_audit
        (tenant_id,actor_id,action,before_state,after_state)
        VALUES($1,$2,'whatsapp_configuration_updated',$3,$4)`,
      [tenantId, principal.id, JSON.stringify(before), JSON.stringify(after)]);
      await client.query('COMMIT');
      return view(updated.rows[0]);
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      if (error.status === 409 && error.code === 'channel_version_conflict') throw error;
      throw unavailable();
    } finally { client?.release(); }
  }

  return { init, get, update };
}
