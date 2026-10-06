/** Private, immutable verification receipts. Storage is not authorization or
 * independent proof: only the trusted driver may attest its observed checks.
 * No Docker calls, credentials, activation, deletion or public route lives here.
 */
import { constants } from 'node:fs';
import { lstat, realpath, mkdir, open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { problem } from './auth.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const binding = {
  jobId: uuid, workerId: uuid, tenantId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), planDigest: sha,
};
const resource = z.object({ containerId: sha, imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict();
const reportSchema = z.object({
  ...binding,
  projectName: z.string().regex(/^onlinu-[a-f0-9]{32}$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  scope: z.enum(['fixture', 'runtime']),
  resources: z.object({ restaurant: resource, postgres: resource }).strict(),
  checks: z.object({ ownership: z.literal(true), healthy: z.literal(true), authenticated: z.literal(true), unauthorizedRejected: z.literal(true) }).strict(),
}).strict().refine(v => v.projectName === 'onlinu-' + hash(v.tenantId).slice(0, 32)
  && v.resources.restaurant.containerId !== v.resources.postgres.containerId);
const referenceSchema = z.object({ ...binding, sha256: sha }).strict();
const storedSchema = z.object({ schemaVersion: z.literal(1), observedAt: z.string().datetime(), report: reportSchema }).strict();
const reject = () => problem(409, 'provisioning_evidence_rejected');
const freeze = value => {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
};
function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw reject();
  return result.data;
}
async function directoryCheck(path, ownerUID) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== ownerUID
      || (info.mode & 0o077) !== 0 || await realpath(path) !== path) throw reject();
}
async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export function createProvisioningEvidence({ directory, ownerUID = process.getuid?.(), now = () => new Date() }) {
  if (process.platform !== 'linux' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY || !constants.O_NONBLOCK
      || typeof directory !== 'string' || !isAbsolute(directory) || directory.length > 3800
      || !Number.isInteger(ownerUID) || ownerUID < 0 || ownerUID > 0xffffffff || typeof now !== 'function')
    throw new Error('invalid_provisioning_evidence_configuration');
  const root = resolve(directory);
  function paths(ref) {
    const project = resolve(root, 'onlinu-' + hash(ref.tenantId).slice(0, 32));
    return { project, path: resolve(project, `${ref.jobId}-${ref.workerId}-${ref.sha256}.json`) };
  }
  async function read(reference) {
    try {
      const ref = parse(referenceSchema, reference), { project, path } = paths(ref);
      await directoryCheck(root, ownerUID); await directoryCheck(project, ownerUID);
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let bytes;
      try {
        const before = await file.stat();
        if (!before.isFile() || before.uid !== ownerUID || before.nlink !== 1
            || (before.mode & 0o077) !== 0 || before.size < 1 || before.size > 16384) throw reject();
        // Fixed-size bounded read: a growing file cannot force unbounded allocation.
        const buffer = Buffer.alloc(16385);
        let size = 0;
        while (size < buffer.length) {
          const result = await file.read(buffer, size, buffer.length - size, size);
          if (!result.bytesRead) break;
          size += result.bytesRead;
        }
        const after = await file.stat();
        if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
            || after.nlink !== 1 || after.mode !== before.mode || size > 16384) throw reject();
        bytes = buffer.subarray(0, size);
      } finally { await file.close(); }
      if (hash(bytes) !== ref.sha256) throw reject();
      const stored = parse(storedSchema, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      if (!Buffer.from(JSON.stringify(stored) + '\n').equals(bytes)) throw reject();
      for (const key of Object.keys(binding)) if (stored.report[key] !== ref[key]) throw reject();
      return freeze(stored);
    } catch { throw reject(); }
  }
  async function write(input) {
    try {
      // Snapshot and validate before any await; never retain caller-owned fields.
      const report = parse(reportSchema, input);
      const observedAt = now().toISOString();
      const stored = parse(storedSchema, { schemaVersion: 1, observedAt, report });
      const bytes = JSON.stringify(stored) + '\n';
      if (Buffer.byteLength(bytes) > 16384) throw reject();
      const ref = freeze(parse(referenceSchema, { jobId: report.jobId, workerId: report.workerId,
        tenantId: report.tenantId, planDigest: report.planDigest, sha256: hash(bytes) }));
      const { project, path } = paths(ref);
      await directoryCheck(root, ownerUID);
      try { await mkdir(project, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      await directoryCheck(project, ownerUID);
      let file;
      try { file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Same bytes may already be durable after a lost reply. Never overwrite.
        await read(ref);
        await syncDirectory(project); await syncDirectory(root);
        return ref;
      }
      try { await file.writeFile(bytes, 'utf8'); await file.chmod(0o600); await file.sync(); }
      finally { await file.close(); }
      await syncDirectory(project); await syncDirectory(root);
      await read(ref);
      return ref;
    } catch { throw reject(); }
  }
  return { write, read };
}
