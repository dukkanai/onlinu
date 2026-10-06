/** Opt-in ephemeral-runner acceptance of client cancellation versus daemon state.
 * Creates (never starts) one owned container with no mounts, secrets or ports.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createProvisioningHostLock } from '../prototype/platform/provisioning-host-lock.mjs';
import { createProvisioningProcess } from '../prototype/platform/provisioning-process.mjs';

export function validateContext(env, image) {
  if (env.GITHUB_ACTIONS !== 'true' || !/^[0-9]+$/.test(env.GITHUB_RUN_ID ?? '')
      || !/^[0-9]+$/.test(env.GITHUB_RUN_ATTEMPT ?? '') || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')
      || typeof env.RUNNER_TEMP !== 'string' || !isAbsolute(env.RUNNER_TEMP)
      || image !== 'onlinu-runtime-smoke:' + env.GITHUB_SHA) throw new Error('invalid_cancellation_fixture_context');
}
export function assertOwned(info, expected) {
  if (!/^[a-f0-9]{64}$/.test(info?.Id ?? '') || info.Name !== '/' + expected.name || info.Image !== expected.imageId
      || Object.entries(expected.labels).some(([key, value]) => info.Config?.Labels?.[key] !== value))
    throw new Error('cancellation_fixture_ownership_mismatch');
}
export function assertInert(info) {
  const host = info.HostConfig;
  if (info.State?.Status !== 'created' || info.State?.Running !== false || info.Config?.User !== '10001:10001'
      || !host?.ReadonlyRootfs || host.Privileged !== false || host.NetworkMode !== 'none'
      || !host.CapDrop?.includes('ALL') || host.CapAdd?.length || Object.keys(host.PortBindings ?? {}).length
      || !Array.isArray(info.Mounts) || info.Mounts.length || !host.SecurityOpt?.some(value => ['no-new-privileges', 'no-new-privileges:true'].includes(value)))
    throw new Error('cancellation_fixture_not_inert');
}

const childSource = `
const {spawnSync}=require('node:child_process');
const {writeFileSync,renameSync}=require('node:fs');
const cfg=JSON.parse(process.argv[1]);
const args=['--context','default','create','--pull','never','--name',cfg.name,'--network','none',
  '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','10001:10001',
  '--entrypoint','/bin/true'];
for(const [key,value] of Object.entries(cfg.labels)) args.push('--label',key+'='+value);
args.push(cfg.image);
const result=spawnSync('/usr/bin/docker',args,{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},encoding:'utf8',timeout:15000});
const id=result.stdout?.trim();
if(result.status!==0 || !/^[a-f0-9]{64}$/.test(id??'')) process.exit(1);
writeFileSync(cfg.marker+'.partial',id,{flag:'wx',mode:0o600});
renameSync(cfg.marker+'.partial',cfg.marker);
setInterval(()=>{},1000);
`;

export async function runSmoke(image, env = process.env) {
  validateContext(env, image);
  const root = await mkdtemp(join(env.RUNNER_TEMP, 'onlinu-cancellation-'));
  const docker = createProvisioningProcess({ executable: '/usr/bin/docker', workingDirectory: root, timeoutMs: 20000 });
  const call = args => docker.run(['--context', 'default', ...args]);
  const nonce = randomBytes(12).toString('hex');
  const expected = { name: `onlinu-cancel-${env.GITHUB_RUN_ID}-${nonce}`, imageId: null,
    labels: { 'org.onlinu.fixture': 'provisioning-cancellation', 'org.onlinu.run': env.GITHUB_RUN_ID,
      'org.onlinu.source': env.GITHUB_SHA, 'org.onlinu.nonce': nonce } };
  const list = async () => (await call(['container', 'ls', '-aq', '--no-trunc', '--filter', 'name=^/' + expected.name + '$']))
    .trim().split(/\s+/).filter(Boolean);
  const inspect = async id => JSON.parse(await call(['container', 'inspect', id]))[0];
  let attempted = false, pending, controller, report, clean = false;
  try {
    const context = JSON.parse(await call(['context', 'inspect', 'default']))[0];
    if (context?.Endpoints?.docker?.Host !== 'unix:///var/run/docker.sock') throw new Error('nonlocal_fixture_daemon');
    const imageInfo = JSON.parse(await call(['image', 'inspect', image]))[0];
    if (!/^sha256:[a-f0-9]{64}$/.test(imageInfo?.Id ?? '')) throw new Error('missing_fixture_image');
    expected.imageId = imageInfo.Id;
    if ((await list()).length) throw new Error('fixture_name_already_exists');
    const lock = createProvisioningHostLock({ directory: root });
    const resource = 'onlinu-' + randomBytes(16).toString('hex');
    await lock.withLock(resource, async () => {
      try {
      const marker = join(root, 'created-container');
      controller = new AbortController();
      const child = createProvisioningProcess({ executable: process.execPath, workingDirectory: root, timeoutMs: 30000 });
      attempted = true;
      let settled = false, outcome;
      pending = child.run(['-e', childSource, JSON.stringify({ ...expected, image, marker })], { signal: controller.signal })
        .then(value => { settled = true; outcome = { value }; }, error => { settled = true; outcome = { error }; });
      const deadline = Date.now() + 15000;
      let identifier;
      while (!identifier && !settled && Date.now() < deadline) {
        try { identifier = await readFile(marker, 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!identifier) await delay(50);
      }
      if (!/^[a-f0-9]{64}$/.test(identifier ?? '') || settled) throw new Error('fixture_create_not_confirmed');
      let info = await inspect(identifier); assertOwned(info, expected); assertInert(info);
      let blocked = false;
      try { await lock.withLock(resource, async () => { throw new Error('competing_fixture_lock_entered'); }); }
      catch (error) { if (error.code === 'provisioning_host_busy') blocked = true; else throw error; }
      if (!blocked) throw new Error('fixture_lock_not_exclusive');
      controller.abort(); await pending;
      if (outcome?.error?.code !== 'provisioning_process_aborted') throw new Error('fixture_client_cancel_not_confirmed');
      // No retry or guessed rollback: inspect the exact owned object left by
      // the daemon after the command process group has been terminated.
      info = await inspect(identifier); assertOwned(info, expected); assertInert(info);
      if ((await list()).length !== 1) throw new Error('fixture_object_count_changed');
      report = { sourceCommit: env.GITHUB_SHA, productionDeployed: false, registryPublished: false,
        realCredentialsUsed: false, containerStarted: false, localImageId: expected.imageId,
        checks: ['exact-ephemeral-image', 'local-daemon-only', 'owned-inert-container-created-once',
          'host-lock-excludes-competing-attempt', 'owned-client-group-cancelled',
          'daemon-object-survives-client-cancellation', 'no-create-retry'],
        notVerified: ['production-apply-driver', 'journal-docker-end-to-end', 'daemon-operation-cancellation',
          'production-recovery', 'real-secret-mounts'] };
      } finally {
        // On every failure path, settle the owned command before releasing
        // the host lock. The outer cleanup then inspects daemon state.
        if (pending) { controller.abort(); await pending; }
      }
    });
  } finally {
    if (pending) { controller.abort(); await pending; }
    if (attempted) {
      const ids = await list();
      if (ids.length > 1) throw new Error('ambiguous_fixture_cleanup');
      for (const id of ids) {
        const info = await inspect(id); assertOwned(info, expected); assertInert(info);
        // One exact owned, never-started, mount-free fixture only. No force,
        // volumes, wildcard cleanup, prune, or removal by unverified name.
        await call(['container', 'rm', info.Id]);
      }
      if ((await list()).length) throw new Error('fixture_cleanup_not_confirmed');
    }
    clean = true;
    await rm(root, { recursive: true, force: true });
  }
  if (!clean || !report) throw new Error('cancellation_fixture_incomplete');
  report.checks.push('exact-owned-fixture-cleanup-confirmed');
  await writeFile(join(env.RUNNER_TEMP, 'onlinu-provisioning-cancellation-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Isolated client-cancellation versus Docker daemon-state acceptance passed.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { if (process.argv.length !== 3) throw new Error(); await runSmoke(process.argv[2]); }
  catch (error) {
    const labels = new Set(['invalid_cancellation_fixture_context', 'cancellation_fixture_ownership_mismatch',
      'cancellation_fixture_not_inert', 'nonlocal_fixture_daemon', 'missing_fixture_image', 'fixture_name_already_exists',
      'fixture_create_not_confirmed', 'competing_fixture_lock_entered', 'fixture_lock_not_exclusive',
      'fixture_client_cancel_not_confirmed', 'fixture_object_count_changed', 'ambiguous_fixture_cleanup',
      'fixture_cleanup_not_confirmed', 'cancellation_fixture_incomplete', 'provisioning_host_lock_rejected',
      'provisioning_host_busy', 'provisioning_process_failed', 'provisioning_process_timeout',
      'provisioning_process_output_limit', 'provisioning_process_output_invalid', 'provisioning_process_stop_unconfirmed']);
    console.error('Isolated cancellation acceptance failed: ' + (labels.has(error?.message) ? error.message : 'unclassified_failure'));
    process.exitCode = 1;
  }
}
