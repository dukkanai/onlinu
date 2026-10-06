import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createProvisioningRunner } from './provisioning-runner.mjs';
import { problem } from './auth.mjs';

function fixture() {
  const actor = randomUUID(), workerId = randomUUID(), jobId = randomUUID();
  let row = { id: jobId, tenantId: 'runner-fixture', planDigest: 'a'.repeat(64), state: 'queued', version: 1 };
  const events = [], calls = { apply: 0, finish: 0, uncertain: 0 };
  let locked = false, enabled = true;
  function check(input) {
    if (!enabled) throw problem(403, 'identity_disabled');
    if (input.expectedVersion !== row.version) throw problem(409, 'version_conflict');
  }
  const journal = {
    async review(_actor, _job, input) { check(input); return { ...row }; },
    async claim(_actor, _job, input) {
      check(input); assert.ok(locked); assert.equal(row.state, 'queued'); events.push('claim');
      row = { ...row, version: row.version + 1, state: 'claimed', workerId: input.workerId }; return { ...row };
    },
    async heartbeat(_actor, _job, input) {
      check(input); assert.ok(locked); assert.equal(row.state, 'claimed'); events.push('checkpoint');
      row.version++; return { ...row };
    },
    async finish(_actor, _job, input) {
      check(input); assert.ok(locked); calls.finish++; events.push('finish');
      assert.match(input.evidenceDigest, /^[a-f0-9]{64}$/);
      row = { ...row, version: row.version + 1, state: 'succeeded', evidenceDigest: input.evidenceDigest }; return { ...row };
    },
    async uncertain(_actor, _job, input) {
      calls.uncertain++; check(input); assert.ok(locked); events.push('unknown');
      row = { ...row, version: row.version + 1, state: 'unknown' }; return { ...row };
    },
  };
  const artifacts = { async prepare(_actor, _job, input) {
    check(input); events.push('prepare'); return { job: { ...row }, plan: { projectName: 'onlinu-fixture' } };
  } };
  const driver = {
    async withLock(name, operation) {
      assert.equal(name, 'onlinu-fixture'); assert.equal(locked, false); locked = true; events.push('lock');
      try { return await operation(); } finally { locked = false; events.push('unlock'); }
    },
    async inspect() { assert.ok(locked); events.push('inspect'); },
    async apply(_prepared, { checkpoint }) {
      assert.ok(locked); calls.apply++; events.push('apply'); await checkpoint();
    },
    async verify() {
      assert.ok(locked); events.push('verify');
      return { jobId, tenantId: row.tenantId, planDigest: row.planDigest, verificationSha256: 'b'.repeat(64) };
    },
  };
  return { actor, jobId, workerId, journal, artifacts, driver, events, calls,
    state: () => ({ ...row }), disable: () => { enabled = false; },
    setVersion: value => { row.version = value; },
    run: () => createProvisioningRunner({ journal, artifacts, driver }).run(actor, jobId, { expectedVersion: 1, workerId }) };
}

test('runner requires every private authority and host driver operation', () => {
  const f = fixture();
  assert.throws(() => createProvisioningRunner({ journal: {}, artifacts: f.artifacts, driver: f.driver }), /configuration/);
  assert.throws(() => createProvisioningRunner({ journal: f.journal, artifacts: {}, driver: f.driver }), /configuration/);
  assert.throws(() => createProvisioningRunner({ journal: f.journal, artifacts: f.artifacts, driver: {} }), /configuration/);
});

test('one attempt keeps host lock across claim, apply, verification and finish', async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.state, 'succeeded'); assert.equal(f.calls.apply, 1); assert.equal(f.calls.finish, 1);
  assert.equal(f.calls.uncertain, 0);
  assert.deepEqual(f.events, ['prepare', 'lock', 'claim', 'prepare', 'inspect', 'checkpoint', 'apply',
    'checkpoint', 'checkpoint', 'verify', 'checkpoint', 'finish', 'unlock']);
  await assert.rejects(f.run(), { code: 'version_conflict' }); assert.equal(f.calls.apply, 1);
});

test('authority failure before touching host does not acquire lock or mutate journal', async () => {
  const f = fixture(); f.disable();
  await assert.rejects(f.run(), { code: 'identity_disabled' });
  assert.deepEqual(f.events, []); assert.equal(f.state().state, 'queued');
});

test('lost claim response never applies or guesses how to recover claim', async () => {
  const f = fixture(), claim = f.journal.claim;
  f.journal.claim = async (...args) => { await claim(...args); throw problem(503, 'database_unavailable'); };
  await assert.rejects(f.run(), { code: 'provisioning_claim_not_confirmed' });
  assert.equal(f.state().state, 'claimed'); assert.equal(f.calls.apply, 0); assert.equal(f.calls.uncertain, 0);
  assert.equal(f.events.at(-1), 'unlock');
});

