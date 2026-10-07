import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createProvisioningAuthentication } from './provisioning-authentication.mjs';
const key = 'public-synthetic-auth-key';
const denied = error => error.code === 'provisioning_authentication_rejected' && !JSON.stringify(error).includes(key);
async function server(t, handler) {
  const http = createServer(handler);
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  t.after(() => { http.closeAllConnections(); return new Promise(resolve => http.close(resolve)); });
  return http.address().port;
}
test('authentication checks absent and incorrect keys before valid key without collecting data', async t => {
  const seen = [];
  const port = await server(t, (req, res) => {
    seen.push({ path: req.url, method: req.method, key: req.headers['x-api-key'] });
    res.writeHead(req.url === '/healthz' || req.headers['x-api-key'] === key ? 200 : 401, { 'Set-Cookie': 'untrusted=ignored' });
    res.end('synthetic private catalogue ignored');
  });
  const checker = createProvisioningAuthentication({ loadAdministratorKey: async tenant => { assert.equal(tenant, 'fixture-a'); return key; } });
  const result = await checker.authenticate({ tenantId: 'fixture-a', port });
  assert.deepEqual(result, { authenticated: true, unauthorizedRejected: true }); assert.ok(Object.isFrozen(result));
  assert.equal(seen.length, 4); assert.equal(seen[0].path, '/healthz'); assert.equal(seen[0].key, undefined);
  assert.equal(seen[1].key, undefined); assert.notEqual(seen[2].key, key); assert.equal(seen[3].key, key);
  assert.ok(seen.every((x, i) => x.path === (i ? '/api/restaurant/catalog' : '/healthz') && x.method === 'GET'));
});
test('invalid target and cancelled calls never load credentials or make requests', async () => {
  let loads = 0; const checker = createProvisioningAuthentication({ loadAdministratorKey: async () => { loads++; return key; } });
  for (const input of [{ tenantId: 'fixture-a', port: 80 }, { tenantId: '../x', port: 18080 },
    { tenantId: 'fixture-a', port: 18080, host: 'remote.example' }, { tenantId: 'fixture-a', port: '18080' }])
    await assert.rejects(checker.authenticate(input), denied);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(checker.authenticate({ tenantId: 'fixture-a', port: 18080 }, { signal: abort.signal }), denied);
  assert.equal(loads, 0);
});
test('redirects and accidentally open endpoints fail without exposing the valid key', async t => {
  for (const status of [200, 302, 403, 500]) {
    let calls = 0;
    const port = await server(t, (req, res) => { calls++; assert.equal(req.headers['x-api-key'], undefined); res.writeHead(status, { Location: 'http://outside.invalid/' }); res.end(); });
    await assert.rejects(createProvisioningAuthentication({ loadAdministratorKey: async () => key }).authenticate({ tenantId: 'fixture-a', port }), denied);
    assert.equal(calls, status === 200 ? 2 : 1);
  }
});
test('wrong-key acceptance and invalid real key responses fail closed', async t => {
  for (const mode of ['wrong-accepted', 'valid-rejected']) {
    const port = await server(t, (req, res) => {
      const provided = req.headers['x-api-key'];
      res.writeHead(req.url === '/healthz' || (mode === 'wrong-accepted' && provided && provided !== key) ? 200 : 401); res.end();
    });
    await assert.rejects(createProvisioningAuthentication({ loadAdministratorKey: async () => key }).authenticate({ tenantId: 'fixture-a', port }), denied);
  }
});
test('deadline terminates a silent loopback request and sanitizes failures', async t => {
  const port = await server(t, () => {});
  await assert.rejects(createProvisioningAuthentication({ loadAdministratorKey: async () => key, timeoutMs: 100 }).authenticate({ tenantId: 'fixture-a', port }), denied);
  const healthyPort = await server(t, (req, res) => { assert.equal(req.url, '/healthz'); res.writeHead(200); res.end(); });
  for (const value of ['', 'bad\r\nheader', 'x'.repeat(4097), undefined])
    await assert.rejects(createProvisioningAuthentication({ loadAdministratorKey: async () => value }).authenticate({ tenantId: 'fixture-a', port: healthyPort }), denied);
});
test('response header limits and cancellation after loading prevent successful evidence', async t => {
  const port = await server(t, (req, res) => { res.writeHead(200, { 'X-Oversized': 'x'.repeat(9000) }); res.end(); });
  let loaded = false;
  await assert.rejects(createProvisioningAuthentication({ loadAdministratorKey: async () => { loaded = true; return key; } }).authenticate({ tenantId: 'fixture-a', port }), denied);
  assert.equal(loaded, false);
  const abort = new AbortController(); let calls = 0;
  const healthyPort = await server(t, (req, res) => { calls++; res.writeHead(200); res.end(); });
  await assert.rejects(createProvisioningAuthentication({ loadAdministratorKey: async () => { abort.abort(); return key; } })
    .authenticate({ tenantId: 'fixture-a', port: healthyPort }, { signal: abort.signal }), denied);
  assert.equal(calls, 1);
});
test('negative probe cannot equal the supplied key and target is snapshotted before loading', async t => {
  const specialKey = 'onlinu-negative-auth-probe', seen = [];
  const port = await server(t, (req, res) => { seen.push(req.headers['x-api-key']); res.writeHead(req.url === '/healthz' || req.headers['x-api-key'] === specialKey ? 200 : 401); res.end(); });
  const input = { tenantId: 'fixture-a', port };
  await createProvisioningAuthentication({ loadAdministratorKey: async () => { input.port = 80; input.tenantId = 'neighbor'; return specialKey; } }).authenticate(input);
  assert.equal(seen.length, 4); assert.notEqual(seen[2], specialKey); assert.equal(seen[3], specialKey);
});
