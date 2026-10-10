# Control-plane recovery safety contract

Status: **full recovery policy remains unimplemented and inactive; bounded authentication and Events-storage preparation source/test increments are staged**.
Source review: `574cbdb30e1e9e9ede3438ea9c6a2d8ba3460a97`, 10 October 2026.

This document specifies the next source/test increment after the
[synthetic archive and rollback-exposure fixtures](../prototype/platform/CONTROL-RECOVERY.md).
It is not an operational restore script, an approval to change a live security
setting, or evidence that production recovery is safe. Read-only investigation,
documentation and authorized isolated source/test work can continue without a
new live-operation approval. The activation gates below apply to live actions.

The [staged preparation implementation](../prototype/platform/CONTROL-RECOVERY-PREPARATION.md)
covers offline auth invalidation, installed Events storage fencing,
target/configuration-bound receipts and isolated archive tests only. It is not
wired into startup and does not satisfy the full
acceptance matrix or authorize serving, Events APIs/workers or live recovery.

## 1. Verified source findings and evidence boundaries

Recorded baseline acceptance for the reviewed commit:

- CI run `38061870169` succeeded in all four normal jobs.
- The dedicated PostgreSQL 16.15 control archive/rollback checks passed 19 of 19
  tests with no skips, including the actual archive exposure matrix.
- Separate media recovery evidence covered 10 files, 22 references and 38
  relations. It does not expand this control-authentication contract's scope.
- No live deployment was performed. These are baseline checks, not tests of the
  unimplemented recovery barrier proposed here.

The following observations describe the reviewed source, not proposed behavior:

- `auth.mjs` stores browser and OAuth access sessions in `demo_sessions`,
  refresh families in `demo_oauth_grants`, refresh tokens in
  `demo_oauth_refresh_tokens`, and authorization codes in `demo_oauth_codes`.
  Acceptance uses their current database expiry/revocation/consumption state;
  there is no independent recovery generation. See
  [schema and validation](../prototype/platform/auth.mjs).
- The actual T0 archive/T1 mutation exposure fixture demonstrates that a restore
  can revive browser logout, OAuth family revocation, refresh consumption and
  scope narrowing, and authorization-code consumption. Its successful result
  intentionally reports `postSnapshotRevocationProtected: false`. See
  [the exposure fixture](../prototype/platform/control-rollback-exposure.test.mjs).
  This design review did not rerun that fixture or examine a live database.
- Pending OIDC state is stored in `oidc_login_states`. Completion consumes the
  row before awaiting the provider, then resolves the identity. The controller
  subsequently issues a browser session. An already-running completion is
  therefore a separate boundary from invalidating stored pending rows. See
  [OIDC flow](../prototype/platform/oidc.mjs) and
  [callback handling](../prototype/platform/control-plane.mjs).
- `verifiedIdentity` checks the trusted upstream issuer, but `resolve` and
  `enabledIdentity` currently select by principal ID and enabled status without
  checking the current trusted issuer. Changing upstream issuer configuration
  alone is not an invalidation mechanism for an existing application session.
  See [identity resolution](../prototype/platform/identity-directory.mjs).
- Native staff OAuth uses the same `demo_*` tables, with a distinct issuer and
  resource. Customer-only invalidation would be incomplete. See
  [native staff auth construction](../prototype/platform/native-staff.mjs).
- Events validate their originating family or code-only session through
  `authorizeEventGrant`, and have database-backed owner epochs, subscription
  generations, verification caches and deliveries of their own. Those records
  are also subject to snapshot rollback. See [grant validation](../prototype/platform/auth.mjs)
  and [Events](../prototype/platform/events.mjs).
- The current control server starts listeners and then workers after ordinary
  module initialization. It has no recovery preparation or readiness barrier.
  See [server lifecycle](../prototype/platform/control-server.mjs).

