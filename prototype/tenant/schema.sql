-- Synthetic fixture service only. Versioned production migrations are a separate gate.
CREATE TABLE IF NOT EXISTS tenant_meta (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    tenant_id text NOT NULL,
    event_sequence bigint NOT NULL DEFAULT 0 CHECK (event_sequence >= 0)
);
CREATE TABLE IF NOT EXISTS menu_items (
    id text PRIMARY KEY,
    name text NOT NULL,
    price_minor bigint NOT NULL CHECK (price_minor BETWEEN 1 AND 100000000),
    stock bigint NOT NULL CHECK (stock >= 0)
);
CREATE TABLE IF NOT EXISTS orders (
    id text PRIMARY KEY,
    owner_id text NOT NULL,
    idempotency_hash bytea NOT NULL UNIQUE CHECK (octet_length(idempotency_hash) = 32),
    request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
    document jsonb NOT NULL,
    payment_provider text NOT NULL DEFAULT '',
    payment_reference text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_recent ON orders(created_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS orders_payment_reference
    ON orders(payment_provider,payment_reference) WHERE payment_reference<>'';
CREATE TABLE IF NOT EXISTS event_outbox (
    sequence bigint PRIMARY KEY,
    event_id text NOT NULL UNIQUE,
    order_id text NOT NULL REFERENCES orders(id),
    version bigint NOT NULL,
    document jsonb NOT NULL,
    UNIQUE(order_id,version)
);
