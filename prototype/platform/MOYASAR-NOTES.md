# Moyasar sandbox boundary

This isolated adapter accepts only a documented `sk_test_` secret key. It never reads an environment variable, creates a timer, or performs a request on import. Tests inject a mock `fetch`; no real or sandbox payment request is part of the test suite. The caller must explicitly select this adapter. A local simulator is not a Moyasar sandbox test.

Official references checked 2026-09-30 before implementation:

- [API introduction](https://docs.moyasar.com/api/api-introduction): the authenticated API key determines live/test request mode; test mode does not reach banking networks.
- [Authentication](https://docs.moyasar.com/api/authentication): secret test keys use `sk_test_`; HTTP Basic authentication uses the secret key as username and an empty password.
- [Create invoice](https://docs.moyasar.com/api/invoices/01-create-invoice): hosted checkout URL, separate server notification/browser return URLs, integer minor-unit amount, and invoice payment attempts.
- [Idempotency](https://docs.moyasar.com/api/idempotency): `given_id` covers payment creation. This does not establish invoice creation or refund idempotency.
- [Webhook reference](https://docs.moyasar.com/api/other/webhooks/webhook-reference): the webhook envelope has a `live` field; the documented invoice/payment fetch schemas do not require an equivalent per-object flag.

`testMode: true` records the authenticated test-key request evidence. It does not claim a nonexistent per-object environment assertion or an actual account test. Any explicit conflicting response mode is rejected. A webhook body is not accepted as payment proof by this adapter. The caller must use authenticated invoice inspection; the adapter checks invoice ID, reference, amount, SAR currency, individual payment identity, invoice linkage, capture/refund amounts, and contradictions before returning `paid`.

The API host is fixed and redirects are disabled. Both callback and return URLs must use HTTPS on the same origin, so local HTTP alone is insufficient for an actual hosted sandbox test. Callback configuration is trusted platform configuration, never customer input. Returned checkout URLs must match the exact Moyasar checkout host and invoice path. Names, addresses, telephone numbers, card data and provider payloads are never returned or passed in invoice creation; the description contains only the synthetic server-issued order reference. Errors contain only stable codes.

`createInvoice` is one POST without retries. Any unknown POST outcome, including an invalid successful response, throws `moyasar_outcome_unknown`. The platform must durably reserve/journal the attempt before calling and must not automatically retry unknown outcomes. `inspectInvoice` performs one read. `review` is never settlement permission. No refund/capture/void operation is exposed. Persistent journaling, tenant authorization, webhook abuse controls, operator reconciliation and production merchant/data-residency acceptance belong to the caller and subsequent release gates.

Exports: `createMoyasarTestGateway({secretKey, fetchImpl = globalThis.fetch})` returning `createInvoice({order, callbackUrl, returnUrl})` and `inspectInvoice({invoiceId, order})`. `order` requires `{id,totalMinor,currency:'SAR'}` with an integer total of at least 100 minor units. Inspection status is `pending`, `paid`, `failed`, `refunded` or `review`; its `paymentId` is null if no unique collected payment can be established. Stable error codes are `moyasar_test_key_required`, `moyasar_invalid_request`, `moyasar_outcome_unknown`, `moyasar_unavailable`, `moyasar_invalid_response`, `moyasar_payment_mismatch`, and `moyasar_test_mode_unverified`.
