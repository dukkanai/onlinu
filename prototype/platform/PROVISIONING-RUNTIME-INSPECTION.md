# Private runtime observation gate

The trusted host executor can validate an observed Docker snapshot with
`inspectProvisionedRuntime`. It is a pure private function, not an API endpoint,
a Docker executor, an authorization decision, or an activation/deployment action.
Expected values must be supplied by the existing trusted reviewed compiler and
approved image resolution. An arbitrary caller cannot establish authority by
supplying matching expected/observed objects.

The gate requires exactly the two healthy, running, distinct container IDs with
expected image IDs and tenant/plan/project/service ownership. It checks the
restaurant's non-root/read-only/capability and no-new-privileges configuration,
loopback-only exact application port, unpublished database, no added devices or
host/shared-container PID/IPC namespace, required environment references and no
inline copies of the known credential fields. Environment values never appear in
its output or errors.

Persistent mount inventory must exactly match the reviewed named volumes and
read-only file-backed secrets/bootstrap asset, including source references,
destinations and write modes. No extra socket or bind mount is accepted. Network
attachments and network IDs must match the private database and runtime egress
networks, whose ownership, bridge driver, internal status and exact membership
are checked. Foreign containers on these networks invalidate acceptance. Named
volumes must be the owned local volumes without extra driver options.

Output is only the frozen container/image identity pair for each service; all
failures use one sanitized code. Secret file bytes, daemon diagnostics and host
paths are not returned. This does not attest secret-file provenance, authenticated
HTTP behavior, backup/recovery, resource capacity, future runtime drift, mobile
clients or public routing. Existing authenticated/unauthorized HTTP probes and
immutable evidence binding remain separate and required in the fixture.

The actual journal/Docker fixture now feeds its complete observations through
this shared gate before emitting verification evidence, including the unknown
apply-reply reconciliation path. Cleanup still uses its separate bounded
ownership checks and never assumes a failed verification authorizes deletion.
No production runtime, credential, account or firewall was accessed.

Local pure tests cover exact acceptance, immutable/redacted results, missing and
duplicate resources, foreign labels/images, unhealthy services, privilege and
port drift, extra/substituted/writable secret mounts, inline credentials,
network membership substitution and local-volume driver options. Five test
groups and the four existing fixture guards pass. Actual Docker acceptance is
pending a new isolated opt-in CI run; the preceding f9a965f image receipt is not
proof that this later gate has passed.

Runtime inspection acceptance: commit
`9154929f905fab1b2024313c64ae0f5738686651` passed all five jobs in
CI37540564750, verified 2026-10-06 22:36 UTC. The actual journal/Docker fixture
passed both successful and unknown-reply reconciliation paths through the new
snapshot gate. All four runtime reports were downloaded and inspected; both
immutable receipts were independently rehashed and source/identity-bound. The
local image ID is
`sha256:31113c204c1aa85119a6ee26b724ec44a1c338d902d8b2d9ed886f39132a1ee8`;
this is not a published registry digest. No production driver, real credential,
public routing, activation or deployment is implied. Local platform tests also
passed 211 with 12 database skips; remote CI supplied database acceptance.

## Bounded read-only daemon probe — pending acceptance

`createProvisioningRuntimeProbe` now gathers the observations through the existing
bounded process capability. It requires Docker's default context to point at the
local Unix socket, lists only the reviewed deterministic project, validates the
two full container IDs before any inspect argument, and reads only those exact
containers and the deterministic two networks/volumes. It then applies the pure
snapshot gate and returns the same redacted frozen identity result.

There are no arbitrary command arguments, shell, apply/delete commands, external
HTTP probes, secret-byte reads or automatic retries. Caller expectations are
copied before awaiting. Output is bounded to 1 MiB per result; malformed JSON,
wrong inventory, process errors and cancellation fail closed with a sanitized
code. The trusted executor must supply the existing bounded Docker process
capability, own its configuration and provide live authorization/host exclusion.
This adapter itself does not grant those powers or prove a Docker daemon stopped.

The actual journal/Docker fixture now uses this shared reader for both successful
verification and explicit reconciliation. Seven new probe tests pass alongside
five observation groups and four fixture guards. Actual Docker acceptance of
this reader awaits its own run; the preceding snapshot-gate acceptance does not
substitute for it.

Read-only runtime probe acceptance: commit
`d099829ea7030a2a45b75d83e1c55bbc467e55c3` passed all five jobs in
CI37542056436, verified 2026-10-06 22:49 UTC. The shared bounded reader ran in
the actual journal/Docker success and unknown-reply reconciliation paths. Four
runtime reports were downloaded and inspected, and both evidence receipts were
independently rehashed and source/identity-bound. Synthetic local image ID:
`sha256:6f0d6c0a1fb85e75eba48b37e9d8b05661206edcbd7656b7a8c975ae4ac5adfb`.
No registry publication, production apply driver, real secret provisioning or
deployment is implied. Local platform218 passed with12 database skips; actual
PostgreSQL, Windows/client and full-image validation passed remotely.
