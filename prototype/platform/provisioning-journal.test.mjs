import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createIdentityDirectory } from './identity-directory.mjs';
import { createProvisioningJournal } from './provisioning-journal.mjs';
import { createProvisioningArtifacts } from './provisioning-artifacts.mjs';
import { createProvisioningRunner } from './provisioning-runner.mjs';
import { createProvisioningHostLock } from './provisioning-host-lock.mjs';
import { createProvisioningStage } from './provisioning-stage.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const issuer = 'https://identity.example/';
const hash = 'a'.repeat(64), evidence = 'b'.repeat(64);
test('provisioning journal validates private worker configuration', () => {
  assert.throws(() => createProvisioningJournal({ pool: {} }), /configuration/);
  const pool = { query() {}, connect() {} };
  for (const leaseSeconds of [0, 29, 901, 1.5, '120'])
    assert.throws(() => createProvisioningJournal({ pool, leaseSeconds }), /configuration/);
});

test('provisioning queue query rejects unbounded or unexpected filters before database access', async () => {
  let touched = false;
  const journal = createProvisioningJournal({ pool: { query() {}, connect() { touched = true; throw new Error('must not connect'); } } });
  for (const input of [{limit:0},{limit:101},{limit:1.2},{limit:'10'},{after:'bad'},{state:'running'},{tenantId:'../other'},{extra:true},null])
    await assert.rejects(journal.list(randomUUID(),input),{code:'invalid_request'});
  assert.equal(touched,false);
});

