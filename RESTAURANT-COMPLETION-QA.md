# Completion-round verification — 2026-09-27

Scope: advanced restaurant appearance, optional courier location, QR conversation archive, stock, cancellation/complaints, refund ledger and concurrency protection. This report describes the development installation, not a new portable release.

## Isolation and safety

- Production snapshot taken before changes: `backups/completion-update.D4UPpE`, directory 0700/files 0600. It includes PostgreSQL, recordings and the private environment; never distribute this directory.
- Tests use `astracalls-completion-test-postgres`, PostgreSQL 16, loopback port 15433 and tmpfs data. Database tests require the exact `astracalls_restaurant_test` database and create independent schemas.
- Browser harnesses are hard-bound to `http://127.0.0.1:18083` and a synthetic administrator credential. No production catalog, customer, courier or order is used as a fixture.
- Provider transports and OpenAI requests are mocked. No real payment, refund, WhatsApp message/call, or summary request is an acceptance-test result.
- New archive capture, retention and AI features default off; existing payment configuration must remain unchanged.
- Existing clean installer/image/source artifacts and `deploy/release.json` are not updated in this round.

## Automated checks

Commands:

```sh
bash scripts/restaurant-completion-go-test.sh ./... -count=1 -timeout=10m
cd client
npm test
npm run build
```

First complete PostgreSQL-backed Go race run passed (`cmd/server`: 181.916s); the final complete rerun passed in 204.805s. Focused reruns passed after review fixes: stock/order/support 6.692s; refunds/payments 5.026s; archive 2.894s; location/courier HTTP 37.3s; branding 1.330s. Frontend: 58/58 tests passed, TypeScript and Vite build passed, including the final Docker build.

Coverage includes:

- Last-item checkout races, simultaneous initial stock configuration, retry identities, no duplicate release and prepared-food waste accounting.
- Cancellation versus preparation, persistent support request identity, ownership checks, complaint decisions and unchanged original monetary/tax snapshots.
- Twenty concurrent refund creations/dispatches, one provider POST, partial/full limits, explicit authorization, unknown financial outcomes, read-only reference recovery and manual-versus-provider confirmation.
- Header-only recording downloads, archive defaults, deduplication, original/summary expiry, legal holds and complaints, tombstones, text-only `store:false` AI contract and concurrent manual-edit protection.
- Private message spool durability and edit generations; leased Chatwoot FIFO and delivery tombstones. External side effects are at-least-once, not guaranteed exactly-once.
- Location ownership, CSRF, timestamp/accuracy bounds, expiry, reassignment, and stop-versus-in-flight-publish fencing.
- Single-active database ownership, release, independent namespaces and fail-closed response to ownership-connection loss.
- Thirteen complete dictionaries (657 total keys, including 226 new labels), placeholder parity, RTL behavior helpers and brand validation.

## Operational limits

- Automatic refund initiation is implemented for Stripe, Tap, PayTabs and MyFatoorah only. Moyasar, Geidea and HyperPay use explicit manual reconciliation. No live merchant acceptance has been performed; see `RESTAURANT-REFUNDS-QA.md`.
- PayTabs cannot discover an external refund made with a different cart ID using the original-cart query alone. An uncertain refund POST is never blindly retried.
- QR archive only; Meta archive and speech-to-text are not implemented. QR call recording contains remote original plus sent audio, which may be translated. AI summaries only receive available text.
- Old recordings remain private and are not mass-deleted. Failed call indexing preserves its private file without automatic reindexing. Message spool replay does not reconstruct every external webhook/Chatwoot insertion lost during a database outage. See `CONVERSATION-ARCHIVE.ar.md`.
- Archive retention does not erase independent backups, administrator downloads or external Chatwoot copies. Legal holds need explicit release.
- Courier tracking is opt-in, latest-point-only, and not guaranteed in the browser background. OSM tiles are loaded only after consent and require compliance with their service policy.
- Refund tax allocations are internal records, not certified ZATCA credit notes. Store receipts are not certified e-invoices.
- Instance ownership provides single-active operation, not active-active clustering or uninterrupted failover.
- Vite reports a non-fatal large-client-chunk warning; optimization is separate from functional acceptance.

## Browser and deployment results

All five browser suites passed on the final image (126 assertions):

| Harness | Checks |
| --- | ---: |
| `restaurant-browser-test.js` | 28 |
| `restaurant-operations-browser-test.js` | 29 |
| `restaurant-completion-browser-test.js` | 25 |
| `restaurant-brand-browser-test.js` | 13 |
| `restaurant-location-browser-test.js` | 31 |

The first run of the old image-upload harness needed its file-input selector updated to the new accessible markup. The cash collection selector was corrected to the exact localized label. The location harness encountered a browser-tool response-body wait, not a server lock; a bounded independent authenticated read now verifies the published point, and a 55-second watchdog bounds that harness. Final location execution passed in 5.504s, with six locally mocked tiles and zero external requests. These initial harness failures are not counted as passing runs.

An independent visual review examined desktop/mobile appearance, the loaded storefront, stock, archive and both Arabic location views. Two preview-only CSS defects were corrected (stretched checkout control and unused coverless hero column), then rebuilt and visually rechecked. No blocking overflow/clipping defect remained in the reviewed screenshots. Synthetic data and mock maps are not real-device GPS acceptance.

`scripts/restaurant-completion-runtime-check.mjs` verified that a duplicate application process targeting the same namespace exits before startup, and that a stop/start preserves the catalog, stock and order/courier/refund records. A Docker CLI restart invocation once exceeded its 30-second command timeout although the container subsequently became healthy; the bounded explicit stop/start rerun passed. No production restart or database outage was used as a failure test.

Deployment completed at approximately **2026-09-27 03:08 UTC**:

- Image: `astracalls-translation:0.5.0-dev-20260927-completion`.
- Image digest: `sha256:ef5bd971deaca9a262cd41af69e4b94af87e5d0e15eceed82c61faeb84207c70`.
- Immediate pre-deployment private snapshot: `backups/completion-update.lobXsj` (in addition to the initial snapshot).
- Only `.env` development image/version pointers changed; application-only Compose recreation used `--no-deps --no-build --pull never`.
- PostgreSQL container ID, start time and restart count were unchanged. Catalog version/content, session configuration fingerprint, gateway fingerprint and order/session/courier counts were unchanged. Counts remained `0 / 1 / 0`.
- The existing QR session remains unpaired; no Meta accounts were present. No pairing, call, message, real payment/refund or OpenAI request was initiated.
- The deployed application became healthy with zero restarts. `restaurant-completion-verify.mjs` passed **16 checks** over the public HTTPS domain and private read-only administration APIs.
- Archive capture, retention and AI remained off; all seven payment gateways remained disabled. Anonymous recording and archive requests were rejected.
- A final read-only production browser check confirmed the Arabic mobile menu without horizontal overflow or runtime errors, plus the administrator login screen.
- Prior portable `0.3.0` installer, image archive and source archive checksums were rechecked and unchanged. This development update does not create a clean distributable release.
- After acceptance, only the two labelled disposable QA containers were stopped and removed. Their tmpfs-only synthetic database/uploads were discarded intentionally; screenshots, test harnesses, reports and all production backups remain. Production HTTPS health stayed successful after cleanup.

Rollback image `astracalls-translation:0.4.0-dev-20260926-ops` and private backups remain available. Do not restore a database snapshot over newer customer activity without a deliberate recovery review.
