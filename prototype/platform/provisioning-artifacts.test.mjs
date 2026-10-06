import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, chmod, unlink, symlink, link, access, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { createProvisioningArtifacts } from './provisioning-artifacts.mjs';
import { problem } from './auth.mjs';
import { createProvisioningStage } from './provisioning-stage.mjs';

const compiler = fileURLToPath(new URL('../../deploy/tenant_plan.py', import.meta.url));
const bootstrap = fileURLToPath(new URL('../../deploy/tenant-bootstrap.sql', import.meta.url));
const publicKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64');
const config = { tenantId: 'artifact-a', runtimeImage: 'registry.example/onlinu@sha256:' + 'a'.repeat(64),
  postgresImage: 'postgres@sha256:' + 'b'.repeat(64), httpPort: 18080,
  publicOrigin: 'https://artifact-a.example.invalid', platformIssuer: 'https://platform.example.invalid', platformPublicKey: publicKey };
function compiled(input) {
  return JSON.parse(execFileSync('/usr/bin/python3', ['-I', '-S', '-B', compiler], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 5000, maxBuffer: 262144,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  }));
}
async function fixture(t, change = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'onlinu-artifact-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = { ...config, ...change }, plan = compiled([input])[0];
  const path = join(directory, plan.planDigest + '.json');
  await writeFile(path, JSON.stringify([input]), { mode: 0o600 });
  const actor = randomUUID();
  const job = { id: randomUUID(), tenantId: input.tenantId, planDigest: plan.planDigest, expectedTenantVersion: 1,
    version: 1, state: 'queued', createdBy: actor, claimedBy: null, workerId: null, leaseUntil: null, evidenceDigest: null };
  let reviews = 0;
  const journal = { async review(who, id, args) {
    reviews++;
    assert.equal(who, actor); assert.equal(id, job.id); assert.equal(args.expectedVersion, job.version);
    return { ...job };
  } };
  const policy = { journal, artifactDirectory: directory, secretRoot: '/srv/onlinu/tenant-secrets',
    platformIssuer: config.platformIssuer, platformPublicKey: publicKey,
    runtimeImage: config.runtimeImage, postgresImage: config.postgresImage,
    bootstrapSha256: createHash('sha256').update(await readFile(bootstrap)).digest('hex') };
  return { directory, path, actor, job, input, plan, journal, policy, reviews: () => reviews,
    prepare: () => createProvisioningArtifacts(policy).prepare(actor, job.id, { expectedVersion: job.version }) };
}

test('private artifact preparation uses authoritative compiler and immutable output', async t => {
  const f = await fixture(t);
  const before = await readdir(f.directory);
  const result = await f.prepare();
  assert.equal(f.reviews(), 2);
  assert.equal(result.plan.planDigest, f.job.planDigest);
  assert.equal(result.compose.name, f.plan.projectName);
  assert.equal(result.compose.services.restaurant.image, config.runtimeImage);
  assert.equal(result.compose['x-onlinu'].deployed, false);
  assert.equal(createHash('sha256').update(result.bootstrapSQL).digest('hex'), f.policy.bootstrapSha256);
  assert.deepEqual(await readdir(f.directory), before, 'preflight creates no artifact or secret file');
  assert.throws(() => { result.compose.services.restaurant.image = 'unreviewed'; }, TypeError);
  assert.equal(result.job.state, 'queued');
});

test('artifact worker configuration rejects unsafe or non-pinned policies', async t => {
  const f = await fixture(t);
  for (const change of [{ runtimeImage: 'latest' }, { postgresImage: 'postgres:16' }, { bootstrapSha256: 'bad' },
    { platformPublicKey: 'not-a-public-key' }, { platformIssuer: 'http://platform.example' },
    { platformIssuer: 'https://platform.example/path' }, { secretRoot: '/etc' }, { secretRoot: '/srv/onlinu/../etc' },
    { artifactDirectory: 'relative' }, { artifactOwnerUID: -1 }, { journal: {} }]) {
    assert.throws(() => createProvisioningArtifacts({ ...f.policy, ...change }), /configuration/);
  }
});

test('operator review happens before filesystem access and is rechecked afterward', async t => {
  const f = await fixture(t);
  const denied = createProvisioningArtifacts({ ...f.policy, artifactDirectory: '/does-not-exist',
    journal: { async review() { throw problem(403, 'forbidden'); } } });
  await assert.rejects(denied.prepare(f.actor, f.job.id, { expectedVersion: 1 }), { code: 'forbidden' });
  let calls = 0;
  const revoked = createProvisioningArtifacts({ ...f.policy, journal: { async review() {
    if (++calls === 2) throw problem(403, 'identity_disabled');
    return { ...f.job };
  } } });
  await assert.rejects(revoked.prepare(f.actor, f.job.id, { expectedVersion: 1 }), { code: 'identity_disabled' });
  assert.equal(calls, 2);
});