The existing archive fixtures do not establish native-staff recovery, Events
recovery, Dex recovery, old-process fencing, coordinated business-data recovery,
or safety of the original restaurant courier sessions. The
[courier-session release gate](SECURITY-REMEDIATION-STATUS.md) remains unchanged.

## 2. Proposed minimum policy: cold recovery with fresh authorization

Every recovered control-plane target remains isolated until all of the following
are complete:

1. Restore to a separately identified target; never overwrite newer source data
   merely to make a recovery test pass. Preserve the input archive unchanged.
2. Fence old application processes and workers. Block ingress, stop and verify
   their termination, and prevent reconnects or downstream dispatch from old
   instances. Drain or explicitly account for in-flight requests and external
   effects. A maintenance page, a changed password, or a stopped listener alone
   is not evidence that established database connections or workers are gone.
3. Invalidate **all** restored authentication authority, including unrevoked
   authority that was valid at snapshot time. Do not infer which old grants are
   safe from the restored snapshot alone.
4. Reconcile identities, permissions and tenant restrictions against trusted
   post-snapshot evidence, or obtain explicit restricted reapproval where that
   evidence is unavailable. Keep affected authority closed while uncertain.
5. Verify recovery preparation and authority review before enabling listeners.
   Keep Events and other external-effect workers off until their own acceptance
   and activation gates pass.
6. Require a new verified OIDC exchange and new OAuth consent/connection. Native
   applications also reconnect. Existing provider SSO may satisfy the new OIDC
   exchange; this is not a promise of a fresh password or MFA prompt.

Business records, identity IDs, exact issuer/subject bindings, tenant IDs,
memberships, client registrations and audit history are preserved. Revoked or
expired authentication rows may be retained for audit. The recovery operation
must not truncate identities, reset roles, silently enable tenants, remap email
addresses to old owners, or clear business queues to simplify acceptance.
Preservation does not mean granting old permissions before reconciliation.

A new login alone cannot repair a restored older membership removal, disabled
identity, revoked platform-admin role or tenant suspension. Reconciliation is a
separate gate, not an inferred effect of the authentication reset. Configuration
and allowed client/redirect policy also need review for post-snapshot changes.

## 3. Proposed implementation boundary

### Explicit target-only preparation

Implement a narrowly scoped administrative recovery-preparation operation,
separate from ordinary application initialization and unavailable over HTTP.
It accepts an explicitly named, verified recovery target and a fresh recovery
ID. It does not discover databases, create backups, restore archives, stop live
processes, rotate credentials, or change ingress on its own.

In one bounded transaction, it must:

- Expire every restored `demo_sessions` row, across both session kinds and all
  configured customer/native resources, including access sessions without a
  refresh family.
- Mark every restored `demo_oauth_grants` family revoked and every restored
  `demo_oauth_refresh_tokens` row unusable. Preserve their historical rows.
- Expire every restored `demo_oauth_codes` row.
- Invalidate every `oidc_login_states` row so it cannot reach provider exchange.
  If retaining rows, use a finite, parseable expiry and verify rejection through
  `complete`; do not assume a PostgreSQL special timestamp is safely comparable
  by JavaScript `Date`.
- Where Events storage is installed, fence its restored owner epochs and
  subscription generations, disable restored subscriptions, mark restored pending
  deliveries revoked, and expire callback-verification cache entries. Preserve
  subscription/delivery history and business cursors. The callback cache is keyed
  by owner/URL/secret rather than grant; invalidating OAuth alone cannot prove
  that a fresh explicit subscription will perform fresh callback verification.
- Record a bounded completion receipt containing recovery ID, target binding,
  configuration binding, implementation/policy version, covered auth/worker
  modules and affected counts.
  Never record raw tokens, authorization codes, PKCE verifiers or secrets.

The exact receipt schema and administrator identity representation must be
reviewed during implementation. Do not invent an application user or weaken a
foreign key simply to write an audit entry. Receipt persistence must not require
resetting the existing identity-audit sequence.

