/** Read-only resolution of already-present, reviewed digest-pinned images.
 * No registry login, pull, build, tagging, daemon mutation or release approval.
 */
import { isPreparedArtifact } from './provisioning-artifacts.mjs';
import { problem } from './auth.mjs';
const rejected = () => problem(409, 'provisioning_image_preflight_rejected');
const imageId = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
export function createProvisioningImagePreflight({ processRunner, architecture = 'amd64' }) {
  if (typeof processRunner?.run !== 'function' || architecture !== 'amd64')
    throw new Error('invalid_provisioning_image_preflight_configuration');
  async function inspect(prepared, { signal } = {}) {
    try {
      if (!isPreparedArtifact(prepared) || prepared.job.state !== 'claimed'
          || (signal !== undefined && !(signal instanceof AbortSignal))) throw rejected();
      async function read(args) {
        if (signal?.aborted) throw rejected();
        const output = await processRunner.run(['--context', 'default', ...args], { signal });
        if (signal?.aborted || typeof output !== 'string' || Buffer.byteLength(output) > 1048576) throw rejected();
        return JSON.parse(output);
      }
      const context = await read(['context', 'inspect', 'default']);
      if (!Array.isArray(context) || context.length !== 1 || context[0]?.Name !== 'default'
          || context[0]?.Endpoints?.docker?.Host !== 'unix:///var/run/docker.sock') throw rejected();
      const result = {};
      for (const service of ['restaurant', 'postgres']) {
        const reference = prepared.compose.services[service].image;
        const info = await read(['image', 'inspect', reference, '--format', '{{json .}}']);
        if (!info || !imageId(info.Id) || info.Os !== 'linux' || info.Architecture !== architecture
            || !Array.isArray(info.RepoDigests) || !info.RepoDigests.includes(reference)
            || (service === 'restaurant' && info.Config?.User !== '10001:10001')) throw rejected();
        result[service] = info.Id;
      }
      if (result.restaurant === result.postgres) throw rejected();
      return Object.freeze(result);
    } catch { throw rejected(); }
  }
  return Object.freeze({ inspect });
}
