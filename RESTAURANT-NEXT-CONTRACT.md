> Scope override, 2026-10-09: the owner removed all restaurant WhatsApp Business/QR,
> calling, translation and related conversation-archive requirements. Only restaurant
> and ChatGPT ordering remain active. Any older WhatsApp requirement below is historical
> and cancelled; other safety, commerce and launch requirements remain. Restore tag:
> before-whatsapp-removal-20261009. See README.md for the current runtime.

# Working contract: restaurant operations update (unreleased)

> Supersession note — 2026-09-30: this document preserves the historical contract, not the current language scope. The user has approved Arabic (`ar`) and English (`en`) only for the restaurant interface; any thirteen-language requirement below is superseded. All five language-independent visual templates remain. Merchant-entered content and WhatsApp call-translation languages are not removed or automatically translated. See [the current iteration audit](RESTAURANT-ITERATION-AUDIT.ar.md) for implementation and verification status; historical results below are not new acceptance evidence.

User approved implementation, not a portable release. DO NOT build/package clean source, offline installer, or portable images; do not edit deploy/release.json or overwrite 0.3.0 artifacts. Existing dirty changes belong to previous work. No real provider transactions, Meta changes, WhatsApp pairing, or production test data. Root alone handles isolated test infrastructure, production backup/app-only deployment after validation, shared server/routes, and browser connection.

## Owners

- root: shared Go/TS DTOs, server wiring and HTTP guards, integration tests, QA, final safety review.
- restaurant_orders: order engine, inclusive tax, payment-policy enforcement, cash collection and immutable payment/tax snapshots.
- meta_accounts: provider-independent payments persistence/service, seven direct provider adapters, configuration and callbacks/verification HTTP in NEW restaurant_payments*.go files. Coordinate order mutation helper with restaurant_orders.
- restaurant_accounts: courier backend/HTTP and its tests in NEW restaurant_couriers*.go. Coordinate order mutation locks with restaurant_orders.
- restaurant_catalog: catalog validation/defaults for country/tax/payment-policy/branding and customer address-country validation. NEW brand helper if needed. Also owns NEW locale extension module covering all thirteen languages after collecting UI keys. Do not alter order engine or existing locale files without coordination.
- previous_whatsapp_session: admin UI: payments/tax/couriers/branding/WhatsApp panel, existing admin files, NEW panels. No backend source edits.
- restaurant_storefront: customer UI checkout/tax/payment/tracking/receipt/country and NEW courier dashboard. No admin files, backend or shared DTO edits.

## Shared DTO additions (root owns files)

Settings additions: country:string ISO alpha2 (default SA); primaryColor:string #RRGGBB; accentColor:string #RRGGBB; backgroundColor:string #RRGGBB; coverUrl:string; taxEnabled:boolean (default false, never invent VAT registration); taxRateBps:number (1500 default SA); taxNumber:string; paymentMethods:{table:string[],delivery:string[],pickup:string[]}.

Methods: cash_before (table only), cash_after (table only), cash_on_delivery (delivery only), card (all modes; only method for pickup). New defaults table cash_before,cash_after,card; delivery cash_on_delivery,card; pickup card. Legacy orders retain missing payment metadata as legacy, do not mark paid. Existing in-flight orders remain readable. Prices, options and delivery fee are gross/inclusive; VAT extraction uses integer rounding, never adds tax to configured price. Tax snapshot persisted at creation and unchanged by later catalog edits. Receipts are explicitly NOT claimed to be ZATCA compliant; official e-invoicing requires separate merchant eligibility/configuration and verification.

Address adds country:string. Superseded country policy (2026-09-27): Saudi Arabia (`SA`) is the only supported country for new settings, delivery orders and saved addresses. The customer does not choose a country; the administration displays it read-only. Legacy missing values normalize safely without database rewrites; historical explicit foreign records stay unchanged and cannot be selected for a new delivery. Exact idempotent recovery of already accepted historical orders is preserved. National address is not a national ID. All thirteen interface languages remain available. This restriction does not implement SPL lookups or per-district delivery prices.

OrderInput adds paymentMethod:string, paymentProvider:string. Quote adds paymentMethods:string[], tax:TaxSummary. Order adds payment:OrderPayment, tax:TaxSummary, courierId:string?, courierName:string?, deliveryStatus:string?, deliveryEvents:DeliveryEvent[].

