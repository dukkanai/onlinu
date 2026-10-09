import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Field } from "../src/restaurant/admin/Fields";
import { LanguageSettings } from "../src/restaurant/admin/LanguageSettings";
import { canCollectCash, formatMinorInput, nextStatuses, parseMinor, paymentAllowsStatus, safeImageUrl, safeMapUrl, tableLink, validCatalog } from "../src/restaurant/admin/helpers";
import { paymentConfigPayload, PaymentProviderEditor, PaymentsPanel, type PaymentProviderConfig } from "../src/restaurant/admin/PaymentsPanel";
import { LocaleProvider } from "../src/restaurant/i18n";
import type { Catalog, Order } from "../src/restaurant/types";

test("admin field accessible names exclude select options and hint text", () => {
  const select = renderToStaticMarkup(createElement(Field, { label: "Currency", hint: "Choose your currency.", children: createElement("select", { defaultValue: "SAR" }, createElement("option", { value: "SAR" }, "SAR"), createElement("option", { value: "AED" }, "AED")) }));
  const label = /<label id="([^"]+)" for="([^"]+)">([^<]+)<\/label>/.exec(select);
  assert.ok(label);
  assert.equal(label[3], "Currency");
  const control = /<select([^>]+)>/.exec(select)![1];
  assert.equal(/\bid="([^"]+)"/.exec(control)?.[1], label[2]);
  assert.equal(/aria-labelledby="([^"]+)"/.exec(control)?.[1], label[1]);
  const hintID = /<small id="([^"]+)">Choose your currency\.<\/small>/.exec(select)?.[1];
  assert.ok(hintID);
  assert.equal(/aria-describedby="([^"]+)"/.exec(control)?.[1], hintID);

  const amount = renderToStaticMarkup(createElement(Field, { label: "Delivery fee", hint: "Enter an amount in SAR.", children: createElement("input", { inputMode: "decimal", defaultValue: "0.00" }) }));
  assert.match(amount, /<label[^>]+>Delivery fee<\/label>/);
  assert.match(amount, /<input[^>]+aria-labelledby="[^"]+"[^>]+aria-describedby="[^"]+"/);
  assert.ok(!/<label[^>]*>[^]*Enter an amount[^]*<\/label>/.test(amount));

  const wrapped = renderToStaticMarkup(createElement(Field, { label: "Search orders", children: createElement("div", null, createElement("span", { "aria-hidden": true }, "⌕"), createElement("input", { type: "search" })) }));
  const wrappedLabel = /<label id="([^"]+)" for="([^"]+)">Search orders<\/label>/.exec(wrapped);
  assert.ok(wrappedLabel);
  assert.equal(/<input[^>]+aria-labelledby="([^"]+)"/.exec(wrapped)?.[1], wrappedLabel[1]);
  assert.equal(/<input[^>]+\bid="([^"]+)"/.exec(wrapped)?.[1], wrappedLabel[2]);
});

test("admin prices preserve ISO minor units and reject rounding or malformed values", () => {
  assert.equal(parseMinor("19.99", 2), 1999);
  assert.equal(parseMinor("0.29", 2), 29);
  assert.equal(parseMinor("١٢٫٥٠", 2), 1250);
  assert.equal(parseMinor("۱۲.۵۰۰", 3), 12500);
  assert.equal(parseMinor("१२,५०", 2), 1250);
  assert.equal(parseMinor("12,50", 2), 1250);
  assert.equal(parseMinor("1,234,567", 2), null);
  assert.equal(parseMinor("125", 0), 125);
  assert.equal(parseMinor("125.5", 0), null);
  assert.equal(parseMinor("1.234", 2), null);
  assert.equal(parseMinor("1e3", 2), null);
  assert.equal(parseMinor("-1", 2), null);
  assert.equal(parseMinor("", 2), null);
  assert.equal(parseMinor("1000000.01", 2), null);
  assert.equal(formatMinorInput(1234, 3), "1.234");
});

