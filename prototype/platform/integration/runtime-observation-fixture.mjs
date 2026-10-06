/** Synthetic data only, no account or daemon access. */
import { createHash } from 'node:crypto';
export function runtimeObservationFixture() {
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
