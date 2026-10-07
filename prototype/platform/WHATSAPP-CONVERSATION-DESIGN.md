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
