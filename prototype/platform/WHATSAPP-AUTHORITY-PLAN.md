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
