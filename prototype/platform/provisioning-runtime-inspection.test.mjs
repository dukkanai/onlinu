import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeObservationFixture as fixture } from './integration/runtime-observation-fixture.mjs';
import { inspectProvisionedRuntime } from './provisioning-runtime-inspection.mjs';

function rejected(mutate) {
  const f = fixture(); mutate(f);
  assert.throws(() => inspectProvisionedRuntime(f.expected, f.observed), error => error.code === 'provisioning_runtime_rejected'
    && !JSON.stringify(error).includes('SENSITIVE_MARKER'));
}
test('runtime observation is exact, immutable and excludes private daemon fields', () => {
  const f = fixture(), before = JSON.stringify(f);
  const result = inspectProvisionedRuntime(f.expected, f.observed);
  assert.deepEqual(result, { restaurant: { containerId: '1'.repeat(64), imageId: 'sha256:' + 'a'.repeat(64) },
    postgres: { containerId: '2'.repeat(64), imageId: 'sha256:' + 'b'.repeat(64) } });
  assert.equal(JSON.stringify(f), before);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.restaurant));
  assert.ok(!JSON.stringify(result).includes('/synthetic/'));
});
test('runtime rejects substituted, duplicate or incomplete containers and unsafe state', () => {
  for (const mutation of [
    f => f.observed.containers.pop(),
    f => f.observed.containers.push(f.observed.containers[0]),
    f => f.observed.containers[0].Image = 'sha256:' + 'c'.repeat(64),
    f => f.observed.containers[0].State.Running = false,
    f => f.observed.containers[0].State.Health.Status = 'starting',
    f => f.observed.containers[0].Id = 'short',
    f => f.observed.containers[0].Config.Labels['org.onlinu.tenant'] = 'neighbor',
    f => f.observed.containers[0].Config.Labels['org.onlinu.plan-digest'] = 'e'.repeat(64),
    f => f.observed.containers[0].Config.Labels['com.docker.compose.service'] = 'postgres',
    f => f.observed.containers[0].HostConfig.Privileged = true,
    f => f.observed.containers[1].HostConfig.PidMode = 'host',
    f => f.observed.containers[0].HostConfig.IpcMode = 'container:neighbor',
    f => f.observed.containers[0].HostConfig.CapAdd = ['SYS_ADMIN'],
    f => f.observed.containers[0].HostConfig.Devices = [{}],
    f => f.observed.containers[0].HostConfig.ReadonlyRootfs = false,
    f => f.observed.containers[0].HostConfig.CapDrop = [],
    f => f.observed.containers[0].HostConfig.SecurityOpt = [],
    f => f.observed.containers[0].Config.User = '0',
  ]) rejected(mutation);
});
test('runtime rejects extra or substituted mounts without reading secret bytes', () => {
  for (const mutation of [
    f => f.observed.containers[0].Mounts.push({ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/docker', RW: true }),
    f => f.observed.containers[0].Mounts.pop(),
    f => f.observed.containers[0].Mounts[0].Name = 'neighbor-media',
    f => f.observed.containers[0].Mounts[1].Source = '/SENSITIVE_MARKER/other',
    f => f.observed.containers[0].Mounts[1].RW = true,
    f => f.observed.containers[1].Mounts[2].Source = '/other/bootstrap.sql',
    f => f.observed.containers[0].Mounts.push({ Type: 'tmpfs', Destination: '/data/recordings' }),
    f => f.observed.containers[0].Mounts[1].Destination = f.observed.containers[0].Mounts[0].Destination,
  ]) rejected(mutation);
});
test('runtime rejects public ports, inline secrets and environment substitutions', () => {
  for (const mutation of [
    f => f.observed.containers[0].HostConfig.PortBindings['8080/tcp'][0].HostIp = '0.0.0.0',
    f => f.observed.containers[0].HostConfig.PortBindings['8080/tcp'][0].HostPort = '18081',
    f => f.observed.containers[0].HostConfig.PortBindings['8080/tcp'].push({ HostIp: '::', HostPort: '18080' }),
    f => f.observed.containers[1].HostConfig.PortBindings['5432/tcp'] = [{}],
    f => f.observed.containers[0].Config.Env.push('WACALLS_API_KEY=SENSITIVE_MARKER'),
    f => f.observed.containers[1].Config.Env.push('POSTGRES_PASSWORD=SENSITIVE_MARKER'),
    f => f.observed.containers[0].Config.Env[0] = 'WACALLS_API_KEY_FILE=/other',
    f => f.observed.containers[0].Config.Env.push(f.observed.containers[0].Config.Env[0]),
  ]) rejected(mutation);
});
test('runtime rejects cross-tenant attachments, external database network and wrong volumes', () => {
  for (const mutation of [
    f => f.observed.networks[0].Internal = false,
    f => f.observed.networks[0].Driver = 'host',
    f => f.observed.networks[0].Containers['5'.repeat(64)] = {},
    f => delete f.observed.networks[0].Containers['2'.repeat(64)],
    f => f.observed.containers[0].NetworkSettings.Networks['foreign'] = { NetworkID: '5'.repeat(64) },
    f => Object.values(f.observed.containers[0].NetworkSettings.Networks)[0].NetworkID = '5'.repeat(64),
    f => f.observed.volumes[0].Labels['com.docker.compose.project'] = 'neighbor',
    f => f.observed.volumes[0].Driver = 'nfs',
    f => f.observed.volumes[0].Options = { type: 'nfs', device: 'neighbor:/data' },
    f => f.observed.networks.pop(),
    f => f.observed.volumes[1] = f.observed.volumes[0],
    f => f.expected.projectName = 'onlinu-' + '0'.repeat(32),
  ]) rejected(mutation);
});
