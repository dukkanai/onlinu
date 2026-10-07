# WhatsApp order intake — private proposal boundary

This is preparation, not a connected shopping adapter. No live WhatsApp account,
provider request, message, subscription, webhook route or worker is enabled by
this increment. Existing account, calling and messaging code is unchanged.
`adapterImplemented` remains false for both WhatsApp shopping channels, and
original-core order creation continues to reject them.

## Implemented boundary

`cmd/server/restaurant_whatsapp_proposal.go` accepts an already authenticated,
server-resolved restaurant/channel/connection generation/peer scope and mapped
internal cart IDs. All values remain private in-process; there is no JSON or
HTTP endpoint for constructing these values. The future transport adapter must
verify its source and current tenant entitlement, account binding and owner
permission before calling this boundary. The scope is not an authorization token.

- Direct inbound, non-history, non-forwarded, non-edited messages only. Outbound
  echoes, groups and invalid origins are rejected.
- A 15-minute freshness window is tied to the original source timestamp, with
  at most 30 seconds of future skew. A retry does not extend it. The clock must
  come from the server, never customer input.
- Bounded IDs/cart quantities/options; deep copies and canonical ordering.
  Ambiguous duplicate cart lines are rejected rather than silently combined.
- Event fingerprints include restaurant, channel, account connection generation,
  peer and source message ID. Separate payload hashes distinguish a conflicting
  redelivery. These hashes are not authentication and are not durable deduplication.
- Read-only previews use the original core for price, stock, delivery coverage,
  tax, payment availability and opening policy. Provider prices and free-text
  instructions cannot supply these values. No order or stock reservation occurs.

## Deliberately not implemented here

Provider-to-tenant binding, product catalogue mapping, Cloud webhook extraction,
QR cart retrieval, durable inbox/replay suppression, conversation drafts, explicit
customer review/confirmation, final order creation, outgoing messages and receipt
reconciliation remain separate gates. No external ID is assumed to be an internal
product ID. The pinned QR `OrderMessage` contains a token/count/total rather than
line items; its displayed total must never substitute for server pricing.

There is no live account or WebRTC acceptance in these tests. Voice transport is
separate from messaging/order intake. Preparing this code does not resume the
owner's personal WhatsApp automation or authorize a new connection.

## Verification

Pure tests cover scope isolation, source rejection, bounds, canonical hashes,
conflicting replays, copies and expiration. The original-core PostgreSQL test
checks pricing, unchanged stock/order count and unchanged disabled WhatsApp
policies. It requires the existing disposable `TEST_RESTAURANT_PG_URL`; local
absence is reported as a skip. Hosted aggregate acceptance is pending.

Acceptance: code `7226bb64b65fbf12a927d976495329bb0c30166d` passed all four
ordinary jobs in [CI37661591551](https://github.com/dukkanai/onlinu/actions/runs/37661591551).
Server logs confirm uncached original Go race suites with disposable PostgreSQL
configured and 396 platform tests/no skips. Client84 tests, build and compiled
storefront browser checks passed, together with Windows and control-image gates.
The earlier run failed the existing translation-coverage guard; all five new
validation messages now have Arabic/English entries. No provider extraction,
durable inbox, final order creation or live-account acceptance is claimed.

## Private durable inbox increment (acceptance pending)

`restaurant_whatsapp_inbox.go` provides an immutable PostgreSQL intake journal.
Its initializer is not called by normal server startup and it has no public route,
provider hook or send worker. Only synthetic fixtures currently construct it.

The scope-bound event key is unique. Concurrent identical proposals converge on
one receipt; a changed payload under that key is a conflict, never an overwrite.
Restart reads preserve the original first-seen/expiry timestamps. A duplicate
may return an expired receipt, explicitly marked expired; it cannot renew a cart
or authorize order execution. Previously unseen expired proposals are rejected.
Derived identity/content/expiry fields are revalidated before persistence, and
stored payload mismatches are rejected rather than repaired or guessed.

Only hashes, internal cart IDs/quantities/options and timestamps are stored; raw
message text, sender identity, account tokens and provider prices are absent.
Hashing is not anonymization or an authorization mechanism. Original restaurant
DB isolation and a verified current transport binding are still required.
No automatic deletion/retention or outgoing replay is introduced. Durable intake
is not durable customer confirmation, order creation or message delivery.

Inbox acceptance: code `6034574e86bc4f9ce1853a53e6277e9921032b70` passed all four
ordinary jobs in [CI37663927719](https://github.com/dukkanai/onlinu/actions/runs/37663927719).
The dedicated verbose Go race step confirms every WhatsApp test passed, including
actual PostgreSQL concurrent receipts, restart/expiry/conflict/isolation checks
and original-core read-only pricing. Full uncached Go race regression and
396 platform tests/no skips also passed. No live transport or order creation.

## QR text extraction preparation (acceptance pending)

The private `restaurantWhatsappQRText` helper consumes the repository's pinned
whatsmeow `events.Message` model. It is not registered in the live session event
handler. Tests construct only synthetic in-memory events, with no QR login or
WhatsApp connection.

It derives the opaque peer from a direct chat and requires the sender to agree;
phone-number and LID namespaces stay distinct. Alternate IDs are not guessed or
silently merged. Own-device echoes, groups/broadcasts, history/unavailable replay,
edits, newsletters, view-once content and forwarded text are rejected. Only
bounded plain/extended text is extracted; mixed/unknown content and native order
cards are unsupported, not guessed from a count/total/token. Text remains
untrusted data and cannot authorize a confirmed order or execute instructions.
The existing proposal freshness/scope validator is reused. Actual session binding,
permissions, conversational parsing and review/confirmation are still required.

QR extraction acceptance: code `cccb463831dd493a9b73ab3577903d5d7570753c` passed
all four ordinary jobs in [CI37666341094](https://github.com/dukkanai/onlinu/actions/runs/37666341094).
The focused verbose Go race log verifies direct PN/LID extraction, all rejected
origin classes and refusal to guess native order cards; original proposal and
PostgreSQL inbox tests also passed. Full Go race,396platform cases/no skips,
client84/build/browser and Windows checks passed. All events remain synthetic;
this is not a connected QR account or a functioning conversational order flow.
