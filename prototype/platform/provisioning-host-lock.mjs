/** Linux-local advisory lock for cooperating trusted provisioning workers.
 * The parent owns the open file description after util-linux flock exits.
 */
import { constants } from 'node:fs';
import { open, lstat, realpath, statfs } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { problem } from './auth.mjs';

const localFilesystems = new Set([0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630]);
const rejected = () => problem(409, 'provisioning_host_lock_rejected');
function acquire(fd) {
  return new Promise((accept, reject) => {
    const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '3'], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C' }, shell: false, stdio: ['ignore', 'ignore', 'ignore', fd],
    });
    let failed = false;
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 5000);
    timer.unref();
    child.on('error', () => { failed = true; clearTimeout(timer); reject(rejected()); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failed) reject(rejected());
      else if (code === 75) reject(problem(409, 'provisioning_host_busy'));
      else if (code !== 0) reject(rejected());
      else accept();
    });
  });
}

export function createProvisioningHostLock({ directory, ownerUID = process.getuid?.() }) {
  if (process.platform !== 'linux' || !constants.O_NOFOLLOW || !constants.O_NONBLOCK
      || typeof directory !== 'string' || !isAbsolute(directory) || directory.length > 4096
      || !Number.isInteger(ownerUID) || ownerUID < 0 || ownerUID > 0xffffffff)
    throw new Error('invalid_provisioning_host_lock_configuration');
  const root = resolve(directory);
  async function withLock(resourceName, operation) {
    if (typeof resourceName !== 'string' || !/^onlinu-[a-f0-9]{32}$/.test(resourceName)
        || typeof operation !== 'function') throw rejected();
    const path = resolve(root, resourceName + '.lock');
    let file;
    try {
      const dir = await lstat(root);
      if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== ownerUID || (dir.mode & 0o077) !== 0
          || await realpath(root) !== root || !localFilesystems.has((await statfs(root)).type)) throw rejected();
      file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      const before = await file.stat();
      if (!before.isFile() || before.uid !== ownerUID || (before.mode & 0o077) !== 0 || before.nlink !== 1 || before.size !== 0)
        throw rejected();
      await acquire(file.fd);
      const current = await lstat(path), after = await file.stat();
      if (!current.isFile() || current.ino !== before.ino || current.dev !== before.dev || after.nlink !== 1
          || after.uid !== ownerUID || (after.mode & 0o077) !== 0 || after.size !== 0) throw rejected();
    } catch (error) {
      if (file) { try { await file.close(); } catch {} }
      throw error?.code === 'provisioning_host_busy' ? error : rejected();
    }
    try { return await operation(); }
    finally {
      // Never unlink a lock file: a replacement inode would split exclusion.
      // Callback must settle all owned subprocesses before this descriptor closes.
      try { await file.close(); } catch { throw rejected(); }
    }
  }
  return { withLock };
}
