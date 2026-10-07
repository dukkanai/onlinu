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
import { createProvisioningRunner } from './provisioning-runner.mjs';
import { createProvisioningHostDriver } from './provisioning-host-driver.mjs';
import { createProvisioningImagePreflight } from './provisioning-image-preflight.mjs';
import { createProvisioningExecutionManifest } from './provisioning-execution-manifest.mjs';

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

test('stage verification binds exact bytes and preserves current worker lease without writes', async t => {
  const f = await stageFixture(t), staged = await f.stager.stage(f.actor, f.prepared, f.args);
  const before = await stat(staged.manifestPath);
  assert.equal(await f.stager.verify(f.actor, f.prepared, staged, f.args), staged);
  assert.equal((await stat(staged.manifestPath)).mtimeMs, before.mtimeMs);
  f.job.version++;
  assert.equal(await f.stager.verify(f.actor, f.prepared, staged, { ...f.args, expectedVersion: f.job.version }), staged);
  await assert.rejects(f.stager.verify(f.actor, f.prepared, structuredClone(staged), { ...f.args, expectedVersion: f.job.version }), { code: 'provisioning_stage_rejected' });
});
test('stage verification refuses tampered manifests bootstrap and receipt without repairing', async t => {
  for (const field of ['manifestPath', 'bootstrapPath', 'receipt']) {
    const f = await stageFixture(t), staged = await f.stager.stage(f.actor, f.prepared, f.args);
    const path = field === 'receipt' ? join(staged.directory, 'receipt.json') : staged[field];
    const original = await readFile(path);
    await chmod(path, 0o600); await writeFile(path, Buffer.concat([original, Buffer.from('changed')]));
    await chmod(path, field === 'bootstrapPath' ? 0o444 : 0o600);
    await assert.rejects(f.stager.verify(f.actor, f.prepared, staged, f.args), { code: 'provisioning_stage_rejected' });
    assert.equal((await readFile(path)).length, original.length + 7);
  }
});
test('stage verification refuses symlink hardlink mode and owner substitution', async t => {
  for (const kind of ['symlink', 'hardlink', 'mode', 'owner']) {
    const f = await stageFixture(t), staged = await f.stager.stage(f.actor, f.prepared, f.args);
    if (kind === 'mode') await chmod(staged.manifestPath, 0o640);
    else if (kind === 'symlink') {
      const target = join(staged.directory, 'substitute');
      await writeFile(target, await readFile(staged.manifestPath), { mode: 0o600 });
      await unlink(staged.manifestPath); await symlink(target, staged.manifestPath);
    } else if (kind === 'hardlink') await link(staged.manifestPath, join(staged.directory, 'alias'));
    const verifier = kind === 'owner' ? createProvisioningStage({ journal: f.journal, directory: f.directory, ownerUID: process.getuid() + 1 }) : f.stager;
    await assert.rejects(verifier.verify(f.actor, f.prepared, staged, f.args), { code: 'provisioning_stage_rejected' });
  }
});
test('stage verification rechecks authority and rejects changed attempt before returning', async t => {
  const f = await stageFixture(t), staged = await f.stager.stage(f.actor, f.prepared, f.args);
  const denied = createProvisioningStage({ directory: '/does-not-exist', journal: { async review() { throw problem(403, 'identity_disabled'); } } });
  await assert.rejects(denied.verify(f.actor, f.prepared, staged, f.args), { code: 'identity_disabled' });
  let count = 0;
  const revoked = createProvisioningStage({ directory: f.directory, journal: { async review() {
    if (++count === 2) throw problem(403, 'identity_disabled'); return { ...f.job };
  } } });
  await assert.rejects(revoked.verify(f.actor, f.prepared, staged, f.args), { code: 'identity_disabled' });
  assert.equal(count, 2);
  f.job.workerId = randomUUID();
  await assert.rejects(f.stager.verify(f.actor, f.prepared, staged, f.args), { code: 'provisioning_stage_rejected' });
  assert.ok((await stat(staged.manifestPath)).isFile());
});

