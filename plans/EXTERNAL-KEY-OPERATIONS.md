# External restaurant keys: opt-in integration and offline maintenance

## Release boundary

This is code and isolated synthetic test work. It does not provision a key,
change a deployment, run maintenance against a real database, authorize a
backup, or resolve production encryption acceptance. The current deployment
configuration remains unchanged. With all external-crypto settings absent,
the application still uses legacy database-resident data-encryption keys.

The opt-in mode is `WACALLS_CRYPTO_MODE=external-v1`. It requires a trusted
`WACALLS_CRYPTO_STORE_ID` and exactly one of `WACALLS_CRYPTO_KEYRING` or
`WACALLS_CRYPTO_KEYRING_FILE`. The reviewed keyring format and file restrictions
are documented in `EXTERNAL-KEY-FOUNDATION.md`. A configured platform tenant
must match the crypto store ID. A keyring or store setting without the exact
mode, missing key material, malformed configuration, or conflicting sources is
an error, never a request to use legacy storage. Mode/store `_FILE` alternatives
are not supported and are rejected. Prefer an operator-controlled read-only
secret file over an environment key value.

External startup validates the keyring before opening any database. It connects
only to the existing `<pg-namespace>_main` database, pins `public` as its search
path, takes the existing namespace ownership lock, verifies database/schema/store
identity and both authenticated DEK envelopes, and checks the empty legacy-table
fences before ordinary schema setup, payment workers or HTTP startup. It does
not create a database, initialize encryption, generate a missing key or fall
back. Provisional DB connections and ownership are closed on failure.

## Separately authorized operator sequence

Do not execute these steps until the owner approves the specific installation,
key custody, maintenance window and recovery decision. No real keys or reusable
example keys are included here. No key-provisioning command is supplied.

1. Confirm the intended restaurant ID, PostgreSQL host and namespace against
   trusted installation records. Legacy storage has **no independently persisted
   restaurant identity**: the initial store-to-database mapping is an explicit
   operator assertion, not a fact cryptography can reconstruct. The command
   verifies the exact database/schema and configured platform tenant, then binds
   that asserted store ID in the committed envelopes and metadata. A wrong
   operator mapping can still bind the wrong legacy database; approval and
   verification of this mapping are essential.
2. Obtain independently generated per-restaurant master keys through the
   separately approved custody process. Do not derive them from passwords,
   restaurant IDs or administrator API keys. Preserve a private retained keyring
   and approved recovery access; no backup/snapshot instruction is changed here.
3. Stop all HTTP applications, payment workers and other writers for this
   namespace. Maintenance takes the same exclusive ownership lock, and refuses
   if a runtime owns it. The transaction uses that very ownership session so a
   lost connection aborts the transaction as well as releasing ownership.
4. Configure the external mode, trusted store ID and one keyring source. Use the
   matching namespace and the application's normal database secret configuration.
   The existing CLI now accepts exactly one of these offline commands:
   - `wacalls -pg-namespace <verified-namespace> -crypto-command migrate`
   - `wacalls -pg-namespace <verified-namespace> -crypto-command init`
   - `wacalls -pg-namespace <verified-namespace> -crypto-command verify`
   - `wacalls -pg-namespace <verified-namespace> -crypto-command rotate`
   These processes exit without creating HTTP listeners or starting workers.
   They never create a PostgreSQL database. Invalid commands fail before opening
   it. A missing database is an error; an operator must explicitly create a new
   database separately if that is the approved task.
5. Run `migrate` for an existing reviewed legacy schema. Run `init` only for a
   completely empty, explicitly selected existing schema. Never substitute init
   for a failed migration. Verify the committed state, then start an
   envelope-aware release with the same mode, store ID and retained keyring.

`migrate` locks all five encryption-bearing tables, rejects unreviewed column
signatures, views, inheritance, partitions, rules and RLS, plus user triggers and foreign keys into/out of key-control
tables, requires
exactly one valid 32-byte key in each legacy singleton table, and authenticates
every order receipt secret, payment configuration and payment-attempt snapshot.
Receipt hashes and configuration/attempt row identities must agree. Any failure
rolls back without a replacement key. Existing payload-table DML triggers are
preserved and never invoked because maintenance only reads those tables. It wraps both **unchanged** DEKs with the
active external KEK, verifies unwrapping, writes the singleton version-1 state,
deletes the two plaintext rows, and installs validated `CHECK(false)` constraints
on both emptied legacy tables in the same transaction. Payload ciphertext bytes
are untouched. Missing or partial legacy structures require investigation.

