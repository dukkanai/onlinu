# Private composed host driver

`createProvisioningHostDriver` composes the existing host lock, reviewed image
preflight, original artifact stager, execution-manifest capability, empty-resource
probe, single-attempt Compose transport and durable runtime verifier for the
private provisioning coordinator. It is not instantiated by the control server,
exposed through HTTP, or started automatically. There is no production endpoint,
credential setup, image publication, tenant activation or implicit recovery.

Each resource namespace has one active in-process phase sequence inside the
real cross-process lock: inspect, apply, verify. Only an original branded claimed
preparation for the configured operator can be used. Copies, another preparation,
calls outside the lock, overlapping callbacks, skipped/repeated phases and
cancellation are rejected. The host lock remains owned until the callback and
its awaited effects settle; the supplied host/process capabilities retain their
existing trust and cancellation obligations.

Inspection checks already-present pinned images and an empty resource namespace.
Apply checks a fresh coordinator heartbeat, stages original bytes, and gives the
single-attempt transport the original manifest verification capability. Every
subsequent transport checkpoint must return a strictly newer version for the
same job and worker. A failed or uncertain apply is permanently spent in that
locked context and cannot be verified as successful or retried. The coordinator
records uncertainty; explicit recovery is a separate operation.

Docker resolves the original `./tenant-bootstrap.sql` relative to the staged
manifest. The driver mirrors only that exact resolution in its expected mount
observation, retaining the unchanged original manifest. It cannot supply an
alternative bootstrap path, image or secret reference. Verification then uses
the expected owned runtime and returns only the exact journal-bound digest;
the durable verifier retains the underlying receipt.

The caller still must configure approved existing credentials, a valid loader,
reviewed image provenance, private host directories and a suitable claim lease
long enough for the bounded process operations. The coordinator renews around
steps; this composition does not add an arbitrary background heartbeat or make
an expired lease valid. No production server or secret directory is configured
by these modules. Public routing, service supervision, real mounts, release
approval and recovery remain separate requirements.

Six local groups exercise the real compiler/stager/manifest/Compose composition,
with synthetic secret metadata, image/process/verification capabilities and a
mock journal. The actual coordinator is included for successful and lost-reply
cases: one create command, bound heartbeat versions, unknown on uncertain reply,
no replay, original bootstrap resolution and lock lifetime. These are component
assembly tests, not actual production-host or registry acceptance. Existing
separate real PostgreSQL/Docker fixtures validate the lower-level components;
the composed production-shaped driver itself has not been deployed.