test('execution manifest capability uses only original staged bytes and reviewed secret references', async t => {
  const f=await stageFixture(t),staged=await f.stager.stage(f.actor,f.prepared,f.args);
  let checked=0;
  const supplier=createProvisioningExecutionManifest({stage:f.stager,actorId:f.actor,secretPreflight:{async check(input){
    checked++;assert.equal(input.tenantId,f.job.tenantId);
    assert.deepEqual(input.refs,Object.fromEntries(Object.entries(f.prepared.compose.secrets).map(([key,value])=>[key,value.file])));
    return {tenantId:f.job.tenantId,projectName:f.prepared.plan.projectName,checkedReferences:Object.keys(input.refs)};
  }}});
  const capability=supplier.bind(f.prepared,staged,{currentFence:()=>f.args});
  assert.ok(Object.isFrozen(capability));assert.equal(await capability.verifyExecution(),staged.manifestPath);assert.equal(checked,1);
  assert.throws(()=>supplier.bind(structuredClone(f.prepared),staged,{currentFence:()=>f.args}),{code:'provisioning_execution_manifest_rejected'});
});
test('execution manifest capability rejects artifact changes during secret preflight', async t => {
  const f=await stageFixture(t),staged=await f.stager.stage(f.actor,f.prepared,f.args);
  const supplier=createProvisioningExecutionManifest({stage:f.stager,actorId:f.actor,secretPreflight:{async check(){
    await writeFile(staged.manifestPath,'tampered');
    return {tenantId:f.job.tenantId,projectName:f.prepared.plan.projectName,checkedReferences:Object.keys(f.prepared.compose.secrets)};
  }}});
  await assert.rejects(supplier.bind(f.prepared,staged,{currentFence:()=>f.args}).verifyExecution(),{code:'provisioning_execution_manifest_rejected'});
  assert.equal(await readFile(staged.manifestPath,'utf8'),'tampered','failed evidence is not repaired or deleted');
});
test('execution manifest capability honors cancellation and authority before secret inspection', async t => {
  const f=await stageFixture(t),staged=await f.stager.stage(f.actor,f.prepared,f.args);
  let inspected=0;
  const supplier=createProvisioningExecutionManifest({stage:f.stager,actorId:f.actor,secretPreflight:{async check(){inspected++;}}});
  const abort=new AbortController();abort.abort();
  await assert.rejects(supplier.bind(f.prepared,staged,{currentFence:()=>f.args,signal:abort.signal}).verifyExecution(),{code:'provisioning_execution_manifest_rejected'});
  f.job.workerId=randomUUID();
  await assert.rejects(supplier.bind(f.prepared,staged,{currentFence:()=>f.args}).verifyExecution(),{code:'provisioning_execution_manifest_rejected'});
  assert.equal(inspected,0);
});

test('execution manifest capability requires an exact preflight acknowledgement', async t => {
  const f=await stageFixture(t),staged=await f.stager.stage(f.actor,f.prepared,f.args);
  for(const response of [undefined,false,{tenantId:f.job.tenantId,projectName:f.prepared.plan.projectName,checkedReferences:[]}]){
    const supplier=createProvisioningExecutionManifest({stage:f.stager,actorId:f.actor,secretPreflight:{async check(){return response;}}});
    await assert.rejects(supplier.bind(f.prepared,staged,{currentFence:()=>f.args}).verifyExecution(),{code:'provisioning_execution_manifest_rejected'});
  }
});


