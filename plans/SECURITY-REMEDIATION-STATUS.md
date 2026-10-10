# Native staff authority checkpoint — 10 October 2026, source CI accepted

A handler-level regression reproduced two non-courier native administration
mutations (profile and menu) dispatching after their originating OAuth family
was revoked while the request body was pending. The fix captures the original
token hash, principal, family and client internally, and checks that exact
authority with database-clock expiry at the final scoped mutation checkpoints.
Another family or a replaced request header cannot substitute. Membership writes
reuse their transaction connection after tenant-lock and target reads.

The 20 new deterministic handler regressions pass, with independent review and
66 focused passing tests (four database-dependent cases skipped in that review).
The subsequent targeted combined PostgreSQL run passed 259 tests without failures
or skips, including four actual HTTP delayed-body cases: profile/menu reject
revocation of the originating family and allow it when only another family was
revoked. Real OAuth revocation and database state are exercised; the signed
downstream restaurant transport remains synthetic. Exact commit
`e48fb4add81e196b98740f767446d5986584a90b` passed all four ordinary jobs in
[CI 38070787097](https://github.com/dukkanai/onlinu/actions/runs/38070787097).
The dedicated control recovery suite passed 40/40 without skips. Optional mobile
and runtime-image jobs were not run. The closure
is internal and is not returned in principal JSON. Browser authentication and
ordinary OAuth event grants retain their previous representation.

This closes tested invalidations completed before the final checkpoint; it does
not provide atomic revocation across concurrent database changes and a remote
core-service mutation. The original courier-cookie/session race is unchanged.
No new deployment or production-security acceptance follows from these tests.

# Review pointer — 10 October 2026

See [the current review and work order](PROJECT-REVIEW-20261010.ar.md) for subsequent
quote-binding, checkout-authority, MCP catalogue and tracking fixes and their
verification limits. External-key separation was subsequently verified in the
test deployments; rotation/recovery acceptance and live payment acceptance remain
separate gates. The courier-session issue below is still open and is not part of
the 10 October patch. This pointer does not turn historical test results into
production acceptance.

# Security remediation status — 9 October 2026

This is a partial code remediation on the restaurant/ChatGPT experiment branch,
based on `061cd4f722d329eb1a0dc38fda8d1503cb8e7a45`. It is not a production
security acceptance or deployment approval.

## Included boundaries

- Browser courier assignment checks both current order-read and assignment
  permission again after consuming the form and before signed core dispatch.
- Events subscriptions remain bound to their originating OAuth family or
  code-only session. Transactional revocation epochs prevent a pending order read
  or callback challenge from recreating revoked access. Queued generations also
  prevent old deliveries from crossing a later authorized subscription.
- Moyasar settlement requires coherent individual collected-payment evidence.
  Paid and capture-verified review attempts receive bounded, read-only follow-up
  reconciliation with durable failure recovery and independent refund-work time.

See [Events semantics](../prototype/platform/CORE-PAYMENTS-EVENTS.md) and
[payment evidence/reconciliation](PAYMENT-EVIDENCE-RECONCILIATION.md) for the
precise guarantees, migration behavior and limits.

## Remaining release gate

The original restaurant courier cookie-session revocation race is **not fixed by
this patch**. A request already authenticated before a password reset or logout
still needs transactionally current session validation at mutation time,
including cash collection and delivery-status changes. Existing courier
production code has not been changed in this partial remediation. That work and
its isolated concurrency regressions remain a security acceptance prerequisite;
passing the existing suite does not establish that this issue is resolved.

External payment/encryption-key separation and rotation, merchant acceptance,
live provider event delivery, and other documented launch gates also remain
separate work. No keys, deployed settings, live orders, provider transactions or
production databases are changed by these source and isolated-test changes.

## Compatibility and operational review

Existing Events subscriptions without an originating-grant binding fail closed
and require explicit resubscription after a separately approved deployment. No
active grant is guessed for an old subscription. Schema additions are additive.

The payment watch defaults are 30 days and a minimum 60-minute interval, with
bounded batches and validated application settings. These are configurable
engineering defaults, **not a commercially approved refund policy or a promise
of exhaustive refund discovery**. Deployment needs an explicit operating-policy
review of provider request costs, backlog, monitoring and outside-window work.
No deployment environment configuration is changed here.

## Verification boundary

New regressions establish rejection of permission changes during a browser
request, revocation during pending subscription work, expired or unrelated grant
substitution, stale queued generations, and concurrent independent delivery.
Tests use disposable PostgreSQL schemas and injected provider/callback traffic.
Final acceptance also requires the exact published commit's ordinary CI jobs;
local database passes do not substitute for browser, image and Windows checks.
