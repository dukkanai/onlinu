# Reviewed-plan Compose rendering (not deployment)

The `--compose` mode of `tenant_plan.py` turns one exact reviewed resource plan
into a Compose JSON specification. It does not call Docker, read secret contents,
create credentials, change file permissions, register a tenant, or start services.
The specification needs a separately authorized trusted executor; no apply worker
or public provisioning endpoint is introduced here.

## Input and review boundary

Standard input is exactly an object with `config`, `expectedDigest` and
`secretRoot`. `config` uses the fields in [TENANT-PLAN.md](TENANT-PLAN.md).
`expectedDigest` must equal the current plan's `planDigest`; stale or modified
configurations are rejected. This is a consistency check, not authentication or
production approval. The plan also binds the bootstrap SQL asset's SHA-256.

`secretRoot` must be an absolute, interpolation-free directory beneath
`/srv/onlinu/`. It is only a reference mapping; the renderer neither creates the
directory nor checks it or its files. Host-specific mapping still requires
separate review. The executor must reject missing/incorrectly owned resources,
symlinks, unsafe file modes, stale registry versions, port conflicts, image
provenance failures and a bootstrap asset whose bytes do not match the plan.
It must not apply untrusted client-supplied manifests or treat a matching hash
as authorization.

```sh
python3 deploy/tenant_plan.py --compose < reviewed-compose-input.json > compose.json
```

Stage the matching `tenant-bootstrap.sql` beside the rendered file. Do not place
real input secret files, passwords or the generated production manifest in Git.
The five secret references are distinct: administrator key, runtime PostgreSQL
URL, Meta encryption key, PostgreSQL bootstrap password, and runtime database
password. The last two are granted only to PostgreSQL; the restaurant cannot
access the bootstrap administrator secret.

## Runtime and database model

The specification uses separate named media and database volumes per tenant,
a dedicated internal database network, and a separate restaurant egress network.
Only restaurant HTTP is published, bound to loopback at the reviewed port.
The restaurant retains UID 10001, read-only root, dropped capabilities and
no-new-privileges. No service receives a Docker socket. These declarations are
not yet a multi-tenant isolation acceptance test. See the official
[Compose network model](https://docs.docker.com/reference/compose-file/networks/)
and [file-secret model](https://docs.docker.com/reference/compose-file/secrets/).

This first renderer targets a dedicated PostgreSQL 16 instance. The selected
pinned image still needs provenance/version verification; the SQL bootstrap
rejects other major versions. The original database provider needs `CREATEDB`
for its main and per-session databases, but its role has no superuser,
role-management, replication or RLS-bypass privileges. Separate instances are
required; `CREATEDB` is not safe tenant isolation in a shared cluster.

The [official PostgreSQL image](https://hub.docker.com/_/postgres) runs init
assets only for an empty data directory. The bootstrap refuses an existing
`onlinu_runtime` role and never alters or drops a role/database. It reads its
bounded, single-line password file under the bootstrap administrator, quotes the
value using SQL formatting, and replaces errors with a non-sensitive label.
No server-file-read privilege is granted to the runtime role; see
[PostgreSQL file-access permissions](https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-ADMIN-GENFILE).

The runtime URL must name role `onlinu_runtime`, service host `postgres`, and the
same privately supplied password as the PostgreSQL-only password reference.
An executor must verify that relationship securely. This renderer does not
create either value, rotate an existing credential, or repair an existing data
volume. A partially initialized volume must be investigated, not automatically
deleted or reinitialized. Health waits for TCP startup rather than the temporary
Unix-socket server used during initialization.

## Evidence and remaining gates

- Thirteen pure planner/renderer tests, six fake-Docker image guard tests and the
  remaining deployment/packaging tests pass locally: 57 Python tests total.
- The exact bootstrap asset rejects a local PostgreSQL 17 synthetic cluster
  without changing the runtime role. This is a negative version check, not proof
  of successful PostgreSQL 16 initialization.
- CI now parses the generated synthetic specification with
  [`docker compose config`](https://docs.docker.com/reference/cli/docker/compose/config/)
  without interpolation, image resolution or Docker resource changes.
- The opt-in image smoke now mounts the bootstrap asset and synthetic database
  password, checks restricted role flags and then the real runtime startup.
  Commit `264157d` passed all five jobs in
  [CI37424797423](https://github.com/dukkanai/onlinu/actions/runs/37424797423).
  The bootstrap/image report was downloaded and inspected; this still does not
  constitute execution of the generated Compose specification.

Production secret mounting, executor authorization/ownership checks, persistent
job reconciliation, live port allocation, HTTPS/proxy routing, media ingress for
calls, resource sizing, backup/rollback and deployment approval remain separate.
The existing offline installer is unchanged. This partial renderer must not be
used to claim that all original call/media functions are deployed or accepted.
