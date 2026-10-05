// Dedicated delivery regression; run after the visual and operations suites.
// This script accepts only the fixed disposable local audit application.
async (page) => {
  const origin = 'http://127.0.0.1:18083', key = 'restaurant-browser-test-key';
  const run = `delivery_audit_${Date.now()}`;
  const context = await page.context().browser().newContext({ viewport: { width: 390, height: 900 } });
  const checks = [], failures = [];
  const verify = (ok, message) => { if (!ok) throw Error(message); checks.push(message); };
  const api = async (path, method = 'GET', data) => {
    if (!/^\/(?:api\/restaurant|storefront-api)\//.test(path)) throw Error('Unexpected audit path');
    const response = await context.request.fetch(origin + path, { method, maxRedirects: 0, headers: { Origin: origin, ...(path.startsWith('/api/') ? { 'X-API-Key': key } : {}) }, ...(data === undefined ? {} : { data }) });
    if (!response.ok()) throw Error(`${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.status() === 204 ? null : response.json();
  };
  let customer;
  try {
    await context.addInitScript(() => {
      localStorage.setItem('restaurant.locale', 'en');
      Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: callback => { window.auditLocationCallback = callback; } } });
    });
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    context.on('request', request => { if (request.url().startsWith(origin + '/storefront-api/') && request.headers()['x-api-key']) failures.push('Admin key leaked'); });
    const districts = await api('/api/restaurant/geography?kind=districts&cityId=sa-c-3');
    const free = districts.districts.find(d => d.id === 'sa-d-10100003001'), paid = districts.districts.find(d => d.id === 'sa-d-10100003002');
    const elsewhere = (await api('/api/restaurant/geography?kind=districts&cityId=sa-c-6')).districts[0];
    let catalog = await api('/api/restaurant/catalog');
    // Own the menu fixture too: another acceptance suite may legitimately leave
    // only items with options, unavailable stock, or different price settings.
    const item = { id: run, categoryId: run, name: `Delivery audit dish ${run}`, description: 'Synthetic delivery acceptance item', priceMinor: 2500, imageUrl: '', available: true, sort: 99, options: [] };
    verify(!!free && !!paid && !!elsewhere, 'Test directory fixtures are available');
    catalog = await api('/api/restaurant/catalog', 'PUT', { ...catalog, categories: [...catalog.categories, { id: run, name: `Delivery audit ${run}`, sort: 99 }], items: [...catalog.items, item], settings: { ...catalog.settings, currency: 'SAR', country: 'SA', demo: true, acceptingOrders: true, deliveryEnabled: true, deliveryPricingMode: 'district', deliveryZones: [{ districtId: free.id, enabled: false, feeMinor: null }, { districtId: paid.id, enabled: true, feeMinor: 1500 }, { districtId: elsewhere.id, enabled: true, feeMinor: 2500 }], deliveryAreas: [], deliveryRadiusKm: 0, requireDeliveryLocation: false, deliveryMinimumMinor: 0, taxEnabled: false, paymentMethods: { ...catalog.settings.paymentMethods, delivery: ['cash_on_delivery'] } } });
    const admin = await context.newPage(); admin.setDefaultTimeout(12000);
    await admin.goto(origin + '/admin'); await admin.getByLabel('Administrator access key', { exact: true }).fill(key); await admin.getByRole('button', { name: 'Sign in', exact: true }).click(); await admin.getByRole('button', { name: 'Restaurant settings', exact: true }).click();
    const zones = admin.locator('.ra-delivery-zones');
    await zones.getByLabel('Region', { exact: true }).selectOption('sa-r-1');
    await zones.getByLabel('City', { exact: true }).selectOption('sa-c-3');
    await zones.getByLabel('Search districts in this city', { exact: true }).fill(free.nameEn);
    const row = zones.locator('.ra-zone-row').filter({ hasText: free.nameEn });
    await row.getByLabel('Delivery enabled', { exact: true }).check();
    await admin.getByRole('button', { name: 'Save and publish', exact: true }).click();
    verify(await row.getByLabel('Delivery fee', { exact: true }).evaluate(el => !el.validity.valid), 'Enabled district with a blank fee cannot be published');
    verify((await api('/api/restaurant/catalog')).version === catalog.version, 'Invalid fee publication leaves existing catalog unchanged');
    await row.getByRole('button', { name: 'Set free delivery', exact: true }).click();
    verify(await row.getByLabel('Delivery fee', { exact: true }).inputValue() === '0.00', 'Explicit free action fills zero at currency precision');
    await admin.getByRole('button', { name: 'Save and publish', exact: true }).click();
    await admin.getByText('Restaurant changes published.', { exact: true }).waitFor();
    catalog = await api('/api/restaurant/catalog');
    verify(catalog.settings.deliveryZones.find(zone => zone.districtId === free.id)?.feeMinor === 0, 'Explicit free fee is persisted as zero');
    await zones.getByLabel('Region', { exact: true }).selectOption('sa-r-1');
    await zones.getByLabel('City', { exact: true }).selectOption('sa-c-3');
    await zones.getByLabel('Search districts in this city', { exact: true }).fill(free.nameEn);
    await row.getByRole('button', { name: 'Correct district name', exact: true }).click();
    const beforeCorrection = await api('/api/restaurant/geography?kind=districts&cityId=sa-c-3');
    await api('/api/restaurant/geography/district', 'PUT', { version: beforeCorrection.version, id: free.id, cityId: free.cityId, nameAr: free.nameAr, nameEn: free.nameEn });
    await zones.getByLabel('District name in English', { exact: true }).fill(free.nameEn + ' audit correction');
    await zones.getByRole('button', { name: 'Save directory correction', exact: true }).click();
    await zones.locator('.ra-alert').waitFor();
    verify(await zones.getByRole('button', { name: 'Save directory correction', exact: true }).isDisabled(), 'Conflicting directory correction cannot overwrite another administrator update');
    verify((await api('/api/restaurant/geography?kind=districts&cityId=sa-c-3')).districts.find(d => d.id === free.id).nameEn === free.nameEn, 'Conflict preserves the latest directory entry');
    await zones.locator('.ra-alert button').click();
    await row.getByRole('button', { name: 'Correct district name', exact: true }).click();
    await zones.getByLabel('District name in English', { exact: true }).fill(free.nameEn + ' audit correction');
    await zones.getByRole('button', { name: 'Save directory correction', exact: true }).click();
    await zones.locator('.ra-zone-correction').waitFor({ state: 'detached' });
    const corrected = (await api('/api/restaurant/geography?kind=districts&cityId=sa-c-3')).districts.find(d => d.id === free.id);
    verify(corrected.nameEn === free.nameEn + ' audit correction' && corrected.custom, 'Reloaded correction saves the local name while retaining the district identifier');

    const username = `delivery_${Date.now()}`;
    await api('/storefront-api/account/register', 'POST', { username, password: 'Local-audit-pass-123', displayName: 'Synthetic delivery customer' });
    customer = await context.newPage(); customer.setDefaultTimeout(12000); customer.on('pageerror', error => failures.push(error.message));
    await customer.goto(origin + '/account');
    await customer.getByRole('button', { name: 'Add an address', exact: true }).click();
    await customer.getByRole('button', { name: 'Choose from the address directory', exact: true }).click();
    await customer.getByLabel('Address label', { exact: true }).fill('Audit saved district');
    await customer.getByLabel('Region', { exact: true }).selectOption('sa-r-1');
    await customer.getByLabel('City', { exact: true }).selectOption('sa-c-3');
    await customer.getByLabel('District', { exact: true }).selectOption(free.id);
    await customer.getByLabel('Saudi national address / short address', { exact: true }).fill('ABCD1234');
    await customer.getByLabel('Phone number', { exact: true }).fill('+966500000000');
    await customer.getByRole('button', { name: 'Save', exact: true }).click();
    await customer.getByText('Saved', { exact: true }).waitFor();
    const account = await api('/storefront-api/account');
    verify(account.customer.addresses.some(address => address.regionId === 'sa-r-1' && address.cityId === 'sa-c-3' && address.districtId === free.id), 'Saving an address preserves complete directory identifiers');
    await customer.reload();
    verify(await customer.getByLabel('District', { exact: true }).inputValue() === free.id, 'Reloaded saved address retains its selected district');
    await customer.goto(origin + '/');
    await customer.getByRole('button', { name: item.name, exact: true }).click();
    await customer.getByRole('dialog', { name: item.name, exact: true }).getByRole('button', { name: /^Add to order/ }).click();
    await customer.getByRole('button', { name: 'Your order', exact: true }).click();
    await customer.getByLabel('Saved addresses', { exact: true }).selectOption('0');
    verify(await customer.getByLabel('District', { exact: true }).inputValue() === free.id, 'Checkout recovers saved directory selections');
    await customer.getByRole('button', { name: 'Use my location', exact: true }).click();
    await customer.getByLabel('District', { exact: true }).selectOption(paid.id);
    verify(await customer.getByLabel('Saudi national address / short address', { exact: true }).inputValue() === '', 'Changing district clears the previous short address');
    await customer.evaluate(() => window.auditLocationCallback({ coords: { latitude: 24.7, longitude: 46.7 } }));
    verify(await customer.getByText('Location attached', { exact: true }).count() === 0, 'Late geolocation cannot attach a previous destination location to the new district');
    await customer.getByLabel('Saudi national address / short address', { exact: true }).fill('EFGH5678');
    let response = customer.waitForResponse(response => response.url() === origin + '/storefront-api/quote' && response.request().method() === 'POST');
    await customer.getByRole('button', { name: 'Review order', exact: true }).click();
    let quote = await (await response).json();
    verify(quote.deliveryFeeMinor === 1500, 'Changed paid destination receives its own server fee');
    await customer.getByRole('button', { name: 'Edit order', exact: true }).click();
    await customer.getByLabel('District', { exact: true }).selectOption(free.id);
    verify(await customer.getByRole('button', { name: /^Confirm order/ }).count() === 0, 'Editing destination requires a fresh quote before confirmation');
    await customer.getByLabel('Saudi national address / short address', { exact: true }).fill('IJKL9876');
    response = customer.waitForResponse(response => response.url() === origin + '/storefront-api/quote' && response.request().method() === 'POST');
    await customer.getByRole('button', { name: 'Review order', exact: true }).click();
    quote = await (await response).json();
    verify(quote.deliveryFeeMinor === 0 && quote.totalMinor === item.priceMinor, 'Explicit free district quote removes the prior paid fee');
    await customer.getByRole('button', { name: 'Edit order', exact: true }).click();
    await customer.getByLabel('Region', { exact: true }).selectOption('sa-r-2');
    verify(await customer.getByLabel('City', { exact: true }).inputValue() === '' && await customer.getByLabel('District', { exact: true }).inputValue() === '', 'Region switch clears city and district selections');
    await customer.getByLabel('City', { exact: true }).selectOption('sa-c-6');
    await customer.getByLabel('District', { exact: true }).selectOption(elsewhere.id);
    verify(await customer.getByLabel('District', { exact: true }).locator('option').count() === 2, 'New city does not expose the previous city districts');
    verify(await customer.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'Saved address and district checkout fit a 390px mobile screen');
    await customer.screenshot({ path: '/home/chatbot/wa/AstraCalls/prints/iteration-audit-delivery-saved-mobile.png', fullPage: true });

    // Reproduce the UI view after an upstream directory retirement: no active
    // hierarchy exposes the persisted district. The backend retirement/save
    // invariant is covered separately against real database state in Go tests.
    const directoryRoute = /^http:\/\/127\.0\.0\.1:18083\/api\/restaurant\/geography\?/;
    await context.route(directoryRoute, async route => {
      const response = await route.fetch();
      const data = await response.json();
      await route.fulfill({ response, json: { ...data, regions: [], cities: [], districts: [] } });
    });
    await admin.reload();
    await admin.getByRole('button', { name: 'Restaurant settings', exact: true }).click();
    // Native <option> elements are not visible while their select is closed.
    // Wait for the post-loading placeholder to exist, not for option visibility.
    await zones.getByLabel('Region', { exact: true }).locator('option').filter({ hasText: /^Choose a region$/ }).waitFor({ state: 'attached' });
    verify(await zones.getByLabel('Region', { exact: true }).locator('option').count() === 1, 'Recovery fixture exposes no selectable active region');
    const configured = zones.locator('.ra-configured-zones');
    await configured.locator('summary').click();
    await configured.getByLabel('Search configured district IDs', { exact: true }).fill(paid.id);
    const savedZone = configured.locator('.ra-configured-zone');
    verify(await savedZone.count() === 1, 'Configured district remains reachable by ID when absent from the active directory');
    await savedZone.getByRole('button', { name: 'Disable delivery', exact: true }).click();
    verify(await savedZone.getByText('Delivery disabled', { exact: true }).count() === 1 && await savedZone.getByRole('button').count() === 0, 'Recovery only disables inaccessible zones; it cannot re-enable them');
    await admin.getByLabel('Restaurant phone', { exact: true }).fill('+966500000111');
    await admin.getByRole('button', { name: 'Save and publish', exact: true }).click();
    await admin.getByText('Restaurant changes published.', { exact: true }).waitFor();
    catalog = await api('/api/restaurant/catalog');
    verify(catalog.settings.deliveryZones.some(zone => zone.districtId === paid.id && !zone.enabled && zone.feeMinor === 1500) && catalog.settings.phone === '+966500000111', 'Recovery preserves the stored fee and allows publishing unrelated restaurant changes');
    verify(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'Configured-zone recovery fits a 390px mobile screen');
    await admin.screenshot({ path: '/home/chatbot/wa/AstraCalls/prints/iteration-audit-delivery-recovery-mobile.png', fullPage: true });
    await context.unroute(directoryRoute);

    catalog = await api('/api/restaurant/catalog');
    await api('/api/restaurant/catalog', 'PUT', { ...catalog, settings: { ...catalog.settings, deliveryPricingMode: 'flat', deliveryFeeMinor: 700 } });
    await customer.reload(); await customer.getByLabel('Saved addresses', { exact: true }).selectOption('');
    verify(await customer.getByLabel('City', { exact: true }).evaluate(el => el.tagName) === 'INPUT', 'Returning to flat pricing restores legacy manual city entry');
    await customer.getByLabel('Saudi national address / short address', { exact: true }).fill('MNOP1234');
    response = customer.waitForResponse(response => response.url() === origin + '/storefront-api/quote' && response.request().method() === 'POST');
    await customer.getByRole('button', { name: 'Review order', exact: true }).click(); quote = await (await response).json();
    verify(quote.deliveryFeeMinor === 700, 'Flat quote uses historical fixed fee despite configured district zones');
    verify(failures.length === 0, 'Delivery flow has no runtime errors or public credential leaks');
    return { checks, failures };
  } catch (error) {
    if (customer) await customer.screenshot({ path: '/home/chatbot/wa/AstraCalls/prints/iteration-audit-delivery-failure.png', fullPage: true }).catch(() => {});
    return { checks, failures: [...failures, error.message] };
  } finally { await context.close(); }
}
