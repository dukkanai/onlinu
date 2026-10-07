# Original execution manifest and existing-secret preflight

The private `createProvisioningExecutionManifest` factory binds the original
in-process prepared artifact and staged handle to the current worker fence.
Each verification checks exact staged files and live actor authority, checks
existing secret-file metadata, then repeats the staged-file/authority check.
Only the original manifest path is returned. There is no image/path override,
secret creation, credential transmission, command execution or public route.

`createProvisioningSecretPreflight` accepts only the five deterministic references
for that tenant under the configured private root. It uses filesystem metadata,
not secret bytes. Files must be regular, single-link, nonempty, bounded to64KiB,
owned by the explicitly configured expected UID, and mode0400 or0600. Symlinks,
foreign paths/tenants, unexpected fields, permissive modes, duplicate hard links,
changed metadata and unsafe root ownership fail closed without repairs. The
acknowledgement exposes only tenant/project and logical reference names.

The trusted operator must supply an accurate image/host UID policy and approved
existing secret files. This is not proof that a container can read them under an
arbitrary user-namespace mapping, that their formats/values are valid, or that a
credential is accepted by any service. Runtime authentication and strict runtime
inspection remain required after creation. The host/ancestors must be controlled;
this does not defeat a compromised UID or prevent changes after the observation.

The manifest capability verifies the exact preflight acknowledgement and rejects
revoked authority, cancelled work, modified artifacts or copied handles before
returning a usable path. It does not read or create real credentials. A restarted
worker still requires explicit reconciliation; it cannot manufacture an earlier
in-process stage handle.

Five actual temporary-filesystem preflight groups and four execution-capability
groups pass locally (27 combined artifact/preflight tests). The capability tests
use the real compiler/stager and a synthetic metadata capability; metadata checks
have their own real-file tests. No production secret directory or UID ownership
was created or changed. Combined host/credential mounts and a production apply
service are not yet accepted; remote ordinary regression remains pending.


Manifest/backup acceptance: `7685020ebc885d2dac99f15fc5384abe79fbd32c`
passed all five jobs in [CI37553654551](https://github.com/dukkanai/onlinu/actions/runs/37553654551),
verified 2026-10-07 00:54 UTC. The private manifest/metadata tests passed ordinary
regression. The actual disposable PostgreSQL archive (89,070 bytes) restored
into a fresh collision-checked database: all43 public-table and6 sequence
fingerprints matched and the source remained unchanged. Neighbor uptime,
recreation and isolation checks passed. Four exact-source runtime reports were
inspected and both immutable verification receipts independently rehashed and
identity-bound. Synthetic local runtime image ID:
`sha256:7a4ef457b9c2e19efdee65ded24dbd4514f2a188680d74529c44fb2cb866f868`.
No archive bytes were uploaded, and no production deployment, registry publication,
real credential creation or activation occurred. Production/session/media backups,
off-host recovery and real credential/mount acceptance remain separate gates.
