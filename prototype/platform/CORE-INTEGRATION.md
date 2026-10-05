# Existing restaurant core integration

This stage uses the original Go/PostgreSQL application, not the simplified
`prototype/tenant` menu or its synthetic order implementation.

## Implemented

- Fixed, deployment-owned registry maps restaurant IDs to distinct origins.
  User/model input cannot choose an upstream URL, path or credential.
- Read original public catalog: categories, available items/options, prices,
  languages, tax settings and published appearance, including all five templates.
  Table QR tokens and unexpected fields are stripped. Stock quantity is not
  fabricated from the public availability flag.
- Original `/storefront-api/quote` adapter preserves the existing full contract.
- New `/storefront-api/preview` shares the core pricing/coverage/stock logic but
  accepts no name, phone, street address or payment data. Full order creation
  retains its existing contact/address validation. Preview does not reserve
  inventory, create orders, store contacts or charge anything.
- MCP core mode exposes three read-only tools: search, menu and cart preview.
  It does not expose synthetic checkout, order-status, Events or a misleading
  synthetic widget alongside actual core data.
- Bounded responses, timeouts, redirects refused, strict request schemas and
  fixed public error codes. Server-side configured origins are trusted routing
  inputs; do not build this configuration from customer input.

## Run locally

Install dependencies in this directory with `npm ci`. Run the original Go
restaurant application with a dedicated development database. Prepare a JSON
configuration outside version control, for example:

    [{"id":"restaurant-a","name":"Synthetic A","cuisine":"saudi","baseUrl":"http://127.0.0.1:3001"}]

Start the bridge with:

    CORE_RESTAURANTS_FILE=/absolute/path/to/restaurants.json node core-server.mjs

Default origin is `http://127.0.0.1:18788`; `/mcp` is the MCP endpoint and `/health`
reports `core_readonly`. `CORE_BASE_URL` may choose a different loopback port.
The local runner rejects remote/public binding. This is a local development
integration, not a deployed or account-accepted ChatGPT plugin.

## Verification

    node --test core-adapter.test.mjs mcp.test.mjs

From repository root, with an isolated disposable restaurant database and Node
dependencies installed, run:

    TEST_CORE_ADAPTER=1 go test -race ./cmd/server -run 'TestRestaurant(CoreAdapter|Preview)'

The cross-language test runs real Go HTTP with two separate DB schemas, different
prices, all five templates and pickup/delivery/table modes. It checks direct Go
quote equality against Node adapter and actual SDK MCP HTTP responses. Original
table tokens are not enumerated by the menu. No external account/payment is used.

## Remaining work

This is the first integration stage. Owned checkout handoff, identity binding,
order status, durable events, restaurant lifecycle/roles, complete Flutter parity
and external provider acceptance remain. Keep the existing synthetic prototype
available for its own tests, but never report it as completed production parity.
No default production routing or database import is changed by this stage.
