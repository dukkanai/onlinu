/** One private provisioning attempt. An injected trusted host driver owns the
 * external lock and effects. No production driver or public route is installed.
 */
import { createHash } from 'node:crypto';
import { problem } from './auth.mjs';

export function createProvisioningRunner({ journal, artifacts, driver }) {
  if (['claim', 'review', 'heartbeat', 'finish', 'uncertain'].some(name => typeof journal?.[name] !== 'function')
      || typeof artifacts?.prepare !== 'function'
      || ['withLock', 'inspect', 'apply', 'verify'].some(name => typeof driver?.[name] !== 'function'))
    throw new Error('invalid_provisioning_runner_configuration');

  async function run(actorId, jobId, input) {
    if (!input || Object.keys(input).sort().join(',') !== 'expectedVersion,workerId'
        || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
        || input.expectedVersion >= Number.MAX_SAFE_INTEGER || typeof input.workerId !== 'string'
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.workerId))
      throw problem(400, 'invalid_request');
    input = Object.freeze({ ...input });
    // Validates authority and immutable input before the trusted host is touched.
    const preview = await artifacts.prepare(actorId, jobId, { expectedVersion: input.expectedVersion });
    if (preview.job.state !== 'queued') throw problem(409, 'invalid_provisioning_transition');
    // Lock must be host-wide and tied to the tenant resource namespace, NOT the
    // request UUID. A new request must not bypass an old still-running process.
    try { return await driver.withLock(preview.plan.projectName, async () => {
      let job;
      let chain = Promise.resolve();
      let checkpointFailure;
      let closed = false;
      const args = () => ({ expectedVersion: job.version, workerId: input.workerId });
      const checkpoint = () => {
        // Serialize version-changing lease renewals, including driver progress.
        const next = chain.then(async () => {
          if (closed || checkpointFailure) throw problem(409, 'provisioning_attempt_stopped');
          try { job = await journal.heartbeat(actorId, jobId, args()); }
          catch (error) { checkpointFailure = error; throw error; }
          return Object.freeze({ jobId, version: job.version, workerId: input.workerId });
        });
        chain = next.catch(() => {});
        return next;
      };
      try {
        job = await journal.claim(actorId, jobId, input);
        const prepared = await artifacts.prepare(actorId, jobId, args());
        await driver.inspect(prepared);
        await checkpoint();
        // Driver must await checkpoints before effects, stop on their rejection,
        // and not resolve/reject until its processes are quiescent. It must never
        // retry an uncertain apply, silently replace resources, or print secrets.
        await driver.apply(prepared, { checkpoint });
        await checkpoint();
        const evidence = await driver.verify(prepared);
        await checkpoint();
        // Evidence is a strict, bounded attestation from the trusted driver,
        // not arbitrary result text and not proof from an untrusted caller.
        if (!evidence || Object.keys(evidence).sort().join(',') !== 'jobId,planDigest,tenantId,verificationSha256'
            || evidence.jobId !== jobId || evidence.planDigest !== prepared.job.planDigest
            || evidence.tenantId !== prepared.job.tenantId
            || typeof evidence.verificationSha256 !== 'string'
            || !/^[a-f0-9]{64}$/.test(evidence.verificationSha256))
          throw problem(409, 'provisioning_verification_rejected');
        const evidenceDigest = createHash('sha256').update(JSON.stringify({
          jobId, planDigest: evidence.planDigest, tenantId: evidence.tenantId,
          verificationSha256: evidence.verificationSha256,
        })).digest('hex');
        closed = true;
        await chain;
        return await journal.finish(actorId, jobId, { ...args(), evidenceDigest });
      } catch (error) {
        closed = true;
        await chain;
        if (!job) throw problem(409, 'provisioning_claim_not_confirmed'); // Never change another worker's intent.
        try { await journal.uncertain(actorId, jobId, args()); }
        catch {
          // A lost finish response might already mean succeeded. A lost renewal
          // response can leave a newer version. Neither permits another attempt.
          throw problem(409, 'provisioning_reconciliation_required');
        }
        throw problem(409, 'provisioning_outcome_unknown');
      }
    }); } catch (error) {
      // Host lock acquisition/release may fail before or after a successful
      // callback. Do not expose arbitrary driver diagnostics or retry effects.
      const safe = new Set(['provisioning_claim_not_confirmed', 'provisioning_reconciliation_required',
        'provisioning_outcome_unknown']);
      throw problem(409, safe.has(error?.code) ? error.code : 'provisioning_reconciliation_required');
    }
  }
  return { run };
}
