# Non-executing tenant resource plans

`tenant_plan.py` is the first offline planning boundary for isolated restaurant
provisioning. It accepts a strict JSON list on standard input and prints a
reviewable, deterministic JSON plan. It never calls Docker, resolves DNS, reads
secrets, changes files/permissions, creates credentials, bootstraps PostgreSQL,
changes the central registry, or deploys anything. Its output is deliberately
not a Compose file or an executable job; `executable` is always `false`.

## Input contract

Every tenant has exactly these fields:

- `tenantId`: same lowercase slug shape as the current identity directory,
  1–64 characters, beginning with a letter or digit.
- `runtimeImage`, `postgresImage`: repository references pinned with a lowercase
  SHA-256 digest. A mutable tag by itself is rejected. A syntactically accepted
  digest is not proof of provenance, availability, signature or runtime health.
- `httpPort`: explicitly allocated host port, 1024–65535. The plan always binds
  HTTP to `127.0.0.1`, never to a caller-supplied interface. It does not inspect
  live host port availability.
- `publicOrigin`, `platformIssuer`: HTTPS DNS origins, without credentials,
  query, fragment, application path or non-default port. The planner does not
  create DNS records or TLS certificates and does not establish domain ownership.
- `platformPublicKey`: canonical base64, 32-byte Ed25519 public key. Never supply
  the private service key, a password, token or raw runtime secret here.

Unknown fields, duplicate JSON keys, overlarge input, malformed values and
repeated tenant IDs, derived project identities, ports or public origins fail
closed. Error labels do not echo rejected input. Plans are sorted by tenant ID.
The input byte limit is 256 KiB and a list may contain at most 1000 entries;
large installations must use bounded batches and an executor-wide resource
registry, not assume each batch proves fleet-wide uniqueness.

Run with a separately prepared non-secret input:

```sh
python3 deploy/tenant_plan.py < tenant-config.json > tenant-plan.json
python3 -m unittest discover -s deploy -p 'test_tenant_plan.py' -v
```

## Isolation contract represented by the output

Each tenant derives a separate project identity, media/PostgreSQL volumes,
database/egress network identities and secret references. The plan describes a
dedicated PostgreSQL instance with no published port, and a runtime role with
`LOGIN`/`CREATEDB` but no superuser, role-management, replication or RLS bypass.
The restaurant process retains UID 10001, read-only root, dropped capabilities
and no-new-privileges. Existing runtime file-secret settings are referenced;
this program never creates or resolves those references.

These are requirements for a future trusted executor, not evidence that Docker
or PostgreSQL has enforced them. In particular, network identities alone are
not firewall isolation, `CREATEDB` does not by itself isolate a shared cluster,
and the database bootstrap credential must never be mounted into the restaurant
process. The central public control/MCP service must not gain a Docker socket.

`planDigest` identifies the canonical reviewed plan. It is not a signature,
permission or instruction to apply it. Any change needs a new reviewed digest.
A future executor must bind registry identity/version and approved manifest,
check live resource ownership/collisions and serialize reconciliation. It must
not trust client-supplied plans or use plan fields as shell commands.

## Remaining before execution

No provisioning worker or apply command is implemented by this increment.
Required gates remain explicit in each output: executor trust, approved existing
secret mounts, restricted-role bootstrap, dedicated network isolation, image
provenance/runtime acceptance, HTTPS routing, live port availability, optional
call-media ingress, measured capacity, backup/rollback and production approval.
No production settings, keys, customer data or existing installer files change.

Local evidence: eight pure planner tests and all 45 deployment/packaging Python
tests pass. Commit `ef87ab9` passed every job in
[CI37407109723](https://github.com/dukkanai/onlinu/actions/runs/37407109723),
including the dedicated planner step. No provisioning was executed.