test('unsafe artifact ownership and writable modes fail closed', async t => {
  const f = await fixture(t);
  await assert.rejects(createProvisioningArtifacts({ ...f.policy, artifactOwnerUID: process.getuid() + 1 })
    .prepare(f.actor, f.job.id, { expectedVersion: 1 }), { code: 'provisioning_artifact_rejected' });
  await chmod(f.path, 0o660);
  await assert.rejects(f.prepare(), { code: 'provisioning_artifact_rejected' });
  await chmod(f.path, 0o600); await chmod(f.directory, 0o777);
  await assert.rejects(f.prepare(), { code: 'provisioning_artifact_rejected' });
});

test('symlinks, hard links, directories and FIFOs cannot stand in for an artifact', async t => {
  const f = await fixture(t);
  const original = await readFile(f.path), target = join(f.directory, 'owned-target.json');
  await writeFile(target, original, { mode: 0o600 }); await unlink(f.path);
  await symlink(target, f.path);
  await assert.rejects(f.prepare(), { code: 'provisioning_artifact_rejected' });
  await unlink(f.path); await link(target, f.path);
  await assert.rejects(f.prepare(), { code: 'provisioning_artifact_rejected' });
  await unlink(f.path);
  execFileSync('/usr/bin/mkfifo', [f.path], { timeout: 1000 });
  await assert.rejects(f.prepare(), { code: 'provisioning_artifact_rejected' });
});

test('oversized, invalid UTF-8, malformed and duplicate-key input are rejected without echo', async t => {
  const f = await fixture(t);
  const duplicate = JSON.stringify([f.input]).replace('"tenantId":"artifact-a"', '"tenantId":"artifact-a","tenantId":"artifact-a"');
  for (const value of [Buffer.alloc(262145, 32), Buffer.from([255]), '{"secret":"PRIVATE_MARKER"', duplicate]) {
    await writeFile(f.path, value);
    await assert.rejects(f.prepare(), error => error.code === 'provisioning_artifact_rejected'
      && !error.message.includes('PRIVATE_MARKER') && !error.message.includes(f.directory));
  }
});

test('multiple plans and changed artifact content cannot use a single journal request', async t => {
  const f = await fixture(t);
  const other = { ...f.input, tenantId: 'artifact-b', publicOrigin: 'https://artifact-b.example.invalid', httpPort: 18081 };
  await writeFile(f.path, JSON.stringify([f.input, other]));
  await assert.rejects(f.prepare(), { code: 'provisioning_artifact_rejected' });
  await writeFile(f.path, JSON.stringify([{ ...f.input, httpPort: 18082 }]));
  await assert.rejects(f.prepare(), { code: 'provisioning_release_mismatch' });
});

test('tenant binding, approved images, issuer, public key and bootstrap release must match', async t => {
  const f = await fixture(t);
  f.job.tenantId = 'another-tenant';
  await assert.rejects(f.prepare(), { code: 'provisioning_release_mismatch' });
  f.job.tenantId = f.input.tenantId;
  for (const change of [{ runtimeImage: 'registry.example/onlinu@sha256:' + 'c'.repeat(64) },
    { postgresImage: 'postgres@sha256:' + 'd'.repeat(64) }, { platformIssuer: 'https://other.example.invalid' },
    { platformPublicKey: Buffer.alloc(32, 7).toString('base64') }, { bootstrapSha256: 'e'.repeat(64) }]) {
    await assert.rejects(createProvisioningArtifacts({ ...f.policy, ...change }).prepare(f.actor, f.job.id, { expectedVersion: 1 }),
      { code: 'provisioning_release_mismatch' });
  }
});

test('a journal change during compilation prevents returning a stale preparation', async t => {
  const f = await fixture(t);
  let calls = 0;
  const reader = createProvisioningArtifacts({ ...f.policy, journal: { async review() {
    return { ...f.job, version: ++calls === 1 ? 1 : 2 };
  } } });
  await assert.rejects(reader.prepare(f.actor, f.job.id, { expectedVersion: 1 }), { code: 'provisioning_changed_during_preflight' });
});

