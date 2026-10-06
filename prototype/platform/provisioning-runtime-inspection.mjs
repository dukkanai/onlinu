/** Pure private runtime observation validation. This neither talks to Docker nor
 * authorizes creation, deletion, account access or tenant activation. Expected
 * values must come from the trusted reviewed compiler, not request bodies.
 */
import { createHash } from 'node:crypto';
import { problem } from './auth.mjs';

const fail = () => { throw problem(409, 'provisioning_runtime_rejected'); };
const id = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const same = (a, b) => Array.isArray(a) && a.length === b.length
  && new Set(a).size === a.length && a.every(v => b.includes(v));
const labelsMatch = (labels, expected) => labels?.['org.onlinu.tenant'] === expected.tenantId
  && labels?.['org.onlinu.plan-digest'] === expected.planDigest
  && labels?.['com.docker.compose.project'] === expected.projectName;
const check = value => { if (!value) fail(); };

export function inspectProvisionedRuntime(input, observation) {
  try {
    // Snapshot caller-owned objects before inspecting; return no original fields,
    // environments, host paths, credentials or arbitrary daemon diagnostics.
    const expected = structuredClone(input), observed = structuredClone(observation);
    check(typeof expected?.tenantId === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(expected.tenantId));
    check(id(expected.planDigest));
    check(expected.projectName === 'onlinu-' + createHash('sha256').update(expected.tenantId).digest('hex').slice(0, 32));
    check(Number.isInteger(expected.httpPort) && expected.httpPort >= 1024 && expected.httpPort <= 65535);
    const spec = expected.compose;
    check(same(Object.keys(spec.services), ['restaurant', 'postgres'])
      && same(Object.keys(spec.networks), ['database', 'egress'])
      && same(Object.keys(spec.volumes), ['media', 'postgres']));
    check(same(Object.keys(expected.images), ['restaurant', 'postgres'])
      && Object.values(expected.images).every(v => /^sha256:[a-f0-9]{64}$/.test(v)));
    check(Array.isArray(observed.containers) && observed.containers.length === 2
      && Array.isArray(observed.networks) && observed.networks.length === 2
      && Array.isArray(observed.volumes) && observed.volumes.length === 2);
    const resources = {}, containers = {};
    for (const info of observed.containers) {
      const service = info?.Config?.Labels?.['com.docker.compose.service'];
      check(['restaurant', 'postgres'].includes(service) && !containers[service]);
      check(id(info.Id) && labelsMatch(info.Config.Labels, expected) && info.Image === expected.images[service]);
      check(info.State?.Running === true && info.State?.Health?.Status === 'healthy');
      const host = info.HostConfig;
      check(host?.Privileged === false && !host.CapAdd?.length && !host.Devices?.length && !host.DeviceRequests?.length
        && !['host', 'container'].some(v => String(host.PidMode ?? '').startsWith(v))
        && !['host', 'container'].some(v => String(host.IpcMode ?? '').startsWith(v)));
      if (service === 'restaurant') {
        const bindings = host.PortBindings;
        check(info.Config.User === '10001:10001' && host.ReadonlyRootfs === true
          && host.CapDrop?.includes('ALL') && host.SecurityOpt?.some(v => ['no-new-privileges', 'no-new-privileges:true'].includes(v)));
        check(same(Object.keys(bindings ?? {}), ['8080/tcp']) && Array.isArray(bindings['8080/tcp'])
          && bindings['8080/tcp'].length === 1 && bindings['8080/tcp'][0].HostIp === '127.0.0.1'
          && bindings['8080/tcp'][0].HostPort === String(expected.httpPort));
      } else check(Object.keys(host.PortBindings ?? {}).length === 0);
      check(Array.isArray(info.Config.Env) && !info.Config.Env.some(v => /^(WACALLS_API_KEY|WACALLS_PG_URL|WACALLS_META_ENCRYPTION_KEY|POSTGRES_PASSWORD)=/.test(v)));
      for (const [key, value] of Object.entries(spec.services[service].environment)) {
        const entries = info.Config.Env.filter(v => v.startsWith(key + '='));
        check(entries.length === 1 && entries[0] === `${key}=${value}`);
      }
      const mounts = [];
      for (const volume of spec.services[service].volumes) mounts.push({ type: 'volume', destination: volume.target, name: spec.volumes[volume.source].name, rw: true });
      for (const secret of spec.services[service].secrets) mounts.push({ type: 'bind', destination: '/run/secrets/' + secret, source: spec.secrets[secret].file, rw: false });
      for (const config of spec.services[service].configs ?? []) mounts.push({ type: 'bind', destination: config.target, source: spec.configs[config.source].file, rw: false });
      check(Array.isArray(info.Mounts));
      const persistent = info.Mounts.filter(v => v.Type !== 'tmpfs');
      check(persistent.length === mounts.length && new Set(persistent.map(v => v.Destination)).size === persistent.length);
      for (const mount of persistent) {
        const wanted = mounts.find(v => v.destination === mount.Destination);
        check(wanted && mount.Type === wanted.type && mount.RW === wanted.rw);
        if (wanted.type === 'volume') check(mount.Name === wanted.name);
        else check(mount.Source === wanted.source);
      }
      for (const mount of info.Mounts.filter(v => v.Type === 'tmpfs')) check(service === 'restaurant' && mount.Destination === '/tmp');
      const networkNames = spec.services[service].networks.map(v => spec.networks[v].name);
      check(same(Object.keys(info.NetworkSettings?.Networks ?? {}), networkNames));
      containers[service] = info;
      resources[service] = Object.freeze({ containerId: info.Id, imageId: info.Image });
    }
    check(containers.restaurant.Id !== containers.postgres.Id);
    for (const [key, wanted] of Object.entries(spec.networks)) {
      const matches = observed.networks.filter(v => v.Name === wanted.name);
      check(matches.length === 1);
      const network = matches[0];
      check(id(network.Id) && labelsMatch(network.Labels, expected) && network.Driver === 'bridge'
        && network.Internal === (key === 'database'));
      const members = key === 'database' ? ['restaurant', 'postgres'] : ['restaurant'];
      check(same(Object.keys(network.Containers ?? {}), members.map(v => containers[v].Id)));
      for (const service of members) check(containers[service].NetworkSettings.Networks[wanted.name].NetworkID === network.Id);
    }
    for (const wanted of Object.values(spec.volumes)) {
      const matches = observed.volumes.filter(v => v.Name === wanted.name);
      check(matches.length === 1 && matches[0].Driver === 'local' && Object.keys(matches[0].Options ?? {}).length === 0
        && labelsMatch(matches[0].Labels, expected));
    }
    return Object.freeze({ restaurant: resources.restaurant, postgres: resources.postgres });
  } catch { fail(); }
}