The transaction must either complete all invalidation and its receipt, or leave
none of it committed. Errors and uncertain outcomes leave the target closed.
Retries may verify and complete the same owned operation; they must not adopt a
different target or erase evidence. No `CASCADE`, destructive schema reset, or
automatic credential rotation is part of this operation.

### Recovery receipt and serving barrier

A trusted recovery/deployment record **outside the restored application
snapshot** supplies the expected fresh recovery ID and target binding. A receipt
restored from an older archive cannot satisfy a new recovery operation.

The startup barrier must run before authenticated listeners or workers start and
verify that the committed receipt matches that external expectation and the
configured security domain. Bind at least:

- Target/database identity and recovery ID
- Canonical application origin
- Customer and enabled native OAuth issuer/resource pairs
- Upstream OIDC issuer and client ID
- Policy version and reviewed authority-reconciliation outcome

Missing, stale, mismatched or incomplete state refuses serving. Ordinary startup
must never silently create, adopt or repair a recovery receipt. Provisioning a
brand-new empty deployment and migrating an existing deployment into the barrier
need explicit distinguishable initialization paths; neither may auto-adopt a
nonempty restored database. Normal restarts retain their accepted recovery ID.
If the implementation cannot prepare installed Events storage, it must record
that exclusion and keep both Events API exposure and workers disabled; a disabled
timer alone does not prevent a new subscription from using the restored cache.
Enabling a previously excluded module requires matching completed recovery
coverage and acceptance, not merely changing its feature flag.

The external recovery record must survive and remain outside the rollback scope.
If an operator restores both the database and this record to the same older
state, this design cannot independently detect the rollback. A fresh recovery ID
for each restore and controlled custody of that record are required assumptions,
not properties proved by an application-table checksum.

The barrier is a readiness condition. A database liveness response must not be
mistaken for permission to reopen ingress or start workers. An ordinary restart
must not rerun global invalidation and log everyone out again.

### Issuer and flow binding

Make existing-identity resolution and authorization honor the current trusted
issuer, including both `resolve` and `enabledIdentity`. Reject recovery when
the configured issuer/client/origin/resource binding differs from the approved
binding. Do not repair the difference by rewriting identity rows.

Preserve exact verified issuer/subject pairs. A replacement Dex subject, signing
configuration or client registration needs separate recovery review. Recovery of
the application's OIDC-state table does not establish provider-side code
consumption, provider sessions, credentials or Dex database correctness.

### Old processes and external effects

This minimum design assumes a cold recovery. A new startup check cannot constrain
an older binary that ignores it. Required operational fencing covers source and
target listeners, database connections, background workers, deployment replicas,
supervisor restarts and downstream service access. Any credential/security
setting changes used for that fencing require their own live approval.

Complete the shutdown before invalidation. In particular, a pending OIDC exchange,
refresh, OAuth consent request or worker may already hold authority in memory.
Stopping old processes prevents their late completion from minting new authority
after the reset. An already-dispatched external effect cannot be retracted by
invalidating a token; reconcile uncertain effects before restarting that work.

For Events, verify old originating grants fail and that restored subscriptions,
pending deliveries and callback-verification work cannot dispatch or become
authorized through another fresh connection. Do not auto-resubscribe on login.
An explicit new subscription must verify its callback again, bind to the fresh
grant and advance the subscription generation so old queued deliveries cannot
borrow that grant. Preserve business cursors and delivery history. The fencing
and cache invalidation above are mandatory for Events-covered recovery; missing
coverage keeps that module closed rather than silently treating it as safe.

## 4. Tradeoffs and non-goals

- Global invalidation trades reconnection and a maintenance window for a small,
  auditable safety boundary. Selective preservation requires trusted revocation
  evidence outside the restored snapshot and is not part of this proposal.
- An external authentication generation checked on every issuance, validation,
  asynchronous completion and worker dispatch is a possible later design for
  stronger online fencing. A generation stored only in the restored database
  rolls back too. Adding generation columns alone does not fence old binaries.
