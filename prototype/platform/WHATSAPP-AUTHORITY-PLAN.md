# WhatsApp authority and runtime integration plan

Implementation plan, October 8, 2026. Nothing in this document enables an account,
grants a permission, creates a credential or installs a live message handler.
The accepted private components are described in `WHATSAPP-CONVERSATION-DESIGN.md`.

## Observed integration points

- `cmd/server/platform_orders.go` already verifies Ed25519 request envelopes:
  issuer, fixed restaurant audience, principal, scope, method, exact URI, body
  digest, idempotency key and a maximum 60-second validity. These signatures are
  request-specific, not a standing background-worker entitlement.
- The Node control plane authorizes `channels:manage` against current directory
  membership and tenant status before signing the existing channel-policy write.
  The original core stores channel policy/version independently of session state.
- `SessionManager.Get` resolves an in-process session ID. It does not establish
  restaurant entitlement, permission to shop, or a pairing generation.
- `Session.handleEvent` already handles real message events. The new private QR
  extractor is not registered there. Existing Chatwoot/webhook/read behavior must
  not be adopted as shopping consent or silently expanded by integration.
- `Session.setAuth` updates a UI snapshot. Transport disconnect, replacement,
  ban, outdated-client and generic connection/stream failures now clear a stale
  open state to the existing error state, preserving pairing independently and
  not overwriting logged-out state. `AuthSnapshot.Paired` or its string state
  alone still cannot authorize a new shopping send. This is synthetic event
  regression coverage, not evidence about a currently connected account.

## Chosen direction

Use separate, operation-bound platform authority for shopping, with the original
restaurant core retaining money, inventory, review and idempotency rules. Do not
enable a background sender by setting `authorizeDispatch` to an always-true
callback or by trusting a known session ID.

Keep these three identities independent:

1. Restaurant runtime identity, fixed by its authenticated deployment audience.
2. Verified current provider account/connection and pairing generation.
3. Direct customer peer, kept opaque in its verified PN or LID namespace.

A transport execution principal must be distinct from a human owner's login and
from a restaurant customer account. It can perform only specifically delegated
shopping operations, not acquire the owner's other management privileges.

## Integration order

1. **Binding lifecycle.** Implement a versioned, audited binding between the
   runtime's own restaurant and an explicitly selected existing provider account.
   A settings change cannot create/link an account as a side effect. A new link,
   account replacement or removal invalidates the previous generation. Reconnect
   and process restart must not guess whether they represent a new pairing.
   Validate generation provenance against the pinned provider SDK before choosing
   a persisted representation; a phone, display name or session ID is insufficient.

2. **Authenticated event ingress.** Resolve the runtime/provider binding before
   constructing a private scope. Verify the source at the actual QR/Cloud ingress,
   not with a field supplied in customer text. Authenticate any core-to-platform
   event hop and bind its restaurant, generation, peer and event digest. Existing
   generic webhook configuration is not assumed to provide this contract. Missing
   transport authentication is a blocker, not a reason to accept unsigned events.

3. **Current operation authority.** Reuse the envelope-verification model with
   dedicated least-privilege operation scopes, not an arbitrary staff role. Bind
   the current connection generation and exact review/event/body in the signed
   operation. The platform must freshly check tenant status, subscription/channel
   entitlement and the approved account binding before issuing it. Do not turn
   a single successful check into a reusable authorization cache or daemon lease.
   Signed-request validity has a bounded revocation window; do not claim atomic
   instantaneous revocation across the platform and a separate tenant database.

4. **Atomic core checks.** Validate the signature before starting the core
   transaction, then check its verified scope/current local generation and policy
   inside that same transaction. Preserve the explicit channel/authority/head/
   review/dispatch lock order. Do not make remote requests or acquire another pool
   connection inside `authorizeDispatch`; a two-connection pool is a required test.

5. **Egress handoff.** Before a provider call, recheck current provider connectivity,
   binding generation, policy and operation authority. Serialize the handoff with
   account replacement/removal through one documented lifecycle lock order.
   Never hold a database transaction across a network send. The unavoidable
   external-call boundary must retain its durable unknown attempt on timeout,
   process loss, revocation or uncertain acknowledgement. A stale claim is not
   permission to send. Revocation cannot retract an already accepted message.

6. **Receipt and conversation wiring.** Resolve explicit reply IDs through the
   accepted send journal in the same scope; never use quoted checkout text.
   Collect concrete catalogue selections/options, service, address and payment
   choice before preparation. An opaque messaging peer is not a customer phone
   or proof of a customer-account link. Use the original core for the complete
   review and final creation. Unsupported or ambiguous input needs clarification.

7. **Activation.** Keep `adapterImplemented` false and the live callback/sender
   unregistered until the complete connected path is accepted. Owner channel
   intent, a compiled implementation, provider connectivity and delivery evidence
   are different states and must remain distinguishable in management UI.

