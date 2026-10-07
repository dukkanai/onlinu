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