- Rotating the CSRF key or changing cookie names is not a replacement for access,
  refresh, code and pending-flow invalidation. Unrelated encryption/signing-key
  rotation is not required merely to invalidate these opaque database tokens.
- This proposal does not fix the original restaurant courier-session mutation
  race, authorize its denied remediation, restore Dex, reconcile provider money,
  define backup retention, or claim production RPO/RTO or production readiness.

## 5. Exact acceptance matrix for the next source/test increment

Use the existing owned, loopback-only, disposable PostgreSQL archive harness.
Create a separate explicitly opted-in safety fixture; a skip is not acceptance.
Use only generated secrets/data and simulated provider/downstream transports.
Never read a live archive or connect to a live identity provider. Retain the
existing negative exposure fixture as baseline evidence instead of changing its
meaning to make it appear safe.

| ID | Scenario | Required result |
| --- | --- | --- |
| R01 | T0 actual archive; independent T1 browser logout, family revocation, refresh consumption/scope narrowing/replay and code consumption; restore unchanged T0 | Existing exposure is reproduced before preparation; source T1 and archive unchanged |
| R02 | Prepare restored target, then present every T0 browser and OAuth access token, including never-revoked and code-only sessions | All rejected; no new sessions or side effects |
| R03 | Present T0 refresh tokens from unrevoked, revoked, consumed and narrowed-scope families | All rejected; no successor access/refresh token and no recovered broader scope |
| R04 | Exchange T0 pending and T1-consumed authorization codes with otherwise valid client, resource, redirect and PKCE | All rejected; no token minting |
| R05 | Complete restored pending OIDC state with correct binding cookie and callback | Rejected before simulated provider exchange; wrong binding and repeated completion also fail |
| R06 | Native staff access, refresh and authorization-code rows coexist with customer rows | Both resource domains are invalidated; no profile is silently excluded |
| R07 | Restored Events family-bound and code-only subscriptions, queued deliveries and callback verification, including T0 cache removed by T1 revocation | Old work cannot dispatch; new login alone never revives a subscription; explicit new subscription requires fresh callback verification and a fresh grant/generation; uncovered Events API and workers remain disabled |
| R08 | Missing/stale recovery receipt or wrong recovery ID, target, origin, upstream issuer/client or OAuth issuer/resource | Startup refuses serving and workers; zero external dispatch |
| R09 | Fault injected after each preparation statement, including immediately before receipt/commit | Atomic rollback or verified full commit; never partial invalidation with serving permission |
| R10 | Cancellation, uncertain commit result, retry, unexpected target or target ownership change | Closed state; bounded verification of the same operation only; unknown targets untouched |
| R11 | Ordinary restart after successful recovery; repeat same owned preparation | Restart does not invalidate newly issued sessions; retry is explicitly idempotent or refuses after activation without mutation |
| R12 | Restore an archive again with a newly allocated external recovery ID | Previously committed/archived receipt cannot reopen service; preparation must run for this restore |
| R13 | Existing identity from now-untrusted upstream issuer; old subject with matching email at a different issuer | Existing-session resolution/authorization denied; no identity rebinding or role adoption |
| R14 | T1 disabled identity, removed membership/admin role, tenant suspension absent from T0 | Authentication reset alone is not reported as reconciliation; serving remains blocked until reviewed evidence/reapproval is applied |
| R15 | Post-preparation new verified login, approved current membership, fresh customer/native consent | Fresh authority works; browser/OAuth separation, disabled-account and cross-tenant checks remain intact |
| R16 | Fresh grants: wrong PKCE/client/resource/redirect, code reuse, refresh reuse and scope narrowing | Existing rejection, single-use and family-revocation guarantees remain intact |
| R17 | OIDC exchange paused after local state consumption; refresh/consent and Events work paused in old process | Cold-recovery orchestration terminates/fences old process before preparation; old work cannot issue or dispatch afterward |
| R18 | Unmodified older binary/replica and supervisor restart attempt | Separate process/network acceptance proves no reachable old listener, database reconnect or downstream dispatch; a unit-test gate is insufficient evidence |
| R19 | Before/after data fingerprints and sequence checks | Source T1 and archive unchanged; target business/binding rows and audit sequence preserved except explicitly reviewed authority reconciliation; intended auth and Events-fencing mutations identified |
| R20 | Fresh empty installation versus nonempty legacy/restored target | Explicit initialization paths are distinguishable; normal startup cannot auto-adopt a restored database |
| R21 | Failed child assertion, fixture timeout or cleanup ownership mismatch | No success-shaped report; bounded cleanup touches only proven owned resources; uncertainty is reported |

