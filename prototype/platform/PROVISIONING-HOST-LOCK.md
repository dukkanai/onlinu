# Linux host exclusion for provisioning

`createProvisioningHostLock({ directory, ownerUID? }).withLock(resourceName,
operation)` supplies a concrete local lock to the private provisioning runner.
It does not execute Docker, read credentials, create tenants or expose a route.

The existing absolute directory must be owned by the configured UID and private
(mode 0700 or stricter). Its ancestors, mount namespace and `/usr/bin/flock` must
be trusted. Only the planner's `onlinu-` plus 32 lowercase hexadecimal resource
names are accepted. Workers using the same Docker host must use the same stable
lock directory and namespace. This is not a distributed lock across hosts.

## Kernel ownership

The module opens an empty mode-0600 regular lock file without following symlinks,
checks ownership/link count, then invokes the installed util-linux `flock` using
only the inherited descriptor, nonblocking mode and a minimal environment. No
shell or user-supplied command/path is invoked. Busy acquisition does not run the
callback or wait indefinitely. Unexpected acquisition errors are sanitized.

Linux flock locks belong to the open file description, so the parent descriptor
retains exclusion after the short helper exits. Closing that descriptor in a
finally block releases it after the callback settles. See the authoritative
[Linux flock(2) semantics](https://man7.org/linux/man-pages/man2/flock.2.html).
Lock files are never removed on release: deleting/replacing an inode can split
exclusion between workers. This component never repairs permissions or removes
an existing file. Rejects include links, unexpected content, loose permissions,
wrong owners and nonlocal/unsupported filesystem types.

Supported filesystem magic values are ext-family, XFS, Btrfs, tmpfs and overlayfs.
Network filesystems are deliberately not accepted. This allowlist is not proof
against a compromised host, a hostile process with the same UID, an administrator
replacing the directory, or another program that ignores advisory locks.

## Crash and subprocess limits

A worker process exit releases the lock. That does NOT prove an asynchronous
Docker daemon operation stopped. The journal's lost-response/unknown state must
still block a new attempt until the actual host is inspected and reconciled.
No automatic requeue is enabled by a released lock.

The callback must await every owned subprocess and cancellation before returning
or throwing. This lock component cannot stop detached driver work or arbitrary
JavaScript. The production Docker driver's process lifecycle, cancellation,
resource ownership and recovery remain unimplemented and require acceptance.
Do not use lock-file deletion as crash recovery.

## Verification

Tests use real util-linux flock and separate Node processes: an acquired lock
survives helper exit, blocks the same tenant in another process, permits a
neighbor, releases on callback failure and owned worker process termination,
and retains stable lock files. Unsafe files and directories are rejected.
The real PostgreSQL/artifact-compiler/runner integration also uses this lock,
with a synthetic apply driver. No Docker or production fixture is involved.
Remote CI acceptance of this increment is pending.
