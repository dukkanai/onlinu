> Scope override, 2026-10-09: the owner removed all restaurant WhatsApp Business/QR,
> calling, translation and related conversation-archive requirements. Only restaurant
> and ChatGPT ordering remain active. Any older WhatsApp requirement below is historical
> and cancelled; other safety, commerce and launch requirements remain. Restore tag:
> before-whatsapp-removal-20261009. See README.md for the current runtime.

# Restaurant completion round — 2026-09-27 (development, not portable release)

> Supersession note — 2026-09-30: this document preserves the historical contract, not the current language scope. The user has approved Arabic (`ar`) and English (`en`) only for the restaurant interface; any thirteen-language requirement below is superseded. All five language-independent visual templates remain. Merchant-entered content and WhatsApp call-translation languages are not removed or automatically translated. See [the current iteration audit](RESTAURANT-ITERATION-AUDIT.ar.md) for implementation and verification status; historical results below are not new acceptance evidence.

User approved implementation of the seven-point completion round: advanced restaurant identity; optional active-delivery location; private conversation/voice/call archive and summaries; stock reservations; cancellation/complaints/refunds; concurrency/reliability; isolated functional/visual/failure testing. Preserve all existing work and production data. This supersedes ownership in RESTAURANT-NEXT-CONTRACT.md, not its security requirements.

## Safety and ownership

No production test orders, pairing, messages, live gateway/refund calls, or OpenAI requests. Existing configured keys stay private. New sensitive capture/AI/retention features are opt-in; do not activate deleting legacy data at migration. Root alone creates isolated infrastructure, snapshots production, integrates shared files, performs final tests and any app-only deployment. No clean source bundle, portable image archive, installer, or deploy/release.json change. Original 0.3.0 artifacts remain untouched. Independent restaurants may run isolated instances; multiple active processes on the same WhatsApp namespace are NOT advertised as supported.

- root: shared restaurant_types.go / types.ts / api.ts, server.go/main.go/restaurant_http.go/httpapi.go wiring, instance ownership guard, cross-feature integration, isolated test/backup/deployment harness, acceptance tests and docs.
- completion_orders: restaurant_orders.go/tests, new restaurant_stock*.go and restaurant_cancellations*.go. Inventory + cancellation/complaint core. DTO definitions in new owned files.
- completion_refunds: restaurant_payments*.go and new restaurant_refund*.go, provider docs/adapters and refund ledger/tests. Directly coordinates transactions with orders.
- completion_archive: conversation_archive*.go, message/session stores, QR session recording and reliability/outbox/webhook files, ArchivePanel.tsx and its isolated API/types. Limited chatwoot.go enqueue-first change. No main/server/global routing edits.
- completion_brand: restaurant_store.go, restaurant_brand*.go, BrandEditor.tsx, standalone branding helpers/CSS, all locale extensions. No stock values in generic catalog save.
- restaurant_storefront: courier backend and new location files, Storefront/CourierDashboard/customer components/CSS/tests; customer cancellation/refund/map/policy UX. Integrate branding component with its owner.
- previous_whatsapp_session: AdminRestaurant/OrdersPanel/MenuEditor/admin tests and new stock/refund/support admin panels, parent integration for archive/branding/location. Coordinate FR/ES help with locale owner.

Use apply_patch, don't overwrite unrelated dirty changes, don't globally format concurrently edited files. Send new translation keys early; all 13 supported UI languages must remain complete. Existing error conventions and private receipt auth continue. Tests run only in exact `astracalls_restaurant_test` disposable database with random private schemas. Gateway tests use fake transports only.

## Shared interfaces

### Branding

Settings.Brand *restaurantBrand (TS brand?: Brand from brand.ts). Owner defines Brand and BrandState. Separate draft and previous appearance; generic catalog saves cannot publish or overwrite a live brand. Optimistic versions. Routes under guarded admin submux: GET /api/restaurant/brand; PUT /api/restaurant/brand/draft {version,brand}; POST /api/restaurant/brand/publish {version}; POST /api/restaurant/brand/revert {version}. All return BrandState {version,live,draft?,hasPrevious,catalogVersion}. Preserve existing restaurant identity when migrating. Contrast checks apply to intended foreground/background pairs, not arbitrary CSS injection.

### Inventory / order support

Stock item fields itemId,tracked,available,held,version,updatedAt. `available` is sellable quantity now, held reservations excluded. Separate SQL state prevents stale catalog documents resetting quantity. GET /api/restaurant/stock => {items}; PUT /api/restaurant/stock/{itemId} {tracked,available,version}. Product availability AND stock must permit sale. Public catalog may expose derived stock hints, never mutation authority.