test("admin transitions respect fulfilment method and terminal states", () => {
  assert.deepEqual(nextStatuses("delivery", "new"), ["accepted", "cancelled"]);
  assert.deepEqual(nextStatuses("delivery", "ready"), ["out_for_delivery", "cancelled"]);
  assert.deepEqual(nextStatuses("pickup", "ready"), ["completed", "cancelled"]);
  assert.deepEqual(nextStatuses("table", "ready"), ["completed", "cancelled"]);
  assert.deepEqual(nextStatuses("delivery", "out_for_delivery"), ["completed", "cancelled"]);
  assert.deepEqual(nextStatuses("delivery", "completed"), []);
  assert.deepEqual(nextStatuses("table", "cancelled"), []);
});

test("admin map and QR URLs cannot use user-supplied link schemes", () => {
  assert.equal(safeMapUrl(null, 46), null);
  assert.equal(safeMapUrl(91, 46), null);
  assert.equal(safeMapUrl(24, Infinity), null);
  const map = new URL(safeMapUrl(24.7, 46.6)!);
  assert.equal(map.origin, "https://www.openstreetmap.org");
  assert.equal(map.searchParams.get("mlat"), "24.7");
  const qr = new URL(tableLink('"><script>alert(1)</script>', "https://restaurant.example"));
  assert.equal(qr.origin, "https://restaurant.example");
  assert.equal(qr.pathname, "/");
  assert.equal(qr.searchParams.get("table"), '"><script>alert(1)</script>');
});

test("admin image URLs accept local validated uploads and HTTPS images only", () => {
  assert.equal(safeImageUrl("/restaurant-media/abc_123.png"), true);
  assert.equal(safeImageUrl("https://images.example/dish.jpg"), true);
  for (const url of ["javascript:alert(1)", "data:image/png,hello", "//evil.example/photo.jpg", "http://images.example/photo.jpg", "/other/photo.png", "https://user:pass@example.org/image.png", "https://example.org/image.svg", "https://example.org/image.jpg#svg", "https://example.org\\evil/image.jpg"]) assert.equal(safeImageUrl(url), false, url);
});

function fixture(): Catalog {
  return { version: 1, settings: { name: "Demo", description: "", address: "", phone: "", logoUrl: "", currency: "SAR", defaultLanguage: "ar", menuLanguage: "ar", demo: true, acceptingOrders: true, deliveryEnabled: true, pickupEnabled: true, tableEnabled: true, deliveryFeeMinor: 100, deliveryMinimumMinor: 0, deliveryAreas: [], deliveryRadiusKm: 0, latitude: null, longitude: null, requireDeliveryLocation: false, pickupInstructions: "", openingHours: "", paymentInstructions: "" }, categories: [{ id: "category", name: "Dishes", sort: 0 }], items: [{ id: "dish", categoryId: "category", name: "Sample", description: "", priceMinor: 1250, imageUrl: "", available: true, sort: 0, options: [{ id: "extra", name: "Free extra", priceMinor: 0, available: true }] }], tables: [{ id: "table", name: "Table 1", code: "", active: true }] };
}

test("language settings offer only Arabic and English while preserving legacy menu metadata", () => {
  for (const menuLanguage of ["ar", "en", "fr", "ur", ""]) {
    const catalog = fixture();
    catalog.settings.menuLanguage = menuLanguage;
    catalog.items[0].name = "Soupe à l’oignon";
    const before = structuredClone(catalog);
    const html = renderToStaticMarkup(createElement(LocaleProvider, { defaultLocale: "en", children: createElement(LanguageSettings, { settings: catalog.settings, onChange: () => { throw Error("Rendering must not relabel menu content"); } }) }));
    for (const label of ["Default interface language", "Menu content language"]) {
      const controlId = new RegExp(`<label[^>]*for="([^"]+)"[^>]*>${label}</label>`).exec(html)?.[1];
      assert.ok(controlId, label);
      const control = [...html.matchAll(/<select([^>]*)>([\s\S]*?)<\/select>/g)].find(match => match[1].includes(`id="${controlId}"`));
      assert.ok(control, label);
      const enabledOptions = [...control[2].matchAll(/<option([^>]*)>/g)].filter(match => !match[1].includes("disabled")).map(match => /value="([^"]*)"/.exec(match[1])?.[1]);
      assert.deepEqual(enabledOptions, ["ar", "en"], `${label}: exactly two selectable languages`);
      if (label === "Menu content language" && !["ar", "en"].includes(menuLanguage)) {
        assert.match(control[2], /<option[^>]*value=""[^>]*disabled=""[^>]*selected=""[^>]*>Keep the existing menu language<\/option>/);
      }
    }
    assert.deepEqual(catalog, before, "Merchant text and legacy language metadata remain unchanged");
  }
});

