// Pass this function to browser_run_code_unsafe only after the isolated server
// is ready. Fixed loopback origin and synthetic credentials; no production
// parameter is accepted. Every external browser request is intercepted.
async (page) => {
  const origin = "http://127.0.0.1:18083";
  const adminKey = "restaurant-browser-test-key";
  const browser = page.context().browser();
  if (!browser || origin !== "http://127.0.0.1:18083") throw new Error("Isolated browser context required");
  const contexts = [], checks = [], failures = [], screenshots = [];
  const run = `loc_${Date.now()}_${Math.random().toString(16).slice(2, 7)}`;
  const password = "location-isolated-test-password";
  let tileConsent = false, tileRequests = 0, publicRequests = 0;
  let stage = "initializing isolated contexts";
  const startedAt = Date.now();
  let finished = false, deadlineReached = false;
  // The watchdog closes only contexts created by THIS run, not the caller's
  // page/profile. Closing rejects a stalled response-body read too, unlike
  // merely abandoning the browser tool's outer promise.
  void page.waitForTimeout(55000).then(async () => {
    if (finished) return;
    deadlineReached = true;
    await Promise.all(contexts.map(context => context.close().catch(() => {})));
  }).catch(() => {});
  const verify = (condition, message) => { if (!condition) throw new Error(message); checks.push(message); };
  const pathURL = path => {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || /[\u0000-\u0020\\]/.test(path) || path.includes("..")) throw new Error("Unsafe isolated route");
    return origin + path;
  };
  const makeContext = async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US" });
    context.setDefaultTimeout(12000);
    context.setDefaultNavigationTimeout(20000);
    contexts.push(context);
    await context.addInitScript(() => { if (!localStorage.getItem("restaurant.locale")) localStorage.setItem("restaurant.locale", "en"); });
    await context.route("**/*", async route => {
      const request = route.request(), url = request.url();
      if (url.startsWith(origin + "/")) return route.continue();
      if (/^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/.test(url)) {
        tileRequests++;
        if (!tileConsent) failures.push("Map tile requested before explicit consent");
        if (request.headers().referer !== origin + "/") failures.push("Map tile did not use origin-only referrer");
        if (request.headers()["x-api-key"] || request.headers()["x-order-token"]) failures.push("Private credential sent to tile service");
        // Entirely local test tile. No OSM network request is actually sent.
        return route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e7eedf"/><path d="M0 80H256M70 0V256M180 0V256M0 180H256" stroke="#c3d1b8" stroke-width="8"/><text x="88" y="135" fill="#42523c" font-size="13">TEST TILE</text></svg>' });
      }
      failures.push("Unexpected external browser request");
      return route.abort();
    });
    context.on("request", request => {
      const url = request.url();
      if (url.startsWith(origin + "/storefront-api/") || url.startsWith(origin + "/courier-api/")) {
        publicRequests++;
        if (request.headers()["x-api-key"]) failures.push("Administrator credential leaked into public/courier transport");
      }
    });
    return context;
  };
  const api = async (context, path, method = "GET", data, admin = false, extra = {}) => {
    stage = `${method} ${path}`;
    const response = await context.request.fetch(pathURL(path), { method, timeout: 12000, headers: { Origin: origin, ...(admin ? { "X-API-Key": adminKey } : {}), ...extra }, ...(data === undefined ? {} : { data }) });
    if (!response.ok()) {
      const result = await response.json().catch(() => ({}));
      throw new Error(`Isolated API ${method} ${path} failed: ${response.status()} ${result.error || "unknown"}`);
    }
    return response.status() === 204 ? null : response.json();
  };
  const observe = async context => {
    const p = await context.newPage(); p.setDefaultTimeout(12000); p.setDefaultNavigationTimeout(20000);
    p.on("pageerror", error => failures.push(error.message));
    p.on("dialog", dialog => dialog.accept());
    return p;
  };
  const noOverflow = async (p, label) => verify(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), `${label}: no horizontal mobile overflow`);
  const waitResponse = (p, path, method) => p.waitForResponse(response => response.url() === pathURL(path) && response.request().method() === method);
  try {
    const admin = await makeContext(), courierContext = await makeContext(), ownerContext = await makeContext();
    // No real geolocation permission or device location is used. The callback
    // table lets the test prove watches were created and then cleaned up.
    await courierContext.addInitScript(() => {
      const state = { started: 0, cleared: 0, next: 0, watches: new Map() };
      window.__restaurantTestGeo = state;
      Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
        watchPosition(success) {
          const id = ++state.next; state.started++; state.watches.set(id, success);
          setTimeout(() => { if (state.watches.has(id)) success({ coords: { latitude: 24.7136, longitude: 46.6753, accuracy: 12, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() }); }, 10);
          return id;
        },
        clearWatch(id) { if (state.watches.delete(id)) state.cleared++; },
        getCurrentPosition(success) { success({ coords: { latitude: 24.7136, longitude: 46.6753, accuracy: 12 }, timestamp: Date.now() }); },
      }});
    });
    const courierPage = await observe(courierContext), ownerPage = await observe(ownerContext);
    await courierPage.goto(pathURL("/courier"));
    verify(await courierPage.evaluate(() => window.__restaurantTestGeo.started) === 0, "Opening courier login never starts geolocation");
    let catalog;
    // Append run-scoped data instead of removing another harness's fixtures.
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await api(admin, "/api/restaurant/catalog", "GET", undefined, true);
      const updated = { ...before, settings: { ...before.settings, demo: true, country: "SA", currency: "SAR", defaultLanguage: "en", acceptingOrders: true, deliveryEnabled: true, deliveryPricingMode: "flat", deliveryZones: [], deliveryFeeMinor: 500, deliveryMinimumMinor: 0, deliveryAreas: [], deliveryRadiusKm: 0, latitude: null, longitude: null, requireDeliveryLocation: false, paymentMethods: { ...before.settings.paymentMethods, delivery: ["cash_on_delivery", "card"] } }, categories: [...before.categories, { id: `${run}_category`, name: "Synthetic location category", sort: 100 }], items: [...before.items, { id: `${run}_dish`, categoryId: `${run}_category`, name: "Synthetic location test dish", description: "Test data only", priceMinor: 1000, imageUrl: "", available: true, sort: 100, options: [] }] };
      const response = await admin.request.put(pathURL("/api/restaurant/catalog"), { timeout: 12000, headers: { Origin: origin, "X-API-Key": adminKey }, data: updated });
      if (response.ok()) { catalog = await response.json(); break; }
      if (response.status() !== 409 || attempt === 2) throw new Error(`Catalog fixture rejected: ${response.status()}`);
    }
    verify(!!catalog?.items.some(item => item.id === `${run}_dish`), "Run-scoped synthetic menu fixture created without removing other items");
    const courier = (await api(admin, "/api/restaurant/couriers", "POST", { username: `${run}_a`, name: "Synthetic Location Courier A", phone: "+966500000011", password }, true)).courier;
    const otherCourier = (await api(admin, "/api/restaurant/couriers", "POST", { username: `${run}_b`, name: "Synthetic Location Courier B", phone: "+966500000012", password }, true)).courier;
    const input = { mode: "delivery", paymentMethod: "cash_on_delivery", paymentProvider: "", customerName: "Synthetic Location Customer", phone: "+966500000010", tableCode: "", notes: run, address: { country: "SA", nationalAddress: "TEST1234", addressLine: "Synthetic test destination only", latitude: 24.721, longitude: 46.685 }, items: [{ itemId: `${run}_dish`, quantity: 1, optionIds: [] }] };
    const quote = await api(ownerContext, "/storefront-api/quote", "POST", input);
    const receipt = await api(ownerContext, "/storefront-api/orders", "POST", { ...input, expectedTotalMinor: quote.totalMinor }, false, { "Idempotency-Key": await courierPage.evaluate(() => crypto.randomUUID()) });
    let order = receipt.order;
    const orderPath = `/storefront-api/orders/${order.number}`, courierOrderPath = `/courier-api/orders/${order.number}`, locationPath = `${courierOrderPath}/location`;
    const privateHeaders = { "X-Order-Token": receipt.trackingToken };
    const privateOrder = () => api(ownerContext, orderPath, "GET", undefined, false, privateHeaders);
    const ownerLocation = () => api(ownerContext, `${orderPath}/location`, "GET", undefined, false, privateHeaders);
    for (const status of ["accepted", "preparing", "ready"]) order = await api(admin, `/api/restaurant/orders/${order.number}`, "PATCH", { status, version: order.version }, true);
    order = await api(admin, `/api/restaurant/orders/${order.number}/courier`, "POST", { courierId: courier.id, version: order.version }, true);
    const originalVersion = order.version;
    await courierPage.getByLabel("Username", { exact: true }).fill(courier.username);
    await courierPage.getByLabel("Password", { exact: true }).fill(password);
    stage = "courier login and assigned job visibility";
    await courierPage.getByRole("button", { name: "Sign in", exact: true }).click();
    await courierPage.getByText(order.number, { exact: true }).waitFor();
    verify(await courierPage.evaluate(() => window.__restaurantTestGeo.started) === 0, "Assigned delivery does not start location sharing automatically");
    verify(await courierPage.evaluate(() => !localStorage.getItem("wacalls.apiKey") && !sessionStorage.getItem("wacalls.apiKey")), "Courier profile has no administrator key storage");
    const start = async () => {
      stage = "explicit start and location POST response";
      const posted = waitResponse(courierPage, locationPath, "POST");
      await courierPage.getByRole("button", { name: "Share my location for this delivery", exact: true }).click();
      const response = await posted;
      verify(response.status() === 200, "Explicit courier consent publishes an authenticated location");
      // The browser tool can stall reading an intercepted Response body even
      // after the page and server have completed it. Independently re-read the
      // protected resource through the bounded API transport instead.
      stage = "independent owner read after successful location POST";
      return ownerLocation();
    };
    const firstPoint = await start();
    verify(firstPoint.location?.accuracy === 12 && firstPoint.location?.latitude === 24.7136, "Only synthetic bounded location coordinates were published");
    verify((await ownerLocation()).location !== null, "Private receipt owner can read the latest location");
    const outsider = await ownerContext.request.get(pathURL(`${orderPath}/location`), { timeout: 12000, headers: { Origin: origin } });
    verify(outsider.status() === 404, "Order number alone cannot reveal courier location");
    const privateURL = `${orderPath.replace("/storefront-api/orders/", "/track?order=")}#token=${encodeURIComponent(receipt.trackingToken)}`;
    stage = "owner tracking page and location accuracy";
    await ownerPage.bringToFront();
    await ownerPage.goto(pathURL(privateURL));
    await ownerPage.getByRole("heading", { name: "Courier location", exact: true }).waitFor();
    await ownerPage.getByText("Approximate accuracy: 12 m", { exact: true }).waitFor();
    verify(tileRequests === 0 && await ownerPage.locator('.rs-map-canvas img').count() === 0, "Tracking page makes no map requests before explicit map consent");
    verify(await ownerPage.getByText("Loading the map sends your IP address and the approximate map area to OpenStreetMap. Your private order number, access code and exact marker coordinates are not sent.", { exact: true }).count() === 1, "Map privacy disclosure is visible before loading tiles");
    tileConsent = true;
    stage = "explicit map consent and local tile decoding";
    await ownerPage.getByRole("button", { name: "Load map", exact: true }).click();
    await ownerPage.waitForFunction(() => { const tiles = [...document.querySelectorAll('.rs-map-canvas img')]; return tiles.length > 0 && tiles.every(image => image.complete && image.naturalWidth > 0); });
    verify(tileRequests > 0 && tileRequests <= 9, "Map uses only the bounded visible set of locally mocked tiles");
    verify(await ownerPage.locator('.rs-map-courier').count() === 1 && await ownerPage.locator('.rs-map-destination').count() === 1, "Exact courier/destination markers are rendered locally");
    verify(await ownerPage.getByRole("link", { name: "© OpenStreetMap contributors", exact: true }).getAttribute("href") === "https://www.openstreetmap.org/copyright", "Map includes visible OpenStreetMap attribution");
    await noOverflow(ownerPage, "English mobile location map");
    await ownerPage.locator('.restaurant-language select').first().selectOption("ar");
    verify(await ownerPage.evaluate(() => document.documentElement.dir) === "rtl", "Customer location interface switches to Arabic RTL");
    await noOverflow(ownerPage, "Arabic mobile location map");
    const ownerScreenshot = "/tmp/restaurant-completion-location-owner-ar.png";
    await ownerPage.screenshot({ path: ownerScreenshot, fullPage: true }); screenshots.push(ownerScreenshot);
    await courierPage.locator('.restaurant-language select').first().selectOption("ar");
    await noOverflow(courierPage, "Arabic mobile courier consent");
    const courierScreenshot = "/tmp/restaurant-completion-location-courier-ar.png";
    await courierPage.screenshot({ path: courierScreenshot, fullPage: true }); screenshots.push(courierScreenshot);
    await courierPage.locator('.restaurant-language select').first().selectOption("en");
    await courierPage.bringToFront();
    const stopped = waitResponse(courierPage, locationPath, "DELETE");
    stage = "explicit stop and location DELETE response";
    await courierPage.getByRole("button", { name: "Stop sharing location", exact: true }).click();
    verify((await stopped).status() === 204, "Explicit Stop deletes the point through authenticated same-origin API");
    await courierPage.waitForFunction(() => window.__restaurantTestGeo.watches.size === 0);
    verify((await ownerLocation()).location === null, "Stopped courier location is immediately inaccessible to the owner");
    const late = await courierContext.request.post(pathURL(locationPath), { timeout: 12000, headers: { Origin: origin }, data: { latitude: 24.714, longitude: 46.676, accuracy: 12, capturedAt: new Date().toISOString(), version: originalVersion } });
    verify(late.status() === 409, "Late publish with pre-stop version cannot resurrect a point");

    await start();
    order = await privateOrder();
    order = await api(admin, `/api/restaurant/orders/${order.number}/courier`, "POST", { courierId: otherCourier.id, version: order.version }, true);
    verify((await ownerLocation()).location === null, "Reassignment immediately revokes the previous courier point");
    stage = "reassignment removes courier browser watch";
    await courierPage.getByRole("button", { name: "Refresh", exact: true }).click();
    await courierPage.waitForFunction(() => window.__restaurantTestGeo.watches.size === 0);
    const removedLocationControls = courierPage.getByRole("button", { name: "Share my location for this delivery", exact: true });
    verify(await removedLocationControls.count() === 0, "Reassigned job disappears and its browser watch is cleaned up");
    order = await api(admin, `/api/restaurant/orders/${order.number}/courier`, "POST", { courierId: courier.id, version: order.version }, true);
    stage = "reassignment back preserves opt-in requirement";
    await courierPage.getByRole("button", { name: "Refresh", exact: true }).click();
    await courierPage.getByRole("button", { name: "Share my location for this delivery", exact: true }).waitFor();
    verify(await courierPage.evaluate(() => window.__restaurantTestGeo.started === 2 && window.__restaurantTestGeo.watches.size === 0), "Assigning the job back requires new consent and never restarts old sharing");
    verify((await ownerLocation()).location === null, "Reassignment back cannot resurrect historical coordinates");
    await start();
    order = await privateOrder();
    for (const status of ["picked_up", "on_the_way", "nearby", "at_door", "delivered"]) order = await api(courierContext, courierOrderPath, "PATCH", { status, version: order.version, collectCash: status === "delivered" });
    verify(order.status === "completed" && order.payment.status === "paid", "Synthetic COD delivery completes only with explicit collection");
    verify((await ownerLocation()).location === null, "Completed deliveries never expose a location");
    stage = "completion removes courier browser watch";
    await courierPage.getByRole("button", { name: "Refresh", exact: true }).click();
    await courierPage.waitForFunction(() => window.__restaurantTestGeo.watches.size === 0);
    verify(await courierPage.evaluate(() => window.__restaurantTestGeo.started === 3 && window.__restaurantTestGeo.cleared === 3), "All three explicitly started watches are cleaned up after stop, reassignment and completion");
    await ownerPage.reload();
    stage = "completed receipt hides location panel";
    await ownerPage.locator('.rs-print-receipt').waitFor();
    verify(await ownerPage.locator('.rs-panel.rs-location').count() === 0, "Completed customer view hides the active-location panel");
    verify(publicRequests > 0 && failures.length === 0, `No browser exception, external network request or credential leakage (${failures.join('; ')})`);
    return { checks, count: checks.length, screenshots, mockedTileRequests: tileRequests, externalNetworkRequestsSent: 0, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return { checks, count: checks.length, stage, deadlineReached, elapsedMs: Date.now() - startedAt, error: String(error), failures, screenshots };
  } finally {
    finished = true;
    for (const context of contexts.reverse()) await context.close();
  }
}
