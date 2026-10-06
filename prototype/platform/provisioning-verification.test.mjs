import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProvisioningVerification } from './provisioning-verification.mjs';
import { createProvisioningEvidence } from './provisioning-evidence.mjs';
import { runtimeObservationFixture } from './integration/runtime-observation-fixture.mjs';
const sourceCommit = 'a'.repeat(40);
const rejected = e => e.code === 'provisioning_verification_rejected' && !JSON.stringify(e).includes('PRIVATE');
async function setup(t, { auth, inspect, write, read } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'onlinu-verification-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { expected, observed } = runtimeObservationFixture();
  const job = { id: randomUUID(), workerId: randomUUID(), state: 'claimed', tenantId: expected.tenantId, planDigest: expected.planDigest };
  const resources = Object.fromEntries(observed.containers.map(v => [v.Config.Labels['com.docker.compose.service'], { containerId: v.Id, imageId: v.Image }]));
  const store = createProvisioningEvidence({ directory: root }), calls = [];
  const verification = createProvisioningVerification({ sourceCommit, scope: 'fixture', probe: { async inspect(...args) {
    calls.push('inspect'); return inspect ? await inspect(resources, calls, ...args) : resources;
  } }, authenticate: async (...args) => {
    calls.push('auth'); return auth ? await auth(resources, ...args) : { authenticated: true, unauthorizedRejected: true };
  }, evidence: { async write(report) { calls.push('write'); return write ? await write(report, store) : store.write(report); },
    async read(ref) { calls.push('read'); return read ? await read(ref, store) : createProvisioningEvidence({ directory: root }).read(ref); } } });
  return { root, verification, expected, job, resources, calls, store };
}
test('verification binds two stable observations and authenticated behavior to durable evidence', async t => {
  const f = await setup(t, { auth: async (_, target) => {
    assert.deepEqual(target, { tenantId: 'synthetic-a', port: 18080 });
    assert.ok(Object.isFrozen(target)); return { authenticated: true, unauthorizedRejected: true };
  } });
  const result = await f.verification.verify({ job: f.job, expected: f.expected });
  assert.deepEqual(f.calls, ['inspect','auth','inspect','write','read']);
  assert.ok(Object.isFrozen(result.evidence.stored.report.resources));
  assert.equal(result.verificationSha256, result.evidence.reference.sha256);
  assert.equal(result.evidence.stored.report.sourceCommit, sourceCommit);
  assert.equal(result.evidence.stored.report.scope, 'fixture');
  assert.equal(result.evidence.stored.report.tenantId, f.job.tenantId);
});
test('verification cannot attest a failed ambiguous or unexpected authentication result', async t => {
  for (const auth of [{ authenticated: false, unauthorizedRejected: true }, { authenticated: true, unauthorizedRejected: false },
    { authenticated: 'yes', unauthorizedRejected: true }, { authenticated: true, unauthorizedRejected: true, detail: 'PRIVATE' }, null]) {
    const f = await setup(t, { auth: async () => auth });
    await assert.rejects(f.verification.verify({ job: f.job, expected: f.expected }), rejected);
    assert.deepEqual(f.calls, ['inspect','auth']); assert.deepEqual(await readdir(f.root), []);
  }
});
test('verification rejects container replacement during authentication and retains first snapshot', async t => {
  const f = await setup(t, { auth: async resources => { resources.restaurant.containerId = '9'.repeat(64); return { authenticated: true, unauthorizedRejected: true }; } });
  await assert.rejects(f.verification.verify({ job: f.job, expected: f.expected }), rejected);
  assert.deepEqual(f.calls, ['inspect','auth','inspect']); assert.deepEqual(await readdir(f.root), []);
});
test('verification rejects mismatched attempt before probes and explicit unknown state may reconcile', async t => {
  const f = await setup(t);
  for (const patch of [{ tenantId: 'other' }, { workerId: '' }, { planDigest: 'c'.repeat(64) }, { state: 'succeeded' }]) {
    await assert.rejects(f.verification.verify({ job: { ...f.job, ...patch }, expected: f.expected }), rejected);
    assert.equal(f.calls.length, 0);
  }
  const result = await f.verification.verify({ job: { ...f.job, state: 'unknown' }, expected: f.expected });
  assert.equal(result.jobId, f.job.id);
});
test('verification rejects substituted stored evidence and lost write replies without retry', async t => {
  let f = await setup(t, { read: async (ref, store) => ({ ...await store.read(ref), report: {} }) });
  await assert.rejects(f.verification.verify({ job: f.job, expected: f.expected }), rejected);
  assert.equal(f.calls.filter(v => v === 'write').length, 1);
  f = await setup(t, { write: async (report, store) => { await store.write(report); throw new Error('PRIVATE lost reply'); } });
  await assert.rejects(f.verification.verify({ job: f.job, expected: f.expected }), rejected);
  assert.equal(f.calls.filter(v => v === 'write').length, 1);
  assert.equal((await readdir(f.root)).length, 1, 'durable receipt retained, never removed or retried');
});
test('verification cancellation before or during probes never emits evidence', async t => {
  const abort = new AbortController();
  const f = await setup(t, { auth: async () => { abort.abort(); return { authenticated: true, unauthorizedRejected: true }; } });
  await assert.rejects(f.verification.verify({ job: f.job, expected: f.expected }, { signal: abort.signal }), rejected);
  assert.deepEqual(f.calls, ['inspect','auth']);
  const before = f.calls.length;
  await assert.rejects(f.verification.verify({ job: f.job, expected: f.expected }, { signal: abort.signal }), rejected);
  assert.equal(f.calls.length, before);
});
