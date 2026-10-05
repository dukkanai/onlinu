# Staff menu read and bounded item edits

Staff with `menu:read` can list the original menu and inspect an item, including
unavailable options. `menu:update` permits a versioned item patch. Customer OAuth
does not grant either route. Restaurant identity/routing and current membership
are rechecked before separate signed `staff:menu:read` / `staff:menu:update` calls.

The list contains item summaries and categories, not every item's option tree.
Full item details have a separate bounded response. This accommodates the core's
maximum catalogue shape without sending an entire large menu on every edit.
Restaurant settings, private table QR capabilities and payment configuration are
not included in these DTOs.

## Write boundary

`POST /api/restaurants/{tenant}/staff/menu/items/{itemId}` accepts only
`expectedVersion` and the supported item fields: name, description, category,
price in minor units, image URL, availability, sort and options. Empty patches
and unrelated settings/actor/table fields are rejected. The item must exist;
this increment is not a bulk catalogue replacement or a delete API.

The core reads the current catalogue, applies the item patch and calls the
existing `SaveCatalog`. That service rechecks the version under its row lock,
validates the full catalogue and preserves the independent appearance state.
Concurrent settings changes cause a conflict instead of being overwritten.
Existing table codes, other settings and untouched options remain unchanged.
Existing orders keep their stored historical price/option snapshots.

Each successful generic catalogue save now writes an actor/scope/target/version
audit row in the same transaction. Native master-key saves use `local-admin`;
staff item patches use the signed pseudonymous actor and item target. Audit
failure rolls back the catalogue update. No old audit identities are invented,
and no private catalogue document/QR secret is copied into audit metadata.

## Browser surface

`/manage/{tenant}/menu` lists items; its item page edits the basic fields while
preserving image/options. The price form parses decimal strings into integer
minor units, including Arabic/Persian digits, without floating-point parsing.
It rejects extra fractional digits, exponents and ambiguous thousands separators.
Read-only staff get no write form. All dynamic content is escaped.

Create/delete/category management, image upload and the full option editor are
still follow-on work; original React management remains intact. This is not a
claim of completed native Flutter or full management parity.

## Evidence

Isolated PostgreSQL tests prove preserved settings/table capabilities, new quote
prices with unchanged historical orders, stale-version rejection and audit
rollback. Cross-language tests cover role/scope exclusions, rejected unrelated
fields and live original-core quote/status results. Chromium CI adds the real
basic item-edit form round trip. Real merchant data and production are untouched.

## Creating categories and items

Scoped staff POSTs to `/platform-api/staff/menu/categories` and
`/platform-api/staff/menu/items` accept an expected catalog version and a bounded
category/item, not an entire settings document. Both merge through the original
SaveCatalog lock, validation and transaction; creation audit and catalog commit
succeed together. Duplicate IDs and stale versions are conflicts.

The browser menu presents creation forms only to members with `menu:update`.
Form IDs are generated before submission and kept in hidden inputs, so repeating
a stale form cannot silently append another object. Categories must exist before
adding items. Browser-created items are disabled drafts; staff review details and
explicitly enable availability using the existing item form. API callers may
choose availability explicitly. The original inventory and opening rules still
apply. No existing orders, settings, table QR codes or brand configuration are
rewritten by these narrow operations.

An ambiguous create is not retried automatically: reload the menu and inspect the
stable submitted ID before deciding whether another edit is needed. Category
rename/reorder, options/media UI and deletion/archive workflows remain separate
work; native React management remains available.
