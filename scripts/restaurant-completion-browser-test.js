// Isolated completion-round QA. This expression is consumed by the browser
// runner as async(page). Never replace its origin or key with production ones.
async (page) => {
  const origin = 'http://127.0.0.1:18083';
  const adminKey = 'restaurant-browser-test-key';
  const browser = page.context().browser();
  if (!browser) throw new Error('An isolated browser is required');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const checks = [], failures = [];
  const run = `completion_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const itemId = `${run}_dish`, categoryId = `${run}_category`;
  const itemName = `Completion test dish ${run}`;
  const verify = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
  const dangerousPath = path => /\/(?:payment|execute|summarize)(?:\/|$)|^\/payment-hooks\/|^\/api\/sessions(?:\/|$)/.test(path);
  // The browser runner VM has no global URL/URLSearchParams. Exact origin
  // matching also rejects prefix lookalikes such as :180830 or host suffixes.
  const isolatedPathname = value => {
    if (value !== origin && !value.startsWith(origin + '/') && !value.startsWith(origin + '?') && !value.startsWith(origin + '#')) return null;
    const tail = value.slice(origin.length);
    return tail.startsWith('/') ? tail.split(/[?#]/, 1)[0] : '/';
  };
  const api = async (path, method = 'GET', data, admin = false, extra = {}) => {
    if (!path.startsWith('/') || path.startsWith('//') || dangerousPath(path)) throw new Error('Forbidden isolated QA path');
    const response = await context.request.fetch(origin + path, {
      method,
      headers: { Origin: origin, ...(admin ? { 'X-API-Key': adminKey } : {}), ...extra },
      ...(data === undefined ? {} : { data }),
      maxRedirects: 0,
    });
    if (!response.ok()) throw new Error(`${method} ${path.split('?')[0]} rejected ${response.status()}: ${await response.text()}`);
    return response.status() === 204 ? null : response.json();
  };
  const safePath = path => { if (!path.startsWith('/') || path.startsWith('//') || dangerousPath(path)) throw new Error('Forbidden isolated QA path'); return origin + path; };
  let cancelSubmission = null;
  try {
    for (const profile of [context, guestContext]) {
      await profile.addInitScript(() => localStorage.setItem('restaurant.locale', 'en'));
      await profile.route('**/*', async route => {
        const request = route.request();
        const pathname = isolatedPathname(request.url());
        if (pathname === null) { failures.push('Unexpected external browser request'); await route.abort(); return; }
        if (dangerousPath(pathname) && !['GET', 'HEAD'].includes(request.method())) { failures.push('Unexpected payment, session or AI mutation'); await route.abort(); return; }
        await route.continue();
      });
      profile.on('request', request => {
        const pathname = isolatedPathname(request.url());
        if (pathname === null) return;
        if (/^\/(storefront|courier)-api\//.test(pathname) && request.headers()['x-api-key']) failures.push('Administrator credential on public/courier API');
        if (profile === guestContext && request.method() === 'POST' && /\/cancel$/.test(pathname)) {
          cancelSubmission = { path: pathname, key: request.headers()['idempotency-key'], body: request.postDataJSON() };
        }
      });
    }
    const admin = await context.newPage();
    const guest = await guestContext.newPage();
    for (const p of [admin, guest]) {
      p.setDefaultTimeout(15000);
      p.on('pageerror', error => failures.push(error.message));
      p.on('dialog', dialog => dialog.accept());
    }
    const layout = async (p, label) => {
      const result = await p.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth, text: document.body.innerText }));
      const keyLeak = /\b(?:errors|adminSupport|adminRefund|adminStock|archive|support|refund|location|brand)\.[a-z][A-Za-z0-9_.]*\b|\b(?:before_preparation|customer_before_preparation|restaurant_cancelled|late_verified_payment|refund_preflight_required)\b/.test(result.text);
      verify(result.content <= result.width + 2 && !keyLeak, `${label}: no horizontal mobile overflow or untranslated internal keys`);
    };
    const track = async receipt => {
      await guest.goto(safePath(`/track?order=${encodeURIComponent(receipt.order.number)}#token=${encodeURIComponent(receipt.trackingToken)}`));
      await guest.getByRole('heading', { name: `Order number ${receipt.order.number}`, exact: true }).waitFor();
    };
    const orderByToken = receipt => api(`/storefront-api/orders/${receipt.order.number}`, 'GET', undefined, false, { 'X-Order-Token': receipt.trackingToken });
    const stock = async () => (await api('/api/restaurant/stock', 'GET', undefined, true)).items.find(value => value.itemId === itemId);
    const selectAdminOrder = async number => {
      await admin.getByRole('button', { name: 'Orders', exact: true }).click();
      await admin.getByLabel('Search order number, name or phone', { exact: true }).fill(number);
      await admin.locator('.ra-order-pick').filter({ hasText: `#${number}` }).click();
      const detail = admin.locator('.ra-order-detail');
      await detail.getByRole('heading', { name: `#${number}`, exact: true }).waitFor();
      return detail;
    };

    let catalog = await api('/api/restaurant/catalog', 'GET', undefined, true);
    const tables = catalog.tables.some(value => value.active) ? catalog.tables : [...catalog.tables, { id: `${run}_table`, name: 'Completion QA table', code: '', active: true }];
    catalog = await api('/api/restaurant/catalog', 'PUT', {
      ...catalog,
      settings: { ...catalog.settings, defaultLanguage: 'en', demo: true, acceptingOrders: true, tableEnabled: true, deliveryPricingMode: 'flat', deliveryZones: [], paymentMethods: { ...catalog.settings.paymentMethods, table: ['cash_after'] } },
      categories: [...catalog.categories, { id: categoryId, name: 'Completion QA', sort: catalog.categories.length }],
      items: [...catalog.items, { id: itemId, categoryId, name: itemName, description: 'Synthetic isolated QA item; no real purchase.', priceMinor: 1200, imageUrl: '', available: true, sort: catalog.items.length, options: [] }],
      tables,
    }, true);
    const table = catalog.tables.find(value => value.active);
    verify(catalog.settings.demo && Boolean(table) && catalog.items.some(value => value.id === itemId), 'Unique synthetic cash-after catalog fixture is ready');
    const createOrder = async label => {
      const input = { mode: 'table', paymentMethod: 'cash_after', paymentProvider: '', customerName: `${label} ${run}`, phone: '', address: {}, tableCode: table.code, items: [{ itemId, quantity: 1, optionIds: [] }], notes: 'ISOLATED QA: no real food, cash, customer or financial transfer.' };
      const quote = await api('/storefront-api/quote', 'POST', input);
      const idempotency = await guest.evaluate(() => crypto.randomUUID());
      return api('/storefront-api/orders', 'POST', { ...input, expectedTotalMinor: quote.totalMinor }, false, { 'Idempotency-Key': idempotency });
    };

    const unauthStock = await guestContext.request.get(safePath('/api/restaurant/stock'), { maxRedirects: 0 });
    verify([401, 403].includes(unauthStock.status()), 'Stock administration rejects unauthenticated requests');
    await admin.goto(safePath('/admin'));
    await admin.getByLabel('Administrator access key').fill(adminKey);
    await admin.getByRole('button', { name: 'Sign in', exact: true }).click();
    await admin.getByRole('button', { name: 'Stock', exact: true }).click();
    await admin.getByRole('button').filter({ hasText: itemName }).click();
    await admin.getByRole('checkbox', { name: "Track this item's stock", exact: true }).check();
    await admin.getByLabel('Available units', { exact: true }).fill('3');
    await admin.getByRole('button', { name: 'Save', exact: true }).click();
    await admin.getByText('Stock updated.', { exact: true }).waitFor();
    let inventory = await stock();
    verify(inventory.tracked && inventory.available === 3 && inventory.held === 0, 'Admin stock UI persists the counted sellable quantity');
    await layout(admin, 'English stock editor');
    await admin.screenshot({ path: '/home/chatbot/wa/AstraCalls/prints/completion-stock-mobile.png', fullPage: true });

    await guest.goto(safePath('/'));
    const cancelled = await createOrder('Cancellation customer');
    inventory = await stock();
    verify(inventory.available === 2 && inventory.held === 1 && Boolean(cancelled.order.stockExpiresAt), 'Checkout atomically reserves one counted portion');
    const unauthOrder = await guestContext.request.get(safePath(`/storefront-api/orders/${cancelled.order.number}`));
    verify([401, 403, 404].includes(unauthOrder.status()), 'Order number alone does not reveal the private tracking record');
    await track(cancelled);
    await guest.getByRole('button', { name: 'Request cancellation', exact: true }).click();
    const cancelReason = `Synthetic change of plans ${run}`;
    await guest.getByLabel('Tell the restaurant what happened', { exact: true }).fill(cancelReason);
    await guest.getByRole('button', { name: 'Send request', exact: true }).click();
    await guest.getByText('Cancellation approved', { exact: true }).waitFor();
    const cancelledOrder = await orderByToken(cancelled);
    verify(cancelledOrder.status === 'cancelled' && cancelledOrder.cancellation.status === 'approved' && cancelledOrder.cancellation.requestedBeforePreparation && !cancelledOrder.preparationStartedAt, 'Customer tracking UI cancels an unprepared order without fabricating preparation');
    inventory = await stock();
    verify(inventory.available === 3 && inventory.held === 0, 'Early cancellation restores the reserved stock exactly once');
    if (!cancelSubmission?.key || cancelSubmission.body.reason !== cancelReason) throw new Error('Cancellation UI did not send a durable request identity');
    const retry = await api(cancelSubmission.path, 'POST', cancelSubmission.body, false, { 'Idempotency-Key': cancelSubmission.key, 'X-Order-Token': cancelled.trackingToken });
    verify(retry.version === cancelledOrder.version && (await stock()).available === 3, 'Retrying the captured UI cancellation UUID cannot duplicate cancellation or restock');
    await guest.getByText('No refund is recorded for this order yet.', { exact: true }).waitFor();
    verify((await api(`/storefront-api/orders/${cancelled.order.number}/refunds`, 'GET', undefined, false, { 'X-Order-Token': cancelled.trackingToken })).refunds.length === 0, 'Unpaid cancellation truthfully shows no money refund');
    await layout(guest, 'English cancelled-order tracking');
    await guest.screenshot({ path: '/home/chatbot/wa/AstraCalls/prints/completion-customer-cancel.png', fullPage: true });

    const complaintReason = `Synthetic receipt question ${run}`;
    await guest.getByRole('button', { name: 'Report a problem', exact: true }).click();
    await guest.getByLabel('Tell the restaurant what happened', { exact: true }).fill(complaintReason);
    await guest.getByRole('button', { name: 'Send request', exact: true }).click();
    await guest.getByText('Problem reported', { exact: true }).waitFor();
    const complaintOrder = await orderByToken(cancelled);
    verify(complaintOrder.complaints.length === 1 && complaintOrder.complaints[0].reason === complaintReason && complaintOrder.complaints[0].status === 'open', 'Customer complaint UI creates an authenticated open complaint');
    let detail = await selectAdminOrder(cancelled.order.number);
    await detail.getByText('No refund requests have been recorded.', { exact: true }).waitFor();
    verify(await detail.getByRole('button', { name: 'Request refund', exact: true }).count() === 0, 'Unpaid admin refund ledger does not offer a fabricated refundable balance');
    const resolution = `Synthetic explanation agreed ${run}`;
    await detail.getByLabel('Resolution details', { exact: true }).fill(resolution);
    await detail.getByRole('button', { name: 'Record resolution', exact: true }).click();
    await admin.getByText('Complaint resolution recorded.', { exact: true }).waitFor();
    verify((await orderByToken(cancelled)).complaints[0].resolution === resolution, 'Administrator resolves the complaint through the real UI with a recorded explanation');
    await admin.screenshot({ path: '/home/chatbot/wa/AstraCalls/prints/completion-admin-support.png', fullPage: true });
    await track(cancelled);
    await guest.getByText('Problem resolved', { exact: true }).waitFor();
    verify((await guest.locator('.rs-support').innerText()).includes(resolution), 'Customer tracking displays the restaurant resolution');

    // Synthetic cash ledger only. No provider credentials, payment creation,
    // refund execution or real financial request is used by this harness.
    const cashReceipt = await createOrder('Manual refund customer');
    let cashOrder = await api(`/api/restaurant/orders/${cashReceipt.order.number}/cash`, 'POST', { version: cashReceipt.order.version }, true);
    cashOrder = await api(`/api/restaurant/orders/${cashReceipt.order.number}`, 'PATCH', { status: 'cancelled', version: cashOrder.version }, true);
    const ledger = await api(`/api/restaurant/orders/${cashReceipt.order.number}/refunds`, 'GET', undefined, true);
    verify(!ledger.capability.automatic && ledger.refunds.length === 1 && ledger.refunds[0].status === 'review' && ledger.capturedMinor === cashOrder.totalMinor, 'Cancelled synthetic cash payment creates a review intent, never an electronic refund');
    detail = await selectAdminOrder(cashReceipt.order.number);
    await detail.getByText('Refund needs review', { exact: true }).waitFor();
    verify(await detail.getByRole('button', { name: 'Authorize provider refund', exact: true }).count() === 0, 'Cash refund UI does not expose a provider-execution action');
    await detail.getByRole('button', { name: 'Record an external refund', exact: true }).click();
    await detail.getByText('Only record a refund you have already completed outside this system. This does not verify that money reached the customer\'s bank.', { exact: true }).waitFor();
    await detail.getByLabel('External refund reference', { exact: true }).fill(`TEST-CASH-${run}`);
    await detail.getByLabel('Reason', { exact: true }).fill('Synthetic QA report of a simulated cash return; no real funds moved.');
    await detail.getByRole('button', { name: 'Record an external refund', exact: true }).last().click();
    await detail.getByText('Manually reported — not provider-confirmed', { exact: true }).waitFor();
    const reported = await api(`/api/restaurant/orders/${cashReceipt.order.number}/refunds`, 'GET', undefined, true);
    verify(reported.refunds[0].status === 'manual_reported' && reported.refunds[0].confirmation === 'manual' && reported.refundedMinor === 0, 'Manual refund report remains distinct from provider-confirmed refunded money');
    await admin.screenshot({ path: '/home/chatbot/wa/AstraCalls/prints/completion-refund-manual-mobile.png', fullPage: true });
    await track(cashReceipt);
    await guest.getByText('Refund reported manually by restaurant', { exact: true }).waitFor();
    await guest.getByText('This is a restaurant-reported refund, not confirmation from the payment provider.', { exact: true }).waitFor();
    verify(await guest.getByText('Refund confirmed by payment provider', { exact: true }).count() === 0, 'Customer sees the manual-report warning and no false provider confirmation');

    const policy = await api('/api/restaurant/archive/policy', 'GET', undefined, true);
    verify(!policy.enabled && !policy.retentionEnabled && !policy.aiEnabled && !policy.noticeAccepted, 'Archive capture, destructive retention and AI remain opt-in by default');
    const unauthArchive = await guestContext.request.get(safePath('/api/restaurant/archive/policy'), { maxRedirects: 0 });
    verify([401, 403].includes(unauthArchive.status()), 'Archive settings are unavailable without administrator authentication');
    await admin.getByRole('button', { name: 'Conversation archive', exact: true }).click();
    const capture = admin.getByRole('checkbox', { name: 'Archive new conversations and supported audio', exact: true });
    await capture.waitFor();
    verify(!(await capture.isChecked()) && !(await admin.getByRole('checkbox', { name: 'Enable automatic deletion after conversation closure', exact: true }).isChecked()) && !(await admin.getByRole('checkbox', { name: 'Allow explicitly requested OpenAI text summaries', exact: true }).isChecked()), 'Archive UI accurately displays disabled capture, deletion and AI without enabling them');
    await admin.locator('.restaurant-language select').first().selectOption('ar');
    await layout(admin, 'Arabic archive administration');
    await admin.screenshot({ path: '/home/chatbot/wa/AstraCalls/prints/completion-archive-rtl.png', fullPage: true });
    await guest.locator('.restaurant-language select').first().selectOption('ar');
    await layout(guest, 'Arabic customer refund tracking');
    await guest.screenshot({ path: '/home/chatbot/wa/AstraCalls/prints/completion-tracking-rtl.png', fullPage: true });
    verify(failures.length === 0, `No browser errors, external requests, unsafe financial/AI calls or administrator credential leakage (${failures.join('; ')})`);
    return { checks, count: checks.length, run, orders: [cancelled.order.number, cashReceipt.order.number] };
  } catch (error) {
    return { checks, count: checks.length, run, error: String(error), failures };
  } finally {
    await guestContext.close();
    await context.close();
  }
}
