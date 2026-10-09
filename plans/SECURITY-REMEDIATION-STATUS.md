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
