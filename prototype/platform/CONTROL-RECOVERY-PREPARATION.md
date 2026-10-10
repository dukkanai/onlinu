# Staged control authentication and Events recovery preparation

Status: source/test increment only. `control-recovery.mjs` is not imported by
ordinary startup, HTTP handlers, workers or deployment configuration. It does
not permit serving. The broader [safety contract](../../plans/CONTROL-RECOVERY-SAFETY.md)
remains the activation gate; the original courier-session denial is unchanged.

## Narrow API and receipt

`controlRecoveryBinding(configuration)` accepts an explicit non-secret security
configuration: HTTPS origin, exact canonical upstream issuer/client ID, customer
redirect allowlist, native staff/mobile switches, `eventsEnabled: false` and an
explicit `eventsStorage: 'absent' | 'installed'` declaration.
It derives customer/native issuer/resource pairs, deduplicates/sorts redirects,
and rejects ambiguous or unsupported configuration. Do not pass credentials.

`prepareControlRecovery({pool, expectation, configuration, signal})` is an
administrative module API with no HTTP or command-line entrypoint. The caller
supplies an already identified target and explicit expectation containing:

- A newly allocated UUID recovery ID and exact `cold-authentication-events-preparation-v2`
  policy version
- Database name, database OID and owner OID, a fresh database ownership comment
  `onlinu-control-recovery:<uuid>`, schema name/OID and schema owner OID
- The independently approved security binding, compared with current configuration
- An external operator reference; reviewed authority-reconciliation reference and
  evidence digest; cold-fencing reference and evidence digest

These are bounded assertions by the caller, not proof of administrator identity,
reconstructed authority or actual fencing. Names, OIDs, comments and receipts can
be copied/rolled back; they are not globally unique or independently trusted
cluster attestations. The expected fresh recovery ID and marker must have trusted
custody outside rollback scope, and the caller must select/verify the database
connection independently. Never reconstruct expectations from a restored receipt.
The module neither creates the ownership marker nor discovers/adopts targets.

After exact catalog binding checks, a bounded transaction serializes preparation,
locks the five authentication tables, expires every browser/OAuth access session,
revokes every refresh family, consumes/expires every refresh token, expires every
authorization code, and sets every pending OIDC state to a finite 1970 expiry.
No resource/profile filter can accidentally omit code-only or native authority.
Rows remain present. Actual Events storage must match the explicit binding before
preparation, same-ID retry or receipt verification. An absent declaration rejects
any `event_*` relation other than indexes; installed storage requires exactly the
four supported permanent ordinary tables. Partial/unknown tables, views, foreign
tables, unlogged storage, inheritance/partitions, row-level security and user
rules/triggers fail closed. This is a bounded catalog check, not complete schema
attestation, migration or runtime compatibility verification. It still assumes
the trusted, reviewed schema and separately fenced DDL writers.

For installed Events storage, the same transaction locks the four tables, adds
missing owner-epoch rows for subscription/cache owners, advances all owner epochs,
advances all subscription generations and disables every subscription, marks only
pending deliveries revoked with a finite completion timestamp, and expires every
callback-verification entry. Existing inactive subscriptions and epoch-only owners
are included. SQL/constraint errors or counter overflow abort the transaction;
no counter is reset or wrapped. Subscription bindings, secrets and timestamps other
than `updated_at`, delivery bodies/attempts and all terminal delivery rows remain
unchanged. The business-ingestion cursor is not reset. The operation does not
decrypt secrets, send callback traffic, verify external effects or resume workers.

A separate receipt table stores only the bounded expectation,
configuration/policy/implementation binding, digest, completion time and affected
row counts. No raw tokens, codes, PKCE values or secrets are recorded. Identity
records, memberships, client registrations, tenant records and identity-audit
history/sequence are not changed. There is no identity-audit FK workaround.

Connection acquisition, statements, lock waiting and rollback are bounded.
Cancellation/errors remain closed. A lost COMMIT acknowledgment is reported as
`recovery_commit_uncertain`; it is not reported as rollback or success. Retrying
exactly the same owned operation verifies its committed receipt or performs the
transaction if none committed. Concurrent identical first requests serialize.
Same-ID retries do not invalidate sessions issued after preparation. Reuse with a
changed configuration, target, operator/review/fence record or policy is refused.
V1 receipts and expectations are unsupported, not silently upgraded or accepted
as Events coverage. A newly reviewed operation needs a fresh external recovery ID
and explicit target/storage binding; existing receipt history is retained.
A different operation is never silently substituted on error.

