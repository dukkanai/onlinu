/** Ephemeral CI bridge: real journal/compiler/stager/locks/processes plus two
 * disposable Docker tenants. Fixture image/path overrides are explicit; this
 * is not the production apply driver or a real-credential provisioning path.
 */
import pg from 'pg';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createIdentityDirectory } from '../identity-directory.mjs';
import { createProvisioningJournal } from '../provisioning-journal.mjs';
import { createProvisioningArtifacts } from '../provisioning-artifacts.mjs';
import { createProvisioningRunner } from '../provisioning-runner.mjs';
import { createProvisioningStage } from '../provisioning-stage.mjs';
import { createProvisioningEvidence } from '../provisioning-evidence.mjs';
import { createProvisioningRuntimeProbe } from '../provisioning-runtime-probe.mjs';
import { createProvisioningComposeApply } from '../provisioning-compose-apply.mjs';
import { createProvisioningHostLock } from '../provisioning-host-lock.mjs';
import { createProvisioningProcess } from '../provisioning-process.mjs';
import { validateContext } from '../../../integration/provisioning-cancellation-smoke.mjs';

export const FIXTURE_IDENTITY_ISSUER = 'https://identity.example.invalid/';
const hash = value => createHash('sha256').update(value).digest('hex');
const compiler = fileURLToPath(new URL('../../../deploy/tenant_plan.py', import.meta.url));
export function verifyTestDatabase(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'postgres:' || url.hostname !== '127.0.0.1' || url.port !== '5432'
        || url.username !== 'postgres' || url.password !== 'ci-only-test-password'
        || url.pathname !== '/astracalls_identity_test' || url.search !== '?sslmode=disable' || url.hash) throw new Error();
    return url.href;
  } catch { throw new Error('fixture_database_not_allowed'); }
}
export function owned(labels, fixture) {
  if (labels?.['org.onlinu.tenant'] !== fixture.config.tenantId
      || labels?.['org.onlinu.plan-digest'] !== fixture.plan.planDigest
      || labels?.['com.docker.compose.project'] !== fixture.plan.projectName) throw new Error('fixture_ownership_mismatch');
}
export function constraints(info, fixture, service) {
  const host = info.HostConfig;
  if (!['restaurant', 'postgres'].includes(service) || !host || host.Privileged !== false
      || !/^sha256:[a-f0-9]{64}$/.test(info.Image ?? '') || info.Image !== fixture.images[service]) throw new Error('fixture_container_mismatch');
  if (service === 'postgres') {
    if (Object.keys(host.PortBindings ?? {}).length) throw new Error('fixture_database_published');
    return;
  }
  const binding = { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(fixture.config.httpPort) }] };
  if (info.Config?.User !== '10001:10001' || host.ReadonlyRootfs !== true || !host.CapDrop?.includes('ALL')
      || host.CapAdd?.length || JSON.stringify(host.PortBindings) !== JSON.stringify(binding)
      || !host.SecurityOpt?.some(x => ['no-new-privileges', 'no-new-privileges:true'].includes(x))
      || info.Config?.Env?.some(x => /^(WACALLS_API_KEY|WACALLS_PG_URL|WACALLS_META_ENCRYPTION_KEY|POSTGRES_PASSWORD)=/.test(x))
      || info.Mounts?.some(x => x.Destination === '/var/run/docker.sock')) throw new Error('fixture_runtime_hardening_mismatch');
}
async function freePort() {
  const server = createServer();
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const port = server.address().port;
  await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
  return port;
}
async function status(port, path, key) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: key ? { 'X-API-Key': key } : {} });
  await response.body?.cancel(); return response.status;
}

