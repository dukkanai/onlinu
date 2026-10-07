/** Private composition of reviewed provisioning capabilities. No public endpoint,
 * automatic startup, credential provisioning, activation or retry/recovery path.
 */
import { dirname, isAbsolute, resolve } from 'node:path';
import { isPreparedArtifact } from './provisioning-artifacts.mjs';
import { createProvisioningComposeApply } from './provisioning-compose-apply.mjs';
import { problem } from './auth.mjs';
const freeze = value => { for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); return Object.freeze(value); };
const rejected = () => problem(409, 'provisioning_host_driver_rejected');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function createProvisioningHostDriver({ actorId, hostLock, stage, manifest, images, probe, processRunner, verification, signal }) {
  if (!uuid(actorId) || typeof hostLock?.withLock !== 'function' || typeof stage?.stage !== 'function'
      || typeof manifest?.bind !== 'function' || typeof images?.inspect !== 'function'
      || typeof probe?.assertEmpty !== 'function' || typeof processRunner?.run !== 'function'
      || typeof verification?.verify !== 'function' || (signal !== undefined && !(signal instanceof AbortSignal)))
    throw new Error('invalid_provisioning_host_driver_configuration');
  const locks = new Map();
  function active(state) {
    if (!state?.held || locks.get(state.project) !== state || signal?.aborted) throw rejected();
  }
  function attempt(prepared) {
    if (!isPreparedArtifact(prepared) || prepared.job.state !== 'claimed' || prepared.job.claimedBy !== actorId
        || !uuid(prepared.job.workerId)) throw rejected();
    const state = locks.get(prepared.plan.projectName);
    active(state);
    if (state.prepared !== prepared) throw rejected();
    return state;
  }
  async function withLock(project, operation) {
    if (typeof project !== 'string' || !/^onlinu-[a-f0-9]{32}$/.test(project)
        || typeof operation !== 'function' || locks.has(project) || signal?.aborted) throw rejected();
    const state = { project, held: false, phase: 'new' };
    locks.set(project, state);
    try {
      return await hostLock.withLock(project, async () => {
        state.held = true; active(state);
        try { return await operation(); }
        finally { state.held = false; }
      });
    } finally { state.held = false; if (locks.get(project) === state) locks.delete(project); }
  }
  async function inspect(prepared) {
    try {
      if (!isPreparedArtifact(prepared)) throw rejected();
      const state = locks.get(prepared.plan.projectName); active(state);
      if (state.phase !== 'new') throw rejected();
      state.prepared = prepared; attempt(prepared); state.phase = 'inspecting';
      const resolved = structuredClone(await images.inspect(prepared, { signal })); active(state);
      if (!resolved || Object.keys(resolved).sort().join(',') !== 'postgres,restaurant'
          || Object.values(resolved).some(v => !/^sha256:[a-f0-9]{64}$/.test(v))
          || resolved.restaurant === resolved.postgres) throw rejected();
      state.expected = { tenantId: prepared.job.tenantId, planDigest: prepared.job.planDigest,
        projectName: prepared.plan.projectName, httpPort: prepared.plan.runtime.httpBinding.port,
        images: Object.freeze(resolved), compose: prepared.compose };
      Object.freeze(state.expected);
      await probe.assertEmpty(state.expected, { signal }); active(state);
      state.phase = 'inspected';
    } catch { throw rejected(); }
  }
  async function apply(prepared, { checkpoint } = {}) {
    try {
      const state = attempt(prepared);
      if (state.phase !== 'inspected' || typeof checkpoint !== 'function') throw rejected();
      state.phase = 'applying'; // Permanently spent even if the first checkpoint fails.
      let fence;
      async function renew() {
        active(state);
        const result = await checkpoint(); active(state);
        if (!result || Object.keys(result).sort().join(',') !== 'jobId,version,workerId'
            || result.jobId !== prepared.job.id || result.workerId !== prepared.job.workerId
            || !Number.isSafeInteger(result.version) || result.version <= (fence?.expectedVersion ?? prepared.job.version)) throw rejected();
        fence = Object.freeze({ expectedVersion: result.version, workerId: result.workerId });
      }
      await renew();
      const staged = await stage.stage(actorId, prepared, fence); active(state);
      // Docker resolves the unchanged relative bootstrap path against the
      // original staged manifest. Mirror that resolution for mount inspection.
      if (prepared.compose.configs.runtime_bootstrap.file !== './tenant-bootstrap.sql'
          || !isAbsolute(staged.manifestPath) || resolve(dirname(staged.manifestPath), './tenant-bootstrap.sql') !== staged.bootstrapPath) throw rejected();
      const observedCompose = structuredClone(prepared.compose);
      observedCompose.configs.runtime_bootstrap.file = staged.bootstrapPath;
      state.expected = freeze({ ...state.expected, compose: observedCompose });
      const capability = manifest.bind(prepared, staged, { currentFence: () => fence, signal });
      const transport = createProvisioningComposeApply({ processRunner,
        verifyExecution: capability.verifyExecution,
        assertEmpty: () => probe.assertEmpty(state.expected, { signal }) });
      await transport.apply({ checkpoint: renew, signal }); active(state);
      state.phase = 'applied';
    } catch { throw rejected(); }
  }
  async function verify(prepared) {
    try {
      const state = attempt(prepared);
      if (state.phase !== 'applied') throw rejected();
      state.phase = 'verifying';
      const result = await verification.verify({ job: prepared.job, expected: state.expected }, { signal }); active(state);
      if (result?.jobId !== prepared.job.id || result.tenantId !== prepared.job.tenantId
          || result.planDigest !== prepared.job.planDigest || !/^[a-f0-9]{64}$/.test(result.verificationSha256 ?? '')) throw rejected();
      state.phase = 'verified';
      return Object.freeze({ jobId: result.jobId, tenantId: result.tenantId,
        planDigest: result.planDigest, verificationSha256: result.verificationSha256 });
    } catch { throw rejected(); }
  }
  return Object.freeze({ withLock, inspect, apply, verify });
}
