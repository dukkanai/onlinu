# Restaurant implementation contract (0.3.0)

> Supersession note — 2026-09-30: this document preserves the historical contract, not the current language scope. The user has approved Arabic (`ar`) and English (`en`) only for the restaurant interface; any thirteen-language requirement below is superseded. All five language-independent visual templates remain. Merchant-entered content and WhatsApp call-translation languages are not removed or automatically translated. See [the current iteration audit](RESTAURANT-ITERATION-AUDIT.ar.md) for implementation and verification status; historical results below are not new acceptance evidence.

One restaurant per existing Docker instance. Existing QR/Meta calling preserved. No external delivery API, no payment gateway, no automatic translation of restaurant-entered menu content. Demo seed only on fresh catalog, visibly labelled demo in storefront/receipts; no real phone/address. Public UI at `/`, `/order`, `/track`, `/account`; protected restaurant dashboard `/admin`; original calls dashboard `/admin/calls`.

Shared Go DTOs: `cmd/server/restaurant_types.go`. Shared TS DTOs: `client/src/restaurant/types.ts`. Every customer/admin-facing fixed label uses `restaurant/i18n.tsx`: `LocaleProvider`, `useLocale()` => `{locale,setLocale,t(key,vars?),money(minor,currency?),date(value),dir}`, `LanguagePicker` component. ar/en/tr/ps/fa/ru/uk/fr/es/sw/ha/ur/hi. Root owns entry routing, Go HTTP routing/security and shared API helper. DTO file changes coordinate with root.

## HTTP

All public JSON errors `{error: translation_key}`; never SQL/provider errors. Public endpoints use SAME-ORIGIN cookies (`credentials: include`) and never an admin API key. Admin endpoints require master `X-API-Key` (not widget/query-only) in addition to existing /api guard. Bodies strict/size limited; mutations require same-origin JSON; bounded per-IP rate limits. GET responses for private records no-store.

- GET `/storefront-api/catalog` => Catalog (no inactive products, no table-code list).
- GET `/storefront-api/tables/{code}` => RestaurantTable (active only).
- POST `/storefront-api/quote` OrderInput => Quote (expectedTotal ignored for preview).
- POST `/storefront-api/orders` OrderInput + `Idempotency-Key` random UUID => Receipt. Revalidate prices/options/availability/delivery in transaction, compare expectedTotalMinor. Account ID only from authenticated customer cookie. No online payment.
- GET `/storefront-api/orders/{number}` + `X-Order-Token` => Order, or authenticated owning customer cookie. Never authorize by order number/phone alone.
- POST `/storefront-api/orders/lookup` `{number,accessCode}` => Receipt. Rate limited; generic invalid credentials response.
- POST `/storefront-api/orders/{number}/table` `{tableCode}` + X-Order-Token or owning customer cookie => Order. Only table-mode active orders, no merging, retain audit history.
- GET `/storefront-api/account` => `{customer: Customer|null}`.
- POST `/storefront-api/account/register` `{username,password,displayName}` => `{customer}` + HttpOnly customer cookie.
- POST `/storefront-api/account/login` `{username,password}` => same.
- POST `/storefront-api/account/logout` `{}` =>204 clear cookie.
- PUT `/storefront-api/account` CustomerUpdate => `{customer}`.
- GET `/storefront-api/account/orders` => `{orders: Order[]}` own only.
- GET `/api/restaurant/catalog` => full Catalog.
- PUT `/api/restaurant/catalog` full Catalog with optimistic Version => updated Catalog. IDs from UI UUID; new tables have blank code, server generates unguessable code. Preserve existing table code on edits; disabled tables unavailable to new orders/change.
- GET `/api/restaurant/orders?status=&search=` => `{orders:Order[]}` max100.
- PATCH `/api/restaurant/orders/{number}` `{status,version}` => Order. Valid transitions enforce version, no payment/total edits.
- POST `/api/restaurant/images` multipart `image` => `{url}` local image URL; max5MiB, jpeg/png validated; no SVG/remote URL fetching.

