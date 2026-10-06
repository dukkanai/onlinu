# Private provisioning artifact preflight

`provisioning-artifacts.mjs` prepares an immutable resource plan, rendered Compose
model and verified bootstrap SQL for a future trusted executor. It has no public
route, scheduler, Docker client, credential reader, tenant activation or apply
operation. Successful preparation is not permission to execute a queued job.

## Inputs and trust boundary

Construct `createProvisioningArtifacts` with the private journal, an absolute
artifact directory, its trusted numeric owner UID, a secret-root reference under
`/srv/onlinu/`, and the approved release's digest-pinned runtime/PostgreSQL images,
HTTPS platform issuer, canonical Ed25519 public key and bootstrap SHA-256.
Release policy comes from the trusted operator, never a restaurant request.
The directory, all its ancestors and deployed compiler/application source must
remain under trusted administration; this is not a sandbox against a compromised
host or another process with the same UID.

Call `prepare(actorId, jobId, { expectedVersion, workerId? })` only after securely
authenticating the operator. The artifact is `<planDigest>.json`, containing a
JSON list of exactly one standard `deploy/tenant_plan.py` tenant configuration.
It contains public configuration, not secrets or arbitrary Compose. The journal
binds its tenant ID, current draft version and reviewed digest. The compiler's
version is part of the deployed trusted code; upgrading it can invalidate an old
review digest and must fail closed rather than substitute an unreviewed plan.

## Checks

- Journal `review` locks and rechecks the enabled platform administrator, tenant
  draft/version and expected job version. A claimed job also requires its current
  operator/worker pair and unexpired database-clock lease. Review writes no state
  or audit event. Unknown, cancelled and completed jobs cannot be prepared.
- Authority is checked before file access and again after compilation. A change
  to the job, authority, tenant version or lease rejects the result.
- Linux regular-file reads reject symlinks, hard links, wrong ownership and
  group/world-writable artifacts. Bounded, nonblocking reads prevent oversized
  files or FIFOs from hanging preflight; inode and metadata changes are rejected.
- The authoritative existing Python compiler uses fixed `/usr/bin/python3` with
  `-I -S -B`, no shell, a minimal environment, bounded output and a five-second
  timeout. Provider credentials, proxy settings and Python startup hooks are not
  inherited. Strict parsing rejects duplicate keys and unsupported fields.
- Tenant, digest, release images, issuer, public key and bootstrap asset must all
  match the trusted policy. Bootstrap bytes are checked against their SHA-256.
- Compose is rendered only from that accepted configuration, exact reviewed
  digest and trusted secret-root reference. No referenced secret file is read.
- Returned job, plan and Compose objects are recursively frozen. Error responses
  do not echo artifact paths, contents or compiler stderr.

## Executor obligations still pending

A future executor must acquire a live fenced claim and recheck authority directly
before effects; the result of this read-only operation is not a durable lock.
It must stage the returned verified bootstrap bytes in a trusted execution
directory, check resource ownership/collisions, secret mounts, public routing,
capacity and all gates in `deploy/TENANT-COMPOSE.md`. It must retain uncertainty
when an external action's outcome is unknown. No automatic retry, real secret
creation, deployment or tenant activation is implemented here.

## Verification

The local platform suite passes 255 tests with no skips, including the actual
Python compiler, negative filesystem/configuration cases, sanitized subprocess
environment and PostgreSQL journal integration. Related actual-main Go race
checks also pass. Remote CI for this increment is pending. These synthetic tests
do not establish production provisioning acceptance.