`verifyControlRecoveryReceipt({pool, expectation, configuration, signal})` is a
read-only prerequisite check, with no schema initialization or repair. Missing,
malformed, mismatched or unsupported receipts fail closed. The successful result
explicitly records `scope: authentication-preparation-only` for absent Events
storage or `authentication-events-preparation-only` for installed storage,
`servingAuthorized: false`, `eventsSupported: false`,
`processFencingVerified: false` and `authorityReconciliationVerified: false`.
The strict `eventsCoverage` is respectively `absent` or `fenced-storage-only`.
`eventsSupported: false` means Events serving/activation remains unsupported by
this prerequisite check, even when its stored authority was prepared. Counts
cover each authentication table and, when installed, each Events table plus
`event_owner_epochs_inserted`; the owner count includes inserted rows and the
delivery count includes only formerly pending rows. Counts contain no row data.

## Acceptance and remaining gates

`control-recovery-safety.test.mjs` has a separate explicit
`TEST_CONTROL_RECOVERY_SAFETY=1` opt-in. It uses the existing owned, loopback-only,
bounded archive harness with generated data and simulated provider exchanges.
A skip is not acceptance. The fixture covers:

- Genuine T0 archive, independent T1 revocation/consumption/narrowing, and separate
  T0 restore; revived authority observed before preparation
- Old browser, customer OAuth, code-only and native OAuth authority rejection;
  pending OIDC rejection before the provider exchange; fresh verified login/consent
- Rollback after every preparation statement, cancellation, target-marker changes,
  concurrent first preparation and uncertain COMMIT recovery
- Exact retry preserving fresh authority; mismatched expectations refusing access
- A second actual archive containing a receipt, separately restored with a fresh
  external recovery ID; the archived receipt cannot satisfy the new expectation
- Unchanged newer sources/archives, retained identity/tenant/member/client records
  and identity-audit sequence, and ownership-verified cleanup

This is not full native application recovery acceptance. It exercises native
tokens in shared tables without enabling signed business APIs. It does not prove
Dex recovery, old-binary/supervisor/process/network fencing, already-dispatched
external effects, reconstruction of post-snapshot authority, initialization or
migration paths, actual server readiness, ingress cutover, business queue recovery,
or live rollback resistance. Those scopes remain closed. The module assumes a
cold, trusted-schema target; cooperating transaction locks do not fence an older
binary or a privileged administrator changing catalogs concurrently.

`control-events-recovery-safety.test.mjs` has a separate explicit
`TEST_CONTROL_EVENTS_RECOVERY_SAFETY=1` opt-in. It extends synthetic archive
acceptance with real family-bound and code-only Events grants and simulated
callback transport. It checks restored cache exposure, atomic preparation,
strict coverage, exact retry, history/cursor preservation, fresh-login
non-reactivation and explicit same-URL/same-secret resubscription with a fresh
challenge, grant and generation. The existing negative exposure fixture is
unchanged. These are isolated storage/authorization tests, not operational
old-worker/process fencing or provider-side acceptance.

Events APIs and workers must remain unavailable until the full serving and
operational acceptance gates pass. Turning workers off alone is insufficient
because callbacks can occur inline through APIs. A caller's
`eventsEnabled: false` declaration is not runtime enforcement; this staged module does not
activate or configure the application. Fresh login never automatically
resubscribes; the isolated fixture's explicit new subscription is test activity,
not an activation path added by this increment.

The separate identity-directory change rejects stored principals from retired
issuers during resolution/authorization and prevents counting retired-issuer owners
as trusted last-owner replacements. Exact issuer/subject rows are preserved.
Known adjacent inconsistency: courier candidate eligibility still advertises an
enabled identity from a retired issuer. Actual identity authorization now rejects
it, but new linking can still select it. That path and the separate original
courier mutation race were deliberately untouched; deployment requires their
separate scope/security review.
