/** Staged, offline authentication preparation. NOT a restore tool or serving permit.
 * Nothing imports this module from server startup, HTTP routes, or workers.
 * The caller must independently fence old processes and keep Events APIs/workers
 * closed. Supplied review/fence records are operator assertions, not proof.
 * Expected recovery ID and fresh target marker MUST be held outside rollback.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const CONTROL_RECOVERY_POLICY = 'cold-authentication-preparation-v1';
const implementation = 'control-recovery-v1';
const receiptTable = 'platform_control_recovery_receipts';
const authTables = ['demo_sessions', 'demo_oauth_grants', 'demo_oauth_refresh_tokens', 'demo_oauth_codes', 'oidc_login_states'];
const expired = '1970-01-01T00:00:00.000Z'; // Finite and parseable by OIDC's JavaScript Date check.
const identifier = z.string().regex(/^(?!pg_)[a-z][a-z0-9_]{0,62}$/);
const oid = z.number().int().min(1).max(4294967295);
const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reference = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const targetSchema = z.object({ database: identifier, databaseOid: oid, databaseOwnerOid: oid,
  marker: z.string().regex(/^onlinu-control-recovery:[a-f0-9-]{36}$/),
  schema: identifier, schemaOid: oid, schemaOwnerOid: oid }).strict();
const evidenceSchema = z.object({ reference, evidenceSha256: digest }).strict();
const bindingSchema = z.object({ origin: z.string().max(2048),
  customer: z.object({ issuer: z.string().max(2048), resource: z.string().max(2048) }).strict(),
  native: z.object({ issuer: z.string().max(2048), resource: z.string().max(2048), mobileEnabled: z.boolean() }).strict().nullable(),
  oidc: z.object({ issuer: z.string().max(2048), clientId: z.string().min(1).max(255) }).strict(),
  redirectAllowlist: z.array(z.string().max(2048)).max(100), events: z.literal('disabled'),
}).strict();
const expectationSchema = z.object({ recoveryId: uuid, policy: z.literal(CONTROL_RECOVERY_POLICY), target: targetSchema,
  binding: bindingSchema, operatorReference: reference,
  authorityReview: evidenceSchema.extend({ outcome: z.literal('reviewed') }).strict(),
  coldFence: evidenceSchema,
}).strict();
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const receiptSchema = z.object({ expectation: expectationSchema, implementation: z.literal(implementation),
  operationSha256: digest, completedAt: z.string().datetime(),
  counts: z.object(Object.fromEntries(authTables.map(name => [name, count]))).strict(),
  scope: z.literal('authentication-preparation-only'), servingAuthorized: z.literal(false),
  eventsSupported: z.literal(false), processFencingVerified: z.literal(false), authorityReconciliationVerified: z.literal(false),
}).strict();

export class ControlRecoveryError extends Error {
  constructor(code) { super(code); this.name = 'ControlRecoveryError'; this.code = code; }
}
const fail = code => { throw new ControlRecoveryError(code); };
function parse(schema, value, code = 'recovery_input_invalid') {
  const result = schema.safeParse(value);
  if (!result.success) fail(code);
  return result.data;
}
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const checksum = value => createHash('sha256').update(stable(value)).digest('hex');
const qualified = (schema, name) => '"' + schema + '"."' + name + '"';

/** Non-secret security configuration only. No automatic defaults or config changes. */
export function controlRecoveryBinding(configuration) {
  const config = parse(z.object({ baseUrl: z.string().max(2048),
    oidc: z.object({ issuer: z.string().max(2048), clientId: z.string().min(1).max(255).regex(/^[^\x00-\x1f\x7f]+$/) }).strict(),
    nativeStaffEnabled: z.boolean(), nativeMobileEnabled: z.boolean(),
    redirectAllowlist: z.array(z.string().max(2048)).max(100), eventsEnabled: z.literal(false),
  }).strict(), configuration);
  let base, upstream;
  try { base = new URL(config.baseUrl); upstream = new URL(config.oidc.issuer); }
  catch { fail('recovery_configuration_invalid'); }
  if (base.protocol !== 'https:' || base.origin !== config.baseUrl || upstream.protocol !== 'https:' ||
      upstream.username || upstream.password || upstream.search || upstream.hash || upstream.href !== config.oidc.issuer ||
      config.nativeMobileEnabled && !config.nativeStaffEnabled) fail('recovery_configuration_invalid');
  for (const value of config.redirectAllowlist) {
    let url;
    try { url = new URL(value); } catch { fail('recovery_configuration_invalid'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.href !== value) fail('recovery_configuration_invalid');
  }
  return { origin: base.origin, customer: { issuer: base.origin, resource: base.origin + '/mcp' },
    native: config.nativeStaffEnabled ? { issuer: base.origin + '/native', resource: base.origin + '/native/api', mobileEnabled: config.nativeMobileEnabled } : null,
    oidc: config.oidc, redirectAllowlist: [...new Set(config.redirectAllowlist)].sort(), events: 'disabled' };
}
function inputs(expectation, configuration) {
  const expected = parse(expectationSchema, expectation);
  if (stable(expected.binding) !== stable(controlRecoveryBinding(configuration))) fail('recovery_configuration_mismatch');
  return expected;
}
function checkpoint(signal) { if (signal?.aborted) fail('recovery_cancelled'); }
async function connect(pool, signal) {
  if (typeof pool?.connect !== 'function') fail('recovery_pool_required');
  checkpoint(signal);
  // Late connections are released instead of continuing canceled/timed-out work.
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, db) => {
      if (settled) { db?.release(true); return; }
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(db);
    };
    const abort = () => finish(new ControlRecoveryError('recovery_cancelled'));
    const timer = setTimeout(() => finish(new ControlRecoveryError('recovery_connection_timeout')), 8000);
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => pool.connect()).then(db => finish(null, db), () => finish(new ControlRecoveryError('recovery_connection_failed')));
  });
}
async function transaction(pool, signal, readOnly, operation) {
  const db = await connect(pool, signal);
  let committing = false;
  const query = async (text, values = []) => {
    checkpoint(signal);
    const result = await db.query({ text, values, query_timeout: 8000 });
    checkpoint(signal);
    return result;
  };
  try {
    await query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    await query("SET LOCAL search_path = pg_catalog");
    await query("SET LOCAL statement_timeout = '5s'");
    await query("SET LOCAL lock_timeout = '3s'");
    await query("SET LOCAL idle_in_transaction_session_timeout = '10s'");
    const result = await operation(query);
    checkpoint(signal); committing = true;
    await query('COMMIT');
    return result;
  } catch (error) {
    try { await db.query({ text: 'ROLLBACK', query_timeout: 8000 }); } catch { /* Remain closed; destroy client below. */ }
    if (committing) fail('recovery_commit_uncertain');
    if (error instanceof ControlRecoveryError) throw error;
    fail('recovery_operation_failed_closed'); // Never expose driver errors or secrets.
  } finally { db.release(true); }
}
async function verifyTarget(query, expected) {
  const { rows } = await query(`SELECT d.datname AS database,d.oid AS database_oid,d.datdba AS database_owner_oid,
    shobj_description(d.oid,'pg_database') AS marker,n.nspname AS schema,n.oid AS schema_oid,n.nspowner AS schema_owner_oid
    FROM pg_database d CROSS JOIN pg_namespace n WHERE d.datname=current_database() AND n.nspname=$1`, [expected.schema]);
  const row = rows[0];
  if (rows.length !== 1 || !row || stable({ database: row.database, databaseOid: row.database_oid,
    databaseOwnerOid: row.database_owner_oid, marker: row.marker, schema: row.schema, schemaOid: row.schema_oid,
    schemaOwnerOid: row.schema_owner_oid }) !== stable(expected)) fail('recovery_target_mismatch');
}
function validateReceipt(value, expected) {
  const receipt = parse(receiptSchema, value, 'recovery_receipt_invalid');
  if (Buffer.byteLength(stable(receipt)) > 16384 || stable(receipt.expectation) !== stable(expected) ||
      receipt.operationSha256 !== checksum(expected)) fail('recovery_receipt_mismatch');
  return receipt;
}
async function readReceipt(query, expected) {
  const { rows } = await query('SELECT receipt FROM ' + qualified(expected.target.schema, receiptTable) + ' WHERE recovery_id=$1', [expected.recoveryId]);
  if (!rows.length) return null;
  if (rows.length !== 1) fail('recovery_receipt_invalid');
  return validateReceipt(rows[0].receipt, expected);
}