function imageProcess(prepared, change = () => {}) {
  const calls = [];
  return { calls, async run(args) {
    calls.push(args);
    assert.deepEqual(args.slice(0, 2), ['--context', 'default']);
    if (args[2] === 'context') return JSON.stringify([{ Name: 'default', Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }]);
    assert.deepEqual([args[2], args[3], ...args.slice(5)], ['image', 'inspect', '--format', '{{json .}}']);
    const service = args[4] === prepared.compose.services.restaurant.image ? 'restaurant' : 'postgres';
    assert.equal(args[4], prepared.compose.services[service].image);
    const info = { Id: 'sha256:' + (service === 'restaurant' ? 'c' : 'd').repeat(64), Os: 'linux', Architecture: 'amd64',
      RepoDigests: [args[4]], Config: { User: service === 'restaurant' ? '10001:10001' : '' } };
    change(info, service); return JSON.stringify(info);
  } };
}
test('image preflight resolves only original pinned references through read-only local inspection', async t => {
  const f = await stageFixture(t), processRunner = imageProcess(f.prepared);
  const result = await createProvisioningImagePreflight({ processRunner }).inspect(f.prepared);
  assert.deepEqual(result, { restaurant: 'sha256:' + 'c'.repeat(64), postgres: 'sha256:' + 'd'.repeat(64) });
  assert.ok(Object.isFrozen(result)); assert.equal(processRunner.calls.length, 3);
});
test('image preflight rejects absent digest provenance, wrong platform, identity and runtime user', async t => {
  const f = await stageFixture(t);
  for (const change of [x => { x.RepoDigests = []; }, x => { x.RepoDigests = ['other@sha256:' + 'a'.repeat(64)]; },
    x => { x.Os = 'windows'; }, x => { x.Architecture = 'arm64'; }, x => { x.Id = 'tag-not-id'; },
    x => { x.Config.User = '0'; }, x => { x.Id = 'sha256:' + 'c'.repeat(64); }]) {
    await assert.rejects(createProvisioningImagePreflight({ processRunner: imageProcess(f.prepared, change) }).inspect(f.prepared),
      { code: 'provisioning_image_preflight_rejected' });
  }
});
test('image preflight rejects copies, cancellation and foreign contexts before image observation', async t => {
  const f = await stageFixture(t), processRunner = imageProcess(f.prepared), checker = createProvisioningImagePreflight({ processRunner });
  await assert.rejects(checker.inspect(structuredClone(f.prepared)), { code: 'provisioning_image_preflight_rejected' });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(checker.inspect(f.prepared, { signal: abort.signal }), { code: 'provisioning_image_preflight_rejected' });
  assert.equal(processRunner.calls.length, 0);
  let calls = 0;
  await assert.rejects(createProvisioningImagePreflight({ processRunner: { async run() { calls++; return JSON.stringify([{ Name: 'default', Endpoints: { docker: { Host: 'tcp://remote:2375' } } }]); } } }).inspect(f.prepared), { code: 'provisioning_image_preflight_rejected' });
  assert.equal(calls, 1);
});
test('image preflight sanitizes missing-image, malformed and oversized responses without retry', async t => {
  const f = await stageFixture(t);
  for (const output of ['not-json', 'x'.repeat(1048577)]) {
    let calls = 0;
    await assert.rejects(createProvisioningImagePreflight({ processRunner: { async run() { calls++; return output; } } }).inspect(f.prepared), { code: 'provisioning_image_preflight_rejected' });
    assert.equal(calls, 1);
  }
  await assert.rejects(createProvisioningImagePreflight({ processRunner: { async run() { throw new Error('private daemon diagnostics'); } } }).inspect(f.prepared),
    error => error.code === 'provisioning_image_preflight_rejected' && !JSON.stringify(error).includes('private daemon diagnostics'));
});


