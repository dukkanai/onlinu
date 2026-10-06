# Private provisioning intent journal

`provisioning-journal.mjs` is a durable PostgreSQL journal for a future trusted
operator/executor path. It is not wired to public HTTP/MCP routes or automatic
control-server startup. It never calls Docker, reads or generates credentials,
activates a tenant, publishes a runtime URL, provisions a service or deletes an
external resource. Initialize it only after the existing identity directory.

## Authority and immutable request

Every operation requires a currently enabled `platform_admin` identity in the
existing directory. Restaurant ownership and staff permissions confer no such
power. The caller must already have authenticated that identity; accepting an
actor UUID from an HTTP request body would not authenticate it. Mutations hold
a shared identity row lock, then tenant and journal row locks in consistent
order. Enable/admin revocation is rechecked on each operation.

An initial request contains only a canonical request UUID, tenant ID, expected
tenant version and lowercase plan SHA-256. No free-form command, URL, filesystem
path, secret value or environment map is accepted. The tenant must be a current
draft. Identical requests replay the original outcome; a reused UUID with a
different actor or request tuple conflicts. There can be only one non-cancelled
initial intent per tenant, including uncertain or succeeded intents.

The journal stores a plan reference, not the artifact itself. A future executor
must resolve a trusted reviewed artifact, recalculate its digest, verify the
artifact's tenant/version binding and bootstrap asset, and check all gates in
`deploy/TENANT-COMPOSE.md` before effects. The journal alone does not prove that
an arbitrary digest corresponds to the correct artifact.

## States and fencing

- `queued`: no execution claim. Explicit cancellation may record `cancelled`.
- `claimed`: one operator and worker UUID hold a bounded database-clock lease.
  Each heartbeat/callback must match the journal version and worker identity.
  Completion and renewal also check the live lease in the SQL update itself.
- `unknown`: an explicit uncertain result or expired-lease handling. It is never
  automatically retried or reclaimed. A new request cannot bypass it.
- `succeeded`: a trusted operator/executor recorded an evidence digest. This does
  not automatically activate the tenant or verify the external evidence.
- `cancelled`: journal disposition only; no container, volume or database is
  removed. A cancelled queued intent permits a new reviewed request while the
  tenant remains a matching draft.

An operator can reconcile `unknown` with an evidence digest to requeue, accept
or cancel. Requeue clears the old worker claim and increments the version; old
callbacks remain fenced. Accept/requeue require the original current draft
version. Cancellation can account for an unknown outcome even after tenant
closure, but must not be mistaken for physical resource cleanup.

There is no built-in polling worker, expiry timer, public promotion endpoint or
implicit retry. `get` is read-only, including for expired work. An evidence hash
is an attestation reference, not a substitute for trusted inspection of external
state. Side effects and a database transaction cannot be made atomic by this
journal; uncertainty is deliberately retained for reconciliation.

## Transactional audit and verification

Every state change writes `platform_identity_audit` in the same transaction.
Audit failure rolls back the change. Audit details contain job/digest/version/
state/worker references, not secrets or arbitrary error text. No membership or
tenant status is changed by this module.

Local PostgreSQL tests cover idempotency, competing requests and worker claims,
stale versions, expiry, late callbacks, evidence-required recovery, privilege
revocation, tenant closure, queued cancellation, rollback and reopening. The
full platform suite passes 243 tests without skips, and related actual-main Go
race tests still pass. Commit `33f15a4` passed all four ordinary jobs in
[CI37427159676](https://github.com/dukkanai/onlinu/actions/runs/37427159676);
the opt-in image job was intentionally skipped. These are
synthetic database tests, not live provisioning or deployment acceptance.
