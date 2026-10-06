/** Bounded Linux child-process transport for a trusted private host driver.
 * Killing a client process never proves a remote daemon operation was undone.
 */
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { problem } from './auth.mjs';

export function createProvisioningProcess({ executable, workingDirectory, timeoutMs = 30000, maxOutputBytes = 1048576 }) {
  if (process.platform !== 'linux' || typeof executable !== 'string' || !isAbsolute(executable)
      || executable.includes('\0') || typeof workingDirectory !== 'string' || !isAbsolute(workingDirectory)
      || !Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 120000
      || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 64 || maxOutputBytes > 1048576)
    throw new Error('invalid_provisioning_process_configuration');
  function run(args, { signal } = {}) {
    if (!Array.isArray(args) || args.length > 128 || args.some(value => typeof value !== 'string'
        || value.includes('\0') || value.length > 16384) || args.join('').length > 65536
        || (signal !== undefined && !(signal instanceof AbortSignal)))
      return Promise.reject(problem(400, 'invalid_provisioning_process_request'));
    if (signal?.aborted) return Promise.reject(problem(409, 'provisioning_process_aborted'));
    const argv = [...args];
    return new Promise((accept, reject) => {
      let child, failure, size = 0, closed = false, killSent = false;
      const output = [];
      function stop(code) {
        if (closed) return;
        failure ??= code;
        if (child?.pid && !killSent) {
          killSent = true;
          // detached:true creates a new Linux session/process group for this
          // child. Signal only that owned group, never an arbitrary caller PID.
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch (error) { if (error.code !== 'ESRCH') failure = 'provisioning_process_stop_unconfirmed'; }
        }
      }
      try {
        child = spawn(executable, argv, { cwd: workingDirectory, detached: true, shell: false,
          env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch { reject(problem(409, 'provisioning_process_failed')); return; }
      const abort = () => stop('provisioning_process_aborted');
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(() => stop('provisioning_process_timeout'), timeoutMs);
      timer.unref();
      child.on('spawn', () => { if (failure) stop(failure); });
      function collect(chunk, keep) {
        size += chunk.length;
        if (size > maxOutputBytes) stop('provisioning_process_output_limit');
        else if (keep && !failure) output.push(chunk);
      }
      child.stdout.on('data', chunk => collect(chunk, true));
      child.stderr.on('data', chunk => collect(chunk, false));
      child.on('error', () => { failure ??= 'provisioning_process_failed'; });
      // Wait for close, not merely exit: do not release the caller's host lock
      // while inherited stdout/stderr are still open in a child of this group.
      child.on('close', code => {
        closed = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (failure || code !== 0) { reject(problem(409, failure ?? 'provisioning_process_failed')); return; }
        try { accept(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(output))); }
        catch { reject(problem(409, 'provisioning_process_output_invalid')); }
      });
    });
  }
  return { run };
}
