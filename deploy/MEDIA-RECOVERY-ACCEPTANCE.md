# Synthetic restaurant media recovery acceptance

`cmd/server/restaurant_media_recovery_test.go` adds a bounded, test-only media
recovery drill to the existing isolated `TestRestaurantKeyRecovery` group. It
reuses that group's PostgreSQL binary validation, freshly owned clusters,
connection identity checks, bounded subprocesses and cleanup. It never accepts an
existing database URL, directory, archive, keyring or media path. No live database,
upload, backup or provider is used. This drill changes only tests and documentation.

## What it verifies

- Initialize and cold-start actual external-v1 main with a freshly generated
  keyring and exact store/database/schema identity. Seed encrypted receipt and
  disabled payment/terminal-attempt payloads without creating legacy key rows.
- Upload ten generated small PNG/JPEG images through the authenticated image
  endpoint. Re-encoding removes an appended synthetic metadata trailer and the
  resulting filenames match the SHA-256 of the normalized bytes.
- Save references through existing catalog and brand operations, including an
  unavailable menu item, published appearance, a previous-only image, and an
  unpublished draft with draft-only images. Preserve an external HTTPS image URL
  without fetching it. Include one unreferenced upload in the complete inventory.
- Dump the newly created source database and restore it into a separately created
  cluster with the same generated database name. Compare all public table and
  sequence fingerprints and the catalog/live/draft/previous reference fields.
- Establish that database restoration alone leaves local image references
  unsatisfied and their image requests return 404.
- Copy generated files into an independently owned empty media directory using
  exclusive file creation. Reject symlink roots/files, unexpected names,
  nonregular entries, size/count overflow, changed content, same-directory copies
  and nonempty targets. Verify separate file identities, exact content hashes and
  sizes, all reference targets, actual PNG/JPEG responses and serving headers.
- Verify and cold-start actual external-v1 main against the target database and
  independent media root, then decrypt and compare the seeded payloads and check
  durable legacy-key fences.
- Check the restored public catalog and authenticated catalog/brand responses.
  The fixture independently checks the visible item set and recursively inspects
  raw JSON for hidden items, draft/previous-only references and table codes.
  Only the four public catalog top-level fields are allowed. Known media URLs
  remain publicly served; privacy here concerns omission from the catalog, not
  access control on the image files.
- Remove a target-only draft image and require completeness failure and a 404;
  alter target-only bytes and require acceptance-hash failure. Restore both
  negative fixtures and verify unchanged source bytes, source/restored database
  fingerprints, and final restored inventory.
- Put an owned sentinel outside `restaurant-images` and verify raw, encoded and
  nested traversal requests cannot serve it. Check the canonical redirect too.
  Reject unsafe catalog and brand image references without changing the database.

The fixture caps media at 32 files and 64 KiB per file. These deliberately small
synthetic bounds do not change the production upload size or filename contract.
The copy/check helpers are not an operator-facing restoration utility.

## Run

Use the same reviewed PostgreSQL 16/17 Debian-layout binaries, non-root Linux
execution and explicit opt-in as the key recovery drill:

```sh
TEST_EXTERNAL_KEY_RECOVERY=1 \
TEST_EXTERNAL_KEY_RECOVERY_PG_BIN=/absolute/path/to/usr/lib/postgresql/17/bin \
go test -race -count=1 -v ./cmd/server -run '^TestRestaurantKeyRecovery' -timeout 5m
```

Without opt-in, the database/media acceptance skips. The pure synthetic media
copy/reference guards still run. The existing dedicated CI step selects this
name and runs it in the same network-isolated PostgreSQL container as the key
recovery tests; merely adding a test to that selector is not evidence that hosted
CI has executed this revision.

Local evidence on 2026-10-10: the combined external-v1 media case and both
existing historical/current key cases passed with PostgreSQL 17.11 and Go's race
detector. Media acceptance compared ten files, 22 reference fields and all 38
public table/sequence relations, with a 75,240-byte generated database archive.
All pure media guards and `go vet ./cmd/server` passed too. The full recovery
group also passed as a static `CGO_ENABLED=0` test binary launched with an empty
inherited environment, matching the CI launch shape; that local run does not
claim Docker/network isolation. These are local synthetic results, not hosted
or production recovery evidence.

## Boundaries and remaining work

The serving handler currently validates upload filename syntax, then serves the
file without recomputing its hash. Tampering rejection here is performed by the
test's acceptance oracle, not by a new runtime integrity feature. The public URL
validation contract is not narrowed to the fixture's hash-generated filenames.
External image URLs are retained but their availability/content is not verified.

The test owns and keeps its source quiescent while taking both resources. It does
not implement an atomic cross-resource snapshot protocol, detect all possible
concurrent live writes, prove historical archive completeness, test symlink-safe
restoration of an untrusted live archive, or establish off-host retention,
custody, destination suitability, RPO/RTO or production readiness. Real media
and database recovery still require separately approved backups, trusted
inventory/identity, cross-resource consistency and execution evidence. See the
[external-key recovery boundaries](EXTERNAL-KEY-RECOVERY-PREFLIGHT.md).