R17 needs process-level tests with controlled paused operations. R18 additionally
needs deployment-specific isolated fencing acceptance and later live verification;
an injected function or stopped mock is not equivalent. R14 can test the barrier
and reconciliation contract with synthetic evidence but cannot prove a live
operator has reconstructed missing historical changes. Include no raw tokens,
row values, archive bytes or private runtime logs in test artifacts.

Run focused unit/database tests, the actual opted-in archive matrix, affected
native/Events regressions and the repository's applicable aggregate checks.
Record passed, failed and skipped scopes separately for the exact final commit.
Do not infer live readiness or courier remediation from a green aggregate.

## 6. Live activation gates and ownership

Before any live security-changing action, obtain per-action approval naming its
target, exact change and consequence. Approval for project source work, review or
isolated tests is not approval to invalidate live sessions, rotate credentials,
change access controls, restore a live database, change routing or deploy.
Any separately required backup/restore or other consequential authorization also
remains necessary; this document does not change existing restrictions.

The activation review must establish:

1. Named operator, recovery target, selected archive and agreed data-loss boundary;
   preservation of newer data and the original archive, with no implicit backup
   or snapshot operation.
2. Approved maintenance/cutover window and explicit acknowledgment that all
   application browser, customer OAuth and native connections must reconnect.
3. Verified old-instance/connection/worker fencing and control of restart paths;
   separate approved handling for any credential, persistent-access or network
   changes used to achieve it.
4. Trusted custody of the external recovery record and a new recovery ID, with
   exact target/configuration binding and an auditable readiness decision.
5. Reviewed post-snapshot identity, platform-admin, membership, tenant and client
   policy reconciliation, including the restricted treatment of missing evidence.
6. Independent Dex/provider identity and credential acceptance when relevant;
   exact issuer/subject continuity and no email-based repair.
7. Exact-commit test evidence, including native/Events coverage where enabled and
   deployment-specific old-binary fencing; unresolved scopes remain closed.
8. Explicit handling of uncertain external effects and worker resumption. Keep
   queues and business evidence, and avoid automatic replay of already-sent work.
9. Startup and post-cutover checks of receipt/readiness, rejection of safely
   generated old canary authority, new verified login and current authorization;
   no raw credential capture in reports.
10. A stop/rollback plan that keeps the fence intact. Reverting code or restoring
    another archive must not reactivate old authority or overwrite newer data.

The staged v2 preparation increment adds explicit Events storage coverage,
callback-cache expiry and subscription/delivery fencing. It does not implement
the startup barrier, authority reconstruction, process/old-binary fencing or
the full acceptance matrix. Further bounded source implementation and isolated
acceptance remain necessary. Deployment and live recovery are distinct decisions. The
original restaurant courier-session gate remains open and outside this work.

## 7. Design review record

Independent read-only review completed on 10 October 2026 against the source
commit named above. It identified the need to invalidate the restored Events
callback-verification cache and gate inline subscription APIs as well as workers.
Those requirements are incorporated into preparation, receipt coverage and R07;
the updated contract was rechecked with no remaining implementation-blocking
findings. This records design consistency, not implementation or live readiness.
Documentation checks verified relative links, ordered unique cases R01–R21 and
whitespace. No runtime behavior was changed or runtime test rerun for this file.
