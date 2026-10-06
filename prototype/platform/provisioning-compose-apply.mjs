/** One private, bounded Compose creation attempt. Capabilities are supplied by
 * the trusted host driver under its existing host lock and journal fencing.
 * No public route, retries, pull/build, cleanup, activation or secret generation.
 */
import { isAbsolute } from 'node:path';
import { problem } from './auth.mjs';
const rejected = () => problem(409, 'provisioning_compose_apply_unconfirmed');
export function createProvisioningComposeApply({ processRunner, verifyExecution, assertEmpty }) {
  if (typeof processRunner?.run !== 'function' || typeof verifyExecution !== 'function' || typeof assertEmpty !== 'function')
    throw new Error('invalid_provisioning_compose_configuration');
  let attempted = false;
  async function apply({ checkpoint, signal } = {}) {
    if (attempted) throw rejected();
    attempted = true;
    try {
      if (typeof checkpoint !== 'function' || (signal !== undefined && !(signal instanceof AbortSignal))) throw rejected();
      let manifest;
      const alive = () => { if (signal?.aborted) throw rejected(); };
      async function verify() {
        alive();
        const path = await verifyExecution();
        alive();
        if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || path.length > 4096
            || (manifest !== undefined && path !== manifest)) throw rejected();
        manifest = path;
      }
      async function run(args) {
        alive();
        const result = await processRunner.run(['--context', 'default', ...args], { signal });
        alive();
        if (typeof result !== 'string' || Buffer.byteLength(result) > 1048576) throw rejected();
        return result;
      }
      await checkpoint(); await verify();
      const contexts = JSON.parse(await run(['context', 'inspect', 'default']));
      if (!Array.isArray(contexts) || contexts.length !== 1 || contexts[0]?.Name !== 'default'
          || contexts[0]?.Endpoints?.docker?.Host !== 'unix:///var/run/docker.sock') throw rejected();
      const args = () => ['compose', '--env-file', '/dev/null', '-f', manifest];
      await run([...args(), 'config', '--quiet']);
      await checkpoint(); await verify();
      await assertEmpty();
      await checkpoint(); await verify();
      // From this point the daemon may retain effects even if the client loses
      // its reply or is killed. Never retry or implicitly delete those effects.
      await run([...args(), 'up', '--wait', '--wait-timeout', '90', '--pull', 'never', '--no-build']);
      return Object.freeze({ commandCompleted: true });
    } catch { throw rejected(); }
  }
  return Object.freeze({ apply });
}
