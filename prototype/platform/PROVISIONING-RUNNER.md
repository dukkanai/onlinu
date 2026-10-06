# Private single-attempt provisioning coordinator

`provisioning-runner.mjs` connects the private journal and artifact preflight to
an injected, trusted host driver. It is not a production Docker driver, public
API, scheduler or tenant-activation service. No default driver is supplied and
no real credentials, resources or production host are touched by this module.

## Attempt lifecycle

1. Authenticate the caller outside this module, then prepare the exact queued
   job/version through the authoritative artifact bridge.
2. Acquire the driver's exclusive host lock on the plan's tenant resource
   namespace. A request UUID is not a sufficient lock key: replacement requests
   must not bypass an old process still acting on that tenant.
3. Claim once and prepare again against that worker's live, fenced journal claim.
4. Inspect host prerequisites, renew the claim, apply once, renew, verify, renew,
   and commit a strict evidence digest to the journal.
5. Keep the host lock through completion or uncertainty accounting. No automatic
   retry, cleanup, rollback, requeue or tenant activation occurs.

Driver checkpoints serialize journal version changes. A failed checkpoint stays
failed even if a driver catches the rejection; the coordinator will not publish
success. An escaped checkpoint cannot renew a completed attempt. A completed
journal entry is evidence of the trusted driver's attestation, not independent
proof that every production readiness condition holds.

## Trusted driver contract — not yet implemented for production

The driver supplies `withLock(resourceName, callback)`, `inspect(prepared)`,
`apply(prepared, { checkpoint })`, and `verify(prepared)`.

- `withLock` must provide real cross-process, host-wide exclusion until the
  callback and all its subprocesses have settled. An in-memory JavaScript lock
  is insufficient for production. It must not invoke the callback without the
  lock or release the lock while child processes can still mutate resources.
- `inspect` is read-only and must enforce the resource/secret/image/provenance/
  routing gates in `deploy/TENANT-COMPOSE.md`. Existing uncertain resources cannot
  silently be adopted, overwritten, deleted or reinitialized.
- `apply` must await `checkpoint()` immediately before each consequential step,
  stop if it rejects, bound its subprocess durations, and await their termination
  before returning or throwing. It must not start detached work, retry ambiguous
  operations, print secrets, or assume an old prepared job version is current.
- `verify` must inspect the actual owned resources and durably preserve a bounded,
  non-secret acceptance report. It returns exactly `jobId`, `tenantId`,
  `planDigest`, and `verificationSha256`. These bind the report to this attempt.
  A supplied hash alone is not independently verified by the coordinator.
- Long operations require driver-managed progress checkpoints within the journal
  lease. The coordinator does not install a background heartbeat or forcibly
  stop arbitrary JavaScript. Production process cancellation and lock acceptance
  must be tested in the concrete driver before this can be used on a host.

The driver is trusted executable application code, not a client-supplied object
or plug-in selected from a request. Both driver and preflight remain private.

## Failure and recovery

Failure after a confirmed claim attempts `unknown` using the latest confirmed
worker version, even if inspection failed before any host mutation. If claim,
renewal or finish committed but its reply was lost, the coordinator does not
invent an outcome. A stale version, revoked authority or failed uncertainty
write requires explicit operator reconciliation. Host-lock errors are sanitized,
including a release error after a successful finish. The caller must inspect the
journal and actual host evidence, never just rerun after an error response.

## Tests

Unit fixtures cover ordering, host-lock lifetime, pre-host authority rejection,
concurrent checkpoints, expiry/revocation, swallowed errors, lost database replies,
strict evidence, and escaped callbacks. PostgreSQL plus the actual Python artifact
compiler exercises an expired attempt, explicit evidenced requeue, a later
successful fixture attempt and unchanged draft tenant status. The fixture driver
has no Docker or network effects. This is coordinator verification, not production
executor or crash-safe host-lock acceptance.

Local verification: 269 platform tests pass without skips and related actual-main
Go race tests pass. Remote CI for this increment is pending.
