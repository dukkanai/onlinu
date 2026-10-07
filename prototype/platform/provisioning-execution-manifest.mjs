/** Private production-shaped manifest capability. No image/path overrides,
 * secret creation, secret-byte reads or Docker commands. The operator supplies
 * previously approved secret references and a currently fenced worker context.
 */
import { isPreparedArtifact } from './provisioning-artifacts.mjs';
import { problem } from './auth.mjs';
const rejected = () => problem(409, 'provisioning_execution_manifest_rejected');
export function createProvisioningExecutionManifest({ stage, secretPreflight, actorId }) {
  if (typeof stage?.verify !== 'function' || typeof secretPreflight?.check !== 'function'
      || typeof actorId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(actorId))
    throw new Error('invalid_provisioning_execution_manifest_configuration');
  function bind(prepared, staged, { currentFence, signal } = {}) {
    if (!isPreparedArtifact(prepared) || prepared.job.state !== 'claimed' || typeof currentFence !== 'function'
        || (signal !== undefined && !(signal instanceof AbortSignal))) throw rejected();
    async function verifyExecution() {
      try {
        const alive = () => { if (signal?.aborted) throw rejected(); };
        alive();
        const fence = structuredClone(await currentFence());
        const first = await stage.verify(actorId, prepared, staged, fence);
        alive();
        const refs = Object.fromEntries(Object.entries(prepared.compose.secrets).map(([key,value])=>[key,value.file]));
        const checked = await secretPreflight.check({ tenantId: prepared.job.tenantId, refs });
        if (!checked || Object.keys(checked).sort().join(',') !== 'checkedReferences,projectName,tenantId'
            || checked.tenantId !== prepared.job.tenantId || checked.projectName !== prepared.plan.projectName
            || !Array.isArray(checked.checkedReferences)
            || JSON.stringify([...checked.checkedReferences].sort()) !== JSON.stringify(Object.keys(refs).sort())) throw rejected();
        alive();
        // Recheck live authority and exact bytes after filesystem metadata work.
        const final = await stage.verify(actorId, prepared, staged, fence);
        alive();
        if (final !== first || final !== staged) throw rejected();
        return final.manifestPath;
      } catch { throw rejected(); }
    }
    return Object.freeze({ verifyExecution });
  }
  return Object.freeze({ bind });
}
