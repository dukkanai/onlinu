# Offline external-key recovery metadata preflight

`external_key_recovery_preflight.py` compares two explicitly supplied, ID-only
JSON declarations. It never connects to PostgreSQL, Docker or a provider, reads
an archive or keyring, creates a backup, changes files, or executes a restore.
There are no defaults from the environment. This is preparation for separately
approved recovery acceptance, not a recovery operation or a readiness certificate.

Run with two non-secret metadata files:

```
python3 deploy/external_key_recovery_preflight.py MANIFEST_JSON TARGET_JSON
python3 -m unittest discover -s deploy -p 'test_external_key_recovery_preflight.py'
```

Never supply a keyring, database URL, password, actual envelope, archive or secret
file as either input. Unknown and duplicate fields are rejected, including nested
fields. Explicit inputs must be regular non-symlink files, at most 64 KiB each.
Errors and successful output contain no caller-supplied values or paths. The
tool does not prevent an operator from mislabelling sensitive data as an ID.

## Synthetic input contract

These are declarations, not extracted or authenticated state. Example source:

```json
{
  "version": 1,
  "kind": "onlinu-external-key-recovery-manifest",
  "cryptoMode": "external-v1",
  "storeId": "synthetic-store",
  "databaseName": "synthetic_main",
  "schemaName": "public",
  "stateVersion": 1,
  "envelopes": [
    {"version": 1, "storeId": "synthetic-store", "purpose": "order-secrets", "dataKeyId": "order-dek-v1", "wrappingKeyId": "retained-old"},
    {"version": 1, "storeId": "synthetic-store", "purpose": "payment-secrets", "dataKeyId": "payment-dek-v1", "wrappingKeyId": "retained-old"}
  ]
}
```

Example target inventory, with the historical key ID retained after rotation:

```json
{
  "version": 1,
  "kind": "onlinu-external-key-recovery-target",
  "cryptoMode": "external-v1",
  "storeId": "synthetic-store",
  "databaseName": "synthetic_main",
  "schemaName": "public",
  "availableWrappingKeyIds": ["current-new", "retained-old"]
}
```

Both purpose/data-key IDs are fixed by `restaurant_key_storage.go`. Both
envelopes must declare the same wrapping generation. Store/key IDs use
`restaurantKeyIdentifier`'s ASCII grammar and 80/64-character bounds; database
and schema names use `restaurantCryptoSQLName`'s ASCII grammar and 63-character
bound. This comparison does not establish that a generic SQL name is a valid
runtime namespace; actual external startup additionally uses `<namespace>_main`
and the `public` schema.

The target's 1–16 unique wrapping IDs describe a key inventory only. Their
presence does not prove correct key bytes, custody, availability or entitlement
to use them. Old material with the same ID but different bytes still fails real
envelope authentication; the offline comparison cannot detect this. It has no
active-key selection and never authorizes retiring a historical key.

## Why database identity must remain exact

`restaurantReadExternalKeys` binds the stored store, database and schema names
to trusted runtime configuration. The existing generic disposable backup smoke
restores `wacalls_main` into `onlinu_restore_<hash>` in the same cluster. Its row
fingerprint match is useful backup-format evidence, but cannot prove successful
external-v1 runtime recovery. The offline comparison refuses that name mismatch.
Do not rewrite stored identity or weaken runtime checks to make a restore pass.

The separate opt-in synthetic regression now implements that exact-identity
drill. It does not turn this metadata preflight into an executable recovery tool.

## Two-cluster synthetic recovery regression

`cmd/server/restaurant_key_recovery_test.go` accepts an explicit local PostgreSQL
binary directory, never an existing data directory, database URL, archive or
keyring. The test creates both clusters itself in private temporary directories,
using generated credentials and keys, separate loopback ports, no Unix sockets,
and the exact same generated `<namespace>_main`/`public`/store identity. Connection
checks bind each cluster to its data directory, port and system identifier.
Every case owns fresh clusters; no restore overwrites or drops a database.

The historical case restores old-generation envelopes with the old key retained
in a ring whose active key is new. The current case explicitly rotates synthetic
source envelopes and restores with the new-only ring. Both seed generated receipt
secrets, disabled Stripe configuration, a failed terminal attempt and non-crypto
business data. Wrong key bytes and missing historical/current keys fail offline
verification and actual-main startup with the expected crypto-error marker and
exit status, without HTTP serving or table/sequence changes. A temporary
target-only catalog rename makes premature schema initialization observable;
it is reversed before successful recovery checks.

The custom-format archive is capped at 32 MiB, checked for its PGDMP header,
written exclusively with mode 0600 and SHA256-checked after readback. All public
table row hashes/counts and sequence values/called flags must match, alongside
real receipt/config/attempt reads, durable key fences, unchanged source and
neighbor fingerprints, and uninterrupted neighbor-cluster uptime. The actual-main
helper rejects outbound HTTP. Reports contain only bounded hashes/counts and
assertion results; no archive, key or raw runtime-log artifact is uploaded.

Run only with official PostgreSQL 16/17 binaries in their reviewed Debian layout,
as a non-root Linux user with loopback socket access:

```
TEST_EXTERNAL_KEY_RECOVERY=1 \
TEST_EXTERNAL_KEY_RECOVERY_PG_BIN=/absolute/path/to/usr/lib/postgresql/17/bin \
go test -race -count=1 -v ./cmd/server -run '^TestRestaurantKeyRecovery' -timeout 5m
```

Without the opt-in, the two-cluster test skips; its pure ownership/output-bound
guard still runs. The ordinary server CI job compiles a static test binary and
runs it as `postgres` in the exact official PostgreSQL 16 image already provisioned
for that job, with an empty inherited environment, `--network none`, a read-only
root, no added capabilities, private tmpfs and only the test binary mounted.
The image's declared data-volume
path is also covered by an unused tmpfs, preventing anonymous persistent-volume
creation. No existing database volume or host port is shared. Cleanup verifies
the created container's exact ID, ownership label and image before removing it.
Native cleanup stops only its own process
groups before temporary-directory removal; it never adopts another cluster.
Shutdown/reaping waits are bounded; failed shutdown retains the owned directory
and fails the test rather than deleting a running cluster's files.

Local evidence on 2026-10-10: both cases passed with PostgreSQL 17.11 and the Go
race detector, with all 38 public table/sequence relations equivalent. The static
test binary also passed both cases with an empty inherited environment. This
evidence covers the local synthetic drill only.
The newly added PostgreSQL 16/network-isolated CI step has not yet been executed.

## Meaning of success and remaining gates

Exit 0 means only `declarations-compatible`; `executable` and `restoreVerified`
remain false. This tool neither authenticates declarations nor binds them to a
particular archive, release, cluster or independently verified installation.
Exit 2 rejects malformed or incompatible declarations without echoing them.

For a live deployment, archive integrity/completeness, correct keys, trusted
installation mapping, target ownership/emptiness/isolation, roles/settings,
payload authentication and envelope-aware release acceptance still need separate
evidence; the synthetic regression cannot establish them. Business recovery includes
data outside encrypted receipt/payment fields. Media must be restored and checked
separately with cross-resource consistency; an existing-volume media marker proves
persistence only. Control-plane/Dex data and their external secrets are outside
this restaurant-key contract. Independent off-host recovery, custody/retention,
RPO/RTO, Saudi recovery destination and execution approval remain open.

The current no-live-backup/snapshot instruction is unchanged. No live key,
rotation, deployment, server/security setting, or courier-session work is part of
this increment.
