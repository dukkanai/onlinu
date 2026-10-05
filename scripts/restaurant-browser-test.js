// Pass this async function verbatim to browser_run_code_unsafe. It requires an
// already running, disposable restaurant server on the exact address below.
// It creates test orders and replaces the TEST server's catalog; never run it
// against a production origin. No browser profile supplied by the caller is used.
async (page) => {
  const origin = "http://127.0.0.1:18083";
  if (!/^http:\/\/127\.0\.0\.1:18083$/.test(origin)) {
    throw new Error("Refusing browser test outside the isolated restaurant server");
  }
  const browser = page.context().browser();
  if (!browser) throw new Error("This harness requires a browser supporting newContext");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US" });
  const checks = [];
  const failures = [];
  const run = `browser-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const dish = "طبق اختبار المتصفح";
  const adminKey = "restaurant-browser-test-key";
  let publicRequests = 0;
  const verify = (condition, description) => {
    if (!condition) throw new Error(description);
    checks.push(description);
  };
  // The browser tool's VM deliberately does not expose URL/URLSearchParams.
  // Inspect only canonical HTTP(S) URLs produced by Playwright, and construct
  // our own fixed-origin routes explicitly; this is not a general URL parser.
  const locationParts = (value) => {
    const match = /^(https?:\/\/[^/?#]+)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(value);
    return match ? { origin: match[1], pathname: match[2] || "/", search: match[3] || "", hash: match[4] || "" } : { origin: "", pathname: "", search: "", hash: "" };
  };
  const safeURL = (path) => {
    if (typeof path !== "string" || /[\u0000-\u0020\\]/.test(path)) throw new Error("Invalid isolated test route");
    const absolute = path.startsWith("/") && !path.startsWith("//") ? origin + path : path;
    if (locationParts(absolute).origin !== origin) throw new Error("Refusing navigation or API request outside isolated server");
    return absolute;
  };
  const api = async (path, method = "GET", data, admin = false, extraHeaders = {}) => {
    const headers = { Origin: origin, ...extraHeaders };
    if (admin) headers["X-API-Key"] = adminKey;
    const response = await context.request.fetch(safeURL(path), { method, headers, ...(data === undefined ? {} : { data }) });
    if (!response.ok()) {
      const result = await response.json().catch(() => ({}));
      throw new Error(`Test API ${method} ${path.split("?")[0]} failed: ${response.status()} ${result.error || "unknown error"}`);
    }
    return response.status() === 204 ? null : response.json();
  };
  const isResponse = (response, path, method) => {
    const url = locationParts(response.url());
    return url.origin === origin && url.pathname === path && response.request().method() === method;
  };
  try {
    // Do not reset the selected language on each navigation: initialize once.
    await context.addInitScript(() => {
      if (!localStorage.getItem("restaurant.locale")) localStorage.setItem("restaurant.locale", "en");
    });
    await context.route("**/*", async (route) => {
      const url = locationParts(route.request().url());
      if (url.origin !== origin) {
        failures.push("Unexpected external browser request");
        await route.abort();
      } else await route.continue();
    });
    context.on("request", (request) => {
      const url = locationParts(request.url());
      if (url.origin === origin && url.pathname.startsWith("/storefront-api/")) {
        publicRequests++;
        if (request.headers()["x-api-key"]) failures.push("Administrator credential sent to a public storefront endpoint");
      }
    });
    const p = await context.newPage();
    p.setDefaultTimeout(20000);
    p.on("pageerror", (error) => failures.push(`Browser error: ${error.message}`));
    p.on("dialog", (dialog) => dialog.accept());
    const noOverflow = async (label) => {
      const width = await p.evaluate(() => ({ viewport: window.innerWidth, body: document.documentElement.scrollWidth }));
      if (width.body > width.viewport + 2) throw new Error(`${label}: horizontal overflow (${width.body}/${width.viewport})`);
    };
    const goto = async (path) => {
      await p.goto(safeURL(path), { waitUntil: "domcontentloaded" });
    };
    const receiptURL = (receipt) => `${origin}/track?order=${encodeURIComponent(receipt.order.number)}#token=${encodeURIComponent(receipt.trackingToken)}`;
    const addAndCheckout = async (extras = false, quantity = 1) => {
      await p.getByRole("button", { name: dish, exact: true }).click();
      const dialog = p.getByRole("dialog", { name: dish, exact: true });
      if (extras) {
        await dialog.getByRole("checkbox", { name: /Free sauce/ }).check();
        await dialog.getByRole("checkbox", { name: /Extra rice/ }).check();
      }
      for (let i = 1; i < quantity; i++) await dialog.getByRole("button", { name: "Increase quantity", exact: true }).click();
      await dialog.getByRole("button", { name: /^Add to order/ }).click();
      // The desktop sidebar is hidden on mobile; the header basket is always
      // visible and has a stable accessible name without a changing total.
      await p.getByRole("button", { name: "Your order", exact: true }).click();
      await p.getByRole("heading", { name: "Complete your order", exact: true }).waitFor();
    };
    const prepare = async (mode, notes) => {
      const name = mode === "pickup" ? "Pickup at the restaurant door" : mode === "table" ? "At a table" : "Delivery";
      await p.getByRole("radio", { name, exact: true }).check();
      await p.getByLabel("Your name", { exact: true }).fill("Browser Test Customer");
      await p.getByLabel("Phone number", { exact: true }).fill("+966500000000");
      await p.getByLabel(/Order notes/).fill(notes);
      if (mode === "delivery") {
        verify(await p.getByRole("combobox", { name: "Country", exact: true }).count() === 0, "Saudi-only checkout has no country selector");
        await p.getByLabel("Saudi national address / short address", { exact: true }).fill("TEST1234");
        await p.getByLabel("Apartment, floor and directions", { exact: true }).fill("Synthetic browser test address only");
        await p.getByRole("radio", { name: "Cash on delivery", exact: true }).check();
      } else if (mode === "table") {
        await p.getByLabel("Table QR link or code", { exact: true }).fill(safeURL(`/?table=${encodeURIComponent(tableA.code)}`));
        await p.getByRole("radio", { name: "Cash after the meal", exact: true }).check();
      }
      const pending = p.waitForResponse(response => isResponse(response, "/storefront-api/quote", "POST"));
      await p.getByRole("button", { name: "Review order", exact: true }).click();
      const response = await pending;
      if (!response.ok()) throw new Error(`Quote rejected: ${response.status()}`);
      const quote = await response.json();
      await p.getByRole("button", { name: /^Confirm order/ }).waitFor();
      return quote;
    };
    const confirm = async (retry = false) => {
      const pending = p.waitForResponse(response => isResponse(response, "/storefront-api/orders", "POST"));
      await p.getByRole("button", { name: retry ? "Try again" : /^Confirm order/, exact: retry }).click();
      const response = await pending;
      if (!response.ok()) throw new Error(`Order rejected: ${response.status()}`);
      const receipt = await response.json();
      await p.waitForURL(url => url.pathname === "/track" && url.searchParams.get("order") === receipt.order.number);
      await p.getByRole("heading", { name: `Order number ${receipt.order.number}`, exact: true }).waitFor();
      return receipt;
    };

    const initial = await api("/api/restaurant/catalog", "GET", undefined, true);
    const catalog = await api("/api/restaurant/catalog", "PUT", {
      ...initial,
      settings: { ...initial.settings, name: "Browser Test Restaurant", description: "", address: "", phone: "", logoUrl: "", coverUrl: "", currency: "SAR", country: "SA", defaultLanguage: "en", menuLanguage: "ar", demo: true, acceptingOrders: true, deliveryEnabled: true, pickupEnabled: true, tableEnabled: true, deliveryPricingMode: "flat", deliveryZones: [], deliveryFeeMinor: 500, deliveryMinimumMinor: 0, deliveryAreas: [], deliveryRadiusKm: 0, latitude: null, longitude: null, requireDeliveryLocation: false, pickupInstructions: "", paymentInstructions: "", openingHours: "", taxEnabled: true, taxRateBps: 1500, taxNumber: "TEST-BROWSER-TAX", paymentMethods: { table: ["cash_before", "cash_after", "card"], delivery: ["cash_on_delivery", "card"], pickup: ["card"] } },
      categories: [{ id: "browser-category", name: "أطباق تجريبية", sort: 0 }],
      items: [{ id: "browser-dish", categoryId: "browser-category", name: dish, description: "وصف ثابت لا تترجمه لغة الواجهة", priceMinor: 1250, imageUrl: "", available: true, sort: 0, options: [{ id: "browser-free", name: "Free sauce", priceMinor: 0, available: true }, { id: "browser-rice", name: "Extra rice", priceMinor: 250, available: true }] }],
      tables: [{ id: "browser-table-a", name: "Browser Table A", code: "", active: true }, { id: "browser-table-b", name: "Browser Table B", code: "", active: true }],
    }, true);
    const [tableA, tableB] = catalog.tables;
    verify(Boolean(tableA.code && tableB.code && tableA.code !== tableB.code), "Isolated demo catalog has separate unguessable table links");
    const providers = await api("/storefront-api/payments?currency=SAR");
    verify(Array.isArray(providers.providers) && providers.providers.length === 0, "Isolated browser server has no enabled payment gateway; no real payment requests will be created");

    await goto("/");
    await p.getByRole("heading", { name: dish, exact: true }).waitFor();
    await noOverflow("English mobile menu");
    await p.screenshot({ path: "/home/chatbot/wa/AstraCalls/prints/restaurant-browser-mobile.png", fullPage: true });
    const languages = ["ar", "en"];
    const picker = p.locator(".restaurant-language select").first();
    verify(JSON.stringify(await picker.locator("option").evaluateAll(options => options.map(option => option.value).sort())) === JSON.stringify(languages), "Storefront offers only Arabic and English interface languages");
    for (const language of languages) {
      await picker.selectOption(language);
      const direction = language === "ar" ? "rtl" : "ltr";
      await p.waitForFunction(({ language, direction }) => document.documentElement.lang === language && document.documentElement.dir === direction, { language, direction });
      if (await p.getByRole("heading", { name: dish, exact: true }).count() !== 1) throw new Error(`Menu text changed in ${language}`);
      await noOverflow(`Mobile ${language}`);
      if (language === "ar") await p.screenshot({ path: "/home/chatbot/wa/AstraCalls/prints/restaurant-browser-mobile-rtl.png", fullPage: true });
    }
    verify(true, "Both interface languages apply correct direction without translating restaurant menu text or overflowing mobile");
    await picker.selectOption("en");
    await p.waitForFunction(() => document.documentElement.lang === "en");

    await addAndCheckout(true, 2);
    await p.getByRole("radio", { name: "Pickup at the restaurant door", exact: true }).check();
    await p.getByText("Online payment is not available yet. Contact the restaurant or choose an available cash method.", { exact: true }).waitFor();
    verify(await p.getByRole("radio", { name: "Pay by card online", exact: true }).isChecked() && await p.getByRole("button", { name: "Review order", exact: true }).isDisabled(), "Pickup is card-only and checkout stays disabled when no gateway is configured");
    // This deliberately rejected order only exercises local capability policy.
    // It does not initiate payment or install/configure any provider credential.
    const rejectedPickup = await context.request.post(safeURL("/storefront-api/orders"), {
      headers: { Origin: origin, "Idempotency-Key": await p.evaluate(() => crypto.randomUUID()) },
      data: { mode: "pickup", customerName: "Browser Test Customer", phone: "+966500000000", address: {}, tableCode: "", notes: `${run}-pickup-rejected`, items: [{ itemId: "browser-dish", quantity: 2, optionIds: ["browser-free", "browser-rice"] }], expectedTotalMinor: 3000, paymentMethod: "card", paymentProvider: "stripe" },
    });
    verify(rejectedPickup.status() === 409 && (await rejectedPickup.json()).error === "payment_unavailable", "Server rejects a forged pickup card order without a usable gateway");
    const tableQuote = await prepare("table", `${run}-guest-table`);
    verify(tableQuote.totalMinor === 3000 && tableQuote.deliveryFeeMinor === 0 && tableQuote.items[0].options.length === 2 && tableQuote.tax.taxMinor === 391 && tableQuote.tax.netMinor === 2609 && tableQuote.tax.grossMinor === 3000, "Guest table quote preserves inclusive gross prices, free/paid extras, and integer tax extraction");
    const guestTable = await confirm();
    const trackLocation = locationParts(p.url());
    verify(guestTable.order.totalMinor === 3000 && guestTable.order.payment.method === "cash_after" && guestTable.order.payment.status === "unpaid" && trackLocation.hash.includes("token=") && !/(?:^|[?&])token(?:=|&|$)/.test(trackLocation.search), "Guest cash-after checkout succeeds without marking paid and tracking secret stays in URL fragment");
    await p.getByText("Order receipt only — this is not a certified ZATCA electronic tax invoice.", { exact: true }).waitFor();
    await noOverflow("Table receipt");
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.getByRole("heading", { name: `Order number ${guestTable.order.number}`, exact: true }).waitFor();
    verify(true, "Private guest tracking survives a real page reload");

    await goto("/");
    await addAndCheckout();
    const deliveryQuote = await prepare("delivery", `${run}-delivery`);
    const delivery = await confirm();
    verify(deliveryQuote.totalMinor === 1750 && delivery.order.address.country === "SA" && delivery.order.address.nationalAddress === "TEST1234" && delivery.order.deliveryFeeMinor === 500 && delivery.order.payment.method === "cash_on_delivery" && delivery.order.payment.status === "unpaid", "Guest COD delivery automatically stores Saudi country/national address, applies inclusive delivery fee, and remains unpaid");

    await goto(`/?table=${encodeURIComponent(tableA.code)}`);
    await p.getByText(`Ordering for ${tableA.name}`, { exact: true }).waitFor();
    await addAndCheckout();
    if (!await p.getByRole("radio", { name: "At a table", exact: true }).isChecked()) throw new Error("Table QR did not select table ordering");
    await prepare("table", `${run}-table-one`);
    const tableOne = await confirm();
    await p.getByRole("button", { name: "Start a new order", exact: true }).click();
    await addAndCheckout();
    verify(await p.getByRole("radio", { name: "At a table", exact: true }).isChecked(), "Starting another order preserves the QR table context");
    await prepare("table", `${run}-table-two`);
    const tableTwo = await confirm();
    verify(tableOne.order.number !== tableTwo.order.number && tableOne.order.tableId === tableA.id && tableTwo.order.tableId === tableA.id, "Two orders at one table remain independent");
    await goto(receiptURL(tableOne));
    await p.getByLabel("New table QR link or code", { exact: true }).fill(safeURL(`/?table=${encodeURIComponent(tableB.code)}`));
    const moving = p.waitForResponse(response => isResponse(response, `/storefront-api/orders/${tableOne.order.number}/table`, "POST"));
    await p.getByRole("button", { name: "Change table", exact: true }).click();
    const moved = await moving;
    if (!moved.ok()) throw new Error(`Table move rejected: ${moved.status()}`);
    const changed = await moved.json();
    const unchanged = await api(`/storefront-api/orders/${tableTwo.order.number}`, "GET", undefined, false, { "X-Order-Token": tableTwo.trackingToken });
    verify(changed.number === tableOne.order.number && changed.tableId === tableB.id && changed.tableChanges.length === 1 && unchanged.tableId === tableA.id, "Authenticated QR table transfer changes only the chosen order and retains its number/history");

    await goto("/account");
    await p.getByRole("button", { name: "Create an account", exact: true }).first().click();
    await p.getByLabel("Username", { exact: true }).fill(run);
    await p.getByLabel("Password", { exact: true }).fill("restaurant-browser-test-passphrase");
    await p.getByLabel("Display name", { exact: true }).fill("Browser Account");
    await p.getByRole("button", { name: "Create an account", exact: true }).last().click();
    await p.getByRole("button", { name: "Sign out", exact: true }).waitFor();
    const freshHistory = await api("/storefront-api/account/orders");
    const cookies = await context.cookies(safeURL("/storefront-api/account"));
    verify(freshHistory.orders.length === 0 && cookies.some(cookie => cookie.name.startsWith("restaurant_customer_") && cookie.httpOnly && cookie.sameSite === "Lax"), "Optional registration uses a namespaced HttpOnly cookie and does not claim existing guest orders");
    await p.getByRole("button", { name: "Add an address", exact: true }).click();
    verify(await p.getByRole("combobox", { name: "Country", exact: true }).count() === 0, "Saudi-only customer profile has no country selector");
    await p.getByLabel("Address label", { exact: true }).fill("Synthetic home");
    await p.getByLabel("Saudi national address / short address", { exact: true }).fill("TEST5678");
    const savingProfile = p.waitForResponse(response => isResponse(response, "/storefront-api/account", "PUT"));
    await p.getByRole("button", { name: "Save", exact: true }).click();
    const savedProfile = await savingProfile;
    if (!savedProfile.ok()) throw new Error("Customer profile could not be saved");
    const savedAddress = (await savedProfile.json()).customer.addresses[0];
    verify(savedAddress.nationalAddress === "TEST5678" && savedAddress.country === "SA", "Customer can save an optional Saudi national-address profile");
    await goto("/");
    await addAndCheckout();
    await prepare("delivery", `${run}-account`);
    const own = await confirm();
    await goto("/account");
    await p.locator(".rs-account-orders").getByRole("button").filter({ hasText: own.order.number }).waitFor();
    const ownHistory = await api("/storefront-api/account/orders");
    verify(ownHistory.orders.length === 1 && ownHistory.orders[0].number === own.order.number, "Signed-in order appears only in its owning account history");
    await p.locator(".rs-account-orders").getByRole("button").filter({ hasText: own.order.number }).click();
    await p.getByRole("heading", { name: `Order number ${own.order.number}`, exact: true }).waitFor();
    if (locationParts(p.url()).hash) throw new Error("Account-history tracking should not require a guest token");
    await goto("/account");
    await p.getByRole("button", { name: "Sign out", exact: true }).click();
    await p.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
    verify((await api("/storefront-api/account")).customer === null, "Customer logout revokes the session");

    await goto("/");
    await addAndCheckout();
    await prepare("table", `${run}-lost-response`);
    const keys = [];
    let committed;
    let dropped = false;
    const dropOnce = async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      keys.push(route.request().headers()["idempotency-key"]);
      if (dropped) return route.continue();
      dropped = true;
      const response = await route.fetch();
      if (!response.ok()) throw new Error(`Real lost-response test did not commit: ${response.status()}`);
      committed = await response.json();
      await route.abort("failed");
    };
    await p.route(`${origin}/storefront-api/orders`, dropOnce);
    await p.getByRole("button", { name: /^Confirm order/ }).click();
    await p.getByText("The result of sending your order is not yet confirmed. Retry this same submission to avoid duplicates.", { exact: true }).waitFor();
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.getByRole("button", { name: "Try again", exact: true }).waitFor();
    const retried = await confirm(true);
    await p.unroute(`${origin}/storefront-api/orders`, dropOnce);
    const afterRetry = await api("/api/restaurant/orders", "GET", undefined, true);
    const matching = afterRetry.orders.filter(order => order.notes === `${run}-lost-response`);
    verify(committed && retried.order.number === committed.order.number && keys.length === 2 && keys[0] === keys[1] && matching.length === 1, "Committed-but-lost response survives reload and retry with one durable order and unchanged idempotency key");

    await goto("/admin");
    await p.getByLabel("Administrator access key", { exact: true }).fill(adminKey);
    await p.getByRole("button", { name: "Sign in", exact: true }).click();
    await p.getByRole("heading", { name: "Orders", exact: true }).first().waitFor();
    await p.getByLabel("Search order number, name or phone", { exact: true }).fill(guestTable.order.number);
    await p.locator(".ra-order-list").getByRole("button").filter({ hasText: guestTable.order.number }).click();
    const statusChange = p.waitForResponse(response => isResponse(response, `/api/restaurant/orders/${guestTable.order.number}`, "PATCH"));
    await p.locator(".ra-status-actions").getByRole("button", { name: "Confirmed", exact: true }).click();
    const statusResponse = await statusChange;
    verify(statusResponse.ok() && (await statusResponse.json()).status === "accepted", "Administrator can advance an actual customer order status");
    for (const [label, status] of [["Being prepared", "preparing"], ["Ready", "ready"]]) {
      const progressing = p.waitForResponse(response => isResponse(response, `/api/restaurant/orders/${guestTable.order.number}`, "PATCH"));
      await p.locator(".ra-status-actions").getByRole("button", { name: label, exact: true }).click();
      const response = await progressing;
      if (!response.ok() || (await response.json()).status !== status) throw new Error(`Cash-after order could not advance to ${status}`);
    }
    verify(await p.locator(".ra-status-actions").getByRole("button", { name: "Completed", exact: true }).isDisabled(), "Cash-after order cannot complete before explicit cash collection");
    const collecting = p.waitForResponse(response => isResponse(response, `/api/restaurant/orders/${guestTable.order.number}/cash`, "POST"));
    await p.getByRole("button", { name: "Confirm cash collected", exact: true }).click();
    const cashResponse = await collecting;
    const collectedOrder = await cashResponse.json();
    verify(cashResponse.ok() && collectedOrder.payment.status === "paid" && collectedOrder.payment.amountMinor === 3000 && collectedOrder.payment.paidAt && collectedOrder.tax.taxMinor === 391, "Administrator explicitly records synthetic cash collection without changing inclusive tax snapshot");
    const completing = p.waitForResponse(response => isResponse(response, `/api/restaurant/orders/${guestTable.order.number}`, "PATCH"));
    await p.locator(".ra-status-actions").getByRole("button", { name: "Completed", exact: true }).click();
    const completedResponse = await completing;
    verify(completedResponse.ok() && (await completedResponse.json()).status === "completed", "Cash-after order completes only after confirmed collection");
    await p.locator(".ra-sidebar").getByRole("button", { name: "Restaurant settings", exact: true }).click();
    verify(await p.getByRole("combobox", { name: "Restaurant country", exact: true }).count() === 0, "Saudi-only restaurant administration has no country selector");
    const currencies = p.getByLabel("Currency", { exact: true });
    await currencies.waitFor({ state: "visible" });
    verify(await currencies.locator("option").count() === 20, "Administrator currency selector exposes 20 safe supported currencies");
    await currencies.selectOption("KWD");
    await p.getByLabel("Delivery fee", { exact: true }).fill("1.234");
    await currencies.selectOption("SAR");
    await p.getByLabel("Delivery fee", { exact: true }).fill("5.00");
    await p.getByLabel("Restaurant name", { exact: true }).fill("Browser Test Restaurant Updated");
    const publishing = p.waitForResponse(response => isResponse(response, "/api/restaurant/catalog", "PUT"));
    await p.getByRole("button", { name: "Save and publish", exact: true }).click();
    const published = await publishing;
    const updated = await published.json();
    verify(published.ok() && updated.settings.name === "Browser Test Restaurant Updated" && updated.settings.deliveryFeeMinor === 500 && updated.settings.currency === "SAR", "Administrator edits and publishes settings with correct minor-unit amounts");
    await p.locator(".ra-sidebar").getByRole("button", { name: "Menu", exact: true }).click();
    await p.locator(".ra-item-pick").filter({ hasText: dish }).click();
    await p.getByLabel("Price", { exact: true }).first().fill("13.00");
    const publishingMenu = p.waitForResponse(response => isResponse(response, "/api/restaurant/catalog", "PUT"));
    await p.getByRole("button", { name: "Save and publish", exact: true }).click();
    const menuResponse = await publishingMenu;
    const changedMenu = await menuResponse.json();
    const originalReceipt = await api(`/storefront-api/orders/${guestTable.order.number}`, "GET", undefined, false, { "X-Order-Token": guestTable.trackingToken });
    verify(menuResponse.ok() && changedMenu.items[0].priceMinor === 1300 && originalReceipt.totalMinor === 3000 && originalReceipt.tax.taxMinor === 391 && originalReceipt.payment.status === "paid", "Administrator publishes menu prices without rewriting existing order/tax/payment snapshots");
    const uploadingImage = p.waitForResponse(response => isResponse(response, "/api/restaurant/images", "POST"));
    await p.locator('.ra-image-editor input[type="file"]').setInputFiles("/home/chatbot/wa/AstraCalls/client/public/favicon.png");
    const uploadedResponse = await uploadingImage;
    if (!uploadedResponse.ok()) throw new Error(`Administrator image upload failed: ${uploadedResponse.status()}`);
    const uploaded = await uploadedResponse.json();
    if (!/^\/restaurant-media\/[A-Za-z0-9_-]+\.(?:jpg|png)$/.test(uploaded.url)) throw new Error("Image upload did not return a safe local image URL");
    await p.waitForFunction(expected => Array.from(document.querySelectorAll(".ra-image-editor input")).some(input => input.value === expected), uploaded.url);
    const publishingImage = p.waitForResponse(response => isResponse(response, "/api/restaurant/catalog", "PUT"));
    await p.getByRole("button", { name: "Save and publish", exact: true }).click();
    const imageCatalogResponse = await publishingImage;
    if (!imageCatalogResponse.ok()) throw new Error(`Uploaded image could not be published: ${imageCatalogResponse.status()}`);
    const imageCatalog = await imageCatalogResponse.json();
    const publicImage = await context.request.get(safeURL(uploaded.url));
    verify(imageCatalog.items[0].imageUrl === uploaded.url && publicImage.status() === 200 && /^image\/(?:png|jpeg)/.test(publicImage.headers()["content-type"] || ""), "Administrator uploads and publishes a real PNG that is publicly served without an administrator credential");
    await p.locator(".ra-sidebar").getByRole("button", { name: "Tables & QR codes", exact: true }).click();
    await p.locator(".ra-public-qr .ra-qr svg").waitFor({ state: "visible" });
    await p.locator(".ra-tables .ra-qr svg").first().waitFor({ state: "visible" });
    verify(await p.locator(".ra-tables .ra-qr svg").count() === 2 && await p.locator(".ra-public-qr .ra-qr svg").count() === 1 && await p.getByRole("button", { name: "Print QR code", exact: true }).count() === 3, "Public menu and both tables each have a rendered and printable ordering QR code");
    await noOverflow("Mobile restaurant administration");
    await p.screenshot({ path: "/home/chatbot/wa/AstraCalls/prints/restaurant-browser-admin-mobile.png", fullPage: true });
    await p.setViewportSize({ width: 1440, height: 1000 });
    await goto("/");
    await p.getByRole("heading", { name: dish, exact: true }).waitFor();
    await noOverflow("Desktop storefront");
    await p.screenshot({ path: "/home/chatbot/wa/AstraCalls/prints/restaurant-browser-desktop.png", fullPage: true });
    verify(publicRequests > 0 && failures.length === 0, `Browser has no runtime errors, external requests, or leaked administrator headers (${publicRequests} public requests checked)`);
    return { checks, screenshots: ["restaurant-browser-mobile.png", "restaurant-browser-mobile-rtl.png", "restaurant-browser-admin-mobile.png", "restaurant-browser-desktop.png"] };
  } finally {
    await context.close();
  }
}
