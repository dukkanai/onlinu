# External restaurant encryption keys: foundation and opt-in integration

## Status and scope — 9 October 2026

The foundation now has an explicit opt-in runtime and offline maintenance path,
described in `EXTERNAL-KEY-OPERATIONS.md`. This remains code and isolated synthetic
test work, not production activation. Existing deployment defaults still use
legacy database-resident DEKs. Merely setting a keyring without the exact
external mode is rejected, not silently ignored.

The helpers below implement bounded keyring loading and authenticated wrapping
of existing 32-byte DEKs. The opt-in integration adds startup validation,
owned migration/init/rotation/verification and legacy-writer fencing. No real key
provisioning, migration, provider operation, deployment change, backup/snapshot,
KMS dependency or courier-session work is authorized by these files.

## Phase 1: keyring and envelope interface

`readRestaurantKeyring(getenv, expectedStoreID)` is an explicitly invoked helper.
Its settings are `WACALLS_CRYPTO_KEYRING` and
`WACALLS_CRYPTO_KEYRING_FILE`. They are used only with the explicit `external-v1` mode. Prefer an
operator-owned read-only secret file; see the operations document for the
required mode/store settings and separate activation gate.

The reader follows the existing `runtime_secrets.go` safety contract without
changing that loader or its supported settings:

- Exactly one nonempty source, no fallback if an explicit source is invalid.
  Missing configuration is an error when the helper is called.
- At most 64 KiB, valid UTF-8, single-line JSON; terminal CR/LF is allowed.
  NUL and interior CR/LF are rejected. The file must be regular and not a symlink;
  its opened identity is checked and the read remains bounded.
- No environment exports, persistence, new key generation, permission changes,
  background reload, logs or filesystem-path/contents/parser errors.
- The file and its parent directories must ultimately be controlled by the
  operator. These checks are not a boundary against a hostile process able to
  replace operator-owned files, read runtime memory or administer the host.

The keyring document has exactly `version`, `storeId`, `activeKeyId` and `keys`.
Version is integer 1. `keys` contains 1–16 entries, each with exactly `id` and
`key`. IDs are unique; the active ID must be present. Each key is canonical,
padded standard base64 encoding of exactly 32 bytes. Unknown, duplicate,
case-mismatched or missing fields and trailing JSON values are rejected.
No real or deployable example key is included.

Store identity is independently supplied by the trusted caller, matches the
existing tenant identifier grammar (1–80 ASCII letters/digits/underscore/hyphen,
starting with a letter or digit), and must equal the keyring's `storeId`.
Wrapping/data key IDs use the same grammar with a 64-byte bound. Expected store,
purpose and DEK ID must never be copied from the untrusted envelope itself.
Separate restaurants need independently generated master keys, not shared keys
with different labels. Do not derive keys from administrator credentials,
database passwords or restaurant identifiers. Key generation is a later,
separately authorized operation.

`wrap(purpose, dataKeyID, existingDEK)` returns a version-1 JSON envelope.
`unwrap(purpose, dataKeyID, envelope)` returns a fresh copy of the exact DEK bytes.
Allowed purposes are `order-secrets` and `payment-secrets`. AES-256-GCM uses the
active wrapping key and a fresh random 96-bit nonce. Associated data is the JSON
array of the fixed `onlinu-restaurant-dek-envelope` domain, format version `1`,
store identity, purpose, DEK ID and wrapping-key ID. Every identifying field is
authenticated. The envelope contains these identifiers plus canonical base64
nonce and ciphertext/tag; its input is bounded to 4 KiB. Unknown key/version,
wrong scope, corruption, invalid lengths and malformed encoding all fail closed.
This is for infrequent DEK wrapping; it is not a bulk encryption API. The later
operating policy must stay far below GCM's 2^32 random-nonce invocation limit per
key, including aliases and all processes using the same key material.

The loaded keyring is immutable and supports concurrent wrapping/unwrapping.
Ordinary formatting is redacted. This does not promise secure erasure from Go
memory, error-proof operator logging, historical-key retirement or a hot reload.
The caller owns decrypted DEK buffers and should clear them after cipher setup;
keys and ciphers necessarily remain available to the running process.

## Phase 2: separately reviewed offline migration and runtime integration

The following requirements are implemented by the opt-in integration and must
be established by its isolated tests and exact published CI before acceptance:

