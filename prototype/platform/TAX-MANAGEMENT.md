# Reviewed original tax configuration

This management increment configures the original restaurant's tax-enabled flag,
rate in basis points and merchant-entered registration text. It does not determine
a legal rate, verify a registration, issue a certified electronic invoice or
introduce another pricing engine. No real registration identifier is used in tests.

## Preservation and authority

- Original prices are gross/inclusive. Changing the configuration does not add
  a percentage on top of menu prices, rewrite existing order/refund snapshots or
  change any unrelated menu, stock, delivery, payment, appearance or table setting.
- A complete reviewed tuple and current catalog version are required. Explicit
  false and zero remain distinct from omitted fields. Original catalog validation,
  row-lock compare-and-swap and transactional actor audit are reused.
- Signed scopes are `staff:tax:read` and `staff:tax:update`; an order/customer scope
  or the general profile scope cannot invoke them. Shared browser/native staff
  writes require current `settings:read` plus `settings:update`, rechecked after
  reading the body. Suspended tenants cannot modify this configuration.
- The narrow read projection omits payment secrets, contact data and table tokens.
  Registration text appears only in the appropriate settings UI and the original
  customer financial snapshots; it is not newly logged or included in audit text.
- Reviewed-quote binding forces an unconfirmed checkout to obtain a fresh
  review if its tax details changed, even when its gross total stayed the same.

## Interfaces

`/manage/{tenant}/tax` offers read-only access when appropriate and separates
form review from checked execution. CSRF and same-origin protections remain.
Unknown outcomes redirect to a fresh GET, without automatic write replay.

The Flutter tax section binds the review to tenant and version, resets approval
when fields change, hides private form contents on lost access/backgrounding and
refuses stale/offline/busy writes. A lost response refreshes current configuration.
Native and browser percentage inputs use exact integer basis points and accept
Arabic digits; they do not use floating-point multiplication for posted rates.

## Evidence and remaining gates

Local 136 Flutter tests, analyzer, 230 platform tests with PostgreSQL, React 80
tests/build and Go vet/build pass. Focused original PostgreSQL/race tests verify narrow preservation, inclusive totals,
unchanged historical snapshots, missing-review/scope denial, stale edits and audit
rollback. Actual Node → Go and central browser-session HTTP cover explicit review,
CSRF, read-only membership and suspension. Actual Dart TLS/PKCE through Node and
Go exercises update, stale denial, explicit false/zero and restoration of the
synthetic configuration. New widget/controller and transport tests cover review,
privacy, invalid values, changed results and unknown outcomes.

Actual Chromium review/cancel/unchecked/checked execution and a Windows tax-review
screenshot are included in remote CI, and passed all jobs of [CI37398729778](https://github.com/dukkanai/onlinu/actions/runs/37398729778)
on `941056bbd6f35db91144c0d98ba63c256b62d838`. The Arabic Windows
tax-review screenshot was inspected; reviewed facts and controls are readable
without clipping. Full SaaS, legal/invoice requirements, actual accounts/devices and
production rollout remain separate release gates. No production tax setting,
real merchant identifier, payment or external account was changed.
