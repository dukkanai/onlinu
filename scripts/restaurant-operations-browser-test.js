// Isolated operations QA. Never point this harness at a production server.
async (page) => {
  const origin = 'http://127.0.0.1:18083';
  const browser = page.context().browser();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const checks = [], failures = [];
  const adminKey = 'restaurant-browser-test-key';
  const run = `ops_${Date.now()}`;
  const verify = (ok, text) => { if (!ok) throw new Error(text); checks.push(text); };
  const api = async (path, method = 'GET', data, admin = false, extra = {}) => {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid isolated path');
    const response = await context.request.fetch(origin + path, { method, headers: { Origin: origin, ...(admin ? { 'X-API-Key': adminKey } : {}), ...extra }, ...(data === undefined ? {} : { data }) });
    if (!response.ok()) throw new Error(`${method} ${path} rejected ${response.status()}: ${await response.text()}`);
    return response.status() === 204 ? null : response.json();
  };
  try {
    await context.addInitScript(() => localStorage.setItem('restaurant.locale', 'en'));
    await context.route('**/*', async route => {
      if (!route.request().url().startsWith(origin + '/')) { failures.push('Unexpected external request'); await route.abort(); }
      else await route.continue();
    });
    context.on('request', req => {
      if (/\/(storefront|courier)-api\//.test(req.url()) && req.headers()['x-api-key']) failures.push('Administrator credential on customer/courier API');
    });
    const p = await context.newPage();
    p.setDefaultTimeout(12000);
    p.on('pageerror', err => failures.push(err.message));
    p.on('dialog', dialog => dialog.accept());
    await p.goto(origin + '/');
    const noOverflow = async label => {
      const v = await p.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
      verify(v.content <= v.width + 2, `${label}: no horizontal mobile overflow`);
    };
    let catalog = await api('/api/restaurant/catalog', 'GET', undefined, true);
    catalog = await api('/api/restaurant/catalog', 'PUT', { ...catalog, settings: { ...catalog.settings, demo: true, country: 'SA', currency: 'SAR', defaultLanguage: 'en', taxEnabled: true, taxRateBps: 1500, taxNumber: '300000000000003', deliveryEnabled: true, tableEnabled: true, acceptingOrders: true, deliveryPricingMode: 'flat', deliveryZones: [], deliveryFeeMinor: 1500, deliveryMinimumMinor: 0, deliveryAreas: [], deliveryRadiusKm: 0, latitude: null, longitude: null, requireDeliveryLocation: false, paymentMethods: { table: ['cash_before', 'cash_after', 'card'], delivery: ['cash_on_delivery', 'card'], pickup: ['card'] } }, items: catalog.items.map((item, i) => i ? item : { ...item, priceMinor: 10000, available: true }) }, true);
    const makeOrder = async (mode, method) => {
      const input = { mode, paymentMethod: method, paymentProvider: '', customerName: 'Operations test customer', phone: '+966500000000', tableCode: mode === 'table' ? catalog.tables[0].code : '', address: { country: 'SA', nationalAddress: 'TEST1234', addressLine: 'Synthetic test location' }, items: [{ itemId: catalog.items[0].id, quantity: 1, optionIds: [] }] };
      const quote = await api('/storefront-api/quote', 'POST', input);
      const key = await p.evaluate(() => crypto.randomUUID());
      return api('/storefront-api/orders', 'POST', { ...input, expectedTotalMinor: quote.totalMinor }, false, { 'Idempotency-Key': key });
    };
    const before = await makeOrder('table', 'cash_before');
    verify(before.order.totalMinor === 10000 && before.order.tax.grossMinor === 10000 && before.order.tax.netMinor + before.order.tax.taxMinor === 10000, 'Inclusive VAT never increases menu gross price');
    const accepted = await api(`/api/restaurant/orders/${before.order.number}`, 'PATCH', { status: 'accepted', version: before.order.version }, true);
    let r = await context.request.patch(origin + `/api/restaurant/orders/${before.order.number}`, { headers: { Origin: origin, 'X-API-Key': adminKey }, data: { status: 'preparing', version: accepted.version } });
    verify(r.status() === 409, 'Cash-before order cannot enter preparation before collection');
    const collected = await api(`/api/restaurant/orders/${before.order.number}/cash`, 'POST', { version: accepted.version }, true);
    verify(collected.payment.status === 'paid', 'Explicit admin cash collection updates payment separately');
    const providers = await api('/storefront-api/payments');
    verify(providers.providers.length === 0, 'No unconfigured gateways offered to customers');
    const allProviders = await api('/api/restaurant/payments', 'GET', undefined, true);
    verify(allProviders.providers.length === 7 && allProviders.providers.every(v => !v.enabled), 'All seven gateways present and disabled by default');

    await p.goto(origin + '/admin');
    await p.getByLabel('Administrator access key').fill(adminKey);
    await p.getByRole('button', { name: 'Sign in', exact: true }).click();
    await p.getByRole('button', { name: 'Couriers', exact: true }).click();
    await p.getByRole('button', { name: 'Add courier', exact: true }).click();
    await p.getByLabel('Username', { exact: true }).fill(run);
    await p.getByLabel('Name', { exact: true }).fill('Operations Courier');
    await p.getByLabel('Phone number', { exact: true }).fill('+966500000001');
    await p.getByLabel('Password', { exact: true }).fill('operations-test-only-password');
    await p.getByRole('button', { name: 'Save', exact: true }).click();
    await p.getByText('Courier account saved.', { exact: true }).waitFor();
    verify(true, 'Admin creates a separate courier account through UI');
    await noOverflow('Admin couriers');
    const couriers = await api('/api/restaurant/couriers', 'GET', undefined, true);
    const courier = couriers.couriers.find(c => c.username === run);
    verify(Boolean(courier) && !JSON.stringify(couriers).includes('operations-test-only-password'), 'Courier account list never returns password');

    await p.getByRole('button', { name: 'Payment gateways', exact: true }).click();
    await p.getByRole('heading', { name: 'MyFatoorah', exact: true }).waitFor();
    for (const name of ['Stripe','Moyasar','Tap','HyperPay','PayTabs','Geidea','MyFatoorah']) verify(await p.getByRole('heading', { name, exact: true }).count() === 1, `Gateway editor ${name} visible`);
    await noOverflow('Gateway configuration');
    await p.screenshot({ path: '/home/chatbot/wa/AstraCalls/prints/operations-gateways-mobile.png', fullPage: true });

    await p.getByRole('button', { name: 'WhatsApp connection', exact: true }).click();
    await p.getByText('No WhatsApp connections have been added.', { exact: true }).waitFor();
    await noOverflow('WhatsApp administration');
    verify(true, 'WhatsApp management page loads without initiating a session');

    await p.getByRole('button', { name: 'Restaurant appearance', exact: true }).click();
    await p.getByText('Appearance drafts stay private. Save a draft, review it, then publish it to customers.', { exact: true }).waitFor();
    await p.getByText('This is a responsive appearance sample, not a live customer order. Publishing updates only the appearance.', { exact: true }).waitFor();
    await p.getByRole('button', { name: 'Save draft', exact: true }).waitFor();
    await p.getByRole('button', { name: 'Publish appearance', exact: true }).waitFor();
    await noOverflow('Appearance preview');
    await p.screenshot({ path: '/home/chatbot/wa/AstraCalls/prints/operations-brand-mobile.png', fullPage: true });
    await p.locator('.restaurant-language select').first().selectOption('ar');
    await noOverflow('Arabic appearance preview');
    await p.screenshot({ path: '/home/chatbot/wa/AstraCalls/prints/operations-brand-rtl.png', fullPage: true });

    const receipt = await makeOrder('delivery', 'cash_on_delivery');
    verify(receipt.order.totalMinor === 11500 && receipt.order.tax.taxMinor === 1500 && receipt.order.tax.netMinor === 10000, 'VAT snapshot includes delivery fee: 115 gross, 100 net, 15 tax');
    let order = receipt.order;
    for (const status of ['accepted','preparing','ready']) order = await api(`/api/restaurant/orders/${order.number}`, 'PATCH', { status, version: order.version }, true);
    order = await api(`/api/restaurant/orders/${order.number}/courier`, 'POST', { courierId: courier.id, version: order.version }, true);

    // Courier/customer test profile has no administrator localStorage or cookie.
    await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('restaurant.locale', 'en'); });
    await p.goto(origin + '/courier');
    await p.getByLabel('Username', { exact: true }).fill(run);
    await p.getByLabel('Password', { exact: true }).fill('operations-test-only-password');
    await p.getByRole('button', { name: 'Sign in', exact: true }).click();
    await p.getByText(order.number, { exact: false }).first().waitFor();
    await noOverflow('Courier active delivery');
    await p.screenshot({ path: '/home/chatbot/wa/AstraCalls/prints/operations-courier-mobile.png', fullPage: true });
    verify(true, 'Courier signs in and sees assigned delivery');
    // UI labels and controls are exercised; auth/version/monotonic behavior is
    // independently covered by database-backed server tests.
    for (const label of ['Collected from restaurant','On the way','Nearby','At your door']) {
      await p.getByRole('button', { name: `Update delivery status · ${label}`, exact: true }).click();
      await p.waitForTimeout(150);
    }
    verify(await p.getByRole('button', { name: 'Update delivery status · Delivered', exact: true }).isDisabled(), 'Courier cannot finish COD before explicit cash collection');
    const cashFormat = new Intl.NumberFormat('en', { style: 'currency', currency: order.currency });
    const cashAmount = cashFormat.format(order.totalMinor / 10 ** (cashFormat.resolvedOptions().maximumFractionDigits ?? 2));
    await p.getByRole('checkbox', { name: `I have collected the full cash amount: ${cashAmount}`, exact: true }).check();
    await p.getByRole('button', { name: 'Update delivery status · Delivered', exact: true }).click();
    await p.waitForTimeout(250);
    const delivered = await api(`/storefront-api/orders/${order.number}`, 'GET', undefined, false, { 'X-Order-Token': receipt.trackingToken });
    verify(delivered.deliveryStatus === 'delivered' && delivered.status === 'completed' && delivered.payment.status === 'paid', 'Courier journey completes only after collecting COD');
    verify(delivered.deliveryEvents.length === 6, 'Assignment and five delivery steps have audit history');
    await p.goto(origin + `/track?order=${encodeURIComponent(order.number)}#token=${encodeURIComponent(receipt.trackingToken)}`);
    await p.getByRole('heading', { name: `Order number ${order.number}`, exact: true }).waitFor();
    await noOverflow('Customer completed delivery tracking');
    await p.screenshot({ path: '/home/chatbot/wa/AstraCalls/prints/operations-tracking-mobile.png', fullPage: true });
    await p.goto(origin + '/payment-return?attempt=00000000-0000-0000-0000-000000000000&success=true');
    verify(!(await p.locator('body').innerText()).includes('Payment confirmed'), 'Forged return query never confirms payment');
    verify(failures.length === 0, `No browser errors, external calls or admin credential leakage (${failures.join('; ')})`);
    return { checks, count: checks.length };
  } catch (error) {
    return { checks, count: checks.length, error: String(error), failures };
  } finally { await context.close(); }
}