1. Stop the HTTP application and payment worker; acquire the existing database
   namespace ownership lock. Refuse migration while another process owns it.
2. Verify the exact database/store identity and both legacy singleton keys.
   Missing keys with dependent ciphertext must fail, never generate replacements.
3. In one transaction, lock the relevant tables, authenticate all existing
   encrypted payment configurations/attempt snapshots and order receipt secrets,
   wrap both unchanged DEKs, verify both unwrap to the original bytes, and record
   versioned migration/envelope state. Keep the payload ciphertext unchanged.
4. Remove the legacy plaintext rows within that same transaction and fence the
   emptied legacy tables against inserts. Dropping the tables is insufficient:
   the old binary recreates them and generates new keys. The fence must be
   independently tested against actual old-binary startup and writes.
5. Make reruns verify the committed state without changing keys. Inject failures
   before each write/commit, including unknown commit outcomes. Contradictory or
   partial state must stop, not trigger fallback or regeneration.
6. Parse the keyring before opening/creating the database. After ownership is
   acquired, authenticate both stored envelopes before ordinary schema setup,
   payment workers or HTTP listening. Missing/invalid keys, an unmigrated DB or
   failed authentication must prevent all serving and worker activity and close
   provisional resources. No runtime legacy-key fallback is permitted.

New-database initialization must likewise be an explicit owned operation. Do
not activate these helpers by merely adding a conditional startup call while
leaving legacy initialization available. Updating mounts, compose/installer
contracts, privacy-safe diagnostics, actual startup tests and runtime-image
acceptance belongs to that reviewed integration. No actual migration follows
from implementing its code; execution remains separately authorized.

## Phase 3: rotation code, recovery and activation acceptance

Routine master-key rotation retains the old key ID/material, introduces a new
ID, and atomically rewraps both unchanged DEKs under the new active key during
owned maintenance. Never reuse a key ID for different key bytes. Retain all keys
needed by retained backups; an ID-only recovery manifest must not contain keys.
A missing historical key is a hard failure. Rollback requires an envelope-aware
release, optionally explicit rewrapping under a retained old key, never automatic
restoration of plaintext storage. Pre-migration restores must migrate before
serving, without overwriting newer business data.

Required future evidence includes interrupted/concurrent migration and rotation,
old-binary fencing, process restart, retained-backup decryption, wrong/missing
key startup refusal before any listener/provider work, and a separately approved
isolated recovery drill. Activation also requires a named key custodian,
approved private storage, an independent Saudi recovery destination, retention
and recovery/outage decisions. The existing no-backup/snapshot instruction is
unchanged; this document does not authorize one.

Removing a plaintext key row is **not secure erasure**. Historical row versions,
WAL, physical backups, replicas and snapshots can retain those bytes. A stronger
physical-volume disclosure claim needs separately approved fresh-volume logical
restore and controlled handling/retention of all old copies; SQL DELETE or
VACUUM is not evidence of secure erasure. Rewrapping an already compromised DEK
does not revoke the attacker’s knowledge of that DEK. Compromise recovery needs
separate payload re-encryption and any necessary provider-credential rotation.

Scope remains the currently encrypted receipt secrets and payment credentials/
attempt snapshots. Customer names, phone numbers, addresses and financial or
status fields in ordinary order documents remain plaintext. This foundation
does not address database-write/rollback attacks, host/process compromise or
complete personal-data protection.

## Phase-1 verification

The focused `TestRestaurantKey*` suite runs without a database, network, provider
or application startup. Only deterministic synthetic keys, temporary files and
in-memory ciphers are used. It covers strict source/JSON/key validation,
redaction, fresh nonces, context and ciphertext/tag tampering, wrong or missing
keys, two-purpose isolation, old/new keyring transitions and concurrent calls.
It also uses the original receipt/payment encryption methods to verify that
unchanged payload ciphertext, receipt credentials and configuration/attempt
snapshots remain readable with the wrapped/unwrapped original DEKs. Frozen
synthetic receipt/configuration/attempt ciphertext generated with the unchanged
e47ff94 codecs also pins their existing payload and associated-data formats; it
is not evidence from a production database.

Run `go test -race -count=1 ./cmd/server -run '^TestRestaurantKey'`.
See the operations document for the integration and actual-main test gates.
These focused checks do not substitute for the phase-2 migration/startup tests,
full database/browser/image regression gates, independent review, or the exact
published commit's CI. There is no deployment or production-security acceptance.
