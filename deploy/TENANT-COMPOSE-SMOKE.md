# Two rendered tenant fixtures (isolated CI only)

`integration/tenant-compose-smoke.py` exercises two synthetic instances of the
reviewed Compose renderer in the existing opt-in runtime-image job. It requires
an ephemeral GitHub Actions context, the exact built source-commit image tag,
and the runner's default local Docker socket. It is not a production executor,
provisioning API, registry publisher or service-account bootstrap tool.

## Exact scope and deliberate fixture overrides

Each fixture is produced by `compose_tenant` with its matching review digest.
Only the image references and host secret/config file paths are replaced for
CI: the just-built local runtime image, already-pulled PostgreSQL 16 image and
new disposable fixture files. Services, role bootstrap bytes, networks, volumes,
ports and hardening settings are otherwise the renderer output. Unit tests
compare that boundary. The test never publishes an image to a registry and uses
`--pull never --no-build` when starting fixtures.

Consequently this proves neither production registry digest resolution nor
production secret provisioning. The non-secret report records these overrides,
source commit, reviewed plan digests and actual local image IDs explicitly.

## Intended checks

- Both independently named tenant specifications start healthy, with distinct
  PostgreSQL/media volumes and per-tenant secret file contents.
- Actual inspected runtime UID, read-only root, capability drops,
  no-new-privileges, image IDs and loopback-only HTTP bindings match the contract.
  PostgreSQL has no published host port. No raw runtime secret environment
  setting or Docker socket is admitted.
- Each original administrator endpoint accepts its own fixture key and rejects
  the other tenant's key. Bootstrap/password files are absent from the runtime.
- Direct TCP attempts from each runtime toward the other tenant's runtime and
  database addresses fail across the generated Docker bridges. Targets are only
  the owned healthy fixture addresses, never arbitrary hosts. A connected
  socket that merely times out is not counted as isolation: the probe checks
  both curl's result and its connected remote-address output.
- Distinct database and media markers survive recreation of the first tenant's
  containers using the existing named volumes. The second tenant's container
  start times and data remain unchanged. Cross-network checks run again after
  recreation.

The implementation follows the documented [Compose startup/recreation behavior](https://docs.docker.com/reference/cli/docker/compose/up/)
and [Docker bridge model](https://docs.docker.com/engine/network/drivers/bridge/).
Those documents are design references, not a substitute for the actual results.

## Ownership and cleanup

Existing project containers, volume names or network names cause refusal before
creation. Before recreation or cleanup, every present resource must have the
exact fixture tenant, plan digest and Compose project labels. Unknown ownership
fails closed; there is no global prune or orphan deletion. Only the two owned
fixture projects and their disposable volumes are removed at the end. A cleanup
failure prevents a successful report. Fixture values are redacted from bounded
failure diagnostics. No production data, credentials or database is touched.

## Evidence boundary

Local evidence currently consists of 64 deployment/packaging and fixture guard
tests, Python compilation, and a loopback curl probe experiment confirming that
a connected timeout exposes its remote address while a refused connection does
not. There is no local Docker daemon, so the two-container-pair acceptance itself
is pending remote CI. Existing single-image and bootstrap acceptance remains
recorded separately in `RUNTIME-IMAGE-ACCEPTANCE.md` and `TENANT-COMPOSE.md`.

Real calls, public HTTPS routing, resource capacity, backup restoration,
production image/secret handling, host-compromise isolation, the trusted
provisioning executor and deployment approval remain separate gates.
