# Payment evidence and bounded reconciliation

Implementation and isolated verification, 9 October 2026. No deployment,
merchant configuration, live payment, or provider refund execution is included.

## Moyasar settlement evidence

The Go invoice adapter follows the strict evidence boundary of the Node test
adapter. An aggregate `paid` invoice alone is insufficient. There must be exactly
one collected payment with a unique ID, the same invoice ID, gross amount and
currency, complete nonnegative capture/refund amounts within the gross amount,
and a coherent paid/captured status. A competing authorization, duplicate charge,
partial capture/refund, inconsistent refund, or malformed evidence cannot mark
an order paid or establish new captured-fund authority. A complete refund also
requires matching refunded invoice/payment status and the exact gross amount.

Provider mode comes from the saved credential snapshot. The invoice/payment
schema does not require response mode flags; supplied flags must be typed and
consistent with that credential's mode. Fetches remain authenticated reads.
HTTP/JSON failures remain errors with durable retry work; contradictory decoded
evidence becomes `review`. Neither a callback nor a browser return is proof.

Official schema checked on 9 October 2026:
https://docs.moyasar.com/api/invoices/04-show-invoice
https://docs.moyasar.com/api/payments/02-fetch-payment
https://docs.moyasar.com/api/api-introduction

Moyasar refund execution remains deliberately manual. Reading a provider-confirmed
refund does not initiate one, and manual reporting still is not provider proof.

## Limited post-capture watch

Clean paid attempts previously left the automatic reconciliation queue entirely.
They now receive best-effort read-only checks with a finite window and minimum
per-attempt interval. Capture-verified attempts that move to `review`, such as
after an external partial refund, stay in this same slow watch so a later full
refund can still be discovered. Unproven review attempts retain the existing
seven-day uncertainty lane. These defaults are an operational cost/recovery tradeoff,
not a provider refund deadline, a business refund policy, or a guarantee that
every external refund will be discovered.

Application environment settings, validated at startup:

- `WACALLS_PAYMENT_SETTLEMENT_WATCH_DAYS`: default 30; integer 1–365.
- `WACALLS_PAYMENT_SETTLEMENT_CHECK_MINUTES`: default 60; integer 15–1440.

No deployment environment values are changed by this implementation. Longer
windows mean more provider reads and a larger rotating queue. Shorter intervals
permit earlier detection but do not guarantee that latency under backlog or
provider failures. The minute worker processes at most eight pending/notified
attempts and two watched settlement attempts per run. Each group has a separate time
budget (25 seconds and 20 seconds), within a 45-second payment-reconciliation
budget; cooling-down rows do not consume batch slots. The refund-ledger worker
then receives an independent 45-second budget so slow payment reads cannot
starve existing refund work. Cycles remain sequential and may take longer than
one minute when both queues are slow; ticker events do not create overlapping
cycles. The watched settlement lane therefore
permits at most 120 attempt lookups per hour; some adapters need multiple
read-only provider requests per lookup. Pending/notified work has its existing
30-second lease and retains durable retries until a successful reconciliation.

`settlement_watch_started_at` is set once when a new attempt first proves
capture; later refreshes or `updated_at` changes do not extend it. The additive,
idempotent schema change does not guess historical capture times or rewrite
payment amounts/statuses. Legacy paid/captured rows use their creation time as
a conservative watch anchor until that same anchor is persisted on refresh.
Changing the configured window changes coverage relative to that fixed anchor.

Hooks and explicit authorized refreshes still work after the routine window.
Lookup errors preserve the last factual status and dirty work; a newer hook
generation survives an older lookup's completion. Claiming any lookup records
dirty work before calling the provider, so cancellation/crash or a failed local
settlement write cannot silently consume the retry. Unknown or unsettled
evidence never authorizes a new refund or charge.

## Administrative visibility and limits

The existing authenticated `GET /api/restaurant/payments` response adds a
`reconciliation` object with settings and counts only:

- `dueSettlements`: paid/capture-verified review attempts currently due within the watch.
- `overdueSettlements`: those due attempts not checked for twice the configured interval
  (or never checked); this indicates backlog, not a financial outcome.
- `outsideAutomaticWindow`: paid/capture-verified review attempts beyond the watch, requiring
  provider hooks or explicit refresh for further detection.
- `pendingRefreshes`: durable work, including failed reads or notifications.
- `settlementBatchLimit`: 2.

This is an API-level operational summary, not a new rendered admin UI or alert.
It exposes no order identifiers, customer data, credentials, or other tenant's
state. Outside-window counts do not mean those payments have been refunded.
No new webhook is configured. Provider-specific discovery limitations remain,
including the documented PayTabs cart-query limitation; polling does not make
an incomplete provider API exhaustive. Merchant acceptance and explicit
deployment/configuration review remain separate.

## Isolated regression coverage

Fake transports only, disposable PostgreSQL test schemas, no real provider
requests: missing/contradictory/duplicate payment evidence; authorized-only
capture and refund reservation rejection; later dashboard refunds without
hooks; cadence/window bounds; fixed legacy anchors and repeated initialization;
bounded batch fairness; captured partial-to-full refunds remain watched after
the uncertainty window; slow payment reads cannot starve refund-ledger lookups;
failed-read retries; cancellation after a read; durable
hook generations; and the additive administrator-only summary. Existing
payment/refund tests remain part of the race-test gate.
