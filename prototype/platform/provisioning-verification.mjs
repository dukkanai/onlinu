/** Compose observations + authenticated behavior + durable receipt as one private
 * verification step. Trusted caller still owns live authority and host exclusion.
 * Does not activate a tenant, create credentials or execute an apply command.
 */
import { createHash } from 'node:crypto';
import { problem } from './auth.mjs';
const rejected = () => problem(409, 'provisioning_verification_rejected');
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const hash = value => createHash('sha256').update(value).digest('hex');
const freeze = value => { for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); return Object.freeze(value); };
export function createProvisioningVerification({ probe, evidence, authenticate, sourceCommit, scope }) {
  if (typeof probe?.inspect !== 'function' || typeof evidence?.write !== 'function' || typeof evidence?.read !== 'function'
      || typeof authenticate !== 'function' || !/^[a-f0-9]{40}$/.test(sourceCommit ?? '') || !['fixture', 'runtime'].includes(scope))
    throw new Error('invalid_provisioning_verification_configuration');
  async function verify(input, { signal } = {}) {
    try {
      if (signal !== undefined && !(signal instanceof AbortSignal)) throw rejected();
      const { job, expected } = structuredClone(input);
      if (!uuid(job?.id) || !uuid(job.workerId) || !['claimed', 'unknown'].includes(job.state)
          || job.tenantId !== expected?.tenantId || job.planDigest !== expected.planDigest
          || !/^[a-f0-9]{64}$/.test(job.planDigest ?? '')
          || typeof expected.tenantId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(expected.tenantId)
          || expected.projectName !== 'onlinu-' + hash(expected.tenantId).slice(0, 32)
          || !Number.isInteger(expected.httpPort) || expected.httpPort < 1024 || expected.httpPort > 65535) throw rejected();
      const alive = () => { if (signal?.aborted) throw rejected(); };
      alive();
      const before = structuredClone(await probe.inspect(expected, { signal }));
      alive();
      // Authentication capability owns credential access and the bounded loopback
      // request. Never pass arbitrary URL, headers or secret bytes from a caller.
      const auth = await authenticate(Object.freeze({ tenantId: expected.tenantId, port: expected.httpPort }), { signal });
      alive();
      if (!auth || Object.keys(auth).sort().join(',') !== 'authenticated,unauthorizedRejected'
          || auth.authenticated !== true || auth.unauthorizedRejected !== true) throw rejected();
      const after = structuredClone(await probe.inspect(expected, { signal }));
      alive();
      for (const service of ['restaurant', 'postgres']) {
        if (!/^[a-f0-9]{64}$/.test(before?.[service]?.containerId ?? '')
            || !/^sha256:[a-f0-9]{64}$/.test(before[service].imageId ?? '')
            || before[service].imageId !== expected.images?.[service]
            || after?.[service]?.containerId !== before[service].containerId
            || after[service].imageId !== before[service].imageId) throw rejected();
      }
      if (before.restaurant.containerId === before.postgres.containerId) throw rejected();
      const report = { jobId: job.id, workerId: job.workerId, tenantId: job.tenantId, planDigest: job.planDigest,
        projectName: expected.projectName, sourceCommit, scope,
        resources: { restaurant: { containerId: before.restaurant.containerId, imageId: before.restaurant.imageId },
          postgres: { containerId: before.postgres.containerId, imageId: before.postgres.imageId } },
        checks: { ownership: true, healthy: true, authenticated: true, unauthorizedRejected: true } };
      const reference = await evidence.write(report);
      alive();
      const stored = await evidence.read(reference);
      alive();
      if (!reference || Object.keys(reference).sort().join(',') !== 'jobId,planDigest,sha256,tenantId,workerId'
          || reference.jobId !== job.id || reference.workerId !== job.workerId || reference.tenantId !== job.tenantId
          || reference.planDigest !== job.planDigest || !/^[a-f0-9]{64}$/.test(reference.sha256 ?? '')
          || !stored || Object.keys(stored).sort().join(',') !== 'observedAt,report,schemaVersion'
          || stored.schemaVersion !== 1 || typeof stored.observedAt !== 'string' || stored.observedAt.length > 35
          || !Number.isFinite(Date.parse(stored.observedAt)) || new Date(stored.observedAt).toISOString() !== stored.observedAt
          || JSON.stringify(stored.report) !== JSON.stringify(report)
          || hash(JSON.stringify(stored) + '\n') !== reference.sha256) throw rejected();
      return freeze({ jobId: job.id, tenantId: job.tenantId, planDigest: job.planDigest,
        verificationSha256: reference.sha256, evidence: { reference, stored } });
    } catch { throw rejected(); }
  }
  return Object.freeze({ verify });
}
