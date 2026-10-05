// Mutates only the explicitly labelled disposable QA application container.
import { execFileSync, spawnSync } from 'node:child_process';
const app = 'astracalls-completion-test-app', postgres = 'astracalls-completion-test-postgres';
const run = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 }).trim();
for (const container of [app, postgres]) {
  if (run(['inspect', '--format', '{{index .Config.Labels "astracalls.purpose"}}', container]) !== 'completion-isolated-test') throw new Error('Refusing non-test container');
}
const fingerprint = () => run(['exec', postgres, 'psql', '-U', 'astracalls_test', '-d', 'completionqa_main', '-At', '-c', "SELECT (SELECT md5(document::text) FROM restaurant_catalog WHERE id=1),(SELECT count(*) FROM restaurant_orders),(SELECT count(*) FROM restaurant_couriers),(SELECT count(*) FROM restaurant_refunds),(SELECT md5(COALESCE(jsonb_agg(to_jsonb(s) ORDER BY item_id)::text,'[]')) FROM restaurant_stock s)"]);
const before = fingerprint();
const image = run(['inspect', '--format', '{{.Config.Image}}', app]);
if (image !== 'astracalls-translation:0.5.0-dev-20260927-completion') throw new Error('Unexpected test image');
const duplicate = spawnSync('docker', ['run', '--rm', '--pull', 'never', '--label', 'astracalls.purpose=completion-isolated-test', '--network', 'host', '-e', 'WACALLS_PG_URL=postgres://astracalls_test:completion-test-only@127.0.0.1:15433/astracalls_restaurant_test?sslmode=disable', '-e', 'WACALLS_PG_NAMESPACE=completionqa', '-e', 'WACALLS_API_KEY=restaurant-browser-test-key', image, '-addr', '127.0.0.1:18085'], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
if (duplicate.status !== 1 || !duplicate.stderr.includes('another application already owns this database namespace')) throw new Error('Duplicate namespace startup was not refused');
run(['stop', '--time', '5', app]);
run(['start', app]);
let ready = false;
for (let attempt = 0; attempt < 20; attempt++) {
  try { if ((await fetch('http://127.0.0.1:18083/healthz', { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
  await new Promise(resolve => setTimeout(resolve, 500));
}
if (!ready || fingerprint() !== before) throw new Error('Test restart failed readiness/data preservation');
console.log(JSON.stringify({ duplicateNamespaceStartupRefused: true, isolatedRestartHealthy: true, catalogOrdersCouriersRefundsStockPreserved: true, productionTouched: false }));