async function composedDriver(t, change = {}) {
  const f = await stageFixture(t), calls = [];
  const manifest = createProvisioningExecutionManifest({ stage: f.stager, actorId: f.actor,
    secretPreflight: { async check(input) { return { tenantId: input.tenantId, projectName: f.prepared.plan.projectName, checkedReferences: Object.keys(input.refs) }; } } });
  const options = { actorId: f.actor, stage: f.stager, manifest,
    hostLock: { async withLock(project, operation) { calls.push('lock'); try { return await operation(); } finally { calls.push('unlock'); } } },
    images: { async inspect() { calls.push('images'); return { restaurant: 'sha256:' + 'c'.repeat(64), postgres: 'sha256:' + 'd'.repeat(64) }; } },
    probe: { async assertEmpty() { calls.push('empty'); } },
    processRunner: { async run(args) { calls.push(args); return args[2] === 'context' ? JSON.stringify([{ Name: 'default', Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }]) : ''; } },
    verification: { async verify({ job, expected }) { calls.push('verify'); assert.equal(expected.compose.configs.runtime_bootstrap.file, join(f.directory, f.prepared.plan.projectName, job.id + '-' + job.workerId, 'tenant-bootstrap.sql')); assert.equal(f.prepared.compose.configs.runtime_bootstrap.file, './tenant-bootstrap.sql'); return { jobId: job.id, tenantId: job.tenantId, planDigest: job.planDigest, verificationSha256: 'e'.repeat(64) }; } },
  };
  const driver = createProvisioningHostDriver({ ...options, ...change });
  const checkpoint = async () => { calls.push('checkpoint'); f.job.version++; return { jobId: f.job.id, workerId: f.job.workerId, version: f.job.version }; };
  return { ...f, driver, checkpoint, calls, options };
}
test('composed driver keeps exact stage and fenced single apply inside host exclusion', async t => {
  const f = await composedDriver(t);
  const result = await f.driver.withLock(f.prepared.plan.projectName, async () => {
    await f.driver.inspect(f.prepared);
    await f.driver.apply(f.prepared, { checkpoint: f.checkpoint });
    return f.driver.verify(f.prepared);
  });
  assert.equal(result.verificationSha256, 'e'.repeat(64)); assert.ok(Object.isFrozen(result));
  assert.equal(f.calls[0], 'lock'); assert.equal(f.calls.at(-1), 'unlock');
  assert.equal(f.calls.filter(x => Array.isArray(x) && x.includes('up')).length, 1);
  assert.equal(f.calls.filter(x => x === 'empty').length, 2);
  assert.ok(f.calls.indexOf('verify') < f.calls.indexOf('unlock'));
  await assert.rejects(f.driver.verify(f.prepared), { code: 'provisioning_host_driver_rejected' });
});
test('composed driver forbids calls outside lock, repeated phases and copied preparation', async t => {
  const f = await composedDriver(t);
  await assert.rejects(f.driver.inspect(f.prepared), { code: 'provisioning_host_driver_rejected' });
  await f.driver.withLock(f.prepared.plan.projectName, async () => {
    await assert.rejects(f.driver.verify(f.prepared), { code: 'provisioning_host_driver_rejected' });
    await f.driver.inspect(f.prepared);
    await assert.rejects(f.driver.inspect(f.prepared), { code: 'provisioning_host_driver_rejected' });
    await assert.rejects(f.driver.apply(structuredClone(f.prepared), { checkpoint: f.checkpoint }), { code: 'provisioning_host_driver_rejected' });
    await f.driver.apply(f.prepared, { checkpoint: f.checkpoint });
    await assert.rejects(f.driver.apply(f.prepared, { checkpoint: f.checkpoint }), { code: 'provisioning_host_driver_rejected' });
    await f.driver.verify(f.prepared);
    await assert.rejects(f.driver.verify(f.prepared), { code: 'provisioning_host_driver_rejected' });
  });
});
test('composed driver loses no lock on uncertain apply and cannot retry it', async t => {
  const f = await composedDriver(t);
  const driver = createProvisioningHostDriver({ ...f.options, processRunner: { async run(args) {
    if (args.includes('up')) { f.calls.push('uncertain-up'); throw new Error('private daemon failure'); }
    return f.options.processRunner.run(args);
  } } });
  await driver.withLock(f.prepared.plan.projectName, async () => {
    await driver.inspect(f.prepared);
    await assert.rejects(driver.apply(f.prepared, { checkpoint: f.checkpoint }), error => error.code === 'provisioning_host_driver_rejected' && !JSON.stringify(error).includes('private daemon failure'));
    assert.ok(!f.calls.includes('unlock'));
    await assert.rejects(driver.apply(f.prepared, { checkpoint: f.checkpoint }), { code: 'provisioning_host_driver_rejected' });
    await assert.rejects(driver.verify(f.prepared), { code: 'provisioning_host_driver_rejected' });
  });
  assert.equal(f.calls.filter(x => x === 'uncertain-up').length, 1); assert.equal(f.calls.at(-1), 'unlock');
});
test('composed driver checks live fence binding before staging or Docker effects', async t => {
  for (const invalid of ['worker', 'version', 'job']) {
    const f = await composedDriver(t);
    await f.driver.withLock(f.prepared.plan.projectName, async () => {
      await f.driver.inspect(f.prepared);
      await assert.rejects(f.driver.apply(f.prepared, { checkpoint: async () => ({ jobId: invalid === 'job' ? randomUUID() : f.job.id,
        workerId: invalid === 'worker' ? randomUUID() : f.job.workerId, version: invalid === 'version' ? f.job.version : f.job.version + 1 }) }),
      { code: 'provisioning_host_driver_rejected' });
      assert.deepEqual(await readdir(f.directory), []);
      assert.ok(!f.calls.some(Array.isArray));
    });
  }
});


