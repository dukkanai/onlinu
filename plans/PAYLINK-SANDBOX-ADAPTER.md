# Paylink hosted checkout: experimental sandbox increment

Status: code-only integration, disabled by default, test mode only. No provider
account was opened or configured and no real Paylink API, checkout, credential,
order, payment, webhook, refund, or deployment was used for this increment.
Production activation is rejected by configuration and by the adapter itself.

## Scope and architecture

The restaurant Go core owns payment credentials, durable attempts, server-side
verification and reconciliation. The current Node control plane delegates to that
core; it only gains the matching provider/checkout URL allowlist. No duplicate
Node Paylink payment engine is added, and the older standalone Moyasar prototype
is unchanged.

The admin provider is off until explicitly configured and enabled. `apiId` and
`secretKey` are both secret fields: they never appear in public configuration,
HTML, URLs or errors. Existing payment-config encryption is reused, including
immutable attempt snapshots. Its key currently shares the database with its
ciphertext, so this is **not** protection from a whole-database compromise. An
external-key migration and its security acceptance remain launch requirements;
this adapter does not claim to finish that work.

## Provider contract

Official documentation reviewed 9 October 2026:

- [Environment setup](https://developer.paylink.sa/docs/environment-setup):
  testing API `https://restpilot.paylink.sa`; production API
  `https://restapi.paylink.sa`. Only the testing host is enabled here.
- [Authentication](https://developer.paylink.sa/docs/authentication):
  `POST /api/auth` with `apiId`, `secretKey`, `persistToken: false`. The returned
  `id_token` is used as a Bearer token. A fresh short-lived token is requested
  for each operation; tokens are not cached or persisted. Expiry/authentication
  failure stops that operation; a later explicit/reconciler read authenticates
  again. There is no automatic authentication or creation retry.
- [Add invoice](https://developer.paylink.sa/docs/add-invoice):
  `POST /api/addInvoice`, minimum SAR 5, customer name/mobile and products.
  The unique local attempt ID is sent as `orderNumber`; the human restaurant
  number is only the product title. One gross-total line preserves the server
  quote. Optional SMS, extra tax, address, email and webhook fields are absent.
  Both callback/cancel browser destinations use the local return bridge.
- [Get invoice](https://developer.paylink.sa/docs/get-invoice) and
  [payment processing](https://developer.paylink.sa/docs/payment-processing):
  `GET /api/getInvoice/{transactionNo}` is the only source of payment evidence.
  `success` describes the API operation, not payment. The transaction ID,
  `gatewayOrderRequest.orderNumber`, explicit SAR currency, and outer/nested
  amounts must be coherent; settlement also compares to the persisted local
  attempt, order total and demo mode. Pending stays pending even with declined
  card errors. Canceled maps to failed, never refunded; a paid-to-canceled
  transition is held for review. Unknown states cannot settle.
- [Recurring payment](https://developer.paylink.sa/docs/recurring-payment)
  includes a pilot hosted URL example. The only accepted sandbox redirect is
  `https://paymentpilot.paylink.sa/pay/info/{numeric transactionNo}`, with no
  credentials, query, fragment, explicit port, alternative path or subdomain.
  The ordinary addInvoice documentation uses a production response example;
  it does **not** explicitly guarantee the pilot URL for ordinary sandbox
  invoices. Later authorized sandbox acceptance must verify this. A different
  response URL fails closed; it must not silently expand the allowlist.
- [Payment webhook](https://developer.paylink.sa/docs/payment-webhook): account-
  level registration needs a separate authenticated routing design. This
  increment does not advertise or accept Paylink webhooks. The local browser
  return never trusts `TransactionNo`, `OrderNumber`, status or amount supplied
  by the browser; an authorized status refresh queries the persisted invoice.
- [Refund an order](https://developer.paylink.sa/docs/refund-an-order): the
  documented endpoint requires a partner role. No automatic Paylink refund or
  cancellation API is exposed. Invoice cancellation is not a refund receipt.
  Existing explicitly reviewed manual refund records remain separate.

API endpoints are fixed in code. Provider `checkUrl`, receipt URLs and error
bodies are ignored; HTTP redirects are refused. Shared request timeouts and the
256 KiB response limit apply. A create request is attempted once after reserving
its durable attempt. Unknown outcomes enter review, and repeated starts do not
create a second invoice. Repeated return/status requests use the existing durable
lookup lease and cannot turn browser data into payment evidence.

## Acceptance and remaining gates

All provider traffic in the new tests uses an injected in-memory HTTP transport
and invented synthetic strings. Published Paylink test credentials are neither
included nor used. Coverage includes create/query, short-lived auth, expired
credentials, malformed/oversized responses, timeout/redirect handling, minimum
amount/name/mobile preflight, live-mode refusal, exact host/path checks, malicious
`checkUrl`, incoherent amounts/currency/transaction/order references, pending card
failures, canceled versus refunded, and no automatic refund/webhook operation.

Additional isolated PostgreSQL tests cover default-off/config secrecy, repeated
browser returns and starts, lookup throttling, uncertain creation non-retry,
wrong local amount and paid-to-canceled review. These tests require the deliberately
named `astracalls_restaurant_test` database and create/drop only their own schemas.
Local socket creation is blocked in the current executor, so database acceptance
must run in an approved test runtime/CI; do not report skipped cases as passed.
The npm/tsx test entry point encounters the same local IPC socket restriction.

Before live support: external-key security acceptance; explicit owner-approved
sandbox account setup using only sandbox credentials; ordinary invoice URL and
paid/pending/declined/canceled acceptance; recovery/reconciliation and operator
procedures; account-level webhook authentication/rate-limit design if needed;
merchant eligibility and refund capabilities. Production keys, real charges and
deployment require separate approval and a deliberate code change removing the
live guard only after these gates. No Paylink credential is requested by this
code-only work.
