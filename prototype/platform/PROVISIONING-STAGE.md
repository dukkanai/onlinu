# Exclusive reviewed-artifact staging

`createProvisioningStage({ journal, directory, ownerUID? })` writes only the
public Compose specification, reviewed bootstrap SQL and a non-secret receipt
for a private executor. It neither reads secret values nor invokes Docker.

Only the actual immutable in-process object returned by the authoritative
artifact bridge is accepted. A parsed JSON copy, lookalike object or queued plan
cannot be staged. That provenance mark is not authorization: staging also checks
the current operator, tenant, worker, lease and journal version before file access
and after writing. It tolerates a renewed version within the same claimed attempt,
but does not permit a different worker, tenant or reviewed digest.

The pre-existing staging root and its ancestors must be trusted. Root and project
directories must be real, privately owned directories with no group/other access.
Each job/worker pair gets a new exclusive directory. Existing attempts are never
overwritten, adopted or silently deleted, even when the previous write failed.
This permits inspection and explicit reconciliation rather than blind retries.

Bootstrap SQL is created read-only for container readability (0444), inside the
private parent directory; it contains no secret value. Compose and receipt files
are 0600. Files use exclusive, no-follow opens, deterministic modes, fsync and
directory sync. The receipt binds job, worker, tenant, plan digest, observed
journal version, manifest SHA-256 and bootstrap SHA-256. A failure after any write
leaves the partial attempt for inspection and does not imply that a runtime was
created. The caller must not automatically clean up such evidence.

A future driver must hold the concrete host lock while staging and applying,
recheck live fencing before effects, preserve trusted ownership of these paths,
and verify the staged bytes before command execution. This module is not a
sandbox against another process with the same UID or a hostile administrator.
It creates no real credential, runtime URL, Docker object or tenant activation.

Tests cover exact bytes/hashes/modes, exclusive attempt reuse rejection,
lookalike/queued rejection, authority checks before filesystem access, retained
files after later revocation, changed workers and unsafe host directories. The
real PostgreSQL + compiler + runner fixture also stages under the concrete Linux
host lock after an explicit reconciliation of an expired attempt.

Local platform verification passes 286 tests without skips; related actual-main
Go race checks pass. Remote CI for this increment is pending.
