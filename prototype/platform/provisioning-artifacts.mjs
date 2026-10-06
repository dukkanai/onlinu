/** Read-only preflight for a separate trusted executor. No Docker or secrets.
 * The existing Python compiler is authoritative for artifact JSON/schema/hash;
 * raw client JSON is never interpolated into commands or accepted as Compose.
 */
import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { problem } from './auth.mjs';

const compiler = fileURLToPath(new URL('../../deploy/tenant_plan.py', import.meta.url));
const bootstrap = fileURLToPath(new URL('../../deploy/tenant-bootstrap.sql', import.meta.url));
const preparedArtifacts = new WeakSet();
export function isPreparedArtifact(value) { return preparedArtifacts.has(value); }
const limit = 262144;
const hash = /^[a-f0-9]{64}$/;
const image = /^[a-z0-9][a-z0-9./:_-]{0,240}@sha256:[a-f0-9]{64}$/;
const badArtifact = () => problem(409, 'provisioning_artifact_rejected');
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function origin(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/')
    throw new Error('invalid_provisioning_artifact_configuration');
  return parsed.origin;
}
async function boundedFile(path, maxBytes, ownerUID, hardLinksAllowed = false) {
  let file;
  try {
    const initial = await lstat(path);
    if (!initial.isFile() || initial.isSymbolicLink()) throw badArtifact();
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat();
    if (initial.ino !== before.ino || initial.dev !== before.dev) throw badArtifact();
    if (!before.isFile() || before.size > maxBytes || (!hardLinksAllowed && before.nlink !== 1)
        || (ownerUID !== undefined && (before.uid !== ownerUID || (before.mode & 0o022) !== 0))) throw badArtifact();
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat();
    if (length > maxBytes || length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs || after.ino !== before.ino || after.dev !== before.dev) throw badArtifact();
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } catch { throw badArtifact(); }
  finally { if (file) { try { await file.close(); } catch { throw badArtifact(); } } }
}
function compile(source, mode = []) {
  return new Promise((accept, reject) => {
    // Isolated stdlib-only Python; do not inherit provider credentials,
    // PYTHONPATH, startup hooks, proxy settings or a caller-controlled shell.
    const child = spawn('/usr/bin/python3', ['-I', '-S', '-B', compiler, ...mode], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    let length = 0, failed = false;
    const chunks = [];
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 5000);
    timer.unref();
    child.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > limit) { failed = true; child.kill('SIGKILL'); }
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on('error', () => { failed = true; });
    child.on('error', () => { failed = true; clearTimeout(timer); reject(badArtifact()); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0) { reject(badArtifact()); return; }
      try { accept(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(badArtifact()); }
    });
    child.stdin.end(source);
  });
}

export function createProvisioningArtifacts({ journal, artifactDirectory, artifactOwnerUID = process.getuid?.(),
  secretRoot, platformIssuer, platformPublicKey, runtimeImage, postgresImage, bootstrapSha256 }) {
  let issuer;
  try {
    if (process.platform !== 'linux' || !constants.O_NOFOLLOW || !constants.O_NONBLOCK || typeof journal?.review !== 'function'
        || typeof artifactDirectory !== 'string' || artifactDirectory.length > 4096 || !isAbsolute(artifactDirectory)
        || !Number.isInteger(artifactOwnerUID) || artifactOwnerUID < 0 || artifactOwnerUID > 0xffffffff
        || typeof secretRoot !== 'string' || secretRoot.length > 240 || !/^\/srv\/onlinu\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(secretRoot)
        || typeof runtimeImage !== 'string' || !image.test(runtimeImage)
        || typeof postgresImage !== 'string' || !image.test(postgresImage)
        || typeof bootstrapSha256 !== 'string' || !hash.test(bootstrapSha256)
        || typeof platformPublicKey !== 'string' || Buffer.from(platformPublicKey, 'base64').length !== 32
        || Buffer.from(platformPublicKey, 'base64').toString('base64') !== platformPublicKey) throw new Error();
    issuer = origin(platformIssuer);
  } catch { throw new Error('invalid_provisioning_artifact_configuration'); }
  const directory = resolve(artifactDirectory);
  async function prepare(actorId, jobId, input) {
    // The journal rechecks enabled operator, tenant version/status and worker
    // fencing both before reading an artifact and after compilation.
    const job = await journal.review(actorId, jobId, input);
    if (job?.id !== jobId || typeof job.planDigest !== 'string' || !hash.test(job.planDigest)
        || !['queued', 'claimed'].includes(job.state) || typeof job.tenantId !== 'string'
        || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(job.tenantId)
        || !Number.isSafeInteger(job.expectedTenantVersion) || job.expectedTenantVersion < 1) throw badArtifact();
    try {
      const directoryInfo = await lstat(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || directoryInfo.uid !== artifactOwnerUID
          || (directoryInfo.mode & 0o022) !== 0 || await realpath(directory) !== directory) throw badArtifact();
    } catch { throw badArtifact(); }
    const source = await boundedFile(resolve(directory, job.planDigest + '.json'), limit, artifactOwnerUID);
    const plans = await compile(source);
    if (!Array.isArray(plans) || plans.length !== 1) throw badArtifact();
    const plan = plans[0];
    if (plan.schemaVersion !== 1 || plan.kind !== 'onlinu-tenant-resource-plan' || plan.executable !== false
        || plan.tenantId !== job.tenantId || plan.planDigest !== job.planDigest
        || plan.runtime?.image !== runtimeImage || plan.postgres?.image !== postgresImage
        || plan.runtime?.environment?.WACALLS_PLATFORM_ISSUER !== issuer
        || plan.runtime?.environment?.WACALLS_PLATFORM_PUBLIC_KEY !== platformPublicKey
        || plan.postgres?.bootstrapAssetSha256 !== bootstrapSha256) throw problem(409, 'provisioning_release_mismatch');
    const bootstrapSQL = await boundedFile(bootstrap, 65536, undefined, true);
    if (createHash('sha256').update(bootstrapSQL).digest('hex') !== bootstrapSha256) throw problem(409, 'provisioning_release_mismatch');
    // Only parse input after the authoritative compiler rejected duplicate keys,
    // invalid UTF-8, unknown fields and unsupported config values.
    const configs = JSON.parse(source);
    const compose = await compile(JSON.stringify({ config: configs[0], expectedDigest: job.planDigest, secretRoot }), ['--compose']);
    if (compose.name !== plan.projectName || compose['x-onlinu']?.planDigest !== job.planDigest) throw badArtifact();
    const current = await journal.review(actorId, jobId, input);
    if (current?.id !== job.id || current.version !== job.version || current.state !== job.state
        || current.tenantId !== job.tenantId || current.planDigest !== job.planDigest
        || current.expectedTenantVersion !== job.expectedTenantVersion || current.workerId !== job.workerId
        || current.claimedBy !== job.claimedBy) throw problem(409, 'provisioning_changed_during_preflight');
    const prepared = freeze({ job: { ...current }, plan, compose, bootstrapSQL });
    preparedArtifacts.add(prepared);
    return prepared;
  }
  return { prepare };
}
