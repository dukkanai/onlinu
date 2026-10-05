// Fixed-origin integration acceptance for geography and reopening. Synthetic
// cash orders only; use after the visual suite, never against a live restaurant.
async (page) => {
  const origin = 'http://127.0.0.1:18083', key = 'restaurant-browser-test-key';
  const context = await page.context().browser().newContext({ viewport: { width: 390, height: 900 } });
  const checks = [], failures = [], requests = [];
  const run = `audit_ops_${Date.now()}`;
  const dish = `District audit dish ${run}`;
  const verify = (value, message) => { if (!value) throw Error(message); checks.push(message); };
  const api = async (path, method = 'GET', data, admin = true, headers = {}, expected = 200) => {
    if (!/^\/(?:api\/restaurant|storefront-api)\//.test(path) || /\/(?:payment|execute|sessions|summarize)(?:\/|$)/.test(path)) throw Error('Unsafe test path');
    const response = await context.request.fetch(origin + path, { method, maxRedirects: 0, headers: { Origin: origin, ...(admin ? { 'X-API-Key': key } : {}), ...headers }, ...(data === undefined ? {} : { data }) });
    if (response.status() !== expected) throw Error(`${method} ${path} returned ${response.status()}: ${await response.text()}`);
    return response.status() === 204 ? null : response.json();
  };
  const layout = async (p, label) => verify(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), `${label}: no horizontal overflow`);
  try {
    await context.addInitScript(() => localStorage.setItem('restaurant.locale', 'en'));
    await context.route('**/*', async route => {
      if (!route.request().url().startsWith(origin + '/')) { failures.push('External request blocked'); return route.abort(); }
      if (/\/(?:payment|execute|summarize)(?:\/|\?|$)|\/api\/sessions/.test(route.request().url())) { failures.push('External-action route blocked'); return route.abort(); }
      return route.continue();
    });
    context.on('request', request => { if (request.url().startsWith(origin + '/storefront-api/') && request.headers()['x-api-key']) failures.push('Admin key leaked to customer'); });
    const admin = await context.newPage(), customer = await context.newPage();
    for (const p of [admin, customer]) { p.setDefaultTimeout(12000); p.on('pageerror', error => failures.push(error.message)); p.on('dialog', dialog => dialog.accept()); }
    let catalog = await api('/api/restaurant/catalog');
    catalog = await api('/api/restaurant/catalog', 'PUT', {
      ...catalog,
      settings: { ...catalog.settings, demo: true, acceptingOrders: true, deliveryEnabled: true, deliveryPricingMode: 'flat', deliveryZones: [], deliveryFeeMinor: 500, deliveryMinimumMinor: 0, deliveryAreas: [], deliveryRadiusKm: 0, requireDeliveryLocation: false, taxEnabled: false, paymentMethods: { delivery: ['cash_on_delivery'], table: ['cash_after'], pickup: ['card'] } },
      categories: [...catalog.categories, { id: run, name: 'Operations audit', sort: 99 }],
      items: [...catalog.items, { id: run, categoryId: run, name: dish, description: 'Synthetic test item', priceMinor: 3000, imageUrl: '', available: true, sort: 99, options: [] }],
    });
    await admin.goto(origin + '/admin');
    await admin.getByLabel('Administrator access key', { exact: true }).fill(key);
    await admin.getByRole('button', { name: 'Sign in', exact: true }).click();
    await admin.getByRole('button', { name: 'Restaurant settings', exact: true }).click();
    const zones = admin.locator('.ra-delivery-zones');
    await zones.getByLabel('Delivery pricing', { exact: true }).selectOption('district');
    await zones.getByLabel('Region', { exact: true }).selectOption('sa-r-1');
    await zones.getByLabel('City', { exact: true }).selectOption('sa-c-3');
    await zones.locator('.ra-zone-row').first().waitFor();
    await zones.getByRole('button', { name: 'Add a missing district', exact: true }).click();
    await zones.getByLabel('District name in Arabic', { exact: true }).fill('حي الاختبار المحلي');
    await zones.getByLabel('District name in English', { exact: true }).fill(run);
    await zones.getByRole('button', { name: 'Save directory correction', exact: true }).click();
    await zones.locator('.ra-zone-correction').waitFor({ state: 'detached' });
    await zones.getByLabel('Search districts in this city', { exact: true }).fill(run);
    const row = zones.locator('.ra-zone-row').filter({ hasText: run });
    await row.waitFor();
    await row.getByLabel('Delivery enabled', { exact: true }).check();
    verify(await row.getByLabel('Delivery fee', { exact: true }).inputValue() === '', 'New enabled district has an unset fee, never implicit zero');
    await row.getByLabel('Delivery fee', { exact: true }).fill('12.50');
    await admin.getByRole('button', { name: 'Save and publish', exact: true }).click();
    await admin.getByText('Restaurant changes published.', { exact: true }).waitFor();
    catalog = await api('/api/restaurant/catalog');
    const directory = await api('/api/restaurant/geography?kind=districts&cityId=sa-c-3');
    const district = directory.districts.find(d => d.nameEn === run);
    verify(district && catalog.settings.deliveryZones.some(z => z.districtId === district.id && z.enabled && z.feeMinor === 1250), 'Local correction and explicit per-district fee persist independently');
    await layout(admin, 'Mobile district editor');
    await admin.screenshot({ path: '/home/chatbot/wa/AstraCalls/prints/iteration-audit-district-admin.png', fullPage: true });
    await customer.goto(origin + '/');
    await customer.getByRole('button', { name: dish, exact: true }).click();
    await customer.getByRole('dialog', { name: dish, exact: true }).getByRole('button', { name: /^Add to order/ }).click();
    await customer.getByRole('button', { name: 'Your order', exact: true }).click();
    await customer.getByRole('heading', { name: 'Complete your order', exact: true }).waitFor();
    await customer.getByLabel('Your name', { exact: true }).fill('Synthetic district customer');
    await customer.getByLabel('Phone number', { exact: true }).fill('+966500000000');
    await customer.getByLabel('Region', { exact: true }).selectOption('sa-r-1');
    await customer.getByLabel('City', { exact: true }).selectOption('sa-c-3');
    await customer.getByLabel('District', { exact: true }).selectOption(district.id);
    verify(await customer.getByLabel('District', { exact: true }).locator('option').count() === 2, 'Customer selector includes only configured delivery districts');
    await customer.getByLabel('Saudi national address / short address', { exact: true }).fill('ABCD1234');
    await customer.getByRole('button', { name: 'Review order', exact: true }).click();
    await customer.getByRole('button', { name: /^Confirm order/ }).waitFor();
    verify((await customer.locator('.rs-cart').innerText()).includes('42.50'), 'Checkout quote includes the configured 12.50 fee with the 30.00 item');
    await layout(customer, 'District checkout');
    await customer.screenshot({ path: '/home/chatbot/wa/AstraCalls/prints/iteration-audit-district-checkout.png', fullPage: true });

    // Direct API adversarial checks use the same synthetic catalog and address.
    const input = { mode: 'delivery', paymentMethod: 'cash_on_delivery', customerName: 'Audit reopen customer', phone: '+966500000000', address: { country: 'SA', regionId: 'sa-r-1', cityId: 'sa-c-3', districtId: district.id, city: 'forged city', district: 'forged district', nationalAddress: 'ABCD1234', latitude: null, longitude: null }, items: [{ itemId: run, quantity: 1, optionIds: [] }], notes: 'Synthetic audit', tableCode: '' };
    const quote = await api('/storefront-api/quote', 'POST', input, false);
    verify(quote.deliveryFeeMinor === 1250, 'Server computes fee from district ID');
    const invalid = await api('/storefront-api/quote', 'POST', { ...input, address: { ...input.address, districtId: 'sa-d-missing' } }, false, {}, 400);
    verify(invalid.error === 'invalid_district', 'Forged district is rejected before order/payment');
    const requestId = await customer.evaluate(() => crypto.randomUUID());
    const receipt = await api('/storefront-api/orders', 'POST', { ...input, expectedTotalMinor: quote.totalMinor }, false, { 'Idempotency-Key': requestId }, 201);
    verify(receipt.order.address.city === 'الرياض' && receipt.order.address.district === 'حي الاختبار المحلي', 'Stored destination uses directory names instead of forged text');
    const cancelled = await api(`/api/restaurant/orders/${receipt.order.number}`, 'PATCH', { version: receipt.order.version, status: 'cancelled' });
    await admin.getByRole('button', { name: 'Orders', exact: true }).click();
    await admin.getByLabel('Search order number, name or phone', { exact: true }).fill(cancelled.number);
    await admin.locator('.ra-order-pick').filter({ hasText: '#' + cancelled.number }).click();
    await admin.getByLabel('Reason for reopening', { exact: true }).fill('Correct an accidental cancellation');
    let loseResponse = true;
    await context.route(origin + `/api/restaurant/orders/${cancelled.number}/reopen`, async route => {
      requests.push(route.request().postDataJSON());
      if (loseResponse) { loseResponse = false; await route.fetch(); return route.abort('failed'); }
      return route.continue();
    });
    await admin.getByRole('button', { name: 'Reopen order', exact: true }).click();
    await admin.locator('.ra-reopen-panel').getByRole('button', { name: 'Try again', exact: true }).waitFor();
    verify(await admin.getByLabel('Reason for reopening', { exact: true }).getAttribute('readonly') !== null, 'Unknown reopen result locks original reason');
    // Repeated response loss must remain safe across a browser refresh too.
    await admin.reload();
    await admin.getByRole('button', { name: 'Orders', exact: true }).click();
    await admin.getByLabel('Search order number, name or phone', { exact: true }).fill(cancelled.number);
    await admin.locator('.ra-order-pick').filter({ hasText: '#' + cancelled.number }).click();
    await admin.locator('.ra-reopen-panel').getByRole('button', { name: 'Try again', exact: true }).click();
    await admin.getByText('Order reopened. Review it before accepting.', { exact: true }).waitFor();
    verify(requests.length === 2 && JSON.stringify(requests[0]) === JSON.stringify(requests[1]), 'Lost response and reload retry retain exact request ID, reason and original version');
    const order = await api(`/storefront-api/orders/${receipt.order.number}`, 'GET', undefined, false, { 'X-Order-Token': receipt.trackingToken });
    verify(order.status === 'new' && order.version === cancelled.version + 1 && order.totalMinor === receipt.order.totalMinor, 'Reopen changes state once and preserves historical prices');
    await layout(admin, 'Reopened order');
    await admin.screenshot({ path: '/home/chatbot/wa/AstraCalls/prints/iteration-audit-reopen-admin.png', fullPage: true });
    const accepted = await api(`/api/restaurant/orders/${order.number}`, 'PATCH', { version: order.version, status: 'accepted' });
    const prepared = await api(`/api/restaurant/orders/${order.number}`, 'PATCH', { version: accepted.version, status: 'preparing' });
    const finalCancel = await api(`/api/restaurant/orders/${order.number}`, 'PATCH', { version: prepared.version, status: 'cancelled' });
    const blocked = await api(`/api/restaurant/orders/${order.number}/reopen`, 'POST', { requestId: await customer.evaluate(() => crypto.randomUUID()), version: finalCancel.version, reason: 'Must be rejected' }, true, {}, 409);
    verify(blocked.error === 'reopen_prepared', 'Prepared cancelled order cannot be reopened');
    await api(`/api/restaurant/orders/${order.number}/reopen`, 'POST', { requestId: await customer.evaluate(() => crypto.randomUUID()), version: finalCancel.version, reason: 'Anonymous attempt' }, false, {}, 401);
    verify(true, 'Reopen route rejects missing administrator credential');
    verify(failures.length === 0, 'No runtime errors, external requests or credential leaks');
    return { checks, failures, requests };
  } finally { await context.close(); }
}
