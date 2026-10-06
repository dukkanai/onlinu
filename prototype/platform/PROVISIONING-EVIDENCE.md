# Private immutable provisioning evidence

`provisioning-evidence.mjs` stores a trusted driver's bounded, non-secret
verification receipt. It does not inspect Docker itself, authenticate an operator,
activate a tenant, provision credentials, or prove production readiness. There is
no public route. The private caller still owns authorization, live claims, host
exclusion and actual observation of every attested check.

Each receipt binds job, worker, tenant, plan digest, source commit, deterministic
project namespace, exact restaurant/database container and image IDs, and four
observed successful checks: resource ownership, health, authenticated catalogue
access and rejection of an incorrect credential. `fixture` and `runtime` scopes
are explicit; neither means every production release gate passed. Arbitrary
fields, diagnostic strings and credential/environment payloads are rejected.
Observation time records the write, not a guarantee that resources remain live.

## Persistence and reading

- The Linux-local root and project directories must be private and owned by the
  configured trusted UID. The operator must also control their ancestor paths.
- Inputs are copied and validated before awaiting filesystem operations.
- Files are exclusively created under job/worker/content-hash names, mode 0600;
  files and parent directories are synchronized before success.
- Existing identical durable bytes may be read back after a lost reply. Nothing
  is overwritten. Partial files and errors remain for explicit investigation.
- Reads use no-follow/nonblocking descriptors, bounded allocation, regular-file,
  owner/mode/link checks, stable size/mtime checks, SHA-256 and canonical strict
  schema validation. A receipt from another binding cannot be substituted.
- Returned records are deeply frozen. Errors omit paths and payloads.
- Concurrent incomplete writes fail closed rather than waiting, retrying effects,
  cleaning files or inventing verification. The host driver should already hold
  the appropriate exclusive lock.

This is an integrity and persistence primitive under a trusted host, not a
cryptographic signature or a defense against compromise of that host/UID.
A caller-supplied digest alone remains insufficient for operational acceptance.

## Acceptance

Ten focused filesystem tests pass locally, including identical-write recovery,
new-reader integrity, immutable snapshots, unsafe metadata, ownership, symlink,
hardlink, permission, oversized and noncanonical-content rejection. Four existing
Docker fixture guards also pass. Local platform suite: 202 passed, 12 database
skips; this is not a full database/daemon integration pass.

The opt-in real journal/Docker fixture now writes and rereads each actual owned
runtime receipt before committing its verification hash. Its final non-secret
CI report embeds the read-back receipts/references so they survive scoped
fixture cleanup. These are synthetic acceptance artifacts with CI retention,
not production storage or deployment. Actual daemon acceptance is pending.

Commit `f9a965f035efea575836c4f8cff2f6bf01ce094f` passed all five jobs in
[CI37479843024](https://github.com/dukkanai/onlinu/actions/runs/37479843024),
verified 2026-10-06 14:45 UTC. All four exact-commit runtime reports were
retrieved and inspected. Both embedded receipts were independently rehashed
and checked against their job/worker/tenant/plan references; fixture cleanup
also passed. No production deployment, published registry image, real provider
credential or real call is implied.
