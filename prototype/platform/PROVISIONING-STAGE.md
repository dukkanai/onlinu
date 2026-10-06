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
Go race checks pass. Commit `518c637` passed all four ordinary jobs in
[CI37444321105](https://github.com/dukkanai/onlinu/actions/runs/37444321105);
the optional unchanged runtime-image job was skipped.

## Live read-back before execution — pending remote acceptance

The stager now exposes a read-only `verify` operation. It accepts only an original
in-process branded stage and prepared artifact, recomputes the expected paths and
exact manifest/bootstrap/receipt bytes, and rechecks current actor/worker/tenant
fencing before and after filesystem reads. A renewed lease version may advance,
but another attempt cannot inherit an old stage.

Regular single-link files must retain exact owner/modes, lengths and bytes.
No-follow/nonblocking descriptors and bounded allocation reject symlinks, hard
links, substituted files and growing data; metadata/inode checks guard the read.
The private directory chain is rechecked. Failures do not repair, overwrite or
remove files, execute Docker, or return arbitrary path/diagnostic content.
Restart recovery cannot forge a stage object: explicit journal reconciliation
remains separate. The trusted host must still prevent changes between this check
and Docker consuming files; this is not protection against a compromised host.

Four new test groups cover unchanged read-back, lease renewal, copied handles,
modified artifacts, filesystem substitution, permissions, changed worker and
revoked authority. All 18 artifact/staging tests pass locally. The real isolated
journal/Docker fixture now runs this live read-back before applying its explicit
synthetic image/path overrides. Remote acceptance of this increment is pending.
