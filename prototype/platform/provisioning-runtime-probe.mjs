/** Read-only private Docker observation adapter. The supplied process capability
 * must be the bounded local Docker executable owned by the trusted host driver.
 * No shell, compose apply, credential read, cleanup, retry or activation.
 */
import { createHash } from 'node:crypto';
import { inspectProvisionedRuntime } from './provisioning-runtime-inspection.mjs';
import { problem } from './auth.mjs';
const reject = () => { throw problem(409, 'provisioning_runtime_probe_failed'); };
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function createProvisioningRuntimeProbe({ processRunner }) {
  if (typeof processRunner?.run !== 'function') throw new Error('invalid_provisioning_probe_configuration');
  async function observe(input, { signal } = {}, requireEmpty = false) {
    try {
      if (signal !== undefined && !(signal instanceof AbortSignal)) reject();
      const expected = structuredClone(input);
      if (typeof expected?.tenantId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(expected.tenantId)
          || !sha(expected.planDigest)) reject();
      const project = 'onlinu-' + createHash('sha256').update(expected.tenantId).digest('hex').slice(0, 32);
      if (expected.projectName !== project) reject();
      const networkNames = ['database', 'egress'].map(v => {
        const name = expected.compose?.networks?.[v]?.name;
        if (name !== project + '-' + v) reject();
        return name;
      });
      const volumeNames = ['media', 'postgres'].map(v => {
        const name = expected.compose?.volumes?.[v]?.name;
        if (name !== project + '-' + v) reject();
        return name;
      });
      async function call(args) {
        if (signal?.aborted) reject();
        const output = await processRunner.run(['--context', 'default', ...args], { signal });
        if (signal?.aborted || typeof output !== 'string' || Buffer.byteLength(output) > 1048576) reject();
        return output;
      }
      async function array(args, count) {
        const value = JSON.parse(await call(args));
        if (!Array.isArray(value) || value.length !== count) reject();
        return value;
      }
      const contexts = await array(['context', 'inspect', 'default'], 1);
      if (contexts[0]?.Name !== 'default' || contexts[0]?.Endpoints?.docker?.Host !== 'unix:///var/run/docker.sock') reject();
      const text = (await call(['container', 'ls', '-aq', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + project])).trim();
      const ids = text ? text.split(/\s+/) : [];
      if (requireEmpty) {
        if (ids.length) reject();
        for (const [type, wanted] of [['volume', volumeNames], ['network', networkNames]]) {
          const output = (await call([type, 'ls', '--format', '{{.Name}}'])).trim();
          const names = output ? output.split(/\r?\n/) : [];
          if (names.some(v => !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v))
              || new Set(names).size !== names.length || wanted.some(v => names.includes(v))) reject();
        }
        return Object.freeze({ projectName: project, empty: true });
      }
      if (ids.length !== 2 || !ids.every(sha) || new Set(ids).size !== 2) reject();
      const containers = await array(['container', 'inspect', ...ids], 2);
      if (containers.some(v => !ids.includes(v?.Id))) reject();
      const networks = await array(['network', 'inspect', ...networkNames], 2);
      const volumes = await array(['volume', 'inspect', ...volumeNames], 2);
      return inspectProvisionedRuntime(expected, { containers, networks, volumes });
    } catch { reject(); }
  }
  return Object.freeze({
    inspect: (input, options) => observe(input, options),
    assertEmpty: (input, options) => observe(input, options, true),
  });
}