Camera QR: open the table link with the phone's camera/QR reader, or paste that link/code into the change-table screen. This release does not embed a camera scanner. A table QR landing page can also move an existing order after number+accessCode verification. A QR itself never authorizes changing someone else's order.

Submission UUIDs are globally unique within an instance. Retries require the same request body and customer ownership (including guest); changing accounts or losing an account session must not create a duplicate or reveal the original receipt. Customer cookies use an instance-specific namespace because cookies do not isolate different ports on one hostname.

## Backend ownership/interfaces

`restaurantStore` owns `.db *sql.DB`, constructor `newRestaurantStore(ctx,db)`, `GetCatalog(ctx,public bool)(restaurantCatalog,error)`, `SaveCatalog(ctx,catalog)(restaurantCatalog,error)`, `TableByCode(ctx,code)(restaurantTable,error)`. Catalog persisted as singleton versioned JSONB in table `restaurant_catalog` (columns id integer primary key CHECK id=1, version bigint, document jsonb, updated_at timestamptz), document includes full Catalog. Expose `loadRestaurantCatalog(ctx, queryer interface QueryRowContext, lock bool)` helper? Orders agent coordinate direct transaction catalog select with store agent.

`restaurantOrders` constructor `newRestaurantOrders(ctx,store)` and methods `Quote(ctx,input)`, `Create(ctx,input,customerID,idempotencyKey)`, `Track(ctx,number,token,code,customerID)`, `Lookup(ctx,number,code)`, `ChangeTable(ctx,number,token,code,customerID,tableCode)`, `ListAdmin(ctx,status,search,limit)`, `SetStatus(ctx,number,status,version)`, `ListCustomer(ctx,customerID)`; returns corresponding DTO, array or error. Each order immutable price/content snapshots, durable guest secret for repeat idempotency receipt (design secure storage), no PII in logs/URLs, no guest record enumeration, no attaching existing guest orders merely by phone. Coordinate any signature changes.

`restaurantAccounts` constructor `newRestaurantAccounts(ctx,db)`; Register(ctx,username,password,displayName)(restaurantCustomer,string,error); Login(ctx,username,password)(restaurantCustomer,string,error); Authenticate(ctx,token)(restaurantCustomer,bool,error); Logout(ctx,token)error; Update(ctx,id,restaurantCustomerUpdate)(restaurantCustomer,error). Random session token returned internally, SHA256 hashed DB, 7-day expiry; salted password hash with bounded CPU/concurrency, no network/email/SMS. Usernames unique, no claim of verified phone/email. Root sets secure cookies and CSRF/rate limits; agents own validation and DB tests.

## Limits and error keys

Common errors `invalid_request`, `unauthorized`, `forbidden`, `not_found`, `server_error`, `rate_limited`, `conflict`, `catalog_changed`, `store_closed`, `mode_unavailable`, `item_unavailable`, `invalid_quantity`, `invalid_option`, `price_changed`, `delivery_unavailable`, `delivery_minimum`, `location_required`, `outside_delivery_area`, `address_required`, `phone_required`, `table_not_found`, `order_not_found`, `invalid_order_access`, `table_change_unavailable`, `invalid_status`, `username_taken`, `invalid_credentials`, `invalid_username`, `weak_password`, `image_invalid`, `image_too_large`, `too_many_addresses`, `session_expired`. Fixed UI keys coordinate with locale owner; all 13 must provide every key (no English fallback as a substitute for translation).

## Testing

No production DB/session writes during development. Local Go tools via Docker golang:1.26.4, caches astracalls-build-gomod and astracalls-build-gocache, mount repo /src with CGO_LDFLAGS='-L/src/native -Wl,-rpath,/src/native', LD_LIBRARY_PATH=/src/native, -tags mlow. Root provisions isolated Postgres `astracalls_restaurant_test`; opt-in TEST_RESTAURANT_PG_URL must match exact test DB name and use random private schemas (no truncation of existing tables). Existing production .env is private; never read or output secrets. Use apply_patch for source edits.
