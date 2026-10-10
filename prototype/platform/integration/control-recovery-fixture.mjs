// Test-only archive helpers. Never use this module as a production restore tool.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';

const execute = promisify(execFile);
export const ARCHIVE_LIMIT = 4 * 1024 * 1024;
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(code); };

export function fixtureDatabase(value, environment = {}) {
  if (Object.entries(environment).some(([key, value]) => /^PG/i.test(key) && value)) fail('fixture_pg_override');
  let url;
  if (typeof value !== 'string' || value.length > 2048 || /[#\x00-\x20\x7f]/.test(value)) fail('fixture_database_not_allowed');
  try { url = new URL(value); } catch { fail('fixture_database_not_allowed'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' ||
      !/^[a-z_][a-z0-9_]{0,62}$/.test(url.username) || !/^[A-Za-z0-9._~-]{8,128}$/.test(url.password) ||
      url.pathname !== '/astracalls_identity_test' ||
      url.hash || url.search !== '?sslmode=disable' ||
      (url.port && (!/^\d+$/.test(url.port) || +url.port < 1024 || +url.port > 65535))) fail('fixture_database_not_allowed');
  return url;
}

export function fixtureIdentifier(value, type) {
  const expression = type === 'schema' ? /^control_recovery_[a-f0-9]{24}$/ :
    type === 'database' ? /^control_recovery_restore_[a-f0-9]{24}$/ : /^[a-z_][a-z0-9_]{0,62}$/;
  if (typeof value !== 'string' || !expression.test(value)) fail('fixture_identifier_not_allowed');
  return '"' + value + '"';
}

export function archiveFingerprint(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.length > ARCHIVE_LIMIT ||
      bytes.subarray(0, 5).toString('ascii') !== 'PGDMP') fail('fixture_archive_invalid');
  return { bytes: bytes.length, sha256: digest(bytes) };
}

export function clientEnvironment(home, database) {
  // Deliberately do not spread process.env: no service files, inherited PG
  // settings, proxies or application credentials can redirect these commands.
  return { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
    PGPASSWORD: decodeURIComponent(database.password), PGCONNECT_TIMEOUT: '5' };
}

export async function clientCommand(bin, name, args, environment, { limit = 65536, signal } = {}) {
  if (!['pg_dump', 'pg_restore'].includes(name)) fail('fixture_command_not_allowed');
  try {
    const { stdout } = await execute(join(bin, name), args, { env: environment, encoding: 'buffer',
      timeout: 30000, maxBuffer: limit, killSignal: 'SIGKILL', signal });
    return stdout;
  } catch { fail('fixture_' + name + '_failed'); } // Never print argv, credentials or archive content.
}

export async function verifyClients(bin, environment, signal) {
  if (!isAbsolute(bin ?? '') || normalize(bin) !== bin) fail('fixture_pg_bin_required');
  const versions = [];
  for (const name of ['pg_dump', 'pg_restore']) {
    let entry;
    try { entry = await lstat(join(bin, name)); } catch { fail('fixture_pg_client_missing'); }
    if (!entry.isFile() || !(entry.mode & 0o111)) fail('fixture_pg_client_invalid');
    const output = await clientCommand(bin, name, ['--version'], environment, { signal });
    const match = new RegExp('^' + name + ' \\(PostgreSQL\\) ((?:16|17)\\.[0-9]+)(?: |$)').exec(output.toString().trim());
    if (!match) fail('fixture_pg_version_unreviewed');
    versions.push(match[1]);
  }
  if (versions[0] !== versions[1]) fail('fixture_pg_client_version_mismatch');
  return versions[0];
}

export function clientArguments(database) {
  return ['--host=127.0.0.1', '--port=' + (database.port || '5432'), '--username=' + database.username,
    '--dbname=' + database.pathname.slice(1), '--no-password'];
}

export async function createRestoreDatabase(admin, name, marker, onCreated = () => {}) {
  const quoted = fixtureIdentifier(name, 'database');
  if (!/^onlinu-control-recovery:[a-f0-9-]{36}$/.test(marker)) fail('fixture_owner_invalid');
  const found = await admin.query('SELECT oid FROM pg_database WHERE datname=$1', [name]);
  if (found.rows.length) fail('fixture_target_exists');
  // No IF NOT EXISTS, DROP, CLEAN, forced disconnect, overwrite or retry.
  await admin.query('CREATE DATABASE ' + quoted + ' TEMPLATE template0');
  // Publish the acknowledged creation immediately, before any later statement
  // can fail. An unknown CREATE outcome is never adopted or retried. If catalog
  // identity cannot be established, cleanup reports an unverified resource and
  // refuses to drop a database by name alone.
  const owner = { name, oid: null, marker };
  onCreated(owner);
  owner.oid = (await admin.query('SELECT oid FROM pg_database WHERE datname=$1', [name])).rows[0]?.oid;
  await admin.query('COMMENT ON DATABASE ' + quoted + " IS '" + marker + "'");
  return owner;
}

export async function verifyRestoreOwner(admin, owner) {
  fixtureIdentifier(owner.name, 'database');
  if (!Number.isInteger(owner.oid)) fail('fixture_target_ownership_unverified');
  const row = (await admin.query("SELECT oid,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1", [owner.name])).rows[0];
  if (!row || row.oid !== owner.oid || row.marker !== owner.marker) fail('fixture_target_ownership_changed');
}

export async function createSourceSchema(admin, name, marker) {
  const quoted = fixtureIdentifier(name, 'schema');
  if (!/^onlinu-control-recovery:[a-f0-9-]{36}$/.test(marker)) fail('fixture_owner_invalid');
  const db = await admin.connect();
  try {
    // PostgreSQL schema creation, marking and identity capture are atomic.
    await db.query('BEGIN');
    await db.query('CREATE SCHEMA ' + quoted);
    await db.query('COMMENT ON SCHEMA ' + quoted + " IS '" + marker + "'");
    const row = (await db.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [name])).rows[0];
    if (!Number.isInteger(row?.oid)) fail('fixture_source_ownership_unverified');
    await db.query('COMMIT');
    return row.oid;
  } catch (error) {
    try { await db.query('ROLLBACK'); } catch { /* Unknown commit stays fail-closed. */ }
    throw error;
  } finally { db.release(); }
}

export async function cleanupAll(operations) {
  const errors = [];
  for (const operation of operations) {
    try { await operation(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'fixture_cleanup_failed');
}

export async function boundedCleanup(operation, milliseconds = 10000) {
  let timer;
  try {
    return await Promise.race([operation(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('fixture_cleanup_timeout')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export function abortCheckedPool(raw, signal) {
  const checkpoint = () => signal.throwIfAborted();
  return {
    query(...args) { checkpoint(); return raw.query(...args); },
    async connect() {
      checkpoint(); const client = await raw.connect();
      return {
        query(...args) {
          // A canceled transaction may roll back, but cleanup never reenables
          // ordinary app SQL, including work resuming from an in-flight query.
          if (!(args.length === 1 && args[0] === 'ROLLBACK')) checkpoint();
          return client.query(...args);
        },
        release() { client.release(); },
      };
    },
  };
}

export const TABLES = Object.freeze([
  'demo_identities', 'demo_oauth_clients', 'demo_oauth_codes', 'demo_oauth_grants',
  'demo_oauth_refresh_tokens', 'demo_sessions', 'oidc_identity_bindings', 'oidc_login_states',
  'platform_identities', 'platform_identity_audit', 'platform_memberships', 'platform_tenants',
]);

export async function logicalFingerprint(pool, schema) {
  const quoted = fixtureIdentifier(schema, 'schema');
  const relations = (await pool.query(`SELECT c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind IN ('r','p','S') ORDER BY c.relname`, [schema])).rows;
  if (JSON.stringify(relations.filter(row => row.relkind !== 'S').map(row => row.relname)) !== JSON.stringify(TABLES) ||
      JSON.stringify(relations.filter(row => row.relkind === 'S').map(row => row.relname)) !== JSON.stringify(['platform_identity_audit_id_seq'])) fail('fixture_relation_set_changed');
  const tables = [];
  for (const name of TABLES) {
    const rows = (await pool.query('SELECT row_to_json(t)::text AS value FROM ' + quoted + '.' + fixtureIdentifier(name) + ' t LIMIT 1001')).rows.map(row => row.value).sort();
    if (rows.length > 1000 || Buffer.byteLength(rows.join('\n')) > 1024 * 1024) fail('fixture_rows_unbounded');
    tables.push({ name, count: rows.length, sha256: digest(rows.join('\n')) });
  }
  const sequence = (await pool.query('SELECT last_value::text,is_called FROM ' + quoted + '.platform_identity_audit_id_seq')).rows[0];
  return { tables, sequence, sha256: digest(JSON.stringify({ tables, sequence })) };
}
