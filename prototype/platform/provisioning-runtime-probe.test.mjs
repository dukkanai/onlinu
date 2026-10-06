import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvisioningRuntimeProbe } from './provisioning-runtime-probe.mjs';
import { runtimeObservationFixture } from './integration/runtime-observation-fixture.mjs';

function setup(intercept = () => undefined) {
  const fixture = runtimeObservationFixture(), calls = [];
  const replies = [JSON.stringify([{ Name: 'default', Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }]),
    fixture.observed.containers.map(v => v.Id).join('\n') + '\n', JSON.stringify(fixture.observed.containers),
    JSON.stringify(fixture.observed.networks), JSON.stringify(fixture.observed.volumes)];
  const probe = createProvisioningRuntimeProbe({ processRunner: { async run(args, options) {
    calls.push({ args, options });
    const result = await intercept(calls.length, fixture, calls);
    return result === undefined ? replies[calls.length - 1] : result;
  } } });
  return { ...fixture, probe, calls };
}
const safeError = error => error.code === 'provisioning_runtime_probe_failed' && !JSON.stringify(error).includes('SENSITIVE_MARKER');

test('probe uses only fixed read commands on exact local context and reviewed resource names', async () => {
  const f = setup(), result = await f.probe.inspect(f.expected);
  assert.equal(result.restaurant.containerId, '1'.repeat(64));
  assert.deepEqual(f.calls.map(v => v.args), [
    ['--context', 'default', 'context', 'inspect', 'default'],
    ['--context', 'default', 'container', 'ls', '-aq', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + f.expected.projectName],
    ['--context', 'default', 'container', 'inspect', '1'.repeat(64), '2'.repeat(64)],
    ['--context', 'default', 'network', 'inspect', f.expected.projectName + '-database', f.expected.projectName + '-egress'],
    ['--context', 'default', 'volume', 'inspect', f.expected.projectName + '-media', f.expected.projectName + '-postgres']
  ]);
  assert.ok(Object.isFrozen(result));
});
test('probe rejects untrusted command identifiers before any invocation', async () => {
  for (const mutate of [
    v => v.tenantId = '--help', v => v.projectName = 'neighbor', v => v.planDigest = 'x',
    v => v.compose.networks.database.name = '--help',
    v => v.compose.volumes.postgres.name = 'neighbor',
  ]) {
    const f = setup(); mutate(f.expected);
    await assert.rejects(f.probe.inspect(f.expected), safeError); assert.equal(f.calls.length, 0);
  }
});
test('probe refuses remote contexts before container access and no automatic retry', async () => {
  for (const reply of ['[]', '{}', 'invalid-json', JSON.stringify([{ Name: 'default', Endpoints: { docker: { Host: 'tcp://remote:2375' } } }])]) {
    const f = setup(() => reply);
    await assert.rejects(f.probe.inspect(f.expected), safeError); assert.equal(f.calls.length, 1);
  }
});
test('probe rejects missing duplicate malformed or oversized daemon inventory', async () => {
  for (const reply of ['', '1'.repeat(64), '1'.repeat(64) + '\n' + '1'.repeat(64), '--help\n' + '2'.repeat(64),
    Array(3).fill('1'.repeat(64)).join('\n'), 'SENSITIVE_MARKER'.repeat(100000)]) {
    const f = setup(step => step === 2 ? reply : undefined);
    await assert.rejects(f.probe.inspect(f.expected), safeError); assert.equal(f.calls.length, 2);
  }
});
test('probe sanitizes process failures and refuses substituted returned container IDs', async () => {
  let f = setup(step => { if (step === 3) throw new Error('SENSITIVE_MARKER'); });
  await assert.rejects(f.probe.inspect(f.expected), safeError); assert.equal(f.calls.length, 3);
  f = setup((step, data) => {
    if (step !== 3) return;
    data.observed.containers[0].Id = '9'.repeat(64);
    return JSON.stringify(data.observed.containers);
  });
  await assert.rejects(f.probe.inspect(f.expected), safeError); assert.equal(f.calls.length, 3);
});
test('probe stops after cancellation even when a process capability ignores signal', async () => {
  const control = new AbortController();
  const f = setup(step => { if (step === 1) control.abort(); });
  await assert.rejects(f.probe.inspect(f.expected, { signal: control.signal }), safeError);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.signal, control.signal);
  const pre = setup();
  await assert.rejects(pre.probe.inspect(pre.expected, { signal: control.signal }), safeError);
  assert.equal(pre.calls.length, 0);
});
test('probe snapshots caller expectations before asynchronous process results', async () => {
  const f = setup((step, data) => {
    if (step === 1) data.expected.compose.volumes.media.name = 'neighbor';
  });
  // setup exposes the same expected object as its closure.
  const result = await f.probe.inspect(f.expected);
  assert.equal(result.postgres.containerId, '2'.repeat(64));
  assert.ok(f.calls[4].args.includes(f.expected.projectName + '-media'));
});