export async function runSmoke(image, env = process.env) {
  validateContext(env, image);
  const database = verifyTestDatabase(env.IDENTITY_TEST_DATABASE_URL);
  const root = await mkdtemp(join(env.RUNNER_TEMP, 'onlinu-journal-docker-'));
  const admin = new pg.Pool({ connectionString: database, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  const schema = 'provision_smoke_' + randomBytes(8).toString('hex');
  let pool, schemaOwned = false, report, phase = 'host-checks';
  const fixtures = [];
  const processRunner = createProvisioningProcess({ executable: '/usr/bin/docker', workingDirectory: root, timeoutMs: 120000 });
  const runtimeProbe = createProvisioningRuntimeProbe({ processRunner });
  const call = args => processRunner.run(['--context', 'default', ...args]);
  const json = async args => JSON.parse(await call(args));
  const inspect = async (id, type = 'container') => (await json([type, 'inspect', id]))[0];
  const ids = async f => (await call(['container', 'ls', '-aq', '--no-trunc', '--filter',
    'label=com.docker.compose.project=' + f.plan.projectName])).trim().split(/\s+/).filter(Boolean);
  const names = async type => new Set((await call([type, 'ls', '--format', '{{.Name}}'])).trim().split(/\s+/).filter(Boolean));
  async function manifest(f) {
    if (hash(await readFile(f.manifest, 'utf8')) !== f.manifestHash) throw new Error('fixture_manifest_changed');
  }
  async function compose(f, args) {
    await manifest(f);
    return call(['compose', '--env-file', '/dev/null', '-f', f.manifest, ...args]);
  }
  async function empty(f) {
    await runtimeProbe.assertEmpty({ tenantId: f.config.tenantId, planDigest: f.plan.planDigest,
      projectName: f.plan.projectName, images: f.images, httpPort: f.config.httpPort, compose: f.spec });
  }
  async function verifyOwnership(f, requireHealthy = false) {
    if (requireHealthy) {
      const result = await runtimeProbe.inspect({ tenantId: f.config.tenantId, planDigest: f.plan.planDigest,
        projectName: f.plan.projectName, images: f.images, httpPort: f.config.httpPort, compose: f.spec });
      return { restaurant: result.restaurant.containerId, postgres: result.postgres.containerId };
    }
    const current = await ids(f);
    if (current.length > 2 || (requireHealthy && current.length !== 2)) throw new Error('fixture_container_count');
    const seen = new Set(), observed = {};
    for (const id of current) {
      const info = await inspect(id);
      owned(info.Config?.Labels, f);
      const service = info.Config.Labels['com.docker.compose.service'];
      if (!['postgres', 'restaurant'].includes(service) || seen.has(service)) throw new Error('fixture_service_mismatch');
      seen.add(service); constraints(info, f, service); observed[service] = info.Id;
      if (requireHealthy && (!info.State?.Running || info.State.Health?.Status !== 'healthy')) throw new Error('fixture_not_healthy');
    }
    for (const [type, field] of [['volume', 'volumes'], ['network', 'networks']]) {
      const existing = await names(type);
      for (const resource of Object.values(f.spec[field])) {
        if (existing.has(resource.name)) {
          const info = await inspect(resource.name, type);
          owned(info.Labels, f);
        }
        else if (requireHealthy) throw new Error('fixture_resource_missing');
      }
    }
    return { restaurant: observed.restaurant, postgres: observed.postgres };
  }
  try {
    const context = (await json(['context', 'inspect', 'default']))[0];
    if (context?.Endpoints?.docker?.Host !== 'unix:///var/run/docker.sock') throw new Error('fixture_daemon_not_local');
    const images = { restaurant: (await inspect(image, 'image')).Id, postgres: (await inspect('postgres:16', 'image')).Id };
    if (Object.values(images).some(x => !/^sha256:[a-f0-9]{64}$/.test(x))) throw new Error('fixture_image_missing');
    phase = 'journal-initialization';
    await admin.query(`CREATE SCHEMA ${schema}`); schemaOwned = true;
    pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}`, max: 4, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    const issuer = FIXTURE_IDENTITY_ISSUER;
    const directory = createIdentityDirectory({ pool, trustedIssuers: [issuer] }); await directory.init();
    // Synthetic identities only. This does not bypass a production OIDC verifier.
    const actor = await directory.verifiedIdentity({ issuer, subject: 'ci-operator' });
    const owner = await directory.verifiedIdentity({ issuer, subject: 'ci-owner' });
    await pool.query('UPDATE platform_identities SET platform_admin=TRUE WHERE id=$1', [actor.id]);
    const journal = createProvisioningJournal({ pool, leaseSeconds: 300 }); await journal.init();
    const artifactRoot = join(root, 'artifacts'), stageRoot = join(root, 'staged'), lockRoot = join(root, 'locks');
    for (const path of [artifactRoot, stageRoot, lockRoot]) await mkdir(path, { mode: 0o700 });
    const stage = createProvisioningStage({ journal, directory: stageRoot });
    const evidenceRoot = join(root, 'evidence'); await mkdir(evidenceRoot, { mode: 0o700 });
    const evidenceStore = createProvisioningEvidence({ directory: evidenceRoot });
    const hostLock = createProvisioningHostLock({ directory: lockRoot });
    const nonce = randomBytes(6).toString('hex');
    for (let number = 0; number < 2; number++) {
      phase = 'fixture-preparation';
      const tenantId = `ci-journal-${env.GITHUB_RUN_ID}-${nonce}-${number}`;
      const config = { tenantId, runtimeImage: 'registry.example/onlinu@sha256:' + 'a'.repeat(64),
        postgresImage: 'postgres@sha256:' + 'b'.repeat(64), httpPort: await freePort(),
        publicOrigin: `https://${tenantId}.example.invalid`, platformIssuer: 'https://platform.example.invalid',
        platformPublicKey: Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64') };
      const source = JSON.stringify([config]);
      const plan = JSON.parse(execFileSync('/usr/bin/python3', ['-I', '-S', '-B', compiler], {
        input: source, encoding: 'utf8', maxBuffer: 262144, timeout: 5000, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      }))[0];
      await writeFile(join(artifactRoot, plan.planDigest + '.json'), source, { mode: 0o600, flag: 'wx' });
      await directory.createTenant(actor.id, { id: tenantId, name: tenantId, ownerId: owner.id });
      let job = await journal.request(actor.id, tenantId, { requestId: randomUUID(), expectedTenantVersion: 1, planDigest: plan.planDigest });
      const artifacts = createProvisioningArtifacts({ journal, artifactDirectory: artifactRoot,
        secretRoot: '/srv/onlinu/ci-owned-fixtures', platformIssuer: config.platformIssuer,
        platformPublicKey: config.platformPublicKey, runtimeImage: config.runtimeImage,
        postgresImage: config.postgresImage, bootstrapSha256: plan.postgres.bootstrapAssetSha256 });
      const f = { config, plan, images, spec: null, manifest: null, manifestHash: null, effectsPossible: false, applies: 0 };
      fixtures.push(f);
      const driver = {
        withLock: hostLock.withLock,
        async inspect(prepared) { f.spec = structuredClone(prepared.compose); await empty(f); },
        async apply(prepared, { checkpoint }) {
          f.applies++;
          const fence = await checkpoint();
          const staged = await stage.stage(actor.id, prepared, { expectedVersion: fence.version, workerId: fence.workerId });
          await stage.verify(actor.id, prepared, staged, { expectedVersion: fence.version, workerId: fence.workerId });
          const target = join(root, 'fixture-' + number); await mkdir(target, { mode: 0o700 });
          // Explicit CI-only image/path overrides; original staged files remain
          // unchanged. These public synthetic values never represent real keys.
          const values = { administrator: `public-ci-admin-${nonce}-${number}`, pg_bootstrap: `public-ci-bootstrap-${nonce}-${number}`,
            runtime_password: `public-ci-database-${nonce}-${number}`,
            runtime_pg_url: `postgres://onlinu_runtime:public-ci-database-${nonce}-${number}@postgres:5432/postgres?sslmode=disable`,
            meta_key: Buffer.alloc(32, number + 1).toString('base64') };
          f.key = values.administrator;
          if (Object.keys(f.spec.secrets).sort().join(',') !== Object.keys(values).sort().join(',')) throw new Error('fixture_secret_contract');
          for (const [name, entry] of Object.entries(f.spec.secrets)) {
            const path = join(target, name);
            await writeFile(path, values[name] + '\n', { mode: 0o444, flag: 'wx' });
            await chmod(path, 0o444); entry.file = path;
          }
          f.spec.services.restaurant.image = image; f.spec.services.postgres.image = 'postgres:16';
          f.spec.configs.runtime_bootstrap.file = staged.bootstrapPath;
          f.manifest = join(target, 'compose.json'); const text = JSON.stringify(f.spec);
          await writeFile(f.manifest, text, { mode: 0o600, flag: 'wx' }); f.manifestHash = hash(text);
          const applyTransport = createProvisioningComposeApply({ processRunner,
            verifyExecution: async () => {
              await manifest(f);
              return f.manifest; // Explicit synthetic overrides, not a production manifest capability.
            }, assertEmpty: () => empty(f) });
          f.effectsPossible = true;
          await applyTransport.apply({ checkpoint });
          if (number === 1) throw new Error('intentional_fixture_lost_apply_reply');
        },
        async verify(prepared) {
          const containerIds = await verifyOwnership(f, true);
          if (await status(config.httpPort, '/healthz') !== 200
              || await status(config.httpPort, '/api/restaurant/catalog', f.key) !== 200
              || await status(config.httpPort, '/api/restaurant/catalog', 'wrong-public-fixture-key') !== 401)
            throw new Error('fixture_runtime_authentication');
          const reference = await evidenceStore.write({ jobId: prepared.job.id, workerId: prepared.job.workerId,
            tenantId, planDigest: plan.planDigest, projectName: plan.projectName, sourceCommit: env.GITHUB_SHA, scope: 'fixture',
            resources: { restaurant: { containerId: containerIds.restaurant, imageId: images.restaurant },
              postgres: { containerId: containerIds.postgres, imageId: images.postgres } },
            checks: { ownership: true, healthy: true, authenticated: true, unauthorizedRejected: true } });
          // Read from a fresh store instance, not an in-memory attestation cache.
          const stored = await createProvisioningEvidence({ directory: evidenceRoot }).read(reference);
          if (hash(JSON.stringify(stored) + '\n') !== reference.sha256) throw new Error('fixture_evidence_changed');
          f.verificationEvidence = { reference, stored };
          return { jobId: prepared.job.id, tenantId, planDigest: plan.planDigest, verificationSha256: reference.sha256 };
        },
      };
      const runner = createProvisioningRunner({ journal, artifacts, driver });
      const input = { expectedVersion: job.version, workerId: randomUUID() };
      phase = number === 0 ? 'successful-attempt' : 'uncertain-attempt';
      if (number === 0) {
        job = await runner.run(actor.id, job.id, input);
        if (job.state !== 'succeeded') throw new Error('fixture_success_not_recorded');
      } else {
        let unknown = false;
        try { await runner.run(actor.id, job.id, input); }
        catch (error) { if (error.code === 'provisioning_outcome_unknown') unknown = true; else throw error; }
        job = await journal.get(actor.id, job.id);
        if (!unknown || job.state !== 'unknown') throw new Error('fixture_uncertainty_not_retained');
        let blocked = false;
        try { await runner.run(actor.id, job.id, { expectedVersion: job.version, workerId: randomUUID() }); }
        catch (error) { if (error.code === 'invalid_provisioning_transition') blocked = true; else throw error; }
        if (!blocked || f.applies !== 1) throw new Error('fixture_replay_not_blocked');
        phase = 'explicit-reconciliation';
        job = await hostLock.withLock(plan.projectName, async () => {
          const current = await journal.get(actor.id, job.id);
          if (current.state !== 'unknown' || current.version !== job.version) throw new Error('fixture_reconciliation_changed');
          const evidence = await driver.verify({ job: current });
          return journal.reconcile(actor.id, current.id, { expectedVersion: current.version,
            decision: 'accept', evidenceDigest: hash(JSON.stringify(evidence)) });
        });
        if (job.state !== 'succeeded') throw new Error('fixture_reconciliation_not_recorded');
      }
      if (f.applies !== 1) throw new Error('fixture_apply_count');
    }
    phase = 'final-journal-check';
    if ((await pool.query("SELECT count(*)::int AS n FROM platform_tenants WHERE status='draft'")).rows[0].n !== 2
        || (await pool.query("SELECT count(*)::int AS n FROM platform_provision_jobs WHERE state='succeeded'")).rows[0].n !== 2)
      throw new Error('fixture_journal_final_state');
    report = { sourceCommit: env.GITHUB_SHA, productionDeployed: false, registryPublished: false,
      realCredentialsUsed: false, fixtureCount: 2, localImageIds: fixtures[0].images,
      verificationEvidence: fixtures.map(f => f.verificationEvidence),
      testOnlyOverrides: ['image references', 'host synthetic secret/config paths', 'synthetic verified identities'],
      checks: ['real-postgresql-journal', 'authoritative-artifact-compiler', 'exclusive-staged-artifacts',
        'linux-host-lock', 'bounded-docker-commands', 'successful-attempt-recorded', 'lost-apply-reply-retained-as-unknown',
        'uncertain-attempt-replay-blocked', 'actual-owned-runtime-inspected-before-reconciliation',
        'explicit-evidenced-reconciliation', 'durable-immutable-verification-receipts', 'fresh-reader-evidence-hash-verification', 'reconciliation-under-host-lock', 'one-apply-per-fixture', 'tenant-activation-not-implied'],
      notVerified: ['production-apply-driver', 'production-registry-digests', 'real-secret-provisioning',
        'external-identity-provider', 'production-routing', 'backup-restore', 'real-calls'] };
  } catch {
    throw Object.assign(new Error('fixture_operation_failed'), { fixturePhase: phase });
  } finally {
    let cleanupFailed = false;
    for (const f of fixtures.reverse()) if (f.effectsPossible) {
      try { await verifyOwnership(f); await compose(f, ['down', '--volumes', '--timeout', '15']); await empty(f); }
      catch { cleanupFailed = true; }
    }
    try {
      if (pool) await pool.end();
      // Keep journal evidence if Docker cleanup was uncertain; never pretend a
      // database cleanup compensates for an unknown external outcome.
      if (schemaOwned && !cleanupFailed) {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        if ((await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount) cleanupFailed = true;
      }
    } catch { cleanupFailed = true; }
    finally { try { await admin.end(); } catch { cleanupFailed = true; } }
    if (cleanupFailed) throw new Error('fixture_cleanup_not_confirmed');
    await rm(root, { recursive: true, force: true });
  }
  if (!report) throw new Error('fixture_report_missing');
  report.checks.push('exact-owned-docker-and-schema-cleanup');
  await writeFile(join(env.RUNNER_TEMP, 'onlinu-journal-docker-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Real PostgreSQL journal and disposable Docker tenant lifecycle acceptance passed.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { if (process.argv.length !== 3) throw new Error(); await runSmoke(process.argv[2]); }
  catch (error) {
    const phases = new Set(['host-checks', 'journal-initialization', 'fixture-preparation', 'successful-attempt',
      'uncertain-attempt', 'explicit-reconciliation', 'final-journal-check']);
    const phase = phases.has(error?.fixturePhase) ? error.fixturePhase
      : error?.message === 'fixture_cleanup_not_confirmed' ? 'owned-cleanup' : 'context-or-finalization';
    console.error('Isolated journal/Docker fixture failed at ' + phase + '; no broader cleanup attempted.');
    process.exitCode = 1;
  }
}