TaxSummary: enabled:boolean, rateBps:number, number:string, netMinor:number, taxMinor:number, grossMinor:number. OrderPayment: method:string, provider:string, status:string, paidAt:string?, amountMinor:number. Status unpaid/pending/paid/failed/refunded/review; never set paid from browser redirect or unverified webhook. Courier transitions cannot settle a card payment. Cash collection explicit by authorized restaurant, or assigned courier for cash_on_delivery only. Cash_before/card blocks preparation unless paid; cash_after/cash_on_delivery blocks final completion until collected. Cancelled/late-success races require review/refund handling, never resurrect cancelled orders.

Courier: id,username,name,phone,active,availability(available/busy/offline),createdAt,updatedAt. Admin supplies password only on create/reset; never returned. Separate HttpOnly cookie scoped /courier-api, namespaced per instance, password hashing/session limits matching customer safeguards. Active assigned delivery orders only visible to the authenticated courier; no global order enumeration/guest receipt credentials.

Delivery status: assigned -> picked_up -> on_the_way -> nearby -> at_door -> delivered. Only delivery orders, active courier, active assignment; enforce monotonic transitions and order readiness before pickup. Delivered maps order completed after payment requirement. Admin may reassign with optimistic version/audit; stale courier loses access immediately. Availability is independent of per-order status.

## Routes (root will mount guards; owners implement handler registrations)

Payment admin: GET /api/restaurant/payments => {providers:PaymentProviderConfig[]}; PUT /api/restaurant/payments/{provider} => sanitized config; optional POST .../{provider}/verify read-only credential test only if explicitly invoked by admin. Config fields id,enabled,mode(test/live),configured,fields(metadata),values(nonsecret),secretSet(flags); secrets write-only via {secrets:{...}}, omitted values retain; explicit clear mechanism. Do NOT return credential values or accept arbitrary URLs. Native official provider credentials only. All real methods remain unavailable until correctly configured.

Public payment availability: GET /storefront-api/payments => {providers:[{id,name,mode}],...}. Checkout: POST /storefront-api/orders/{number}/payment {provider} authenticated owner/token => {attemptId,status,url?,...}. GET /storefront-api/orders/{number}/payment => status/attempt, owner only. POST .../payment/refresh => server-side provider requery owner only. Callback /payment-hooks/{provider}/{opaqueAccountId?} is not browser-CSRF checked but must verify provider signature and/or authenticated server-side status lookup; do not trust supplied amount/status/reference. Persist durable idempotency and reuse active attempt; prevent duplicate concurrent charge creation; strict provider hostname allowlists, bounded bodies/timeouts; unit tests fake HTTP transport only. Polling after return/manual refresh + authenticated webhooks/reconciliation, no fake success. Seven providers stripe,moyasar,tap,hyperpay,paytabs,geidea,myfatoorah. Stripe Saudi merchant activation caveat shown. Root never creates merchant accounts.

Cash: POST /api/restaurant/orders/{number}/cash {version} => Order (root wires to order service).

Courier admin: GET/POST /api/restaurant/couriers, PATCH /api/restaurant/couriers/{id}, POST /api/restaurant/orders/{number}/courier {courierId,version} => Order.
Courier: GET /courier-api/account => {courier:null|Courier}; POST /courier-api/login {username,password}; POST /courier-api/logout {}; PATCH /courier-api/account {availability}; GET /courier-api/orders => {orders:Order[]}; PATCH /courier-api/orders/{number} {status,version,collectCash:boolean} => Order.
Frontend /courier is the independent courier dashboard. Customer payment return uses /payment-return with opaque attempt identifier, never a receipt token in query strings; prefer retained existing private tracking receipt in sessionStorage, safe fallback asks receipt credentials. Browser return never marks payment paid.

Branding admin: preview before save, restore defaults (not destructive DB reset), logo/cover via existing safe upload endpoint or validated image URL. Apply only scoped CSS variables; validate color syntax, auto choose foreground contrast or block unsafe pairs; check RTL/mobile. Existing menu image editor retained.

WhatsApp admin: use existing QR/Meta session APIs and SSE; no new external messages/calls, no automatic pairing/deletion. Show QR in panel and active session state, Meta setup/status with credentials never returned. Preserve /admin/calls. Avoid remote QR-generation URLs. Root will verify authentication boundaries and visuals.

## Coordination / tests

Use apply_patch. Send root exact signatures/interface changes early, and English+Arabic new UI labels/key list before localization freeze. New code uses existing generic error keys unless necessary new keys, send any additions immediately. Never weaken existing tests or label mocked provider tests as real acceptance. No local secrets in source or logs. Root provides isolated PostgreSQL test DB and Docker Go runner commands. Existing tests opt-in exact astracalls_restaurant_test database; random schemas. All new handlers use same-origin, bounded request/read timeout/rate-limit guards. No production mutation by subagents. No agent browser calls until root explicitly delegates a separate session.
