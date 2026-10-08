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

## Private original-core dispatch increment (acceptance pending)

A confirmed review can now be dispatched internally through `Dispatch`, but its
transaction-scoped authority callback is nil by default. No startup wiring,
HTTP route, WhatsApp session hook, outbound message or enabled shopping adapter
is introduced. Tests provide synthetic authority only; a future transport must
verify and lock the current restaurant/account/generation/entitlement binding
using the supplied transaction. An account ID or customer boolean is insufficient.

A durable, immutable UUID submission key and normalized input hash are claimed
before invoking the original core. The core binds the actual input, owner and
submission key internally, then checks the reviewed scope, fingerprint, active
conversation version, confirmation, expiry and channel-policy version inside the
same transaction that reserves stock and creates the order. Current authority is
checked again there. Lock order is channel, authority, conversation and review;
no second pool connection may be opened by the authority callback.

Original money, stock, coverage, opening and quote-binding rules remain in the
core. A channel disable/re-enable cycle invalidates an unaccepted claim instead
of reviving its pending work. An existing committed order can still be recovered
with its unchanged key after review expiry or channel closure; an unseen expired
submission cannot create a fresh order. Unknown results retain the original key.
Only the accepted order number is stored in the dispatch journal; the core keeps
its existing sealed receipt capabilities. No second plaintext receipt copy is
persisted. Sending a receipt and proving delivery remain separate unimplemented
transport steps, with current egress authority rechecks required.

Private dispatch acceptance: code `0d218ad8105c723b9fa06378407bfd150e4c9afc` passed
all four ordinary jobs in [CI37701906784](https://github.com/dukkanai/onlinu/actions/runs/37701906784).
The focused verbose Go race log verifies both channel identities,12 concurrent
dispatches with a two-connection pool creating one actual core order/reservation,
lost committed result recovery, expired unseen rejection, policy-cycle rejection,
altered input/owner/key, revoked binding, changed price/stock and supersession.
Full uncached Go race and396platform tests/no skips passed; client84/build/browser,
Windows and control-image checks passed. Transport authority was synthetic and no
provider was contacted. Live account binding, conversation/rendered review delivery
and outgoing receipt reconciliation remain unimplemented acceptance gates.

## Complete review text preparation (hosted acceptance pending)

The private renderer prepares deterministic Arabic/English plain text from the
verified immutable checkout and quote. It includes every item/option/quantity,
unit and line money, subtotal/delivery/tax/total, service method, contact,
complete supplied delivery details, payment choice, notes, expiry and review ID.
It explicitly distinguishes review, order creation and card charging. Dynamic
text is quoted/escaped so a newline or bidi control cannot impersonate a total.
A conservative internal3000-byte limit rejects an oversized review in full;
there is no truncation or claim about the provider's actual message limit. A
complete alternative review path is still required for oversized carts.

Preparation now freezes authoritative delivery labels resolved from the selected
geography IDs instead of displaying forged client labels. The frozen input is
reused on dispatch retries; labels are not re-resolved before retry hashing.
Reading a stored rendered review requires current transaction-scoped authority,
enabled channel intent and the active pending unexpired review. Rendering does
not record a presentation, create an order, send a message or establish delivery.
String-level tests are not WhatsApp-device visual or provider acceptance.

Review-text acceptance: code `9e4367edc7be29f30c6cc8b83574c32daf8cc2fc` passed
all four ordinary jobs in [CI37704442623](https://github.com/dukkanai/onlinu/actions/runs/37704442623).
Verbose race logs verify complete Arabic/English fields, money/tax, deterministic
escaping, expired/changed/oversized rejection and actual PostgreSQL authority plus
canonical delivery labels. Full Go race and396platform cases/no skips passed;
client84/build/browser and Windows/control checks also passed. No WhatsApp-device
visual review, external message, presentation receipt or provider acceptance.

## Private review-send journal (acceptance pending)

A private PostgreSQL journal now claims one immutable outbound review attempt,
including review fingerprint, exact Arabic/English rendering digest, locale,
channel-policy version and original start time. Only the first committed claim
returns the complete text. Concurrent callers and restart return status only.
The initial state is deliberately unknown, not sent: a crash could occur before
or after a provider call. There is no lease reset, expiry-based resend or retry
of a rejected attempt. No second plaintext customer-review copy is persisted.

Only a trusted adapter may record positive acceptance or definitive rejection
with an evidence digest and the exact attempt/body identity. Contradictory results
are rejected. Acceptance is distinct from delivery/read; no such delivery claim
is made. A current accepted review is marked presented atomically with the
journal result. Late evidence is retained without reviving expired, superseded
or policy-invalidated review presentation. Disabled channels can still reconcile
already claimed evidence under current account authority, but cannot claim a new
send. Revoked account authority blocks even that private read/write path.

No sender, worker, live account, endpoint or startup initialization is added.
A claim is not an egress permission: a future sender still needs a current,
transport-specific handoff gate, authority/policy rechecks and reconciliation
against actual provider evidence. Synthetic tests do not establish provider
acceptance or safe runtime activation. Existing private Present remains a trusted
fixture/internal boundary; a live adapter must use verified journal evidence.
