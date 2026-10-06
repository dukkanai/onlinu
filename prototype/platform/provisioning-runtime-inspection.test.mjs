import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inspectProvisionedRuntime } from './provisioning-runtime-inspection.mjs';

function fixture() {
  const tenantId = 'synthetic-a', planDigest = 'd'.repeat(64);
  const projectName = 'onlinu-' + createHash('sha256').update(tenantId).digest('hex').slice(0, 32);
  const labels = { 'org.onlinu.tenant': tenantId, 'org.onlinu.plan-digest': planDigest, 'com.docker.compose.project': projectName };
  const ids = { restaurant: '1'.repeat(64), postgres: '2'.repeat(64) };
  const images = { restaurant: 'sha256:' + 'a'.repeat(64), postgres: 'sha256:' + 'b'.repeat(64) };
  const networkIds = { database: '3'.repeat(64), egress: '4'.repeat(64) };
  const compose = { services: {
    restaurant: { environment: { WACALLS_API_KEY_FILE: '/run/secrets/administrator' },
      volumes: [{ source: 'media', target: '/data/recordings' }], secrets: ['administrator'], networks: ['database', 'egress'] },
    postgres: { environment: { POSTGRES_PASSWORD_FILE: '/run/secrets/pg_bootstrap' },
      volumes: [{ source: 'postgres', target: '/var/lib/postgresql/data' }], secrets: ['pg_bootstrap'],
      configs: [{ source: 'runtime_bootstrap', target: '/docker-entrypoint-initdb.d/10-onlinu.sql' }], networks: ['database'] }
    }, networks: { database: { name: projectName + '-database' }, egress: { name: projectName + '-egress' } },
    volumes: { media: { name: projectName + '-media' }, postgres: { name: projectName + '-postgres' } },
    secrets: { administrator: { file: '/synthetic/administrator' }, pg_bootstrap: { file: '/synthetic/pg_bootstrap' } },
    configs: { runtime_bootstrap: { file: '/synthetic/bootstrap.sql' } } };
  const containers = ['restaurant', 'postgres'].map(service => ({ Id: ids[service], Image: images[service],
    Config: { User: service === 'restaurant' ? '10001:10001' : '', Labels: { ...labels, 'com.docker.compose.service': service },
      Env: Object.entries(compose.services[service].environment).map(([k,v]) => `${k}=${v}`) },
    State: { Running: true, Health: { Status: 'healthy' } },
    HostConfig: { Privileged: false, CapAdd: [], Devices: [], DeviceRequests: [], PidMode: '', IpcMode: 'private',
      ...(service === 'restaurant' ? { ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
        PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }] } } : { PortBindings: {} }) },
    Mounts: [
      ...compose.services[service].volumes.map(v => ({ Type: 'volume', Name: compose.volumes[v.source].name, Destination: v.target, RW: true })),
      ...compose.services[service].secrets.map(v => ({ Type: 'bind', Source: compose.secrets[v].file, Destination: '/run/secrets/' + v, RW: false })),
      ...(compose.services[service].configs ?? []).map(v => ({ Type: 'bind', Source: compose.configs[v.source].file, Destination: v.target, RW: false })) ],
    NetworkSettings: { Networks: Object.fromEntries(compose.services[service].networks.map(v => [compose.networks[v].name, { NetworkID: networkIds[v] }])) }
  }));
  const networks = Object.entries(compose.networks).map(([key,v]) => ({ Name: v.name, Id: networkIds[key], Driver: 'bridge', Internal: key === 'database', Labels: { ...labels },
    Containers: Object.fromEntries((key === 'database' ? Object.values(ids) : [ids.restaurant]).map(id => [id, {}])) }));
  const volumes = Object.values(compose.volumes).map(v => ({ Name: v.name, Driver: 'local', Labels: { ...labels } }));
  return { expected: { tenantId, projectName, planDigest, images, httpPort: 18080, compose }, observed: { containers, networks, volumes } };
}
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