test("catalog validation catches invalid delivery centres, orphan dishes and fractional minor prices", () => {
  assert.equal(validCatalog(fixture()), true);
  const catalog = fixture(); catalog.settings.deliveryRadiusKm = 5;
  assert.equal(validCatalog(catalog), false);
  catalog.settings.latitude = 24; catalog.settings.longitude = 46;
  assert.equal(validCatalog(catalog), true);
  catalog.items[0].categoryId = "missing";
  assert.equal(validCatalog(catalog), false);
  catalog.items[0].categoryId = "category"; catalog.items[0].priceMinor = 12.5;
  assert.equal(validCatalog(catalog), false);
  catalog.items[0].priceMinor = 1250; catalog.settings.deliveryEnabled = false; catalog.settings.pickupEnabled = false; catalog.settings.tableEnabled = false;
  assert.equal(validCatalog(catalog), false);
});

test("payment settings never replay saved credentials and clearing is explicit", () => {
  const config: PaymentProviderConfig = { id: "hyperpay", name: "HyperPay", enabled: false, mode: "test", configured: true, fields: [{ key: "entityId", label: "Entity ID", secret: false, required: true }, { key: "accessToken", label: "Access token", secret: true, required: true }], values: { entityId: "entity" }, secretSet: { accessToken: true } };
  assert.deepEqual(paymentConfigPayload(config, true, "test", { entityId: "new", accessToken: "must-not-copy", unknown: "ignored" }, { accessToken: "", unknown: "ignored" }, []), { enabled: true, mode: "test", values: { entityId: "new" }, secrets: {}, clearSecrets: [] });
  assert.deepEqual(paymentConfigPayload(config, false, "test", {}, { accessToken: "replacement" }, ["accessToken", "accessToken", "entityId"]), { enabled: false, mode: "test", values: {}, secrets: {}, clearSecrets: ["accessToken"] });
  assert.deepEqual(paymentConfigPayload(config, true, "live", {}, { accessToken: "replacement" }, []).secrets, { accessToken: "replacement" });
});

test("payment editors show provider limitations without rendering stored credentials", () => {
  const config: PaymentProviderConfig = { id: "myfatoorah", name: "MyFatoorah", enabled: false, mode: "test", configured: true, limitation: "merchant_sar_currency", fields: [{ key: "apiToken", label: "API token", secret: true, required: true }], values: { apiToken: "MUST-NOT-RENDER" }, secretSet: { apiToken: true } };
  const render = (provider: PaymentProviderConfig) => renderToStaticMarkup(createElement(LocaleProvider, { defaultLocale: "en", children: createElement(PaymentProviderEditor, { config: provider, country: "SA", onSaved: () => {} }) }));
  const html = render(config);
  assert.match(html, /base currency is SAR/);
  assert.match(html, /KWD as their base currency cannot be used/);
  assert.match(html, /type="password"[^>]+value=""/);
  assert.doesNotMatch(html, /MUST-NOT-RENDER/);
  assert.match(render({ ...config, id: "hyperpay", name: "HyperPay", limitation: "hyperpay_test_only" }), /<option value="live" disabled="">/);
  assert.match(render({ ...config, id: "paytabs", name: "PayTabs", limitation: "merchant_mode_credentials" }), /cannot turn live merchant credentials into a sandbox account/);
  const panel = renderToStaticMarkup(createElement(LocaleProvider, { defaultLocale: "en", children: createElement(PaymentsPanel) }));
  assert.match(panel, /Demo restaurants use test payment gateways only/);
  assert.match(panel, /demo mode turned off use live gateways only/);
});