Order additions StockExpiresAt, PreparationStartedAt, Cancellation *restaurantCancellation, Complaints []restaurantComplaint (lower camel JSON). Original prices/options/tax immutable. Cancellation {id,status,reason,decisionReason,requestedAt,decidedAt?,requestedBeforePreparation}; complaint {id,status,reason,resolution,requestedAt,resolvedAt?}.

Protected customer POST /storefront-api/orders/{number}/cancel {reason,version}, POST .../complaints {reason,version}, both durable Idempotency-Key, auth by private order token or owning account, NOT order number alone. Admin POST /api/restaurant/orders/{number}/cancel-decision {approve,reason,version}; POST .../complaints/{id}/resolve {reason,version}. Return updated Order.

Before actual preparation, cancellation can auto-approve and create refund intent if funds captured; after preparation it is a request with documented decision. Accepting an order is not preparation. Times are server-generated immutable evidence; unresolved early cancellation must not be bypassed by preparation racing it. Cancelled prepared food is not automatically restocked. Pending/ambiguous payment must not free inventory and then silently fulfill a late paid order; reconcile or review. Stock row locks deterministic; no provider network request while holding stock transaction.

### Refunds

DTOs owned in new refund files; methods on restaurantPayments: Refunds, RequestRefund, RefreshRefund, ResolveRefundManual. Admin GET/POST /api/restaurant/orders/{number}/refunds; POST .../refunds/{id}/refresh and .../manual. Initiation {requestId UUID,amountMinor,reason,version}. Resolution includes reference/reason/version. Sanitize customer ledger; expose protected owner endpoint. States distinguish requested/processing/succeeded/failed/review/manual_reported. `manual_reported` NEVER means provider-confirmed refund. Amount reserved atomically before external call, cumulative refunds cannot exceed verified captured amount. Unknown network outcome never permits a blind second non-idempotent financial request. Exactly which providers can safely initiate is verified from official docs and displayed; unsupported paths give honest review/manual workflow. Cancellation helper `restaurantEnsureCancellationRefundTx(ctx,tx,order,reason)` creates intent transactionally. No automatic financial action in development or production migration.

### Delivery location

Owner proposes exact DTO/routes shortly. Current location only (not a historical movement trail), explicit courier consent for an active assigned job. Authenticated courier publishes, customer owner/admin read. Reassignment/terminal status revokes read/access immediately. Stale timestamps visible; stop/finish/unmount cleans up watcher. No guarantee of browser background tracking; geolocation is not delivery or payment evidence. Third-party map requests must be deliberate and disclosed, without private order identifiers in external URLs.

### Archive / reliable messaging

Policy capture/retention/AI initially OFF. Suggested configurable defaults originals 24h after conversation closes, summaries 90d; these are operational defaults, not a legal mandate. Legacy messages/recordings must not be swept automatically. Closed conversation summaries record provenance/review; AI cannot invent transcript or evidence. Holds need reason/until and linked open complaint cannot lose its source just because timer expired. Admin-only original/voice/recording download, no publicly accessible capability URLs or query API keys. QR recording labels must explain which streams actually captured; no claim of full original/translated tracks or Meta capture until implemented/tested.

New archive routes registered into guarded restaurant admin mux. Archive worker called from server lifecycle. Optional OpenAI text summaries use explicit enabled policy/admin action, bounded input, fixed official endpoint, server key, store:false, no tools; store:false is not a promise of zero external retention. Messages/voice jobs have durable bounded retries, leases and deterministic per-chat ordering where relevant; repeated transport events don't duplicate irreversible work. Existing blind recording janitor must not override legal holds. Copies delivered to third parties and existing backups require a separate disclosed retention procedure.

## Verification gates

Add tests for last-item race, repeated checkout, stock expiry with uncertain/late payment, preparing/cancelling race, partial/refund retry races, provider ambiguity, private location isolation/reassignment/stop, draft publication and stale edits, archive access/retention/hold races, durable message retries and ownership. Full Go -race on isolated PostgreSQL; frontend build/tests all locales; browser guest/admin/courier tests on isolated app; mobile RTL/LTR and contrast review. Do not substitute fake transport results for real merchant or WhatsApp acceptance. Back up before app deployment, preserve database lifecycle, verify health/state afterward. Final report separates implemented/tested/deployed from opt-in/merchant activation/manual limits.
