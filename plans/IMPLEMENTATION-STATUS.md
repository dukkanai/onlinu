# Product completion ledger

Owner-authorized direction, 2026-10-05: complete the existing restaurant SaaS
scope and decide implementation details autonomously. Work is performed directly
by the user's dot in its cloud computer, with no coding-agent delegation.
Existing production/security and external-account approval boundaries remain.

## Acceptance order

1. Repeatable isolated database tests, CI coverage and baseline fixes.
2. Connect the existing restaurant core to the platform/MCP without duplicating
   money, stock, delivery, tax or order state rules.
3. Owned checkout and order status, durable event integration and identity binding.
4. Restaurant registry/lifecycle, staff identity/roles, channel entitlements and
   isolation across API, database, files, jobs and events.
5. Complete Flutter management parity while retaining React management and all
   five customer templates. Windows validation precedes mobile distribution.
6. Provider-specific payment/refund and WhatsApp order integration; external
   account acceptance must be recorded separately from simulated test results.
7. Production readiness, transfer/rollback and release acceptance. No production
   deployment is implied by local progress or a pushed feature branch.

## Completed baseline

- Full authenticated Git checkout and private branch pushes verified.
- Exact pinned Saudi geography data restored with license/provenance and
  narrow packaging allowlists; focused test and 37 Python tests pass.
- Nine pre-existing Go formatting errors corrected (57d6677).
- Local PostgreSQL 17 installed in the cloud workspace, loopback-only synthetic
  cluster. First DB-enabled run: Go 549 passed/5 network-limited failures/1 native
  codec skip; tenant 8 passed; platform 108 passed without skips. Counts include
  nested tests and must not be presented as independent feature coverage.
- CI definition now prepares PostgreSQL 16, exercises DB cases and client tests.
  Local PostgreSQL 17 success is not proof of CI's PostgreSQL 16 outcome.

## Current increment

Original core adapter, contact-free cart preview and read-only core MCP mode.
See `prototype/platform/CORE-INTEGRATION.md`. Cross-language parity uses real
Go HTTP/PostgreSQL and SDK MCP, rather than mocked prices. This is not yet the
owned checkout/production identity phase. Tests and publication are recorded
when the increment is complete.

## External acceptance still required

- Actual ChatGPT account/Extensions/Events flows on an approved HTTPS origin.
- Merchant sandbox/provider agreements/credentials when integrating payments.
- Windows environment and signing/distribution credentials at packaging time.
- Production server access and explicit rollout confirmation. Existing product
  plans report historical staging at almujeeb.info; current live state has not
  been reverified or changed by this cloud-development work.
- Security/licensing and geographic-data gates in SAAS-LAUNCH-GATES.ar.md remain
  distinct from a successful source-data restoration.
