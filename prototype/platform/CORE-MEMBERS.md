# Restaurant staff management

`/manage/{tenant}/members` is a browser-session/CSRF-protected view over the
existing identity directory. Customer OAuth cannot enter it. A person first
signs in through the configured verified OIDC issuer, then shares the opaque
account ID shown on `/manage` with the restaurant owner. No account is created
or linked by an entered name, email or phone. No invitation/email is sent.
Verify the account ID with its holder before granting access.

Owners or explicitly delegated membership managers can add an already verified
account, choose a role preset or granular permissions, set an internal display
alias, and enable/disable membership. New form defaults are kitchen role and
disabled membership for review. Aliases describe people within this restaurant;
they are not authentication claims and do not change the principal's identity.
Omitting `displayName` in an existing API update preserves its stored alias.

All writes retain optimistic versions, current actor authority, tenant locking,
non-escalation rules for delegated managers, and the last-enabled-owner guard.
Revoked membership is checked again on subsequent staff requests; previously
accepted in-flight signed core operations retain their short request lifetime.
Existing directory policy allows membership management during suspension to
support access removal, while closed tenants reject it. No restaurant master
key or service key is exposed to staff browsers.

## Storage and rollback

Additive startup migrations add `platform_memberships.display_name` and
`platform_identity_audit.details`, with empty defaults for historical records.
Membership audit snapshots record before/after roles, permissions, enabled state
and versions in the SAME transaction as the membership write. They record only
whether an alias changed, not the alias text, provider subject or login tokens.
Earlier audit rows are not retroactively attributed or reconstructed.

An application rollback can leave these extra columns in place; do not drop
columns or delete existing membership/audit records as a rollback shortcut.
Actual production schema execution remains a deployment approval gate.

## Verification

Tests cover unauthenticated login return, customer OAuth refusal, role/CSRF
checks, disabled onboarding, exact granular grants, version conflicts, alias
escaping/preservation, audit snapshots without alias text, and last-owner
protection with a non-success HTML status. Chromium exercises actual form
creation, granting read-only order access, disabling it and rejecting removal of
the last owner. These use generated verified test identities, not real accounts.
Remote verification is pending for this increment. Invitation links, account
recovery administration and native Flutter authentication remain separate work.
