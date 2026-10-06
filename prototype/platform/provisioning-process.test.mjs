import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createProvisioningProcess } from './provisioning-process.mjs';
import { createProvisioningHostLock } from './provisioning-host-lock.mjs';

const config = { executable: process.execPath, workingDirectory: tmpdir() };
const node = (source, extra = []) => ['-e', source, ...extra];

test('private process configuration and arguments reject unsafe values', async () => {
  for (const change of [{ executable: 'node' }, { workingDirectory: 'relative' }, { timeoutMs: 0 }, { maxOutputBytes: 0 }])
    assert.throws(() => createProvisioningProcess({ ...config, ...change }), /configuration/);
  const child = createProvisioningProcess(config);
  for (const args of [null, ['bad\0arg'], Array(129).fill('x'), [42]])
    await assert.rejects(child.run(args), { code: 'invalid_provisioning_process_request' });
});

test('child receives explicit arguments without a shell or inherited credentials', async () => {
  process.env.ONLINU_PROCESS_SYNTHETIC_SECRET = 'must-not-inherit';
  try {
    const output = await createProvisioningProcess(config).run(node(
      'process.stdout.write(JSON.stringify({arg:process.argv[1],secret:process.env.ONLINU_PROCESS_SYNTHETIC_SECRET,keys:Object.keys(process.env).sort()}))',
      ['$(not-a-shell);&& literal']));
    assert.deepEqual(JSON.parse(output), { arg: '$(not-a-shell);&& literal', keys: ['LANG', 'PATH'] });
  } finally { delete process.env.ONLINU_PROCESS_SYNTHETIC_SECRET; }
});

test('nonzero exit and spawn errors do not expose output, args or paths', async () => {
  await assert.rejects(createProvisioningProcess(config).run(node(
    "process.stderr.write('private-stderr');process.stdout.write('private-stdout');process.exitCode=4")),
    error => error.code === 'provisioning_process_failed' && !JSON.stringify(error).includes('private-'));
  await assert.rejects(createProvisioningProcess({ ...config, executable: '/does-not-exist/private-path' }).run([]),
    error => error.code === 'provisioning_process_failed' && !JSON.stringify(error).includes('private-path'));
});

test('combined output is bounded and malformed UTF-8 is rejected', async () => {
  const child = createProvisioningProcess({ ...config, maxOutputBytes: 128 });
  await assert.rejects(child.run(node("process.stdout.write('a'.repeat(80));process.stderr.write('b'.repeat(80))")),
    { code: 'provisioning_process_output_limit' });
  await assert.rejects(child.run(node('process.stdout.write(Buffer.from([255]))')), { code: 'provisioning_process_output_invalid' });
});

test('pre-cancelled and live cancellation fail closed', async () => {
  const controller = new AbortController(); controller.abort();
  const child = createProvisioningProcess(config);
  await assert.rejects(child.run(node("process.stdout.write('must-not-run')"), { signal: controller.signal }),
    { code: 'provisioning_process_aborted' });
  const live = new AbortController();
  const result = child.run(node('setInterval(()=>{},1000)'), { signal: live.signal });
  live.abort(); await assert.rejects(result, { code: 'provisioning_process_aborted' });
});

test('timeout stops the owned process group and waits for pipe closure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'onlinu-process-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, 'ticks');
  const descendant = "require('fs').appendFileSync(process.argv[1],'x');setInterval(()=>require('fs').appendFileSync(process.argv[1],'x'),20)";
  const source = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[1]],{stdio:'inherit'});setInterval(()=>{},1000)`;
  const child = createProvisioningProcess({ ...config, timeoutMs: 1000 });
  await assert.rejects(child.run(node(source, [marker])), { code: 'provisioning_process_timeout' });
  const before = await readFile(marker, 'utf8'); assert.ok(before.length > 0);
  await delay(100); assert.equal(await readFile(marker, 'utf8'), before, 'descendant stopped writing before promise rejected');
});


test('host exclusion stays held until a timed-out command has settled', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'onlinu-process-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lock = createProvisioningHostLock({ directory });
  const resource = 'onlinu-' + 'c'.repeat(32);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = lock.withLock(resource, async () => {
    const result = createProvisioningProcess({ ...config, timeoutMs: 500 }).run(node('setInterval(()=>{},1000)'));
    entered(); return result;
  });
  const rejected = assert.rejects(pending, { code: 'provisioning_process_timeout' });
  await started;
  await assert.rejects(lock.withLock(resource, async () => {}), { code: 'provisioning_host_busy' });
  await rejected;
  assert.equal(await lock.withLock(resource, async () => 'released'), 'released');
});
