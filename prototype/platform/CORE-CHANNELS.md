# Order channel policy

Only `web` and `chatgpt` are active channels. Existing order/stock/payment authority
and idempotent retries remain in the original restaurant core. Disabling a channel
blocks new orders, not recovery or settlement of accepted work. Settings are
versioned and audited; manager permissions and request signatures remain required.

WhatsApp QR/Cloud adapters and synthetic connection settings were removed on
2026-10-09. Old database rows are retained for rollback/history but excluded from
active views and cannot be enabled through the current API. No external accounts
or private historical data were purged. See the repository restore tag.
