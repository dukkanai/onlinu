// Private, read-only production snapshot. Never prints credentials or customer data.
import { execFileSync } from 'node:child_process';
import { closeSync, copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = '/home/chatbot/wa/AstraCalls';
if (process.cwd() !== root || !existsSync(resolve(root, '.env'))) throw new Error('Unexpected workspace');
const app = 'astracalls-main-astracalls-1';
const postgres = 'astracalls-main-postgres-1';
const run = (args) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
const appInfo = JSON.parse(run(['inspect', '--format', '{{json .State}}', app]));
if (!appInfo.Running || appInfo.Health?.Status !== 'healthy') throw new Error('Production not healthy; investigate first');
mkdirSync(resolve(root, 'backups'), { recursive: true, mode: 0o700 });
const directory = mkdtempSync(resolve(root, 'backups/completion-update.'));
chmodSync(directory, 0o700);
copyFileSync(resolve(root, '.env'), resolve(directory, 'env.before'));
chmodSync(resolve(directory, 'env.before'), 0o600);
const capture = (filename, args) => {
  const fd = openSync(resolve(directory, filename), 'wx', 0o600);
  try { execFileSync('docker', args, { stdio: ['ignore', fd, 'pipe'], maxBuffer: 1024 * 1024 }); }
  finally { closeSync(fd); }
};
capture('postgres-all.sql', ['exec', postgres, 'pg_dumpall', '-U', 'astracalls']);
capture('recordings.tar.gz', ['exec', app, 'tar', '-C', '/data/recordings', '-czf', '-', '.']);
const state = {
  at: new Date().toISOString(),
  app: { id: run(['inspect', '--format', '{{.Id}}', app]), image: run(['inspect', '--format', '{{.Config.Image}}', app]) },
  postgres: { id: run(['inspect', '--format', '{{.Id}}', postgres]), startedAt: run(['inspect', '--format', '{{.State.StartedAt}}', postgres]), restarts: Number(run(['inspect', '--format', '{{.RestartCount}}', postgres])) },
  catalog: run(['exec', postgres, 'psql', '-U', 'astracalls', '-d', 'wacalls_main', '-At', '-c', "SELECT version || ':' || md5(document::text) FROM restaurant_catalog WHERE id=1"]),
  counts: run(['exec', postgres, 'psql', '-U', 'astracalls', '-d', 'wacalls_main', '-At', '-c', 'SELECT (SELECT count(*) FROM restaurant_orders),(SELECT count(*) FROM sessions),(SELECT count(*) FROM restaurant_couriers)']),
  sessionFingerprint: run(['exec', postgres, 'psql', '-U', 'astracalls', '-d', 'wacalls_main', '-At', '-c', "SELECT md5(COALESCE(jsonb_agg(to_jsonb(s) ORDER BY id)::text,'[]')) FROM sessions s"]),
  gatewayFingerprint: run(['exec', postgres, 'psql', '-U', 'astracalls', '-d', 'wacalls_main', '-At', '-c', "SELECT md5(COALESCE(jsonb_agg(to_jsonb(p) ORDER BY provider)::text,'[]')) FROM restaurant_payment_configs p"]),
};
writeFileSync(resolve(directory, 'before.json'), JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ backup: directory, verifiedHealthy: true, postgresUnchanged: true, counts: state.counts }));
