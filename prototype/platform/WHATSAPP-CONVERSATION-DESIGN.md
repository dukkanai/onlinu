# WhatsApp conversation review and confirmation

Design for the next implementation increment, not implemented acceptance.
Existing private source extraction/proposals/inbox do not execute this workflow.

## State and boundaries

Each conversation is bound to the server-owned restaurant, channel, connection
and connection generation plus opaque peer. A re-linked account gets a new
generation; old drafts are not adopted by matching a phone or display name.

1. Authenticate the actual transport and resolve the current restaurant binding,
   subscription entitlement and owner-enabled channel policy. None can be supplied
   by message text. The existing shopping adapters remain disabled until wired.
2. Persist a bounded source event in the durable inbox before consuming its intent.
   Identical redelivery returns the existing outcome; conflicting content is not
   a second command. Processing and network send outcomes need separate records.
3. Build a versioned draft from explicit customer selections. Catalogue search may
   assist selection, but ambiguous names/quantities/options require clarification.
   No guessed product mapping, payment choice or delivery address is committed.
4. Collect checkout information for the requested service method. An opaque LID
   is not a phone number. The messaging peer is not automatically a verified
   customer account or permission to disclose an existing order.
5. Obtain the authoritative original-core quote and freeze a review of the entire
   checkout input plus quote binding: items/options/quantities, currency, subtotal,
   delivery fee, tax and total, service method, destination and payment choice.
6. Present the exact review. Persist the review ID/version, rendering hash and
   provider message identity separately from send acceptance/delivery evidence.
   An ambiguous send result is not retried until reconciled or explicitly handled.
7. Accept only an explicit confirmation bound to that review and the same current
   peer/account generation. A generic yes without the expected review context,
   quoted old message, forwarded text or unrelated receipt is insufficient.
8. Recheck current authority, active draft/review version and expiry, then call the
   original core with the immutable reviewed input, expected quote binding and a
   stable scope-bound idempotency key. The core must still reject stale price,
   stock, opening hours, coverage or disabled channels. Confirmation is not payment.
9. If the create result is unknown, reconcile the same durable idempotency key.
   Do not create a new draft/order as an automatic recovery. Distinguish a saved
   order receipt from an outgoing acknowledgement and from message delivery.

## Invalidation and time

A newer draft or review supersedes the previous review in a transaction using an
expected version. Changed items, options, contact/destination, service or payment
selection require a new review. New authoritative quote details do as well.

A review lasts at most five minutes and never outlives the underlying proposal's
original 15-minute source expiry. Retries and restart do not extend either window.
A fresh customer interaction may explicitly begin a new proposal; replay alone
cannot. Cancellation invalidates a pending review, not an already accepted order.
Existing-order cancellation uses its separate original-core rules.

Disabling the channel or suspending the tenant blocks fresh work and sends;
previously accepted order recovery/settlement remains available through permitted
paths. Re-enabling never blindly drains old pending messages or confirmations.

## Required verification before transport activation

- Real PostgreSQL draft CAS, concurrent confirm, cancel-versus-confirm,
  supersession, restart and immutable receipt tests.
- Same peer in different restaurants/accounts/generations cannot read/confirm
  another draft. LID/phone aliases require verified mapping, not heuristics.
- Price/tax/delivery/stock/opening/policy changes between review and confirmation
  force a safe new review or rejection; no stale order is silently accepted.
- Simulated accepted, rejected and unknown sends are reconciled independently;
  no receipt is labelled delivered merely because the send API returned success.
- Full original-core creation and stock/event/payment regressions with synthetic
  transports only. No customer charge or external message in these tests.
- Actual account/network acceptance requires separate explicit authorization.

No production route, review table, worker, model prompt, transport connection or
send permission is created by this design document.

## Private review-store increment (hosted acceptance pending)

`restaurant_whatsapp_reviews.go` now implements private PostgreSQL conversation
heads and immutable review versions with pending/confirmed/cancelled intent.
It is not initialized at server startup and has no route, live transport or send
worker. Tests alone construct it. The stored complete checkout input includes
customer data when supplied; production use requires authorized collection and
restaurant database isolation. It must not be logged or published in artifacts.

Preparation validates the cart against its proposal, uses original-core checkout
quoting, freezes complete input and quote hashes, and uses a conversation-version
CAS. A later review invalidates earlier pending reviews. Expiry is the earlier of
five minutes and the source proposal expiry. Presentation binds an exact review
fingerprint to a provider message ID; this method is only an internal receipt
boundary, not independent proof that a message was sent or delivered.

Confirmation/cancel needs a validated direct event, expected review context and
presentation ID. The original cart message cannot confirm itself. Concurrent
identical confirmation events converge; changed event content, stale versions,
wrong peers and changed presentation IDs are rejected. A fresh original-core quote
check precedes confirmation. It deliberately occurs outside the locked review
transaction to avoid pool starvation; eventual order creation MUST atomically
recheck prices/stock/policy again. No order dispatch exists in this increment.
An idempotent historical confirmation receipt is never permission for a new order
or charge after expiry. Presentation/decision adapters and final dispatch remain
unimplemented; no natural-language yes parser is introduced.

Review-store acceptance: code `e5d805ded23e4e327b869e031ea2ecfa87be6720` passed
all four ordinary jobs in [CI37694002174](https://github.com/dukkanai/onlinu/actions/runs/37694002174).
Dedicated verbose Go race logs verify four actual PostgreSQL tests:12 concurrent
confirmations with a two-connection pool and restart; supersession/cancel/expiry
and identity isolation; changed price/cart/stored-input rejection; and concurrent
cancel-versus-confirm plus source expiry. Full Go race and396platform cases/no
skips passed, along with84client/build/browser and Windows checks. This accepts
the private intent store only. No live review presentation, send, provider account,
conversation UI or final order dispatch has been accepted.