test('inspection or apply failure marks uncertainty and never retries or rolls back', async () => {
  for (const stage of ['inspect', 'apply', 'verify']) {
    const f = fixture(); f.driver[stage] = async () => { throw new Error('raw-secret-and-path-must-not-escape'); };
    await assert.rejects(f.run(), error => error.code === 'provisioning_outcome_unknown'
      && !error.message.includes('raw-secret'));
    assert.equal(f.state().state, 'unknown'); assert.equal(f.calls.finish, 0); assert.equal(f.calls.uncertain, 1);
    assert.equal(f.events.at(-1), 'unlock');
  }
});

test('revoked authority after inspection prevents any apply and needs reconciliation', async () => {
  const f = fixture(); f.driver.inspect = async () => { f.disable(); };
  await assert.rejects(f.run(), { code: 'provisioning_reconciliation_required' });
  assert.equal(f.calls.apply, 0); assert.equal(f.calls.finish, 0); assert.equal(f.state().state, 'claimed');
});

test('concurrent driver checkpoints serialize journal versions', async () => {
  const f = fixture();
  f.driver.apply = async (_prepared, { checkpoint }) => {
    const checkpoints = await Promise.all([checkpoint(), checkpoint(), checkpoint()]);
    assert.deepEqual(checkpoints.map(x => x.version), [4, 5, 6]);
    assert.ok(checkpoints.every(Object.isFrozen));
  };
  assert.equal((await f.run()).state, 'succeeded');
});

test('lost heartbeat reply forbids finish or automatic reclaim', async () => {
  const f = fixture(), heartbeat = f.journal.heartbeat;
  f.journal.heartbeat = async (...args) => { await heartbeat(...args); throw new Error('connection-lost'); };
  await assert.rejects(f.run(), { code: 'provisioning_reconciliation_required' });
  assert.equal(f.calls.apply, 0); assert.equal(f.calls.finish, 0); assert.equal(f.state().state, 'claimed');
});

test('verification evidence must match exact job, tenant, digest and strict schema', async () => {
  for (const change of [{ jobId: randomUUID() }, { tenantId: 'neighbor' }, { planDigest: 'c'.repeat(64) },
    { verificationSha256: 'invalid' }, { secret: 'not-accepted' }]) {
    const f = fixture(), verify = f.driver.verify;
    f.driver.verify = async () => ({ ...await verify(), ...change });
    await assert.rejects(f.run(), { code: 'provisioning_outcome_unknown' });
    assert.equal(f.calls.finish, 0); assert.equal(f.state().state, 'unknown');
  }
});

test('lost finish response retains completed result without a second apply', async () => {
  const f = fixture(), finish = f.journal.finish;
  f.journal.finish = async (...args) => { await finish(...args); throw new Error('lost-response'); };
  await assert.rejects(f.run(), { code: 'provisioning_reconciliation_required' });
  assert.equal(f.calls.apply, 1); assert.equal(f.state().state, 'succeeded');
  await assert.rejects(f.run(), { code: 'version_conflict' }); assert.equal(f.calls.apply, 1);
});

test('escaped checkpoint cannot extend a finished lease', async () => {
  const f = fixture(); let late;
  f.driver.apply = async (_prepared, { checkpoint }) => { late = checkpoint; };
  await f.run(); const before = f.state();
  await assert.rejects(late(), { code: 'provisioning_attempt_stopped' }); assert.deepEqual(f.state(), before);
});


test('host lock failures hide raw diagnostics, including release after success', async () => {
  for (const after of [false, true]) {
    const f = fixture(), lock = f.driver.withLock;
    f.driver.withLock = async (...args) => {
      if (after) await lock(...args);
      throw new Error('secret-host-path');
    };
    await assert.rejects(f.run(), error => error.code === 'provisioning_reconciliation_required'
      && !error.message.includes('secret-host-path'));
    assert.equal(f.calls.apply, after ? 1 : 0);
    assert.equal(f.state().state, after ? 'succeeded' : 'queued');
  }
});

test('driver swallowing a failed checkpoint cannot publish success', async () => {
  const f = fixture();
  f.driver.apply = async (_prepared, { checkpoint }) => {
    f.setVersion(100);
    try { await checkpoint(); } catch { /* Deliberately broken fixture driver. */ }
  };
  await assert.rejects(f.run(), { code: 'provisioning_reconciliation_required' });
  assert.equal(f.calls.finish, 0);
});


test('attempt inputs are strict and snapshotted before asynchronous preparation', async () => {
  const f = fixture(), runner = createProvisioningRunner(f);
  for (const input of [null, {}, { expectedVersion: 0, workerId: f.workerId },
    { expectedVersion: 1, workerId: 'invalid' }, { expectedVersion: 1, workerId: f.workerId, command: 'ignored' }])
    await assert.rejects(runner.run(f.actor, f.jobId, input), { code: 'invalid_request' });
  assert.deepEqual(f.events, []);
  const input = { expectedVersion: 1, workerId: f.workerId };
  const result = runner.run(f.actor, f.jobId, input);
  input.workerId = randomUUID(); input.expectedVersion = 999;
  assert.equal((await result).state, 'succeeded'); assert.equal(f.state().workerId, f.workerId);
});
