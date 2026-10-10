# Synthetic control-plane archive/restore acceptance

`control-recovery.test.mjs` exercises a real PostgreSQL custom-format archive of
generated control-plane data. It is a test fixture, not an operational backup or
restore tool. It never connects to Dex, a restaurant core, a payment service or a
messaging service.

## Run

Use the existing isolated PostgreSQL harness described in
[`integration/LOCAL-POSTGRES.md`](../../integration/LOCAL-POSTGRES.md), with a fresh
owned cluster and a database named exactly `astracalls_identity_test`. Its role
must be able to create and drop disposable databases. The database URL must have
the literal host `127.0.0.1`, a synthetic username/password, and only
`?sslmode=disable`. No inherited `PG*` settings are allowed. Never use production
credentials or an existing application cluster.

From the repository root, with `IDENTITY_TEST_DATABASE_URL` set to that fixture:

```sh
TEST_CONTROL_RECOVERY=1 \
TEST_CONTROL_RECOVERY_PG_BIN=/absolute/path/to/postgresql/bin \
node --test prototype/platform/control-recovery.test.mjs
```

The explicit client directory must contain executable `pg_dump` and `pg_restore`
from the same reviewed PostgreSQL 16 or 17 version. The dump client cannot be older
than the server major version. Opting in without a database or required clients
fails the test. Ordinary platform tests run the always-on safety guards, but skip
the actual archive/restore unless explicitly opted in; a skip is not acceptance.

## Isolation and evidence

- Create one random, ownership-marked source schema in the isolated test database.
  Other schemas and public tables are excluded by an exact `pg_dump --schema`.
- Generate all identities, OIDC state, sessions, PKCE codes and OAuth tokens in
  process. No live credential, database archive, secret file or external service
  is read. The OIDC adapter is deliberately simulated.
- Quiesce this fixture before dumping. Store at most 4 MiB in a fresh private
  directory, in an exclusive `0600` file. Verify the `PGDMP` header and byte/hash
  read-back before restore.
- Restore into a newly created `control_recovery_restore_<random>` database.
  Existing targets are refused without overwrite or retry. Restore is one
  transaction, without `--clean`, `--create`, roles, ownership or ACL restoration.
- Compare all 12 populated tables and the audit sequence exactly. Reinitialize
  the actual control-plane modules and compare again, detecting silent authority
  changes during startup.
- Verify active/draft/suspended/closed restaurant visibility, original owner
  subject binding, no same-email rebinding, disabled identities, cross-tenant
  rejection, custom permission limits, membership versions, last-owner safety,
  foreign-key/unique constraints and audit sequence advancement.
- Verify restored browser/OAuth separation, snapshot-time revoked grants,
  single-use authorization codes, PKCE, scope narrowing, refresh rotation and
  consumed-token replay revocation. Pending OIDC state retains browser binding
  and single-use consumption.
- Confirm the source fingerprint remains unchanged. Close connections and clean
  up only resources whose generated name, recorded catalog OID and ownership
  marker still match. There is no forced disconnect or cleanup of other fixtures.
- Output only counts, PostgreSQL version, archive length/hash, logical fingerprint
  and scope flags. Archive bytes, row values and raw tokens are not test artifacts.
- SQL has server and client deadlines, connections and pool shutdown are bounded,
  and test cancellation prevents subsequent SQL and aborts archive subprocesses.
  Failure cleanup tries each known resource independently and reports any
  ownership uncertainty or cleanup error instead of adopting an unknown target.

## Separate gates

Passing proves this generated control schema can be restored at its captured
point in time. It does not establish deployed backup coverage or production
recovery readiness.

Dex uses a separate database and separately mounted configuration. Its signing
keys, connector/static-user identifiers, bcrypt hashes, client registration and
client secret have their own recovery requirements. A replacement Dex subject
must not be silently rebound to an old owner. This fixture proves the application
retains its issuer/subject binding; it does not prove a recovered Dex can issue
that same verified subject or complete an HTTPS login.

OAuth token hashes in a backup still authorize holders of corresponding raw
tokens if restored while valid. Revocation that happened **after** the snapshot
is not represented in that archive. This test preserves revocations already in
the snapshot; it is not rollback-resistant revocation or a production session
invalidation procedure. An explicit negative regression revokes a generated
browser session, restores that one captured row, and confirms the old unexpired
token becomes accepted again. It then revokes that synthetic session once more.
Live recovery needs an explicitly reviewed policy for
invalidating/reissuing sessions, grants, authorization codes and pending OIDC
flows before restored services are exposed. No such policy is implemented or
activated by this fixture.

### Full-archive post-snapshot exposure matrix

`control-rollback-exposure.test.mjs` is a separate, explicitly opted-in negative
fixture. A passing result **demonstrates exposure**, not a safe invalidation
policy. It uses the same database/client/ownership guards as the recovery test:

```sh
TEST_CONTROL_ROLLBACK_EXPOSURE=1 \
TEST_CONTROL_RECOVERY_PG_BIN=/absolute/path/to/postgresql/bin \
node --test prototype/platform/control-rollback-exposure.test.mjs
```

The source is quiesced for a real T0 archive. Only after that archive is complete
does the fixture perform and verify these T1 changes on independent generated
identities:

- Browser logout: the old cookie no longer authenticates.
- OAuth family revocation: old access and refresh tokens are rejected.
- Refresh rotation with scope narrowing, followed by consumed-token replay: the
  older access token is rejected, and replay revokes the successor family.
- Authorization-code consumption: a second exchange is rejected.

It restores the unchanged T0 archive to a newly created database, compares all
12 tables and the sequence exactly, restarts the control modules, and verifies
the old authority becomes usable again. In particular, the older refresh token
recovers its T0 broader scope. Tokens minted only at T1 remain absent from the
restored database. Within the recovered timeline, subsequent logout, revocation,
refresh replay detection and authorization-code single use still work.

Negative controls preserve revocations and expired browser/code/family authority
already present at T0. Wrong PKCE, client, resource and redirect are rejected;
browser cookies and OAuth bearer tokens retain their separate authority. The
source's T1 fingerprint and the archive hash must remain unchanged through target
testing. Cleanup verifies the owned schema and restored database are gone before
emitting the bounded report. No raw tokens, row contents or archive bytes are
reported. Ordinary runs skip this test; CI explicitly opts into both fixtures.

This matrix uses direct generated identity seeding and never invokes its provider
adapter. Some of its 12 tables are intentionally empty; populated identity,
membership and OIDC-state restoration remain covered by the original fixture.
It does not test Dex, provider-side authorization codes, native-staff storage,
Events, courier sessions, a coordinated system snapshot or live recovery. The
report deliberately retains `postSnapshotRevocationProtected: false`. Any real
invalidation/reissuance procedure remains a separately reviewed operating policy
and implementation gate.

Also excluded: native-staff OAuth storage, provisioning/checkouts/event tables,
cluster-global roles and ACLs, a coordinated snapshot with restaurant databases
or media, production secret/key mounts, off-host encryption and retention, RPO,
RTO, deployed ingress and real account activation. Those require independent
acceptance even when this test passes.
