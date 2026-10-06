# Configured checkout payment methods

The signed original-core `/platform-api/staff/payment-methods` view and patch
expose only configured checkout choices by service mode, catalogue version,
currency and demo flag. No provider credentials, merchant identifiers, callback
secrets, customer records, payment attempts or private configuration are returned.

- Read requires `staff:settings:read`; write requires `staff:settings:update`.
  The browser/native staff API checks current `settings:read` and, for writes,
  `settings:update` again after reading the request body.
- A write specifies one mode, exact expected catalogue version and explicit
  method list. Missing/null lists, duplicate choices, unknown fields and methods
  outside the original mode contract are rejected.
- Existing contracts remain: delivery supports cash on delivery/card; pickup
  supports card; table supports cash before/cash after/card. Enabled services
  cannot have an empty configured list. An explicitly disabled service may.
- Original `SaveCatalog` performs version checks, validation and transactional
  actor audit. Other modes/settings, provider configuration, existing order
  snapshots, payment state, tax, price and stock are not rewritten.
- Configured card does not mean a working payment provider. The original quote
  path still filters against eligible configured providers, currency and demo
  mode. No charge, refund, provider connection or credential change is triggered.
  Disabling a usable method can leave checkout unavailable when remaining card
  providers are unconfigured; the future review UI must explain this distinction.
- An inconsistent acknowledgement is uncertain and is never retried as a fresh
  mutation. Native transport shares the same scoped endpoint; no Flutter or
  browser management form is included in this API increment yet.

Local validation: pure Go input checks, Go build/vet and 36 focused Node tests
pass. The broader local platform suite passes 204 with 12 database-dependent
skips. PostgreSQL tests cover immutable historical orders, unchanged unrelated
settings, original provider-availability filtering, stale edits, disabled-service
empty lists and audit rollback. Actual signed native-to-Node-to-Go read/write,
stale/invalid/revert regression is added to CI; remote acceptance is pending.

The first CI run,37483820446, failed the new PostgreSQL readiness assertion
because the shared test fixture enables a synthetic card provider by default.
The test now explicitly clears that callback for its unconfigured-provider
scenario, then re-enables a synthetic callback to check the positive case.
Production availability logic and assertions are unchanged. The other three
ordinary jobs passed; corrected database/aggregate acceptance is pending.