test("cash controls cannot settle card, reviewed payments, or terminal orders", () => {
  const order = { status: "accepted", payment: { method: "cash_before", status: "unpaid", provider: "", amountMinor: 1000 } } as Order;
  assert.equal(canCollectCash(order), true);
  assert.equal(paymentAllowsStatus(order, "preparing"), false);
  assert.equal(paymentAllowsStatus(order, "cancelled"), true);
  order.payment!.status = "paid";
  assert.equal(canCollectCash(order), false);
  assert.equal(paymentAllowsStatus(order, "preparing"), true);
  for (const status of ["review", "refunded", "pending", "failed"]) { order.payment!.status = status; assert.equal(canCollectCash(order), false); }
  order.payment!.status = "unpaid"; order.payment!.method = "card";
  assert.equal(canCollectCash(order), false);
  assert.equal(paymentAllowsStatus(order, "ready"), false);
  order.payment!.method = "cash_on_delivery";
  assert.equal(paymentAllowsStatus(order, "preparing"), true);
  assert.equal(paymentAllowsStatus(order, "completed"), false);
  order.status = "completed"; assert.equal(canCollectCash(order), false);
  delete order.payment; assert.equal(paymentAllowsStatus(order, "completed"), true);
});

test("brand, inclusive tax and per-mode payment policy drafts reject unsafe settings", () => {
  const catalog = fixture();
  catalog.settings.primaryColor = "url(https://example.org)";
  assert.equal(validCatalog(catalog), false);
  catalog.settings.primaryColor = "#103B45"; catalog.settings.coverUrl = "javascript:alert(1)";
  assert.equal(validCatalog(catalog), false);
  catalog.settings.coverUrl = ""; catalog.settings.taxEnabled = true; catalog.settings.taxNumber = "";
  assert.equal(validCatalog(catalog), false);
  catalog.settings.taxNumber = "TEST"; catalog.settings.taxRateBps = 1500;
  assert.equal(validCatalog(catalog), true);
  catalog.settings.taxRateBps = 1500.1; assert.equal(validCatalog(catalog), false);
  catalog.settings.taxRateBps = 1500; catalog.settings.paymentMethods = { table: ["cash_before"], delivery: ["cash_on_delivery"], pickup: [] };
  assert.equal(validCatalog(catalog), false);
  catalog.settings.paymentMethods.pickup = ["card"];
  assert.equal(validCatalog(catalog), true);
  catalog.settings.paymentMethods.pickup = ["cash_after"];
  assert.equal(validCatalog(catalog), false);
});

test("Paylink settings expose only a disabled live option and masked credential controls", () => {
  const config: PaymentProviderConfig = { id: "paylink", name: "Paylink", enabled: false, mode: "test", configured: false, limitation: "paylink_sandbox_only", fields: [{ key: "apiId", label: "API ID", secret: true, required: true }, { key: "secretKey", label: "Secret key", secret: true, required: true }], values: { apiId: "MUST-NOT-RENDER", secretKey: "MUST-NOT-RENDER" }, secretSet: { apiId: false, secretKey: false } };
  const html = renderToStaticMarkup(createElement(LocaleProvider, { defaultLocale: "en", children: createElement(PaymentProviderEditor, { config, country: "SA", onSaved: () => {} }) }));
  assert.match(html, /Experimental Paylink sandbox only/);
  assert.match(html, /minimum SAR 5/);
  assert.match(html, /<option value="live" disabled="">/);
  assert.equal((html.match(/type="password"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /MUST-NOT-RENDER/);
  assert.match(html, /API ID/);
});
