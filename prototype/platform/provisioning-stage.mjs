/** Exclusive staging of a reviewed artifact for a private trusted executor.
 * No secret values or Docker calls; failed attempts are never silently removed.
 */
import { constants } from 'node:fs';
import { mkdir, lstat, realpath, open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { isPreparedArtifact } from './provisioning-artifacts.mjs';
import { problem } from './auth.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
const rejected = () => problem(409, 'provisioning_stage_rejected');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
async function privateDirectory(path, ownerUID) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== ownerUID || (info.mode & 0o077) !== 0
      || await realpath(path) !== path) throw rejected();
}
async function syncDirectory(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}
async function writeNew(path, value, mode) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await file.writeFile(value, 'utf8'); await file.chmod(mode); await file.sync(); }
  finally { await file.close(); }
}

async function readExactFile(path, expected, mode, ownerUID) {
  const beforePath = await lstat(path);
  const max = Buffer.byteLength(expected);
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size !== max || max > 262144) throw rejected();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== ownerUID || before.nlink !== 1 || (before.mode & 0o7777) !== mode
        || before.size !== max || before.ino !== beforePath.ino || before.dev !== beforePath.dev) throw rejected();
    const buffer = Buffer.alloc(max + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await file.read(buffer, size, buffer.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    const after = await file.stat();
    const finalPath = await lstat(path);
    if (size !== max || !buffer.subarray(0, size).equals(Buffer.from(expected))
        || ['size', 'mode', 'uid', 'nlink', 'ino', 'dev', 'mtimeMs', 'ctimeMs'].some(k => before[k] !== after[k])
        || finalPath.ino !== after.ino || finalPath.dev !== after.dev || finalPath.isSymbolicLink()) throw rejected();
  } finally { await file.close(); }
}
const stagedArtifacts = new WeakSet();

export function createProvisioningStage({ journal, directory, ownerUID = process.getuid?.() }) {
  if (process.platform !== 'linux' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY || !constants.O_NONBLOCK
      || typeof journal?.review !== 'function' || typeof directory !== 'string' || !isAbsolute(directory)
      || directory.length > 4096 || !Number.isInteger(ownerUID) || ownerUID < 0 || ownerUID > 0xffffffff)
    throw new Error('invalid_provisioning_stage_configuration');
  const root = resolve(directory);
  async function stage(actorId, prepared, input) {
    if (!isPreparedArtifact(prepared) || prepared.job.state !== 'claimed'
        || !uuid.test(prepared.job.id) || !uuid.test(prepared.job.workerId ?? '')
        || !/^onlinu-[a-f0-9]{32}$/.test(prepared.plan.projectName)) throw rejected();
    // Authority is live; the in-process artifact brand is provenance, not auth.
    const current = await journal.review(actorId, prepared.job.id, input);
    function sameAttempt(row) {
      return row.state === 'claimed' && row.id === prepared.job.id && row.tenantId === prepared.job.tenantId
        && row.planDigest === prepared.job.planDigest && row.expectedTenantVersion === prepared.job.expectedTenantVersion
        && row.workerId === prepared.job.workerId && row.claimedBy === prepared.job.claimedBy;
    }
    if (!sameAttempt(current)) throw rejected();
    const project = resolve(root, prepared.plan.projectName);
    const attempt = resolve(project, prepared.job.id + '-' + prepared.job.workerId);
    const manifestPath = resolve(attempt, 'compose.json');
    const bootstrapPath = resolve(attempt, 'tenant-bootstrap.sql');
    const manifest = JSON.stringify(prepared.compose, null, 2) + '\n';
    const receipt = Object.freeze({ schemaVersion: 1, jobId: prepared.job.id, workerId: prepared.job.workerId,
      tenantId: prepared.job.tenantId, planDigest: prepared.job.planDigest, journalVersion: current.version,
      manifestSha256: digest(manifest), bootstrapSha256: digest(prepared.bootstrapSQL) });
    try {
      await privateDirectory(root, ownerUID);
      try { await mkdir(project, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      await privateDirectory(project, ownerUID);
      // No recursive mkdir and no overwrite/reuse of an earlier attempt.
      await mkdir(attempt, { mode: 0o700 });
      await privateDirectory(attempt, ownerUID);
      await writeNew(bootstrapPath, prepared.bootstrapSQL, 0o444);
      await writeNew(manifestPath, manifest, 0o600);
      await writeNew(resolve(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', 0o600);
      await syncDirectory(attempt); await syncDirectory(project); await syncDirectory(root);
    } catch { throw rejected(); }
    const final = await journal.review(actorId, prepared.job.id, input);
    if (!sameAttempt(final) || final.version !== current.version) throw rejected();
    // Files remain for inspection even if the final review fails. Never turn a
    // partial stage into automatic deletion/retry or claim that Docker ran.
    const result = Object.freeze({ directory: attempt, manifestPath, bootstrapPath, receipt });
    stagedArtifacts.add(result);
    return result;
  }
  async function verify(actorId, prepared, staged, input) {
    if (!isPreparedArtifact(prepared) || !stagedArtifacts.has(staged) || prepared.job.state !== 'claimed') throw rejected();
    const current = await journal.review(actorId, prepared.job.id, input);
    const sameAttempt = row => row?.state === 'claimed' && row.id === prepared.job.id
      && row.tenantId === prepared.job.tenantId && row.planDigest === prepared.job.planDigest
      && row.expectedTenantVersion === prepared.job.expectedTenantVersion
      && row.workerId === prepared.job.workerId && row.claimedBy === prepared.job.claimedBy;
    if (!sameAttempt(current) || !Number.isSafeInteger(staged.receipt.journalVersion)
        || staged.receipt.journalVersion > current.version) throw rejected();
    const project = resolve(root, prepared.plan.projectName);
    const attempt = resolve(project, prepared.job.id + '-' + prepared.job.workerId);
    const manifestPath = resolve(attempt, 'compose.json'), bootstrapPath = resolve(attempt, 'tenant-bootstrap.sql');
    const manifest = JSON.stringify(prepared.compose, null, 2) + '\n';
    const receipt = { schemaVersion: 1, jobId: prepared.job.id, workerId: prepared.job.workerId,
      tenantId: prepared.job.tenantId, planDigest: prepared.job.planDigest, journalVersion: staged.receipt.journalVersion,
      manifestSha256: digest(manifest), bootstrapSha256: digest(prepared.bootstrapSQL) };
    if (staged.directory !== attempt || staged.manifestPath !== manifestPath || staged.bootstrapPath !== bootstrapPath
        || JSON.stringify(staged.receipt) !== JSON.stringify(receipt)) throw rejected();
    try {
      for (const path of [root, project, attempt]) await privateDirectory(path, ownerUID);
      await readExactFile(manifestPath, manifest, 0o600, ownerUID);
      await readExactFile(bootstrapPath, prepared.bootstrapSQL, 0o444, ownerUID);
      await readExactFile(resolve(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', 0o600, ownerUID);
      for (const path of [root, project, attempt]) await privateDirectory(path, ownerUID);
    } catch { throw rejected(); }
    const final = await journal.review(actorId, prepared.job.id, input);
    if (!sameAttempt(final) || final.version !== current.version) throw rejected();
    // No filesystem mutation. Only the original in-process stage is returned;
    // callers cannot smuggle a path or resurrect a stage after restart.
    return staged;
  }
  return { stage, verify };
}
