# Saudi-only country policy — 2026-09-27

Scope: Saudi Arabia is the only country supported for new restaurant settings and delivery addresses. This is a development update, not a portable release.

## Policy and compatibility

- Customer checkout and saved-address forms no longer offer a country selector. New addresses use `SA`; administration displays the restaurant country read-only.
- The server rejects explicit foreign countries for new delivery quotes/orders, saved addresses and catalog settings. Missing country remains invalid for new API writes; existing legacy defaults are unchanged.
- All thirteen interface languages remain available. Menu content, payment gateways, currency settings, phone formats, taxes and delivery coverage rules are not changed by this update.
- Existing foreign records are not silently relabeled or migrated. They remain readable but are unavailable for a new delivery. A profile retaining an unsupported historical address must have that address explicitly removed before saving.
- An already accepted historical order can still be recovered using its original request and idempotency key. A new key cannot create a foreign delivery.
- SPL address resolution, a national city/district catalog and per-district delivery prices are not implemented by this change. A fixed country code is not geographic verification of free-text addresses or coordinates.

## Safety

- Pre-update private snapshot: `backups/completion-update.8weKsh` (directory 0700/files 0600; environment, PostgreSQL and recordings).
- Production checks before implementation found no foreign saved addresses. The existing catalog uses the legacy Saudi default without a database rewrite.
- Automated database/browser tests use only the disposable labelled `astracalls-completion-test-postgres` and `astracalls-completion-test-app` containers, loopback ports 15433/18083 and synthetic data.
- No real payment, refund, WhatsApp call/message or SPL request is part of this change.
- Existing portable installer/image/source artifacts and `deploy/release.json` remain out of scope.

## Verification results

- Frontend: `npm test` passed **61/61**; `npx tsc -b` passed; Docker's TypeScript/Vite build and unit tests passed.
- Focused PostgreSQL-backed Go race tests passed (9.717s), including historical foreign-order receipt recovery and unchanged persisted legacy addresses.
- The first full Go race run found one outdated payment/tax test fixture that still expected a new British delivery to succeed. Only that fixture was changed to Saudi Arabia; its monetary/tax assertions were preserved. Its focused rerun passed (1.202s). No application-runtime fix was required.
- Saudi-only browser harness passed **24 checks**, covering country rejection through direct APIs, checkout, profile addresses, administration, thirteen language choices, and a GET-only historical foreign-address fixture.
- Existing end-to-end browser harness passed **32 checks**, including cash-on-delivery, table orders, saved addresses, inclusive tax snapshots, QR transfer, exact retry identity, menu administration and all thirteen languages.
- Both browser harnesses ran against `astracalls-translation:0.5.1-dev-20260927-saudi`, using the isolated application. No browser runtime errors, external requests or administrator header leakage were observed.
- Mobile administrator and Arabic checkout screenshots reviewed: fixed Saudi country fields are readable, with no overflow or clipping. A focused Arabic checkout check also confirmed the localized readonly value and absence of a country dropdown.
- Final complete PostgreSQL-backed Go race rerun passed (`cmd/server`: **188.009s**; all other packages passed). The corrected test fixture does not alter the tested runtime binary.

## Deployment

- Deployed at approximately **2026-09-27 07:22 UTC** to `https://almujeeb.info`.
- Development image: `astracalls-translation:0.5.1-dev-20260927-saudi`.
- Image digest: `sha256:0cf11c568ff761beed5cd32e40238dad712cca2bfb1c979d8384bd5fc1dde666`.
- Immediate pre-deployment private snapshot: `backups/completion-update.UfOjtB`, in addition to the initial snapshot above. Active calls were zero before replacement.
- Changed only `.env` image/version pointers, then recreated the application using `--no-deps --no-build --pull never`. PostgreSQL was neither replaced nor restarted.
- Post-update verification passed **16 checks**: catalog, existing order/session/courier counts (`1 / 1 / 0`), session and gateway fingerprints, and all other environment settings remained unchanged. Application health is healthy with zero restarts.
- A read-only browser check on the public HTTPS site confirmed the Arabic checkout uses a fixed Saudi country, no country dropdown, no mobile overflow and no runtime errors. No production order was submitted.
- Archive capture/retention/AI and all seven payment providers remain disabled. No existing portable release was regenerated.
- After acceptance, only the two labelled disposable test containers were stopped and removed. Their tmpfs-only synthetic data was discarded; production, private backups, test scripts and screenshots were retained. Public HTTPS health stayed successful after cleanup.
- The previous development image `astracalls-translation:0.5.0-dev-20260927-completion` remains available for an application-only rollback; do not overwrite newer data with a backup without a separate recovery decision.
