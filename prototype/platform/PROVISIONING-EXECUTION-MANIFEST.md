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
