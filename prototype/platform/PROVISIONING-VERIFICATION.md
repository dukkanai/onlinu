# Stable runtime and authentication verification

`createProvisioningVerification` joins the shared read-only runtime probe,
a trusted bounded authentication capability and immutable evidence store into
one private verification step. It does not claim operator authority, acquire a
host lock, apply configuration, activate tenants or generate credentials. The
runner/caller must retain live journal fencing and host exclusion around it.

The step snapshots the known job/runtime binding, accepts only claimed or
explicitly unknown attempts, and observes the exact owned healthy runtime.
Authentication receives only the validated tenant ID and loopback port; the
trusted capability owns credential access and bounded HTTP behavior. Both valid
credentials and rejection of incorrect credentials must be confirmed explicitly.
Extra fields or ambiguous results fail closed and cannot become evidence.

A second full runtime observation must return the same container and image IDs.
This prevents a restart/replacement during authentication from producing a
receipt for the wrong container. It is not proof of future health or an atomic
snapshot against a compromised Docker host. The first result is copied before
awaiting the authentication call.

Only after these checks does the step write the bounded private evidence receipt,
read it back, verify exact report/source/job/worker bindings and independently
check its canonical hash. Results are deeply frozen and exclude arbitrary daemon
or authentication diagnostics. Cancellation, failed reads and lost write replies
produce sanitized failure, never an automatic retry, deletion or activation.
A receipt may exist after an uncertain response; explicit reconciliation is
still required before claiming a journal outcome.

The real journal/Docker fixture now uses this verifier for both successful
attempts and explicit lost-reply reconciliation, with the existing bounded
loopback status requests and a fresh evidence-store reader. Its fixture scope,
synthetic credentials and image/path overrides remain explicit. A production
credential/manifest supplier and deployment approval are not implied.

Six focused groups pass locally: exact durable binding, failed/ambiguous auth,
replacement during authentication, attempt/state mismatch, substituted receipt,
lost write reply and cancellation. Four existing fixture guards also pass.
Remote actual Docker acceptance for this increment is pending.

Stable-verifier acceptance: `813e69264da0997021bd6a8532afd22bbdbc50a9`
passed all five jobs in CI37548290444, verified 2026-10-06 23:54 UTC on standard
hosted runners after the authorized public conversion. Actual Docker success and
unknown-reply reconciliation passed the shared before/auth/after verifier. Four
runtime reports were inspected and both immutable receipts independently rehashed
and source/identity-bound. Synthetic local image ID:
`sha256:4397c735dd2d24de4b7495e0cbf5aa4696622ed37ab259b4ebca98d1125de043`.
No production credential, activation, registry publication or deployment occurred.
Local platform236 tests passed with12 DB skips; remote database/Windows/full-image
checks passed. Production manifest/secret supply and release gates remain open.
