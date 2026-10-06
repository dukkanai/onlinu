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

export function createProvisioningStage({ journal, directory, ownerUID = process.getuid?.() }) {
  if (process.platform !== 'linux' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY
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
    return Object.freeze({ directory: attempt, manifestPath, bootstrapPath, receipt });
  }
  return { stage };
}
