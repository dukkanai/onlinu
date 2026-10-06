import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, chmod, symlink, link, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createProvisioningHostLock } from './provisioning-host-lock.mjs';

const resource = 'onlinu-' + 'a'.repeat(32), neighbor = 'onlinu-' + 'b'.repeat(32);
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'onlinu-host-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, lock: createProvisioningHostLock({ directory }), path: join(directory, resource + '.lock') };
}
function contender(directory, name = resource) {
  const source = `import { createProvisioningHostLock } from ${JSON.stringify(new URL('./provisioning-host-lock.mjs', import.meta.url).href)};
    try { await createProvisioningHostLock({directory:process.argv[1]}).withLock(process.argv[2],async()=>{}); process.exitCode=0; }
    catch(e) { process.exitCode=e.code==='provisioning_host_busy'?75:1; }`;
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, directory, name], {
      env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore',
    });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('fixture timeout')); }, 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); accept(code); });
  });
}

test('Linux host lock configuration and namespace are restricted', async t => {
  assert.throws(() => createProvisioningHostLock({ directory: 'relative' }), /configuration/);
  const f = await fixture(t);
  for (const name of ['../escape', 'onlinu-fixture', 'onlinu-' + 'A'.repeat(32), null])
    await assert.rejects(f.lock.withLock(name, async () => {}), { code: 'provisioning_host_lock_rejected' });
  assert.deepEqual(await readdir(f.directory), []);
});

test('flock survives helper exit, blocks another process, and permits a separate tenant', async t => {
  const f = await fixture(t);
  await f.lock.withLock(resource, async () => {
    assert.equal(await contender(f.directory), 75);
    assert.equal(await contender(f.directory, neighbor), 0);
    await assert.rejects(createProvisioningHostLock({ directory: f.directory }).withLock(resource, async () => {
      assert.fail('competing callback must not run');
    }), { code: 'provisioning_host_busy' });
  });
  assert.equal(await contender(f.directory), 0);
  assert.deepEqual((await readdir(f.directory)).sort(), [resource + '.lock', neighbor + '.lock'].sort());
});

test('callback rejection releases descriptor but leaves stable lock file', async t => {
  const f = await fixture(t), error = new Error('fixture callback');
  await assert.rejects(f.lock.withLock(resource, async () => { throw error; }), error);
  assert.equal(await contender(f.directory), 0);
  assert.deepEqual(await readdir(f.directory), [resource + '.lock']);
});

test('unsafe directories, symlinks, hard links and content-bearing files are rejected', async t => {
  const f = await fixture(t);
  await chmod(f.directory, 0o755);
  await assert.rejects(f.lock.withLock(resource, async () => {}), { code: 'provisioning_host_lock_rejected' });
  await chmod(f.directory, 0o700);
  const target = join(f.directory, 'target'); await writeFile(target, '', { mode: 0o600 });
  await symlink(target, f.path);
  await assert.rejects(f.lock.withLock(resource, async () => {}), { code: 'provisioning_host_lock_rejected' });
  await unlink(f.path); await link(target, f.path);
  await assert.rejects(f.lock.withLock(resource, async () => {}), { code: 'provisioning_host_lock_rejected' });
  await unlink(f.path); await writeFile(f.path, 'not-an-empty-lock', { mode: 0o600 });
  await assert.rejects(f.lock.withLock(resource, async () => {}), { code: 'provisioning_host_lock_rejected' });
});

test('wrong owner policy and readable lock files fail closed', async t => {
  const f = await fixture(t);
  await assert.rejects(createProvisioningHostLock({ directory: f.directory, ownerUID: process.getuid() + 1 })
    .withLock(resource, async () => {}), { code: 'provisioning_host_lock_rejected' });
  await writeFile(f.path, '', { mode: 0o644 });
  await assert.rejects(f.lock.withLock(resource, async () => {}), { code: 'provisioning_host_lock_rejected' });
});

test('owned worker process exit releases the kernel lock without deleting its inode', async t => {
  const f = await fixture(t);
  const source = `import { createProvisioningHostLock } from ${JSON.stringify(new URL('./provisioning-host-lock.mjs', import.meta.url).href)};
    await createProvisioningHostLock({directory:process.argv[1]}).withLock(process.argv[2], async()=>{
      process.stdout.write('locked\\n'); await new Promise(resolve=>{process.stdin.resume();process.stdin.on('end',resolve);});
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, f.directory, resource], {
    env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const exited = new Promise(resolve => child.once('close', resolve));
  t.after(async () => { child.kill('SIGKILL'); await exited; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture acquisition timeout')), 5000);
    child.stdout.once('data', data => { clearTimeout(timer); assert.equal(data.toString(), 'locked\n'); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  assert.equal(await contender(f.directory), 75);
  child.kill('SIGKILL'); await exited;
  assert.equal(await contender(f.directory), 0);
  assert.deepEqual(await readdir(f.directory), [resource + '.lock']);
});
