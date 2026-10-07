# Disposable main-database backup/restore acceptance

The two-tenant Compose fixture now tests PostgreSQL custom-format backup and
restore of the first disposable tenant's `wacalls_main` database. It validates
exact resource ownership/image identity, stops only that fixture application,
and leaves its database and the neighboring tenant running.

The backup stays under the fixture's private temporary directory, in an
exclusive0600 file. Its PGDMP header,32MiB bound, hash and file read-back are
checked. A deterministic restore name requires an owned `ci-<run>-<nonce>-<n>`
fixture and canonical container ID. An existing database with that name causes
failure; no drop, clean, overwrite or retry is attempted. Restoration goes into
a newly created database inside the already-owned disposable PostgreSQL volume.

Every public table's stable logical row hash/count and every sequence's value/
called flag must match. The original source fingerprint must remain unchanged.
Queries normalize session timezone to UTC. The existing later container
recreation, media-marker persistence, cross-network checks and neighbor uptime
checks still run. Final cleanup remains the existing exact-ownership-verified
fixture cleanup, not an arbitrary database deletion command.

Only source/version, archive size/hash and logical counts/fingerprint are kept
in the CI JSON report. Archive bytes and row values are never uploaded. This is
synthetic acceptance, not a backup tool or a live production recovery operation.
It does not verify session-specific databases, cluster-global roles/settings,
media backup/restore, cross-resource atomic snapshots, off-host encryption or
retention, recovery-point/time objectives or production rollback. Those gates
remain explicit even if this fixture passes.

Four new local guards cover disposable target identity, binary archive handling,
collision refusal and unsafe relation identifiers. All68 deployment/packaging
unit tests pass; actual dump/restore requires the opt-in full-image CI fixture
and is pending for this increment.
