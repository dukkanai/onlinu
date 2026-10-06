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