test('durable operator provisioning intents and fenced outcomes', { skip: !process.env.IDENTITY_TEST_DATABASE_URL }, async t => {
  const url = new URL(process.env.IDENTITY_TEST_DATABASE_URL);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/astracalls_identity_test');
  assert.equal(url.search, '?sslmode=disable');
  const schema = `provision_test_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: url.href });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: url.href, options: `-c search_path=${schema}`, max: 12 });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const directory = createIdentityDirectory({ pool, trustedIssuers: [issuer] });
  await directory.init();
  const actor = await directory.verifiedIdentity({ issuer, subject: 'operator-a' });
  const otherActor = await directory.verifiedIdentity({ issuer, subject: 'operator-b' });
  const owner = await directory.verifiedIdentity({ issuer, subject: 'restaurant-owner' });
  await pool.query('UPDATE platform_identities SET platform_admin=TRUE WHERE id=ANY($1::uuid[])', [[actor.id, otherActor.id]]);
  const journal = createProvisioningJournal({ pool });
  await journal.init();
  await t.test('empty private queue denies restaurant owners and contains no state changes', async () => {
    await assert.rejects(journal.list(owner.id), { code: 'forbidden' });
    assert.deepEqual(await journal.list(actor.id), { jobs: [], nextCursor: null });
  });
  async function tenant(name) { await directory.createTenant(actor.id, { id: name, name, ownerId: owner.id }); }
  const request = () => ({ requestId: randomUUID(), expectedTenantVersion: 1, planDigest: hash });
  const claiming = row => ({ expectedVersion: row.version, workerId: randomUUID() });

  await t.test('operator queue pagination preserves microseconds, filters states and never expires jobs', async () => {
    const ids = [];
    for (let i=0;i<4;i++) {
      const name='queue-page-'+i;
      await tenant(name);
      const job=await journal.request(actor.id,name,request()); ids.push(job.id);
      await pool.query("UPDATE platform_provision_jobs SET created_at='2026-10-06 01:00:00.000001+00'::timestamptz + $2::int * interval '1 microsecond' WHERE id=$1",[job.id,i]);
    }
    const auditBefore=Number((await pool.query('SELECT count(*) AS n FROM platform_identity_audit')).rows[0].n);
    const seen=[];let after;
    do {
      const page=await journal.list(actor.id,{state:'queued',limit:2,...(after?{after}:{})});
      seen.push(...page.jobs.map(v=>v.id)); after=page.nextCursor;
      assert.ok(page.jobs.every(v=>v.state==='queued' && v.leaseExpired===false));
    } while(after);
    assert.deepEqual(seen,[...ids].reverse());
    const filtered=await journal.list(actor.id,{tenantId:'queue-page-1'});
    assert.equal(filtered.jobs.length,1);assert.equal(filtered.jobs[0].id,ids[1]);
    assert.equal(filtered.nextCursor,null);
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM platform_identity_audit')).rows[0].n),auditBefore);
    const queued=await journal.get(actor.id,ids[0]);
    const claimed=await journal.claim(actor.id,queued.id,{expectedVersion:queued.version,workerId:randomUUID()});
    await pool.query("UPDATE platform_provision_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[claimed.id]);
    const expired=await journal.list(actor.id,{state:'claimed',tenantId:'queue-page-0'});
    assert.equal(expired.jobs[0].leaseExpired,true);assert.equal(expired.jobs[0].state,'claimed');
    assert.equal((await journal.get(actor.id,claimed.id)).version,claimed.version);
    await assert.rejects(journal.list(actor.id,{after:randomUUID()}),{code:'invalid_provisioning_cursor'});
    await pool.query('UPDATE platform_identities SET enabled=FALSE WHERE id=$1',[otherActor.id]);
    await assert.rejects(journal.list(otherActor.id),{code:'identity_disabled'});
    await pool.query('UPDATE platform_identities SET enabled=TRUE WHERE id=$1',[otherActor.id]);
  });

  await t.test('restaurant owners and disabled identities are not operators', async () => {
    await tenant('authority');
    await assert.rejects(journal.request(owner.id, 'authority', request()), { code: 'forbidden' });
    await pool.query('UPDATE platform_identities SET enabled=FALSE WHERE id=$1', [otherActor.id]);
    await assert.rejects(journal.request(otherActor.id, 'authority', request()), { code: 'identity_disabled' });
    await pool.query('UPDATE platform_identities SET enabled=TRUE WHERE id=$1', [otherActor.id]);
    await assert.rejects(journal.request(actor.id, 'authority', { ...request(), password: 'must-not-store' }), { code: 'invalid_request' });
    await assert.rejects(journal.request(actor.id, 'authority', { ...request(), planDigest: 'UPPER' }), { code: 'invalid_request' });
  });

  let shared, sharedInput;
  await t.test('concurrent identical intent creates one journal row and one audit', async () => {
    await tenant('concurrent'); sharedInput = request();
    const rows = await Promise.all(Array.from({ length: 8 }, () => journal.request(actor.id, 'concurrent', sharedInput)));
    assert.equal(new Set(rows.map(row => row.id)).size, 1);
    shared = rows[0]; assert.equal(shared.state, 'queued'); assert.equal(shared.version, 1);
    const audits = await pool.query("SELECT count(*)::int AS n FROM platform_identity_audit WHERE action='provisioning_requested' AND tenant_id='concurrent'");
    assert.equal(audits.rows[0].n, 1);
    await assert.rejects(journal.request(actor.id, 'concurrent', { ...sharedInput, planDigest: evidence }), { code: 'idempotency_conflict' });
    await assert.rejects(journal.request(otherActor.id, 'concurrent', sharedInput), { code: 'idempotency_conflict' });
    await assert.rejects(journal.request(actor.id, 'concurrent', request()), { code: 'provisioning_already_exists' });
  });

  let winner;
  await t.test('only one fenced worker claim wins and other callbacks fail', async () => {
    const claims = [claiming(shared), claiming(shared)];
    const outcomes = await Promise.allSettled(claims.map(input => journal.claim(actor.id, shared.id, input)));
    assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(outcomes.find(row => row.status === 'rejected').reason.code, 'version_conflict');
    winner = outcomes.find(row => row.status === 'fulfilled').value;
    assert.equal(winner.state, 'claimed'); assert.equal(winner.version, 2);
    assert.ok(new Date(winner.leaseUntil) > new Date());
    await assert.rejects(journal.heartbeat(actor.id, winner.id, { expectedVersion: winner.version, workerId: randomUUID() }), { code: 'provisioning_worker_mismatch' });
    await assert.rejects(journal.finish(otherActor.id, winner.id, { expectedVersion: winner.version, workerId: winner.workerId, evidenceDigest: evidence }), { code: 'provisioning_worker_mismatch' });
    await assert.rejects(journal.expire(actor.id, winner.id, { expectedVersion: winner.version }), { code: 'invalid_provisioning_transition' });
    winner = await journal.heartbeat(actor.id, winner.id, { expectedVersion: winner.version, workerId: winner.workerId });
    assert.equal(winner.version, 3);
  });

  await t.test('expired lease becomes unknown and cannot be replayed automatically', async () => {
    await pool.query("UPDATE platform_provision_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [winner.id]);
    await assert.rejects(journal.finish(actor.id, winner.id, { expectedVersion: winner.version, workerId: winner.workerId, evidenceDigest: evidence }), { code: 'provisioning_lease_expired' });
    const unknown = await journal.expire(otherActor.id, winner.id, { expectedVersion: winner.version });
    assert.equal(unknown.state, 'unknown'); assert.equal(unknown.leaseUntil, null);
    await assert.rejects(journal.claim(actor.id, unknown.id, claiming(unknown)), { code: 'invalid_provisioning_transition' });
    await assert.rejects(journal.request(actor.id, 'concurrent', request()), { code: 'provisioning_already_exists' });
    await assert.rejects(journal.reconcile(otherActor.id, unknown.id, { expectedVersion: unknown.version, decision: 'requeue' }), { code: 'invalid_request' });
    const queued = await journal.reconcile(otherActor.id, unknown.id, { expectedVersion: unknown.version, decision: 'requeue', evidenceDigest: evidence });
    assert.equal(queued.workerId, null); assert.equal(queued.claimedBy, null);
    const claimed = await journal.claim(otherActor.id, queued.id, claiming(queued));
    await assert.rejects(journal.finish(actor.id, claimed.id, { expectedVersion: claimed.version, workerId: winner.workerId, evidenceDigest: evidence }), { code: 'provisioning_worker_mismatch' });
    const done = await journal.finish(otherActor.id, claimed.id, { expectedVersion: claimed.version, workerId: claimed.workerId, evidenceDigest: evidence });
    assert.equal(done.state, 'succeeded'); assert.equal(done.evidenceDigest, evidence);
    assert.equal((await pool.query("SELECT status FROM platform_tenants WHERE id='concurrent'")).rows[0].status, 'draft');
    assert.deepEqual(await directory.published(['concurrent']), []);
    assert.equal((await journal.request(actor.id, 'concurrent', sharedInput)).state, 'succeeded');
    await assert.rejects(journal.request(actor.id, 'concurrent', request()), { code: 'provisioning_already_exists' });
  });

  await t.test('tenant changes prevent execution and queued cancellation changes no resources', async () => {
    await tenant('changed'); const queued = await journal.request(actor.id, 'changed', request());
    await directory.setTenantStatus(actor.id, 'changed', { expectedVersion: 1, status: 'closed' });
    await assert.rejects(journal.claim(actor.id, queued.id, claiming(queued)), { code: 'provisioning_tenant_changed' });
    const cancelled = await journal.cancelQueued(actor.id, queued.id, { expectedVersion: queued.version });
    assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.workerId, null);
    await assert.rejects(journal.request(actor.id, 'changed', request()), { code: 'provisioning_tenant_changed' });
  });

  await t.test('uncertain work needs explicit evidence and disabled workers cannot complete', async () => {
    await tenant('uncertain');
    const queued = await journal.request(actor.id, 'uncertain', request());
    const claimed = await journal.claim(otherActor.id, queued.id, claiming(queued));
    await pool.query('UPDATE platform_identities SET enabled=FALSE WHERE id=$1', [otherActor.id]);
    await assert.rejects(journal.finish(otherActor.id, claimed.id, { expectedVersion: claimed.version, workerId: claimed.workerId, evidenceDigest: evidence }), { code: 'identity_disabled' });
    await pool.query('UPDATE platform_identities SET enabled=TRUE WHERE id=$1', [otherActor.id]);
    const unknown = await journal.uncertain(otherActor.id, claimed.id, { expectedVersion: claimed.version, workerId: claimed.workerId });
    const done = await journal.reconcile(actor.id, unknown.id, { expectedVersion: unknown.version, decision: 'accept', evidenceDigest: evidence });
    assert.equal(done.state, 'succeeded');
    await assert.rejects(journal.cancelQueued(actor.id, done.id, { expectedVersion: done.version }), { code: 'invalid_provisioning_transition' });
  });

  await t.test('cancelled initial intent allows a new reviewed request but preserves replay', async () => {
    await tenant('cancelled'); const input = request();
    const queued = await journal.request(actor.id, 'cancelled', input);
    const cancelled = await journal.cancelQueued(actor.id, queued.id, { expectedVersion: queued.version });
    const next = await journal.request(actor.id, 'cancelled', request());
    assert.notEqual(next.id, cancelled.id);
    assert.equal((await journal.request(actor.id, 'cancelled', input)).state, 'cancelled');
    const claimed = await journal.claim(actor.id, next.id, claiming(next));
    const unknown = await journal.uncertain(actor.id, claimed.id, { expectedVersion: claimed.version, workerId: claimed.workerId });
    await directory.setTenantStatus(actor.id, 'cancelled', { expectedVersion: 1, status: 'closed' });
    await assert.rejects(journal.reconcile(actor.id, unknown.id, { expectedVersion: unknown.version, decision: 'requeue', evidenceDigest: evidence }), { code: 'provisioning_tenant_changed' });
    assert.equal((await journal.reconcile(actor.id, unknown.id, { expectedVersion: unknown.version, decision: 'cancel', evidenceDigest: evidence })).state, 'cancelled');
  });

  await t.test('distinct requests serialize per tenant and cross-tenant UUID reuse fails', async () => {
    await tenant('one-initial'); await tenant('uuid-other');
    const inputs = [request(), request()];
    const results = await Promise.allSettled(inputs.map(input => journal.request(actor.id, 'one-initial', input)));
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(results.find(row => row.status === 'rejected').reason.code, 'provisioning_already_exists');
    const created = results.find(row => row.status === 'fulfilled').value;
    await assert.rejects(journal.request(actor.id, 'uuid-other', { ...request(), requestId: created.id }), { code: 'idempotency_conflict' });
    await assert.rejects(journal.request(actor.id, 'uuid-other', { ...request(), expectedTenantVersion: 2 }), { code: 'provisioning_tenant_changed' });
    await assert.rejects(journal.get(actor.id, randomUUID()), { code: 'provisioning_not_found' });
  });

  await t.test('tenant closure after claim fences success but allows uncertainty accounting', async () => {
    await tenant('closing'); const queued = await journal.request(actor.id, 'closing', request());
    const claimed = await journal.claim(actor.id, queued.id, claiming(queued));
    await assert.rejects(journal.cancelQueued(actor.id, claimed.id, { expectedVersion: claimed.version }), { code: 'invalid_provisioning_transition' });
    await directory.setTenantStatus(actor.id, 'closing', { expectedVersion: 1, status: 'closed' });
    await assert.rejects(journal.heartbeat(actor.id, claimed.id, { expectedVersion: claimed.version, workerId: claimed.workerId }), { code: 'provisioning_tenant_changed' });
    await assert.rejects(journal.finish(actor.id, claimed.id, { expectedVersion: claimed.version, workerId: claimed.workerId, evidenceDigest: evidence }), { code: 'provisioning_tenant_changed' });
    const unknown = await journal.uncertain(actor.id, claimed.id, { expectedVersion: claimed.version, workerId: claimed.workerId });
    await assert.rejects(journal.reconcile(otherActor.id, unknown.id, { expectedVersion: unknown.version, decision: 'accept', evidenceDigest: evidence }), { code: 'provisioning_tenant_changed' });
    assert.equal((await journal.reconcile(otherActor.id, unknown.id, { expectedVersion: unknown.version, decision: 'cancel', evidenceDigest: evidence })).state, 'cancelled');
  });

  await t.test('operator privilege is rechecked rather than inherited from an old claim', async () => {
    await tenant('revoked'); const queued = await journal.request(actor.id, 'revoked', request());
    const claimed = await journal.claim(otherActor.id, queued.id, claiming(queued));
    await pool.query('UPDATE platform_identities SET platform_admin=FALSE WHERE id=$1', [otherActor.id]);
    await assert.rejects(journal.heartbeat(otherActor.id, claimed.id, { expectedVersion: claimed.version, workerId: claimed.workerId }), { code: 'forbidden' });
    await pool.query('UPDATE platform_identities SET platform_admin=TRUE WHERE id=$1', [otherActor.id]);
    await pool.query("UPDATE platform_provision_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [claimed.id]);
    await assert.rejects(journal.heartbeat(otherActor.id, claimed.id, { expectedVersion: claimed.version, workerId: claimed.workerId }), { code: 'provisioning_lease_expired' });
    assert.equal((await journal.get(actor.id, claimed.id)).state, 'claimed', 'reads do not mutate expired work');
    const unknown = await journal.expire(actor.id, claimed.id, { expectedVersion: claimed.version });
    assert.equal(unknown.state, 'unknown');
    assert.equal((await pool.query("SELECT 1 FROM platform_identity_audit WHERE details::text LIKE '%must-not-store%'")).rowCount, 0);
  });

  await t.test('preflight reviews check current operator, draft and worker without changing state', async () => {
    await tenant('review'); const queued = await journal.request(actor.id, 'review', request());
    assert.deepEqual(await journal.review(actor.id, queued.id, { expectedVersion: queued.version }), queued);
    await assert.rejects(journal.review(owner.id, queued.id, { expectedVersion: queued.version }), { code: 'forbidden' });
    await assert.rejects(journal.review(actor.id, queued.id, { expectedVersion: queued.version, workerId: randomUUID() }), { code: 'invalid_provisioning_transition' });
    const claimed = await journal.claim(actor.id, queued.id, claiming(queued));
    const args = { expectedVersion: claimed.version, workerId: claimed.workerId };
    assert.deepEqual(await journal.review(actor.id, claimed.id, args), claimed);
    await assert.rejects(journal.review(otherActor.id, claimed.id, args), { code: 'provisioning_worker_mismatch' });
    await directory.setTenantStatus(actor.id, 'review', { expectedVersion: 1, status: 'closed' });
    await assert.rejects(journal.review(actor.id, claimed.id, args), { code: 'provisioning_tenant_changed' });
    const unknown = await journal.uncertain(actor.id, claimed.id, args);
    await assert.rejects(journal.review(actor.id, unknown.id, { expectedVersion: unknown.version }), { code: 'invalid_provisioning_transition' });
  });

  await t.test('real journal and authoritative artifact compiler bind one approved tenant', async child => {
    await tenant('artifact-bridge');
    const directoryPath = await mkdtemp(join(tmpdir(), 'onlinu-journal-artifact-'));
    child.after(() => rm(directoryPath, { recursive: true, force: true }));
    const config = { tenantId: 'artifact-bridge', runtimeImage: 'registry.example/onlinu@sha256:' + 'a'.repeat(64),
      postgresImage: 'postgres@sha256:' + 'b'.repeat(64), httpPort: 18080,
      publicOrigin: 'https://artifact-bridge.example.invalid', platformIssuer: 'https://platform.example.invalid',
      platformPublicKey: Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64') };
    const source = JSON.stringify([config]);
    const compiler = fileURLToPath(new URL('../../deploy/tenant_plan.py', import.meta.url));
    const plan = JSON.parse(execFileSync('/usr/bin/python3', ['-I', '-S', '-B', compiler], {
      input: source, encoding: 'utf8', timeout: 5000, maxBuffer: 262144,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    }))[0];
    await writeFile(join(directoryPath, plan.planDigest + '.json'), source, { mode: 0o600 });
    const queued = await journal.request(actor.id, 'artifact-bridge', { ...request(), planDigest: plan.planDigest });
    const artifacts = createProvisioningArtifacts({ journal, artifactDirectory: directoryPath, secretRoot: '/srv/onlinu/tenant-secrets',
      platformIssuer: config.platformIssuer, platformPublicKey: config.platformPublicKey,
      runtimeImage: config.runtimeImage, postgresImage: config.postgresImage, bootstrapSha256: plan.postgres.bootstrapAssetSha256 });
    await assert.rejects(artifacts.prepare(owner.id, queued.id, { expectedVersion: queued.version }), { code: 'forbidden' });
    const result = await artifacts.prepare(actor.id, queued.id, { expectedVersion: queued.version });
    assert.equal(result.plan.tenantId, 'artifact-bridge'); assert.equal(result.job.state, 'queued');
    const claimed = await journal.claim(actor.id, queued.id, claiming(queued));
    await assert.rejects(artifacts.prepare(actor.id, claimed.id, { expectedVersion: claimed.version }), { code: 'provisioning_worker_mismatch' });
    assert.equal((await artifacts.prepare(actor.id, claimed.id, { expectedVersion: claimed.version, workerId: claimed.workerId })).job.workerId, claimed.workerId);
    await pool.query("UPDATE platform_provision_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [claimed.id]);
    await assert.rejects(artifacts.prepare(actor.id, claimed.id, { expectedVersion: claimed.version, workerId: claimed.workerId }), { code: 'provisioning_lease_expired' });
    let pending = await journal.expire(actor.id, claimed.id, { expectedVersion: claimed.version });
    pending = await journal.reconcile(actor.id, pending.id, { expectedVersion: pending.version, decision: 'requeue', evidenceDigest: evidence });
    let locked = false, applies = 0, expireDuringApply = true;
    const hostLock = createProvisioningHostLock({ directory: directoryPath });
    const stage = createProvisioningStage({ journal, directory: directoryPath });
    let staged;
    const driver = {
      async withLock(resource, operation) {
        assert.equal(resource, plan.projectName);
        return hostLock.withLock(resource, async () => {
          assert.equal(locked, false); locked = true;
          try { return await operation(); } finally { locked = false; }
        });
      },
      async inspect(prepared) { assert.ok(locked); assert.equal(prepared.job.id, pending.id); },
      async apply(prepared, { checkpoint }) {
        assert.ok(locked); applies++;
        if (expireDuringApply) await pool.query("UPDATE platform_provision_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [pending.id]);
        const fence = await checkpoint();
        staged = await stage.stage(actor.id, prepared, { expectedVersion: fence.version, workerId: fence.workerId });
      },
      async verify(prepared) {
        return { jobId: prepared.job.id, tenantId: prepared.job.tenantId,
          planDigest: prepared.job.planDigest, verificationSha256: evidence };
      },
    };
    const runner = createProvisioningRunner({ journal, artifacts, driver });
    await assert.rejects(runner.run(actor.id, pending.id, { expectedVersion: pending.version, workerId: randomUUID() }),
      { code: 'provisioning_outcome_unknown' });
    pending = await journal.get(actor.id, pending.id);
    assert.equal(pending.state, 'unknown'); assert.equal(applies, 1); assert.equal(locked, false);
    await assert.rejects(runner.run(actor.id, pending.id, { expectedVersion: pending.version, workerId: randomUUID() }),
      { code: 'invalid_provisioning_transition' });
    pending = await journal.reconcile(actor.id, pending.id, { expectedVersion: pending.version, decision: 'requeue', evidenceDigest: evidence });
    expireDuringApply = false;
    const completed = await runner.run(actor.id, pending.id, { expectedVersion: pending.version, workerId: randomUUID() });
    assert.equal(completed.state, 'succeeded'); assert.equal(applies, 2); assert.equal(locked, false);
    assert.equal(staged.receipt.planDigest, plan.planDigest);
    assert.equal(staged.receipt.jobId, pending.id);
    assert.equal((await journal.get(actor.id, pending.id)).evidenceDigest, completed.evidenceDigest);
    assert.equal((await pool.query("SELECT status FROM platform_tenants WHERE id='artifact-bridge'")).rows[0].status, 'draft');
  });

  await t.test('audit failure rolls back intent and new store recovers existing state', async () => {
    await tenant('audit');
    await pool.query(`CREATE FUNCTION reject_provision_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='provisioning_requested' AND NEW.tenant_id='audit' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER reject_provision_audit BEFORE INSERT ON platform_identity_audit FOR EACH ROW EXECUTE FUNCTION reject_provision_audit();`);
    const input = request();
    await assert.rejects(journal.request(actor.id, 'audit', input), /synthetic audit failure/);
    assert.equal((await pool.query('SELECT 1 FROM platform_provision_jobs WHERE id=$1', [input.requestId])).rowCount, 0);
    await pool.query('DROP TRIGGER reject_provision_audit ON platform_identity_audit; DROP FUNCTION reject_provision_audit();');
    const reopened = createProvisioningJournal({ pool }); await reopened.init();
    assert.equal((await reopened.get(actor.id, shared.id)).state, 'succeeded');
    await assert.rejects(reopened.get(owner.id, shared.id), { code: 'forbidden' });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM platform_tenants WHERE status='active'")).rows[0].n, 0);
  });
});
