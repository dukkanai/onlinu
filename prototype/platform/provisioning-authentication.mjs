/** Bounded, loopback-only authentication observation for an already-owned runtime.
 * The trusted caller supplies an approved, bounded in-memory key capability.
 * No credential files, redirects, proxies, retries, cookies or public route.
 */
import { request } from 'node:http';
import { problem } from './auth.mjs';
const rejected = () => problem(409, 'provisioning_authentication_rejected');
export function createProvisioningAuthentication({ loadAdministratorKey, timeoutMs = 5000 }) {
  if (typeof loadAdministratorKey !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 10000)
    throw new Error('invalid_provisioning_authentication_configuration');
  function status(port, key, signal, path = '/api/restaurant/catalog') {
    return new Promise((resolve, reject) => {
      // Direct node:http bypasses ambient fetch dispatchers and proxy settings.
      const req = request({ hostname: '127.0.0.1', family: 4, port, method: 'GET',
        path, agent: false, maxHeaderSize: 8192, signal,
        headers: key === undefined ? {} : { 'X-API-Key': key } }, response => {
        const code = response.statusCode;
        response.destroy(); // No catalogue, response body, cookies or diagnostics retained.
        resolve(code);
      });
      req.on('error', () => reject(rejected()));
      req.end();
    });
  }
  async function authenticate(input, { signal } = {}) {
    try {
      if (!input || Object.keys(input).sort().join(',') !== 'port,tenantId'
          || typeof input.tenantId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.tenantId)
          || !Number.isInteger(input.port) || input.port < 1024 || input.port > 65535
          || (signal !== undefined && !(signal instanceof AbortSignal))) throw rejected();
      const { tenantId, port } = input;
      const bounded = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
      bounded.throwIfAborted();
      if (await status(port, undefined, bounded, '/healthz') !== 200) throw rejected();
      // Loader owns approved credential access; it must honor the supplied bound.
      const key = await loadAdministratorKey(tenantId, { signal: bounded });
      bounded.throwIfAborted();
      if (typeof key !== 'string' || key.length < 1 || key.length > 4096 || /[^\x20-\x7e]/.test(key)) throw rejected();
      if (await status(port, undefined, bounded) !== 401) throw rejected();
      const wrongKey = key === 'onlinu-negative-auth-probe' ? 'onlinu-negative-auth-probe-2' : 'onlinu-negative-auth-probe';
      if (await status(port, wrongKey, bounded) !== 401 || await status(port, key, bounded) !== 200) throw rejected();
      bounded.throwIfAborted();
      return Object.freeze({ authenticated: true, unauthorizedRejected: true });
    } catch { throw rejected(); }
  }
  return Object.freeze({ authenticate });
}
