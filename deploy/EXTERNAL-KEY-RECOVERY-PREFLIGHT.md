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

A future approved synthetic drill should use a fresh independently owned cluster
with the original database/schema/store identity. Seed synthetic receipt and
disabled payment configuration/terminal-attempt data; exercise historical and
current wrapping generations. Restore each approved synthetic archive into an
absent target; use retained keys to run offline verification and an envelope-aware
cold start. Wrong or missing historical material must fail before schema changes,
HTTP serving or provider work. Prove payload preservation, key fences, full
business-table/sequence equivalence, unchanged source and neighboring resources.
Keep reports to bounded hashes/counts and assertion results, never archive or
key bytes. That drill has not been implemented or executed by this increment.

## Meaning of success and remaining gates

Exit 0 means only `declarations-compatible`; `executable` and `restoreVerified`
remain false. This tool neither authenticates declarations nor binds them to a
particular archive, release, cluster or independently verified installation.
Exit 2 rejects malformed or incompatible declarations without echoing them.

Actual archive integrity/completeness, correct keys, trusted installation mapping,
target ownership/emptiness/isolation, roles/settings, payload authentication and
envelope-aware release acceptance still need evidence. Business recovery includes
data outside encrypted receipt/payment fields. Media must be restored and checked
separately with cross-resource consistency; an existing-volume media marker proves
persistence only. Control-plane/Dex data and their external secrets are outside
this restaurant-key contract. Independent off-host recovery, custody/retention,
RPO/RTO, Saudi recovery destination and execution approval remain open.

The current no-backup/snapshot instruction is unchanged. No live key,
rotation, deployment, server/security setting, or courier-session work is part of
this increment.
