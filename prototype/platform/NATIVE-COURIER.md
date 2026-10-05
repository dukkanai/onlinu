# Native courier identity and owned work

Status: local implementation and targeted acceptance passed; remote CI/Windows pending, not production acceptance. Dispatcher assignment
to existing courier accounts is already verified separately.

## Authority and identity

- Original courier account IDs are 32-hex; verified control-plane principals are UUIDs.
  Linking is explicit. Never infer a link from an email, name or telephone number.
- Add `couriers:link` for binding administration and `courier:read`, `courier:update`,
  `courier:collect` for the bound person's own work. These are separate from global
  dispatcher permissions and staff cash collection.
- New courier-role defaults use the three owned permissions. Existing memberships
  are not automatically expanded. Changes use the existing reviewed membership editor;
  older owners can explicitly review applying the complete current owner permission set.
- Only enabled, verified tenant members with `courier:read` are eligible targets.
  The link administrator needs `couriers:link`; platform-operator status is no bypass.
- Store a tenant/issuer-scoped principal hash in the original tenant DB, not login claims.
  One principal can bind to one courier account per tenant; one courier can have one link.

## Binding safety

- Versioned link/unlink commands and audit insertion share one transaction.
- Lock courier, then link rows. New/replacement binding is blocked while the account
  has active assigned orders; unlink remains available for immediate native revocation.
- A link does not create/reset a password or revoke the original password-based login.
  The review explicitly explains this. No actual account/permission setup is performed
  by development tests; all fixture identities and accounts are synthetic.
- Courier mutations recheck the current link inside the original order transaction,
  after the existing order/courier locks. A cached account ID cannot outlive revocation.
- Reuse original delivery transitions, payment gates, cash attribution and event/audit
  transactions. Cash confirmation is separate and cannot itself advance delivery status.

## Data and interface

- Show only the bound courier's unfinished assignments, with contact/address details
  fetched for a selected owned order. Never return receipt capabilities, account secrets,
  other couriers' tasks or global dispatch authority.
- Keep data in memory; clear/reject stale results on tenant, membership or link changes.
- Availability is an explicit own-account operation. Device location collection and
  live tracking are separate, opt-in work; this increment does not enable GPS.
- Preserve original courier login and management flows while adding the native path.

## Acceptance gates

Test distinct identities/tenants, duplicate bindings, stale versions, disabled accounts,
revocation races, active-order binding restrictions, audit rollback, owned-read privacy,
separate update/cash grants, delivery/payment gates, explicit UI review and no blind
write retries. Real device/OIDC/MFA, real staff-account binding, load/shared-NAT fairness,
signing and production rollout remain separate approvals/acceptance.

## Local verification (2026-10-05 18:50 UTC)

97 Flutter unit/widget tests and analyzer pass. 203 platform tests pass with the
isolated PostgreSQL identity database. `TestPlatformCourier*` passes under the Go
race detector, including audit rollback and a mutation queued across unlink.
A dedicated actual Dart PKCE/TLS→Node→Go/PostgreSQL test completes delivery stages,
refuses unpaid COD completion, separately confirms cash, finishes the owned task
and updates availability. Another courier's order remains unchanged. Browser API
CSRF, duplicate identities, busy rebindings, disabled/granular grants and revoked
native access are checked. Go vet/build pass. Windows renderer/build verification
is pending the feature branch CI, and real OIDC/device/merchant acceptance remains.