## Required acceptance before activation

- Current binding versus a different restaurant, account, generation and peer;
  same displayed phone/name must never merge identities.
- New pairing, reconnect, logout, stream replacement, ban, account removal and
  restart, including an operation waiting on a lock during the transition.
- Invalid/expired/wrong-audience/wrong-body envelopes, suspended subscriptions,
  revoked channel permission, disabled/re-enabled policy and unavailable authority.
- Two-connection-pool concurrency, deterministic lock-order checks and simultaneous
  prepare/confirm/cancel/account replacement. No blind transaction/order replay.
- A lost reply before versus after provider acceptance. The immutable attempt
  survives restart; unknown, rejected, accepted, delivered and read are distinct.
- Full customer path with fixture transports, then separately authorized real
  account and provider tests. Synthetic success does not establish actual QR
  reply-context shape, a verified account generation or transport availability.
- No real phone, token, secret, customer checkout or receipt capability in logs,
  test artifacts, version control or public CI output.

Creating persistent transport credentials, linking an account, sending external
messages and production activation require the relevant explicit permissions.
This plan is not that permission and does not resume personal WhatsApp automation.

## Private binding journal increment (October 8)

`restaurant_whatsapp_bindings.go` adds an unregistered PostgreSQL QR binding
journal for a fixed runtime restaurant. Changes require an explicitly supplied,
current authority callback (nil by default), compare-and-swap revision and an
immutable request ID/body hash. Every explicit rebind/removal gets a fresh,
persisted generation, even if the selected provider identity is unchanged.
Repeated delivery of the same current change returns that generation; an old
change cannot revive a binding after replacement. Restart resolution requires the
same verified connection/device fingerprint. No customer text resolves identity.

Local checks run on the caller's transaction: policy/entitlement before binding,
then conversation head/review/dispatch. Two-connection-pool tests exercise retries,
replacement, revocation before order creation and lock serialization. This does
not cover external sends, remote instantaneous revocation or the authenticated
platform-to-runtime hop. The future authority callback must also check signed
operation scope and current subscription entitlement; a binding match alone is
not permission.

The pinned SDK creates fresh identity/noise keys in `sqlstore.NewDevice`, persists
and reloads them, and marks deleted devices unusable. `Session.replaceClient`
currently attaches the shared session handler to a new client; queued callbacks
from an earlier client still need provenance fencing before shopping integration.
Consequently this increment does not derive a production device fingerprint or
claim a live pairing epoch. The independent persisted generation avoids assuming
that a displayed phone, stable SDK key, reconnect or process restart proves a
new owner-approved binding. No credentials, real account link or live handler
were created, and `adapterImplemented` remains false.

## Private signed dispatch boundary (local acceptance)

The unregistered `restaurant_whatsapp_authority.go` boundary verifies the existing
platform signature format with a dedicated `transport:whatsapp:dispatch` scope,
configured transport principal, fixed tenant, exact method/path/body and canonical
request UUID. It captures a single immutable peer/generation/review operation.
Staff scopes or another valid signer subject cannot substitute for that principal.
The internal path constant is not a registered endpoint or new account grant.

Dispatch uses a per-operation service copy, not a shared always-authorized service.
It rechecks the signed expiry and current persisted binding in the claim and
original order transactions, including after waiting for binding/review locks.
Replay still uses the original durable order key. There is no remote call under a
transaction and no new token, transport principal or persistent signing key is
created by this code. Platform-side entitlement-backed issuance, real provider
identity provenance and live ingress/egress remain required before activation.

Local acceptance:46 WhatsApp Go race cases,233 aggregate restaurant/platform
cases plus all seven separately enabled Node/core integration cases,84 client
cases, TypeScript/Vite build and Go vet/build passed. No local Dart SDK was used.
Hosted acceptance is tracked in `plans/IMPLEMENTATION-STATUS.md`.

## Private QR attachment fence (local acceptance)

`restaurant_whatsapp_qr_source.go` captures immutable binding and verified-self
context for one provider-client attachment. Text and decision extraction require
both that original client pointer and the still-current attachment. Reattachment
invalidates old sources even for the same client and durable binding; late old
logout/failure notifications cannot invalidate a replacement. Eight failure event
types close the source; Connected alone never reactivates it. Pure extraction runs
under the fence lock, with no database or SDK/network call held under that lock.
Returned intent retains its original scope and still requires current durable
binding/entitlement checks before persistence or execution.

Three source-fence race tests passed25 repetitions; all49 WhatsApp race cases
and84 client cases passed, as did Go vet/build. This is not a registered SDK
callback and does not independently verify the supplied device or establish a
signed event hop. A future lifecycle controller must resolve the actual provider
identity and preserve captured-source provenance when registering callbacks.
Legacy asynchronous Session handlers are not claimed to be fully isolated by
this private increment. No connection, permission or sender is activated.