`init` alone generates two new random payload DEKs inside explicit offline
maintenance and stores only their envelopes. It refuses any existing schema
relations or namespace-dependent objects without committed external state. It does not generate a master key.
The normal runtime performs its usual business-schema initialization only after
loading valid external state. An already initialized/migrated database is
verified on init/migrate rerun without replacing keys or envelopes.

`verify` authenticates both envelopes and all present reviewed encrypted payload
tables without modifying them. An initialized schema may have no business tables
yet; a partially present encryption-bearing table set is an error. Verification
is not a full business-data completeness audit or evidence of backup quality.

## Rotation and recovery

Retain the old key ID and exact bytes, add a newly provisioned ID/key, and select
that new ID as active. Stop the runtime and use `rotate`: it authenticates all
existing encrypted values, unwraps both original DEKs with retained historical
keys, and atomically rewraps both under the new active KEK. It does not change
payload ciphertext, receipt tokens, payment credentials or DEKs. A rerun with
both envelopes already under the active ID verifies without rewriting. Unknown
or missing historical keys, authentication failures, mixed wrapping generations,
nonempty/unfenced legacy tables and inconsistent metadata fail closed.

Never reuse a key ID for different bytes. The implementation catches a changed
key while that ID is required by the current envelopes; it cannot detect reuse
of an ID referenced only by an offline historical copy. Keep every key needed
by retained approved historical copies. Rotation is not permission to retire
old keys. Any recovery manifest should contain IDs and procedure, never keys.

Rollback must use an envelope-aware release. To revert a wrapping generation,
explicitly select a retained old key as active and use `rotate` after approval.
Do not restore plaintext keys or remove the fences. Newer legacy-mode startup
rejects any external-state marker or fence before schema work. The reviewed old
constructors unconditionally insert a legacy singleton and are rejected by
`CHECK(false)`, preventing replacement-key generation from reaching a running
server even after an old binary recreates its `IF NOT EXISTS` tables.

A commit error or lost acknowledgment may mean maintenance committed. Treat the
outcome as uncertain: keep the application stopped and use the retained keyring
to verify. Do not automatically rerun init or generate replacement keys. Atomic
state means a subsequent migrate/rotate rerun can establish either the unchanged
legacy state or the committed external state; contradictory state remains an
error. Test fault hooks simulate rollback before writes/commit and an error after
a successful commit. They do not prove every network or storage failure mode.

A pre-migration historical restore must migrate before external-mode serving.
Recovery must not overwrite newer business data. Actual recovery drills,
production startup/image acceptance and the deployment configuration change
remain separately approved work. Compose/installer defaults are intentionally
not changed by this increment; enabling them is a coordinated activation gate.

## Security limits and acceptance evidence

Deleting plaintext rows is **not secure erasure**. Old row versions, WAL,
physical backups, replicas and snapshots can still contain them. DELETE or
VACUUM does not establish protection from historical physical-volume disclosure.
A stronger claim requires a separately approved fresh-volume logical migration
and disposition of every older copy. KEK rotation does not undo prior DEK
compromise; that requires separate payload re-encryption and possibly provider
credential rotation.

The encrypted scope remains receipt access secrets and payment credentials/
attempt snapshots. Ordinary customer names, phone numbers, addresses and order
financial/status fields remain plaintext. This does not prevent malicious DB
writes, rollback of an entire consistent DB image, compromised host/process
memory or hostile operator-controlled secret files. The database role must not
be treated as an adversary that the CHECK fence can restrain: a privileged actor
can remove it. Single-active ownership applies to cooperating releases.

Required automated gates include pure/race key tests, synthetic PostgreSQL
migration/init/rotation/fault-injection tests, old-constructor fencing, competing
owners, valid payload preservation, and actual-main cold-start success/failure
before HTTP/worker activity. Run the existing CI's full server/client/platform
checks against the exact reviewed publication SHA. Skipped local database tests
are not passing tests. Separately authorized runtime-image acceptance and real
installation approval must follow before making any production security claim.
