# Restaurant operations update — 2026-09-26

## Deployed on this server

- Site: https://almujeeb.info
- Application image: `astracalls-translation:0.4.0-dev-20260926-ops`.
- Runtime image version label: `0.4.0-dev-20260926`.
- This is a server development update, **not a new clean/portable release**.
- Private backup and deployment verification: `backups/operations-update.VTABdkjz/` (directory 0700; environment/database backups 0600). Never publish this directory.
- Only the application container was replaced. PostgreSQL container ID, start time and restart count were unchanged.
- Existing catalog version, all eight demo items, table identifiers/codes, WhatsApp session identifier, and translation configuration were preserved.
- The previous WhatsApp session remains logged out/unpaired. This update does not claim a successful WhatsApp call or fresh pairing.

## Implemented

- Independent courier accounts and scoped HttpOnly sessions; admin assignment/reassignment, availability, sequential delivery progress, explicit COD collection, and customer tracking.
- Country-aware delivery addresses; Saudi national-address fields are hidden and cleared for non-Saudi destinations.
- Admin branding preview, colors with contrast-aware text, logo/cover uploads and deliberate restore-to-defaults.
- Admin WhatsApp QR/Meta connection page; pairing, verification and QR logout require explicit actions.
- Per-mode payment policy: table cash-before/cash-after/card; delivery COD/card; pickup card only. Preparation is blocked when required advance payment has not been confirmed.
- Direct provider adapters and configuration for Stripe, Moyasar, Tap, HyperPay, PayTabs, Geidea and MyFatoorah. No WooCommerce/WordPress dependency.
- Tax-inclusive integer pricing and immutable gross/net/tax snapshots; inclusive tax is extracted, never added twice.
- All thirteen UI languages: 431 fixed labels including 178 new operations labels. Restaurant-authored menu content is not automatically translated.

## Verification completed

1. Full Go tests with race detection and disposable PostgreSQL: `go test -race -tags mlow ./... -count=1 -timeout=8m` passed. Server package completed in 183.023 seconds; voice/media/signaling/transport packages also passed.
2. Focused gateway/core tests used local fake transports only, including creation ambiguity, concurrent initiation, amount/reference/currency/mode binding, cancellation races and durable refund notification handling.
3. Regional refund tests passed, covering 36 provider scenarios plus an unpaid/no-network guard. No external merchant accounts were contacted.
4. Client tests: 46 passed, zero failures; TypeScript and Vite build passed. Vite reports a nonblocking bundle-size warning.
5. Browser tests ran against the actual read-only Docker image, as UID 10001, on an isolated loopback server and disposable database: 28 storefront/account/admin checks plus 29 operations/payment-policy/courier checks passed.
6. Additional browser checks confirmed Saudi address fields disappear and their values are cleared after country changes.
7. Independent visual review covered mobile English/Arabic branding, gateways, courier and tracking screens. Both reported issues were fixed and rechecked: translated upload controls and correct MyFatoorah/mode warnings.
8. Post-deployment checks: health, HTTPS routes, admin authentication, empty courier accounts, seven disabled/unconfigured providers, unchanged catalog/session/translation configuration and unchanged PostgreSQL lifecycle passed. Public mobile Arabic menu, admin login and courier login rendered without runtime errors or horizontal overflow.
9. `git diff --check` and syntax checks for both browser harnesses passed.
10. The isolated test application and disposable PostgreSQL containers were stopped and removed after verification; only synthetic test data was discarded. Production data, images, backups and test reports were retained.

## Explicit limitations and required activation work

- **No real merchant acceptance test has been performed.** Correct account credentials, provider activation and an end-to-end provider test are required before real customers pay. Every gateway remains disabled/unconfigured on the deployed server.
- Initial payment integrations are SAR-only. Test credentials are offered only in demo restaurant mode; live credentials only in non-demo mode. Selecting a mode does not transform PayTabs/Geidea live credentials into test credentials.
- HyperPay is deliberately **test-only** until its isolated hosted widget is validated with the merchant account. Its live checkout is unavailable.
- Stripe requires an eligible merchant account in a supported business country; do not assume a Saudi entity can open a local account.
- MyFatoorah requires an SAR-base account, including testing; a KWD-base demo account is not supported for these SAR orders.
- One durable attempt is allowed per order. Uncertain results are held for review; the application does not automatically initiate a second charge or issue refunds. Refund initiation is done in the provider dashboard.
- PayTabs refunds under a different `cart_id` cannot be discovered through the original-cart lookup. Such refunds require manual provider verification; complete automatic coverage would need a further verified refund-reference notification path. See `RESTAURANT.ar.md`.
- Pending notifications survive refresh throttling and are reconciled server-side. Browser return parameters never establish payment success.
- Provider secrets are encrypted, but their encryption key is stored in the same database: this does not protect against compromise of the entire database. Protect database access and backups accordingly.
- Tax remains disabled and the tax number blank until the restaurant supplies its applicable registration. No fictitious merchant registration was activated.
- Printed records are internal receipts, **not certified ZATCA e-invoices**. Formal ZATCA compliance is a separate merchant-specific implementation/validation step.
- Card-only pickup is intentionally unavailable until an eligible payment gateway is configured; cash table/delivery modes remain available according to restaurant policy.

## Portable artifacts intentionally untouched

`deploy/release.json` remains version `0.3.0`. No installer, portable source bundle or portable image archive was produced or replaced. The pre-existing 0.3.0 files retained these SHA-256 hashes, verified before and after deployment:

| Artifact | SHA-256 |
| --- | --- |
| Installer | `d8855fbeeae3aab0194c35a4a333c14a3caea9747f865fea2536304d691a7676` |
| Installer images | `5760c7e0449e0390ce8d725df952169462e870a1762ad980ae134e0524af1fe7` |
| Portable source | `d87a66b606b65a0d02d3b5a2918b5dbde1cbaa6c48ce0f5d305026ec6e428882` |

## Recovery

The previous image `astracalls-translation:0.3.0` and the private pre-update environment/database/recording backups are retained. If rollback is needed, restore the previous application image/version settings and recreate **only** the application service with `--no-deps --no-build --pull never`. Do not automatically overwrite the database with the older backup: migrations are additive and newer orders must not be lost. Inspect application/schema compatibility and current traffic first.
