# Live core menu preview in ChatGPT

Implemented on 9 October 2026. This component belongs to the existing remote MCP
server and its deployment. It does not require a desktop-only plugin package,
another website, new credentials, or additional OAuth scopes.

## Binding and boundaries

- `get_restaurant_menu` points to the versioned
  `ui://onlinu/core-menu-v1.html` MCP Apps resource. Core mode previously had no UI
  resource; the older synthetic directory remains separate.
- The resource is self-contained Arabic/RTL HTML. It initializes the standard
  MCP Apps iframe bridge and consumes the opening tool result. A feature-detected
  `window.openai` compatibility path is available for older hosts.
- Quantity and per-unit add-on selections call `quote_cart` through the host.
  All line totals, tax and the total displayed come from that returned quote.
  No network access, catalog fixture, pricing calculation, credentials or
  persistent cart storage is embedded in the component.
- Only menu and quote tools are available to this core UI. Quote results do not
  instantiate another widget. Existing model-facing tool access remains subject
  to the same schemas and server-side authorization.
- The component supports **pickup price previews only**. Closed/unavailable
  pickup is explained. Empty payment-method lists remain valid price previews.
  There are no checkout, order, contact, address, location or payment controls.
- Edits immediately hide the old price. A short debounce limits repeated calls;
  view/cart/request generations reject stale replies, including after reset,
  refresh and teardown. Returned item quantities and option IDs must match the
  request before a quote can be shown. Initial errors and cancellation leave an
  actionable state; explicit refresh can recover.
- Resource CSP denies external connections and resources. Merchant text is
  rendered with `textContent`. Refresh deliberately clears the cart.

## Verification

Protocol tests cover modern/legacy resource discovery, metadata, unchanged OAuth
gates and UI restrictions. `core-menu-ui.test.mjs` covers the sandboxed iframe
handshake, 70/82 SAR sample cart, add-ons, reset, stale responses, quote and initial
errors, cancellation, refresh, narrow viewport, hostile text, legacy bridge and
teardown. These browser tests require `CORE_BROWSER_TEST=1` and Chromium.

`TestRestaurantIntelligentUIReadOnlyExperiment` also reads the UI resource from
the actual MCP server. With `CORE_BROWSER_TEST=1`, its controls invoke real
Go/PostgreSQL fixture prices through MCP, verify the fixture's 70/80 SAR totals,
and leave zero orders/customers. This older isolated fixture has 5 SAR rice;
the standalone 70/82 fixture uses 6 SAR rice. Neither is a live merchant claim.

The existing GitHub CI test job enables `CORE_BROWSER_TEST=1` for both suites.
`CORE_MENU_SCREENSHOT` retains the real-core browser screenshot as
`onlinu-core-menu-preview-<commit>`. A passing test host is **not** proof of
ChatGPT rendering; that requires the connected host after deployment.

Local execution of Chromium in the authoring shell was blocked by its Unix
socket restriction. The separately exposed cloud browser could not reach that
executor's loopback fixture. No public tunnel or security-setting change was
used. Local MCP and isolated real-core tests remain independently useful.

## Deployment and actual host acceptance

Use the existing reviewed branch/commit and normal operator deployment. Rebuild
the **control-plane image** from `prototype/platform/Dockerfile.control`; its
explicit source allowlist includes `core-menu-ui.mjs`. No dependency install,
database migration, secret, OAuth scope or redirect change is required.

After deployment:

1. Verify `get_restaurant_menu` discovery points to `core-menu-v1.html` and that
   `resources/read` returns the HTML with `text/html;profile=mcp-app`.
2. Refresh the existing custom connection's tool discovery if the host still
   has the older descriptor. Keep the same endpoint and account; do not replace
   them with a desktop-only import or widen access.
3. In the connected ChatGPT conversation, request the restaurant's menu. Verify
   the real rendered component and its quantity/add-on controls. Check a known
   cart against fresh `quote_cart` results, then test rapid edits and reset.
4. Record host success or the exact rendering blocker separately from server/CI
   results. Do not describe static generated UI as a working MCP binding.

Current official references:
[MCP Apps UI](https://developers.openai.com/plugins/build/chatgpt-ui),
[tool/resource metadata](https://developers.openai.com/plugins/reference).