test('composed driver rejects overlapping locks and cancellation before staging', async t => {
  const f = await composedDriver(t), abort = new AbortController();
  const driver = createProvisioningHostDriver({ ...f.options, signal: abort.signal, images: { async inspect() {
    abort.abort(); return { restaurant: 'sha256:' + 'c'.repeat(64), postgres: 'sha256:' + 'd'.repeat(64) };
  } } });
  await driver.withLock(f.prepared.plan.projectName, async () => {
    await assert.rejects(driver.withLock(f.prepared.plan.projectName, async () => assert.fail('overlapping lock callback')), { code: 'provisioning_host_driver_rejected' });
    await assert.rejects(driver.inspect(f.prepared), { code: 'provisioning_host_driver_rejected' });
    await assert.rejects(driver.apply(f.prepared, { checkpoint: f.checkpoint }), { code: 'provisioning_host_driver_rejected' });
  });
  assert.deepEqual(await readdir(f.directory), []); assert.ok(!f.calls.some(Array.isArray)); assert.equal(f.calls.at(-1), 'unlock');
});
test('real coordinator composes host driver and records success or uncertainty without replay', async t => {
  for (const uncertain of [false, true]) {
    const f = await composedDriver(t);
    Object.assign(f.job, { state: 'queued', version: 1, workerId: null, claimedBy: null });
    Object.assign(f.journal, {
      async claim(actor, id, input) {
        await f.journal.review(actor, id, input);
        Object.assign(f.job, { state: 'claimed', version: f.job.version + 1, workerId: input.workerId, claimedBy: actor }); return { ...f.job };
      },
      async heartbeat(actor, id, input) { await f.journal.review(actor, id, input); f.job.version++; return { ...f.job }; },
      async finish(actor, id, input) { await f.journal.review(actor, id, input); f.job.state = 'succeeded'; f.job.version++; return { ...f.job }; },
      async uncertain(actor, id, input) { await f.journal.review(actor, id, input); f.job.state = 'unknown'; f.job.version++; return { ...f.job }; },
    });
    const driver = createProvisioningHostDriver({ ...f.options, processRunner: { async run(args) {
      const result = await f.options.processRunner.run(args);
      if (uncertain && args.includes('up')) throw new Error('synthetic lost reply');
      return result;
    } } });
    const runner = createProvisioningRunner({ journal: f.journal, artifacts: { async prepare(actor, id, input) {
      assert.equal(input.expectedVersion, f.job.version); return f.prepare();
    } }, driver });
    const run = runner.run(f.actor, f.job.id, { expectedVersion: 1, workerId: randomUUID() });
    if (uncertain) await assert.rejects(run, { code: 'provisioning_outcome_unknown' });
    else assert.equal((await run).state, 'succeeded');
    assert.equal(f.job.state, uncertain ? 'unknown' : 'succeeded');
    assert.equal(f.calls.filter(x => Array.isArray(x) && x.includes('up')).length, 1);
    assert.equal(f.calls.at(-1), 'unlock');
  }
});