/** Administrative API only; no CLI/HTTP route, backup, restore or target discovery.
 * Atomic auth invalidation + receipt. Exact same-operation retries are read-only
 * after the receipt lookup and retain freshly issued sessions. New restores MUST
 * receive a new external ID; reusing an archived ID is not detectable here.
 */
export async function prepareControlRecovery({ pool, expectation, configuration, signal }) {
  const expected = inputs(expectation, configuration);
  return transaction(pool, signal, false, async query => {
    await verifyTarget(query, expected.target); // No DDL/write before exact target check.
    // Serialize concurrent preparation in the same database/schema, including DDL.
    await query('SELECT pg_advisory_xact_lock($1::int,$2::int)', [19470101, expected.target.schemaOid | 0]);
    await verifyTarget(query, expected.target);
    const table = qualified(expected.target.schema, receiptTable);
    await query('CREATE TABLE IF NOT EXISTS ' + table + ` (recovery_id UUID PRIMARY KEY,
      receipt JSONB NOT NULL CHECK(octet_length(receipt::text)<=16384), created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const previous = await readReceipt(query, expected);
    if (previous) return previous;
    await query('LOCK TABLE ' + authTables.map(name => qualified(expected.target.schema, name)).join(',') + ' IN ACCESS EXCLUSIVE MODE');
    const updates = ['expires_at=$1', 'revoked=TRUE', 'consumed=TRUE,expires_at=$1', 'expires_at=$1', 'expires_at=$1'];
    const counts = {};
    for (let i = 0; i < authTables.length; i++) {
      const result = await query('UPDATE ' + qualified(expected.target.schema, authTables[i]) + ' SET ' + updates[i], i === 1 ? [] : [expired]);
      counts[authTables[i]] = parse(count, result.rowCount, 'recovery_count_invalid');
    }
    await verifyTarget(query, expected.target);
    const receipt = validateReceipt({ expectation: expected, implementation, operationSha256: checksum(expected),
      completedAt: new Date().toISOString(), counts, scope: 'authentication-preparation-only', servingAuthorized: false,
      eventsSupported: false, processFencingVerified: false, authorityReconciliationVerified: false }, expected);
    await query('INSERT INTO ' + table + '(recovery_id,receipt) VALUES($1,$2)', [expected.recoveryId, JSON.stringify(receipt)]);
    return receipt;
  });
}

/** Read-only prerequisite validation, never a complete startup/activation permit.
 * Missing, stale or mismatched receipt fails closed; no schema init or repair.
 */
export async function verifyControlRecoveryReceipt({ pool, expectation, configuration, signal }) {
  const expected = inputs(expectation, configuration);
  return transaction(pool, signal, true, async query => {
    await verifyTarget(query, expected.target);
    const receipt = await readReceipt(query, expected);
    if (!receipt) fail('recovery_receipt_missing');
    return receipt;
  });
}