test('compiler ignores Python startup injection and does not modify the artifact directory', async t => {
  const f = await fixture(t);
  const marker = join(f.directory, 'startup-must-not-run');
  await writeFile(join(f.directory, 'sitecustomize.py'), `open(${JSON.stringify(marker)}, 'w').write('unexpected')`);
  const oldPath = process.env.PYTHONPATH;
  process.env.PYTHONPATH = f.directory;
  try { await f.prepare(); }
  finally { if (oldPath === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = oldPath; }
  await assert.rejects(access(marker));
});


async function stageFixture(t) {
  const f = await fixture(t);
  f.job.state = 'claimed'; f.job.workerId = randomUUID(); f.job.claimedBy = f.actor;
  const prepared = await f.prepare();
  const directory = await mkdtemp(join(tmpdir(), 'onlinu-stage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const args = { expectedVersion: f.job.version, workerId: f.job.workerId };
  return { ...f, prepared, directory, args, stager: createProvisioningStage({ journal: f.journal, directory }) };
}

test('reviewed staging writes exact public artifacts exclusively and preserves their hashes', async t => {
  const f = await stageFixture(t);
  const result = await f.stager.stage(f.actor, f.prepared, f.args);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.receipt));
  const raw = await readFile(result.manifestPath, 'utf8');
  assert.deepEqual(JSON.parse(raw), f.prepared.compose);
  assert.equal(createHash('sha256').update(raw).digest('hex'), result.receipt.manifestSha256);
  assert.equal(await readFile(result.bootstrapPath, 'utf8'), f.prepared.bootstrapSQL);
  assert.equal((await stat(result.manifestPath)).mode & 0o777, 0o600);
  assert.equal((await stat(result.bootstrapPath)).mode & 0o777, 0o444);
  assert.deepEqual((await readdir(result.directory)).sort(), ['compose.json', 'receipt.json', 'tenant-bootstrap.sql']);
  await assert.rejects(f.stager.stage(f.actor, f.prepared, f.args), { code: 'provisioning_stage_rejected' });
  assert.equal(await readFile(result.manifestPath, 'utf8'), raw, 'retry cannot overwrite evidence');
});

test('staging rejects unbranded or queued objects before writing any files', async t => {
  const f = await stageFixture(t);
  await assert.rejects(f.stager.stage(f.actor, structuredClone(f.prepared), f.args), { code: 'provisioning_stage_rejected' });
  f.job.state = 'queued'; f.job.workerId = null; f.job.claimedBy = null;
  await assert.rejects(f.stager.stage(f.actor, await f.prepare(), f.args), { code: 'provisioning_stage_rejected' });
  assert.deepEqual(await readdir(f.directory), []);
});

test('staging checks live authority before filesystem access and retains evidence after later revocation', async t => {
  const f = await stageFixture(t);
  const denied = createProvisioningStage({ directory: '/does-not-exist', journal: {
    async review() { throw problem(403, 'identity_disabled'); },
  } });
  await assert.rejects(denied.stage(f.actor, f.prepared, f.args), { code: 'identity_disabled' });
  let calls = 0;
  const revoked = createProvisioningStage({ directory: f.directory, journal: {
    async review() { if (++calls === 2) throw problem(403, 'identity_disabled'); return { ...f.job }; },
  } });
  await assert.rejects(revoked.stage(f.actor, f.prepared, f.args), { code: 'identity_disabled' });
  const project = join(f.directory, f.prepared.plan.projectName);
  const attempt = join(project, f.job.id + '-' + f.job.workerId);
  assert.deepEqual((await readdir(attempt)).sort(), ['compose.json', 'receipt.json', 'tenant-bootstrap.sql']);
  await assert.rejects(f.stager.stage(f.actor, f.prepared, f.args), { code: 'provisioning_stage_rejected' });
});

test('staging rejects a changed worker or unsafe host directory', async t => {
  const f = await stageFixture(t);
  const changed = createProvisioningStage({ directory: f.directory, journal: {
    async review() { return { ...f.job, workerId: randomUUID() }; },
  } });
  await assert.rejects(changed.stage(f.actor, f.prepared, f.args), { code: 'provisioning_stage_rejected' });
  await chmod(f.directory, 0o755);
  await assert.rejects(f.stager.stage(f.actor, f.prepared, f.args), { code: 'provisioning_stage_rejected' });
  await chmod(f.directory, 0o700);
  const alias = join(f.directory, 'alias'); await symlink(f.directory, alias);
  await assert.rejects(createProvisioningStage({ journal: f.journal, directory: alias }).stage(f.actor, f.prepared, f.args),
    { code: 'provisioning_stage_rejected' });
  await assert.rejects(createProvisioningStage({ journal: f.journal, directory: f.directory, ownerUID: process.getuid() + 1 })
    .stage(f.actor, f.prepared, f.args), { code: 'provisioning_stage_rejected' });
});
