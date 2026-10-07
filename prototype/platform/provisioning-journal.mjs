/** Private operator journal only: no Docker, secrets, activation or public API.
 * A claimed intent is not proof of execution. Expired/uncertain work is fenced
 * and needs an explicit, evidenced operator reconciliation before any retry.
 */
import { z } from 'zod';
import { problem } from './auth.mjs';

const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/);
const tenantId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1);
const expected = z.object({ expectedVersion: version }).strict();
const workerInput = z.object({ expectedVersion: version, workerId: uuid }).strict();
function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw problem(400, 'invalid_request');
  return result.data;
}
function snapshot(row) {
  return { id: row.id, tenantId: row.tenant_id, planDigest: row.plan_digest,
    expectedTenantVersion: Number(row.expected_tenant_version), state: row.state,
    version: Number(row.version), createdBy: row.created_by,
    claimedBy: row.claimed_by, workerId: row.worker_id,
    leaseUntil: row.lease_until?.toISOString() ?? null,
    evidenceDigest: row.evidence_digest };
}

export function createProvisioningJournal({ pool, leaseSeconds = 120 }) {
  if (!pool?.query || !pool?.connect || !Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 900)
    throw new Error('invalid_provisioning_journal_configuration');
  async function transaction(operation) {
    const db = await pool.connect();
    try { await db.query('BEGIN'); const value = await operation(db); await db.query('COMMIT'); return value; }
    catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }
  async function operator(db, actorId) {
    parse(uuid, actorId);
    // SHARE prevents the actor's enable/admin flags changing during a mutation,
    // but permits independent operator reads in concurrent transactions.
    const { rows } = await db.query('SELECT enabled,platform_admin FROM platform_identities WHERE id=$1 FOR SHARE', [actorId]);
    if (!rows[0]?.enabled) throw problem(403, 'identity_disabled');
    if (!rows[0].platform_admin) throw problem(403, 'forbidden');
  }
  async function audit(db, actorId, action, row, previous = null) {
    await db.query(`INSERT INTO platform_identity_audit(actor_id,action,tenant_id,target_id,details)
      VALUES($1,$2,$3,NULL,$4)`, [actorId, `provisioning_${action}`, row.tenant_id, JSON.stringify({
        jobId: row.id, planDigest: row.plan_digest, version: Number(row.version),
        state: row.state, previousState: previous?.state ?? null,
        previousWorkerId: previous?.worker_id ?? null,
        workerId: row.worker_id, evidenceDigest: row.evidence_digest,
      })]);
  }
  function currentDraft(tenant, row) {
    if (!tenant || tenant.status !== 'draft' || Number(tenant.version) !== Number(row.expected_tenant_version))
      throw problem(409, 'provisioning_tenant_changed');
  }
  function matchesVersion(row, input) {
    if (Number(row.version) !== input.expectedVersion) throw problem(409, 'version_conflict');
  }
  function ownedClaim(row, actorId, workerId, requireLive = true) {
    if (row.state !== 'claimed') throw problem(409, 'invalid_provisioning_transition');
    if (row.claimed_by !== actorId || row.worker_id !== workerId) throw problem(409, 'provisioning_worker_mismatch');
    if (requireLive && row.lease_expired) throw problem(409, 'provisioning_lease_expired');
  }
  async function mutate(actorId, jobId, input, operation) {
    parse(uuid, jobId);
    return transaction(async db => {
      await operator(db, actorId);
      const located = await db.query('SELECT tenant_id FROM platform_provision_jobs WHERE id=$1', [jobId]);
      if (!located.rows[0]) throw problem(404, 'provisioning_not_found');
      // Every mutator uses tenant -> job lock order, including request replay.
      const tenant = (await db.query('SELECT id,status,version FROM platform_tenants WHERE id=$1 FOR UPDATE', [located.rows[0].tenant_id])).rows[0];
      const row = (await db.query(`SELECT *,lease_until <= clock_timestamp() AS lease_expired
        FROM platform_provision_jobs WHERE id=$1 FOR UPDATE`, [jobId])).rows[0];
      if (!row) throw problem(404, 'provisioning_not_found');
      matchesVersion(row, input);
      return operation(db, tenant, row);
    });
  }
  async function change(db, actorId, row, state, action, { workerId = row.worker_id, evidenceDigest = null, requireLive = false } = {}) {
    const claiming = state === 'claimed';
    const queued = state === 'queued';
    const { rows } = await db.query(`UPDATE platform_provision_jobs SET state=$2,version=version+1,
      claimed_by=$3,worker_id=$4,lease_until=CASE WHEN $5 THEN clock_timestamp()+($6 * interval '1 second') ELSE NULL END,
      evidence_digest=$7,updated_at=clock_timestamp()
      WHERE id=$1 AND ($8=FALSE OR lease_until > clock_timestamp()) RETURNING *`,
    [row.id, state, queued ? null : (claiming ? actorId : row.claimed_by), queued ? null : workerId,
      claiming, leaseSeconds, evidenceDigest, requireLive]);
    if (!rows[0]) throw problem(409, 'provisioning_lease_expired');
    await audit(db, actorId, action, rows[0], row);
    return snapshot(rows[0]);
  }
  async function init() {
    // Requires the existing identity directory schema. No production migration
    // or job execution is automatically wired into control-server startup.
    await pool.query(`CREATE TABLE IF NOT EXISTS platform_provision_jobs (
      id UUID PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES platform_tenants(id),
      plan_digest TEXT NOT NULL CHECK(plan_digest ~ '^[a-f0-9]{64}$'),
      expected_tenant_version BIGINT NOT NULL CHECK(expected_tenant_version>0 AND expected_tenant_version<=9007199254740991),
      state TEXT NOT NULL CHECK(state IN ('queued','claimed','unknown','succeeded','cancelled')),
      version BIGINT NOT NULL DEFAULT 1 CHECK(version>0 AND version<=9007199254740991),
      created_by UUID NOT NULL REFERENCES platform_identities(id),
      claimed_by UUID REFERENCES platform_identities(id), worker_id UUID,
      lease_until TIMESTAMPTZ, evidence_digest TEXT CHECK(evidence_digest ~ '^[a-f0-9]{64}$'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK((state='claimed' AND claimed_by IS NOT NULL AND worker_id IS NOT NULL AND lease_until IS NOT NULL)
        OR (state<>'claimed' AND lease_until IS NULL)),
      CHECK(state<>'queued' OR (claimed_by IS NULL AND worker_id IS NULL)),
      CHECK(state NOT IN ('claimed','unknown','succeeded') OR (claimed_by IS NOT NULL AND worker_id IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS platform_provision_one_initial_job
      ON platform_provision_jobs(tenant_id) WHERE state<>'cancelled';
    CREATE INDEX IF NOT EXISTS platform_provision_jobs_recent ON platform_provision_jobs(created_at DESC,id DESC);`);
  }
  async function request(actorId, requestedTenant, input) {
    parse(tenantId, requestedTenant);
    const args = parse(z.object({ requestId: uuid, expectedTenantVersion: version, planDigest: digest }).strict(), input);
    try {
      return await transaction(async db => {
        await operator(db, actorId);
        const tenant = (await db.query('SELECT id,status,version FROM platform_tenants WHERE id=$1 FOR UPDATE', [requestedTenant])).rows[0];
        if (!tenant) throw problem(404, 'tenant_not_found');
        const existing = (await db.query('SELECT * FROM platform_provision_jobs WHERE id=$1 FOR UPDATE', [args.requestId])).rows[0];
        if (existing) {
          if (existing.tenant_id !== requestedTenant || existing.created_by !== actorId || existing.plan_digest !== args.planDigest
              || Number(existing.expected_tenant_version) !== args.expectedTenantVersion) throw problem(409, 'idempotency_conflict');
          return snapshot(existing);
        }
        currentDraft(tenant, { expected_tenant_version: args.expectedTenantVersion });
        if ((await db.query("SELECT 1 FROM platform_provision_jobs WHERE tenant_id=$1 AND state<>'cancelled'", [requestedTenant])).rowCount)
          throw problem(409, 'provisioning_already_exists');
        const row = (await db.query(`INSERT INTO platform_provision_jobs(id,tenant_id,plan_digest,expected_tenant_version,state,created_by)
          VALUES($1,$2,$3,$4,'queued',$5) RETURNING *`, [args.requestId, requestedTenant, args.planDigest, args.expectedTenantVersion, actorId])).rows[0];
        await audit(db, actorId, 'requested', row);
        return snapshot(row);
      });
    } catch (error) {
      if (error.code === '23505' && error.constraint === 'platform_provision_jobs_pkey') throw problem(409, 'idempotency_conflict');
      throw error;
    }
  }
  async function list(actorId, input = {}) {
    const args = parse(z.object({ tenantId: tenantId.optional(),
      state: z.enum(['queued','claimed','unknown','succeeded','cancelled']).optional(),
      after: uuid.optional(), limit: z.number().int().min(1).max(100).default(25),
    }).strict(), input);
    return transaction(async db => {
      await operator(db, actorId);
      if (args.after && !(await db.query('SELECT 1 FROM platform_provision_jobs WHERE id=$1', [args.after])).rowCount)
        throw problem(400, 'invalid_provisioning_cursor');
      // Cursor timestamp stays in PostgreSQL (microsecond precision), never
      // round-trips through a JavaScript millisecond Date. Job rows are retained.
      const { rows } = await db.query(`SELECT *,state='claimed' AND lease_until<=clock_timestamp() AS lease_expired
        FROM platform_provision_jobs
        WHERE ($1::text IS NULL OR tenant_id=$1) AND ($2::text IS NULL OR state=$2)
          AND ($3::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM platform_provision_jobs WHERE id=$3))
        ORDER BY created_at DESC,id DESC LIMIT $4`, [args.tenantId ?? null, args.state ?? null, args.after ?? null, args.limit + 1]);
      const page = rows.slice(0, args.limit);
      return { jobs: page.map(row => ({ ...snapshot(row), createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(), leaseExpired: row.lease_expired === true })),
        nextCursor: rows.length > args.limit ? page.at(-1).id : null };
    });
  }
  async function get(actorId, jobId) {
    parse(uuid, jobId);
    return transaction(async db => {
      await operator(db, actorId);
      const row = (await db.query('SELECT * FROM platform_provision_jobs WHERE id=$1', [jobId])).rows[0];
      if (!row) throw problem(404, 'provisioning_not_found');
      return snapshot(row);
    });
  }
  async function review(actorId, jobId, input) {
    const args = parse(z.object({ expectedVersion: version, workerId: uuid.optional() }).strict(), input);
    return mutate(actorId, jobId, args, async (_db, tenant, row) => {
      if (row.state === 'claimed') ownedClaim(row, actorId, args.workerId);
      else if (row.state !== 'queued' || args.workerId !== undefined) throw problem(409, 'invalid_provisioning_transition');
      currentDraft(tenant, row);
      return snapshot(row);
    });
  }
  async function claim(actorId, jobId, input) {
    const args = parse(workerInput, input);
    return mutate(actorId, jobId, args, async (db, tenant, row) => {
      if (row.state !== 'queued') throw problem(409, 'invalid_provisioning_transition');
      currentDraft(tenant, row);
      return change(db, actorId, row, 'claimed', 'claimed', args);
    });
  }
  async function heartbeat(actorId, jobId, input) {
    const args = parse(workerInput, input);
    return mutate(actorId, jobId, args, async (db, tenant, row) => {
      ownedClaim(row, actorId, args.workerId); currentDraft(tenant, row);
      return change(db, actorId, row, 'claimed', 'lease_extended', { ...args, requireLive: true });
    });
  }
  async function finish(actorId, jobId, input) {
    const args = parse(z.object({ expectedVersion: version, workerId: uuid, evidenceDigest: digest }).strict(), input);
    return mutate(actorId, jobId, args, async (db, tenant, row) => {
      ownedClaim(row, actorId, args.workerId); currentDraft(tenant, row);
      return change(db, actorId, row, 'succeeded', 'succeeded', { ...args, requireLive: true });
    });
  }
  async function uncertain(actorId, jobId, input) {
    const args = parse(workerInput, input);
    return mutate(actorId, jobId, args, async (db, _tenant, row) => {
      ownedClaim(row, actorId, args.workerId, false);
      return change(db, actorId, row, 'unknown', 'outcome_unknown');
    });
  }
  async function expire(actorId, jobId, input) {
    const args = parse(expected, input);
    return mutate(actorId, jobId, args, async (db, _tenant, row) => {
      if (row.state !== 'claimed' || !row.lease_expired) throw problem(409, 'invalid_provisioning_transition');
      return change(db, actorId, row, 'unknown', 'lease_expired');
    });
  }
  async function cancelQueued(actorId, jobId, input) {
    const args = parse(expected, input);
    return mutate(actorId, jobId, args, async (db, _tenant, row) => {
      if (row.state !== 'queued') throw problem(409, 'invalid_provisioning_transition');
      return change(db, actorId, row, 'cancelled', 'cancelled');
    });
  }
  async function reconcile(actorId, jobId, input) {
    const args = parse(z.object({ expectedVersion: version, decision: z.enum(['requeue','accept','cancel']), evidenceDigest: digest }).strict(), input);
    return mutate(actorId, jobId, args, async (db, tenant, row) => {
      if (row.state !== 'unknown') throw problem(409, 'invalid_provisioning_transition');
      if (args.decision !== 'cancel') currentDraft(tenant, row);
      const state = { requeue: 'queued', accept: 'succeeded', cancel: 'cancelled' }[args.decision];
      return change(db, actorId, row, state, `reconciled_${args.decision}`, args);
    });
  }
  return { init, request, list, get, review, claim, heartbeat, finish, uncertain, expire, cancelQueued, reconcile };
}
