// Run this async function only against the disposable, isolated restaurant
// server below. It replaces that TEST server's catalog and creates synthetic
// orders/accounts. All browser traffic is restricted to this one origin.
async (page) => {
  const origin = "http://127.0.0.1:18083";
  const adminKey = "restaurant-browser-test-key";
  const browser = page.context().browser();
  if (!browser) throw new Error("This harness requires an isolated browser context");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US" });
  const checks = [], failures = [];
  const run = `saudi_${Date.now()}`;
  const dish = "Saudi-only test dish";
  const verify = (ok, description) => { if (!ok) throw new Error(description); checks.push(description); };
  const safeURL = (path) => {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || /[\u0000-\u0020\\]/.test(path)) throw new Error("Unsafe isolated request path");
    return origin + path;
  };
  const request = (path, method = "GET", data, admin = false, headers = {}) => context.request.fetch(safeURL(path), {
    method, maxRedirects: 0, timeout: 15000,
    headers: { Origin: origin, ...(admin ? { "X-API-Key": adminKey } : {}), ...headers },
    ...(data === undefined ? {} : { data }),
  });
  const api = async (...args) => {
    const response = await request(...args);
    if (!response.ok()) throw new Error(`Isolated ${args[1] || "GET"} ${args[0]} failed: ${response.status()}`);
    return response.status() === 204 ? null : response.json();
  };
  const rejected = async (path, method, data, admin, description, headers) => {
    const response = await request(path, method, data, admin, headers);
    const body = await response.json();
    verify(response.status() === 400 && typeof body.error === "string", description);
  };
  const address = { country: "SA", label: "Synthetic Saudi address", city: "Riyadh", district: "Synthetic district", street: "Test street", building: "1234", postalCode: "12345", additionalNumber: "1234", nationalAddress: "TEST1234", addressLine: "Synthetic test location only", area: "", latitude: null, longitude: null };
  let mockedAccount;
  try {
    await context.addInitScript(() => {
      if (!localStorage.getItem("restaurant.locale")) localStorage.setItem("restaurant.locale", "en");
    });
    await context.route("**/*", async route => {
      if (!route.request().url().startsWith(origin + "/")) {
        failures.push("Unexpected external browser request");
        return route.abort();
      }
      return route.continue();
    });
    context.on("request", req => {
      if (req.url().startsWith(origin + "/storefront-api/") && req.headers()["x-api-key"]) failures.push("Administrator credential leaked to storefront API");
    });
    const p = await context.newPage();
    p.setDefaultTimeout(15000);
    p.on("pageerror", error => failures.push(error.message));
    const goto = path => p.goto(safeURL(path), { waitUntil: "domcontentloaded" });
    const noOverflow = async description => {
      const size = await p.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
      verify(size.content <= size.viewport + 2, description);
    };
    const initial = await api("/api/restaurant/catalog", "GET", undefined, true);
    const catalog = await api("/api/restaurant/catalog", "PUT", {
      ...initial,
      settings: { ...initial.settings, name: "Saudi-only browser test", description: "", country: "SA", currency: "SAR", defaultLanguage: "en", menuLanguage: "en", demo: true, acceptingOrders: true, deliveryEnabled: true, pickupEnabled: true, tableEnabled: true, deliveryPricingMode: "flat", deliveryZones: [], deliveryFeeMinor: 500, deliveryMinimumMinor: 0, deliveryAreas: [], deliveryRadiusKm: 0, latitude: null, longitude: null, requireDeliveryLocation: false, paymentMethods: { delivery: ["cash_on_delivery"], table: ["cash_after"], pickup: ["card"] } },
      categories: [{ id: "saudi-category", name: "Synthetic dishes", sort: 0 }],
      items: [{ id: "saudi-dish", categoryId: "saudi-category", name: dish, description: "Synthetic isolated test only", priceMinor: 2000, imageUrl: "", available: true, sort: 0, options: [] }],
      tables: [{ id: "saudi-table", name: "Synthetic table", code: "", active: true }],
    }, true);
    const providers = await api("/storefront-api/payments?currency=SAR");
    verify(providers.providers.length === 0, "No live payment gateways enabled in the disposable Saudi test server");
    await rejected("/api/restaurant/catalog", "PUT", { ...catalog, settings: { ...catalog.settings, country: "AE" } }, true, "Server rejects changing restaurant country to a foreign country");
    verify((await api("/api/restaurant/catalog", "GET", undefined, true)).settings.country === "SA", "Rejected country change leaves stored restaurant country Saudi Arabia");

    const input = { mode: "delivery", paymentMethod: "cash_on_delivery", paymentProvider: "", customerName: "Saudi test customer", phone: "+966500000000", address, items: [{ itemId: "saudi-dish", quantity: 1, optionIds: [] }], notes: run };
    const quote = await api("/storefront-api/quote", "POST", input);
    verify(quote.totalMinor === 2500 && quote.deliveryFeeMinor === 500, "Saudi delivery quote retains correct item and delivery prices");
    const foreignInput = { ...input, address: { ...address, country: "AE" } };
    await rejected("/storefront-api/quote", "POST", foreignInput, false, "Server rejects a foreign delivery quote even when the country field is forged");
    await goto("/");
    await rejected("/storefront-api/orders", "POST", { ...foreignInput, expectedTotalMinor: quote.totalMinor }, false, "Server rejects a forged foreign delivery order before persistence", { "Idempotency-Key": await p.evaluate(() => crypto.randomUUID()) });
    verify(!(await api("/api/restaurant/orders", "GET", undefined, true)).orders.some(order => order.notes === run), "Rejected foreign delivery does not create an order");

    const checkout = async () => {
      await p.getByRole("button", { name: dish, exact: true }).click();
      await p.getByRole("dialog", { name: dish, exact: true }).getByRole("button", { name: /^Add to order/ }).click();
      await p.getByRole("button", { name: "Your order", exact: true }).click();
      await p.getByRole("heading", { name: "Complete your order", exact: true }).waitFor();
      await p.getByRole("radio", { name: "Delivery", exact: true }).check();
    };
    await p.getByRole("heading", { name: dish, exact: true }).waitFor();
    verify(JSON.stringify(await p.locator(".restaurant-language select").first().locator("option").evaluateAll(options => options.map(option => option.value).sort())) === '["ar","en"]', "Saudi-only geography offers only Arabic and English interface languages");
    await checkout();
    verify(await p.getByRole("combobox", { name: "Country", exact: true }).count() === 0, "Delivery checkout has no country dropdown");
    await p.getByLabel("Your name", { exact: true }).fill("Saudi UI customer");
    await p.getByLabel("Phone number", { exact: true }).fill("+966500000000");
    await p.getByLabel("Saudi national address / short address", { exact: true }).fill("TEST5678");
    await p.getByLabel("City", { exact: true }).fill("Riyadh");
    await p.getByLabel("District", { exact: true }).fill("Synthetic district");
    await p.getByLabel("Apartment, floor and directions", { exact: true }).fill("Synthetic UI destination");
    await p.getByLabel(/Order notes/).fill(`${run}-ui`);
    await p.getByRole("radio", { name: "Cash on delivery", exact: true }).check();
    await noOverflow("Saudi delivery checkout does not overflow a mobile viewport");
    await p.getByRole("button", { name: "Review order", exact: true }).click();
    await p.getByRole("button", { name: /^Confirm order/ }).click();
    await p.waitForURL(url => url.pathname === "/track");
    const order = (await api("/api/restaurant/orders", "GET", undefined, true)).orders.find(entry => entry.notes === `${run}-ui`);
    verify(order && order.address.country === "SA" && order.address.nationalAddress === "TEST5678" && order.address.city === "Riyadh" && order.address.district === "Synthetic district" && order.totalMinor === 2500, "Real UI delivery checkout saves Saudi country and national-address details automatically");

    const registered = await api("/storefront-api/account/register", "POST", { username: run, password: "saudi-browser-test-only-passphrase", displayName: "Saudi browser customer" });
    await rejected("/storefront-api/account", "PUT", { displayName: "Saudi browser customer", phone: "+966500000000", addresses: [{ ...address, country: "AE" }] }, false, "Account API rejects adding a foreign saved address");
    verify((await api("/storefront-api/account")).customer.addresses.length === 0, "Rejected foreign address does not alter saved customer addresses");
    await goto("/account");
    await p.getByRole("button", { name: "Add an address", exact: true }).click();
    verify(await p.getByRole("combobox", { name: "Country", exact: true }).count() === 0, "Customer saved-address editor has no country dropdown");
    await p.getByLabel("Address label", { exact: true }).fill("Synthetic Saudi address");
    await p.getByLabel("Saudi national address / short address", { exact: true }).fill("TEST9012");
    await p.getByRole("button", { name: "Save", exact: true }).click();
    await p.getByText("Saved", { exact: true }).waitFor();
    const saved = (await api("/storefront-api/account")).customer;
    verify(saved.addresses.length === 1 && saved.addresses[0].country === "SA" && saved.addresses[0].nationalAddress === "TEST9012", "Saved-address UI automatically stores Saudi Arabia without a country choice");

    // Present a legacy address only in browser GET responses. It is never
    // created in the server, altered, or submitted as a real address update.
    const legacy = { ...address, id: "legacy-foreign", label: "Legacy foreign address", country: "AE", city: "Dubai", nationalAddress: "", additionalNumber: "", addressLine: "Legacy foreign destination" };
    mockedAccount = async route => {
      if (route.request().method() !== "GET") return route.continue();
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ customer: { ...saved, addresses: [...saved.addresses, legacy] } }) });
    };
    await p.route(origin + "/storefront-api/account", mockedAccount);
    await goto("/account");
    await p.getByRole("heading", { name: "Legacy foreign address", exact: true }).waitFor();
    const legacyEditor = p.locator(".rs-address-editor").filter({ has: p.getByRole("heading", { name: "Legacy foreign address", exact: true }) });
    verify(await legacyEditor.getByLabel("Country", { exact: true }).inputValue() === "United Arab Emirates", "Legacy foreign address keeps its original country rather than being relabeled Saudi Arabia");
    verify(await legacyEditor.getByLabel("City", { exact: true }).isDisabled() && await legacyEditor.getByRole("button", { name: "Remove", exact: true }).isEnabled(), "Legacy foreign address cannot be edited as a Saudi address but can be explicitly removed");
    await legacyEditor.getByText("Only delivery addresses within Saudi Arabia are supported.", { exact: true }).waitFor();
    let profileWrites = 0;
    const observeProfileWrite = req => {
      if (req.url() === origin + "/storefront-api/account" && req.method() === "PUT") profileWrites++;
    };
    p.on("request", observeProfileWrite);
    await p.getByRole("button", { name: "Save", exact: true }).click();
    await p.getByText("Only delivery addresses within Saudi Arabia are supported.", { exact: true }).first().waitFor();
    verify(profileWrites === 0, "Profile save does not silently submit or convert a legacy foreign address");
    p.off("request", observeProfileWrite);
    await goto("/");
    await p.getByRole("heading", { name: dish, exact: true }).waitFor();
    await checkout();
    const savedChoices = p.getByRole("combobox", { name: "Saved addresses", exact: true });
    await savedChoices.waitFor();
    verify(await savedChoices.locator("option").filter({ hasText: "Legacy foreign address" }).count() === 0 && await savedChoices.locator("option").filter({ hasText: "Synthetic Saudi address" }).count() === 1, "Checkout offers Saudi saved addresses but excludes a legacy foreign destination");
    await p.unroute(origin + "/storefront-api/account", mockedAccount);
    mockedAccount = undefined;

    await goto("/admin");
    await p.getByLabel("Administrator access key", { exact: true }).fill(adminKey);
    await p.getByRole("button", { name: "Sign in", exact: true }).click();
    await p.locator(".ra-sidebar").getByRole("button", { name: "Restaurant settings", exact: true }).click();
    await p.getByLabel("Restaurant name", { exact: true }).waitFor();
    verify(await p.getByRole("combobox", { name: "Restaurant country", exact: true }).count() === 0, "Restaurant administration has no country dropdown");
    const country = p.getByLabel("Restaurant country", { exact: true });
    verify(await country.count() === 1 && (await country.isDisabled() || await country.getAttribute("readonly") !== null) && /Saudi Arabia|SA/.test(await country.inputValue()), "Restaurant country is visibly fixed to Saudi Arabia in administration");
    await noOverflow("Saudi restaurant settings remain usable on mobile");
    await p.screenshot({ path: "/home/chatbot/wa/AstraCalls/prints/restaurant-saudi-admin-mobile.png", fullPage: true });
    verify(failures.length === 0, "Saudi UI runs without browser errors, external network traffic or leaked administrator headers");
    verify(registered.customer.id === saved.id, "All account checks used only the isolated synthetic customer");
    return { checks, screenshots: ["restaurant-saudi-admin-mobile.png"] };
  } finally {
    await context.close();
  }
}
