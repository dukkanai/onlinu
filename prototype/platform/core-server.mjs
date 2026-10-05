// Local integration entry point. Uses real restaurant APIs; no synthetic menu.
// Public deployment and order creation await identity/checkout acceptance.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createCoreAdapter } from './core-adapter.mjs';
import { createMcpHandler } from './mcp.mjs';

export function createCoreServer({ baseUrl, restaurants }) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.pathname !== '/'
      || base.username || base.password || base.search || base.hash) throw new Error('core_bridge_requires_loopback_origin');
  const adapter = createCoreAdapter({ restaurants });
  const handler = createMcpHandler({ baseUrl: base.origin, authenticate: async () => null, coreAdapter: adapter });
  const windows = new Map();
  const server = http.createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    if (req.headers.host !== base.host || (req.headers.origin && req.headers.origin !== base.origin)) {
      res.writeHead(403); res.end(); return;
    }
    const key = req.socket.remoteAddress;
    let row = windows.get(key); const now = Date.now();
    if (!row || row.until < now) { row = { until: now + 60_000, count: 0 }; windows.set(key, row); }
    if (++row.count > 240) { res.writeHead(429, { 'retry-after': '60' }); res.end(); return; }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', mode: 'core_readonly', ordersEnabled: false })); return;
    }
    if (req.url !== '/mcp') { res.writeHead(404); res.end(); return; }
    try { await handler(req, res); }
    catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  return { server, adapter };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!process.env.CORE_RESTAURANTS_FILE) throw new Error('CORE_RESTAURANTS_FILE required');
  const raw = await readFile(process.env.CORE_RESTAURANTS_FILE);
  if (raw.length > 128_000) throw new Error('oversized_core_configuration');
  const baseUrl = process.env.CORE_BASE_URL ?? 'http://127.0.0.1:18788';
  const { server } = createCoreServer({ baseUrl, restaurants: JSON.parse(raw) });
  const base = new URL(baseUrl);
  server.listen(Number(base.port || 80), '127.0.0.1', () => console.log('Read-only restaurant core MCP bridge ready'));
  const stop = () => server.close(() => process.exit(0));
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
