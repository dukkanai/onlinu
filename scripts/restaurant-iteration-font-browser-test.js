// Follow-up acceptance after the final build is frozen. Fixed disposable origin.
async (page) => {
  const origin = 'http://127.0.0.1:18083', key = 'restaurant-browser-test-key';
  const checks = [], failures = [], screenshots = [], fonts = [], printEvidence = [], shortPdfEvidence = [];
  const browser = page.context().browser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const verify = (ok, text) => { if (!ok) throw new Error(text); checks.push(text); };
  const imagePath = '/restaurant-media/iteration-audit-fixture.png';
  const api = async (path, method = 'GET', data, headers = {}) => {
    if (!path.startsWith('/api/restaurant/') && !path.startsWith('/storefront-api/')) throw new Error('Unexpected isolated route');
    const response = await context.request.fetch(origin + path, { method, maxRedirects: 0, headers: { Origin: origin, ...(path.startsWith('/api/') ? { 'X-API-Key': key } : {}), ...headers }, ...(data === undefined ? {} : { data }) });
    if (!response.ok()) throw new Error(`${method} ${path}: ${response.status()}`);
    return response.json();
  };
  const publish = async brand => {
    let state = await api('/api/restaurant/brand');
    state = await api('/api/restaurant/brand/draft', 'PUT', { version: state.version, brand });
    return api('/api/restaurant/brand/publish', 'POST', { version: state.version });
  };
  try {
    await context.addInitScript(() => { if (!localStorage.getItem('restaurant.locale')) localStorage.setItem('restaurant.locale', 'ar'); });
    await context.route('**/*', async route => {
      const url = route.request().url();
      if (!url.startsWith(origin + '/')) { failures.push('Unexpected external request'); return route.abort(); }
      if (url === origin + imagePath) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600"><rect width="960" height="600" fill="#d8b98a"/><circle cx="480" cy="300" r="195" fill="#f7f1e4"/><circle cx="480" cy="300" r="130" fill="#315743"/><circle cx="435" cy="275" r="38" fill="#d2783b"/><circle cx="525" cy="340" r="42" fill="#b92f2f"/></svg>' });
      return route.continue();
    });
    // Reruns may begin after a failed print assertion left the isolated demo
    // brand dark. Start from the same explicit, valid light fixture each time.
    const base = { ...(await api('/api/restaurant/brand')).live, template: 'classic', storefrontTemplate: 'classic', primaryColor: '#214e40', primaryTextColor: '#ffffff', secondaryColor: '#d6a85f', secondaryTextColor: '#000000', headingColor: '#1f332e', bodyColor: '#1f332e', pageColor: '#f8f7f2', cardColor: '#fffefa', cartColor: '#fffefa', borderColor: '#798373', hideHero: false, font: 'system', headingFont: '', bodyFont: '', buttonFont: '' };
    await publish({ ...base, storefrontTemplate: 'showcase', headingFont: 'amiri', bodyFont: 'cairo', buttonFont: 'tajawal', hideHero: false, coverUrl: imagePath });
    const p = await context.newPage(); p.setDefaultTimeout(15000); p.on('pageerror', e => failures.push(e.message));
    await p.goto(origin + '/'); await p.locator('.rs-food-card').first().waitFor(); await p.evaluate(() => document.fonts.ready);
    verify(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'Final showcase Arabic1440 has no horizontal overflow');
    verify(await p.locator('[data-storefront-template]').getAttribute('data-storefront-template') === 'showcase', 'Final showcase Arabic1440 renders correct template');
    const shot = '/home/chatbot/wa/AstraCalls/prints/iteration-audit-showcase-ar-1440-final.png'; await p.screenshot({ path: shot, fullPage: true }); screenshots.push(shot);
    const cdp = await context.newCDPSession(p); await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    async function glyphs(selector, label) {
      const doc = await cdp.send('DOM.getDocument');
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
      const result = await cdp.send('CSS.getPlatformFontsForNode', { nodeId }); fonts.push({ label, ...result }); return result.fonts;
    }
    for (const [label, selector, expected] of [['heading', '.rs-hero h1', 'Amiri'], ['body', '.rs-food-content p', 'Cairo'], ['button', '.rs-categories button', 'Tajawal']]) {
      const loaded = await glyphs(selector, 'showcase-' + label);
      verify(loaded.some(f => f.familyName.includes(expected) && f.isCustomFont && f.glyphCount > 0), 'Final showcase ' + label + ' actually renders ' + expected);
    }
    // These are merchant-authored Unicode samples, not selectable interface
    // languages. Removing UI dictionaries must not corrupt existing menu text.
    verify(await p.locator('.rs-header-actions select option').evaluateAll(options => options.map(option => option.value).sort().join(',')) === 'ar,en', 'Storefront language picker contains only Arabic and English');
    const samples = [
      ['ur', 'لذیذ کھانے آپ کے لیے', 'rtl'], ['ps', 'خوندور خواړه ستاسو لپاره', 'rtl'], ['fa', 'غذاهای خوشمزه برای شما', 'rtl'], ['hi', 'नमस्ते स्वादिष्ट भोजन', 'ltr'], ['ru', 'Вкусные блюда для вас', 'ltr'],
    ];
    await p.evaluate(samples => {
      const panel = document.createElement('section'); panel.id = 'audit-script-fonts'; panel.style.cssText = 'background:white;color:#172a24;padding:24px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px;';
      for (const [role, family] of [['heading', '--restaurant-heading-font'], ['body', '--restaurant-body-font'], ['button', '--restaurant-button-font']]) {
        const col = document.createElement('div'); const title = document.createElement('h2'); title.textContent = role; col.append(title);
        for (const [lang, value, dir] of samples) {
          const label = document.createElement('p'); label.textContent = lang; label.style.cssText = 'margin:16px 0 4px;font:14px Arial;'; col.append(label);
          const sample = document.createElement('p'); sample.id = `audit-${role}-${lang}`; sample.textContent = value; sample.lang = lang; sample.dir = dir; sample.style.cssText = `font-family:var(${family});font-size:28px;line-height:1.9;margin:0;`; col.append(sample);
        } panel.append(col);
      }
      document.querySelector('.restaurant-storefront').prepend(panel); panel.scrollIntoView();
    }, samples);
    await p.evaluate(() => document.fonts.ready);
    for (const role of ['heading', 'body', 'button']) for (const [lang] of samples) await glyphs(`#audit-${role}-${lang}`, `${role}-${lang}`);
    const sampleShot = '/home/chatbot/wa/AstraCalls/prints/iteration-audit-merchant-unicode-fonts.png'; await p.locator('#audit-script-fonts').screenshot({ path: sampleShot }); screenshots.push(sampleShot);
    await cdp.detach();
    // Inherit keeps the old field live: toggling serif updates inherited roles,
    // while explicitly selected Cairo body remains independently configured.
    await publish({ ...base, font: 'serif', headingFont: '', bodyFont: 'cairo', buttonFont: '', coverUrl: '', introImageUrl: '' });
    const live = (await api('/api/restaurant/brand')).live;
    verify(live.headingFont === '' && live.buttonFont === '', 'Empty roles remain inherited after save/publication');
    await p.reload(); await p.locator('.rs-food-card').first().waitFor();
    const inherited = await p.evaluate(() => ({ heading: getComputedStyle(document.querySelector('.rs-hero h1')).fontFamily, body: getComputedStyle(document.querySelector('.rs-food-content p')).fontFamily, button: getComputedStyle(document.querySelector('.rs-categories button')).fontFamily }));
    verify(inherited.heading.includes('Georgia') && inherited.button.includes('Georgia') && inherited.body.includes('Astra Cairo'), 'Inherited heading/button use legacy serif while explicit Cairo body remains');
    await publish({ ...base, storefrontTemplate: 'classic', font: 'system', headingFont: '', bodyFont: '', buttonFont: '', coverUrl: '', introImageUrl: '' });
    const defaults = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const requestedFonts = [];
      await defaults.addInitScript(() => localStorage.setItem('restaurant.locale', 'en'));
      await defaults.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
      defaults.on('request', request => { if (/\/fonts\/.*\.woff2/.test(request.url())) requestedFonts.push(request.url()); });
      const q = await defaults.newPage(); await q.goto(origin + '/'); await q.locator('.rs-food-card').first().waitFor(); await q.evaluate(() => document.fonts.ready);
      verify(requestedFonts.length === 0, 'Default system typography fetches no unused bundled WOFF2 files');
    } finally { await defaults.close(); }
    await p.evaluate(() => localStorage.setItem('restaurant.locale', 'en'));
    await p.reload(); await p.locator('.rs-food-card').first().waitFor();
    const admin = await context.newPage(); admin.setDefaultTimeout(12000);
    await admin.goto(origin + '/admin');
    await admin.getByLabel('Administrator access key', { exact: true }).fill(key);
    await admin.getByRole('button', { name: 'Sign in', exact: true }).click();
    await admin.getByRole('button', { name: 'Restaurant appearance', exact: true }).click();
    await admin.getByLabel('Menu template', { exact: true }).waitFor();
    await admin.getByRole('button', { name: 'Desktop', exact: true }).click();
    verify(await p.locator('.rs-hero-art .rs-dish-art').count() === 1 && await admin.locator('.ra-brand-preview .rs-hero-art .rs-dish-art').count() === 1, 'No-cover classic live and preview use the same decorative hero');
    const desktopColumns = await admin.locator('.ra-brand-preview .rs-hero').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    verify(desktopColumns === 2, 'Desktop preview retains no-cover classic two-column structure');
    await admin.getByRole('button', { name: 'Mobile', exact: true }).click();
    const mobileCanvas = await admin.locator('.ra-brand-preview').evaluate(el => ({ width: getComputedStyle(el).width, columns: getComputedStyle(el.querySelector('.rs-hero')).gridTemplateColumns.split(' ').length }));
    verify(mobileCanvas.width === '375px' && mobileCanvas.columns === 1, 'Mobile preview uses375px canvas and one-column hero on desktop admin');
    const previewShot = '/home/chatbot/wa/AstraCalls/prints/iteration-audit-no-cover-mobile-preview.png'; await admin.locator('.ra-brand-preview-panel').screenshot({ path: previewShot }); screenshots.push(previewShot);

    // Menu descriptions and selected item names are merchant text, including
    // long words/URLs without spaces. They must wrap instead of widening cards.
    await p.setViewportSize({ width: 320, height: 900 });
    await p.locator('.rs-food-content p').first().evaluate(el => { el.textContent = 'UnbrokenMerchantDescription'.repeat(12); });
    verify(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'Unbroken merchant description wraps at320px without page overflow');

    // Actual tracking receipt from an isolated cash-after table order. No
    // payment provider, external customer or real money is involved.
    const catalog = await api('/api/restaurant/catalog');
    const table = catalog.tables.find(entry => entry.active);
    // Menu options are optional; a fixture item does not need an empty option
    // list to create a valid order selecting none of those extras.
    const item = catalog.items.find(entry => entry.available);
    verify(Boolean(table && item && catalog.settings.demo && catalog.settings.paymentMethods.table.includes('cash_after')), 'Print fixture uses the demo catalog and cash-after table policy');
    const input = { mode: 'table', paymentMethod: 'cash_after', paymentProvider: '', tableCode: table.code, customerName: 'Isolated print acceptance', phone: '', address: {}, items: [{ itemId: item.id, quantity: 1, optionIds: [] }], notes: 'Print QA only — no real purchase.' };
    const quote = await api('/storefront-api/quote', 'POST', input);
    const receipt = await api('/storefront-api/orders', 'POST', { ...input, expectedTotalMinor: quote.totalMinor }, { 'Idempotency-Key': await p.evaluate(() => crypto.randomUUID()) });
    await publish({ ...base, primaryColor: '#ffe0aa', primaryTextColor: '#000000', secondaryColor: '#111122', secondaryTextColor: '#ffffff', pageColor: '#101820', cardColor: '#162330', cartColor: '#162330', bodyColor: '#ffffff', headingColor: '#ffffff', borderColor: '#91a5b8', headingFont: 'amiri', bodyFont: 'cairo', buttonFont: 'tajawal' });
    for (const locale of ['ar', 'en']) {
      await p.emulateMedia({ media: 'screen' });
      await p.evaluate(value => localStorage.setItem('restaurant.locale', value), locale);
      await p.goto(`${origin}/track?order=${encodeURIComponent(receipt.order.number)}#token=${encodeURIComponent(receipt.trackingToken)}`);
      // The second iteration targets the identical URL including its fragment;
      // goto can be a same-document navigation and retain React's old locale.
      // Preference is read on provider mount, not on arbitrary storage writes.
      await p.reload({ waitUntil: 'domcontentloaded' });
      await p.locator('.rs-print-receipt h2').first().waitFor();
      await p.waitForFunction(expected => document.documentElement.lang === expected && document.documentElement.dir === (expected === 'ar' ? 'rtl' : 'ltr'), locale);
      await p.evaluate(() => document.fonts.ready);
      verify(await p.locator('.rs-print-receipt h2').first().evaluate(el => getComputedStyle(el).color) === 'rgb(255, 255, 255)', `${locale}: dark brand retains white receipt headings on screen`);
      await p.emulateMedia({ media: 'print' });
      const printed = await p.evaluate(() => {
        const receipt = document.querySelector('.rs-print-receipt');
        const text = [...receipt.querySelectorAll('h2, h3, strong, p, .rs-totals span')].filter(el => el.textContent.trim()).map(el => ({ color: getComputedStyle(el).color, visibility: getComputedStyle(el).visibility }));
        return { text, paper: getComputedStyle(receipt).backgroundColor, panels: [...receipt.querySelectorAll('.rs-panel')].map(el => getComputedStyle(el).backgroundColor), header: getComputedStyle(document.querySelector('.rs-header')).visibility, dir: document.documentElement.dir, lang: document.documentElement.lang, savedLocale: localStorage.getItem('restaurant.locale') };
      });
      printEvidence.push({ locale, ...printed });
      verify(printed.text.length >= 8 && printed.text.every(text => text.color === 'rgb(0, 0, 0)' && text.visibility === 'visible'), `${locale}: printed headings, line items, totals and disclaimer are visible black`);
      verify(printed.paper === 'rgb(255, 255, 255)' && printed.panels.every(color => color === 'rgb(255, 255, 255)'), `${locale}: printed dark-brand receipt uses white paper and panels`);
      verify(printed.header === 'hidden' && printed.dir === (locale === 'ar' ? 'rtl' : 'ltr'), `${locale}: print isolates receipt while preserving reading direction; evidence=${JSON.stringify({ header: printed.header, dir: printed.dir, lang: printed.lang, savedLocale: printed.savedLocale })}`);
      const printShot = `/home/chatbot/wa/AstraCalls/prints/iteration-audit-dark-receipt-${locale}.png`;
      await p.screenshot({ path: printShot, fullPage: true }); screenshots.push(printShot);
      const shortPdfPath = `/home/chatbot/wa/AstraCalls/prints/iteration-audit-dark-receipt-short-${locale}.pdf`;
      const shortPdf = await p.pdf({ path: shortPdfPath, format: 'A4', printBackground: false, displayHeaderFooter: false, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
      const shortPrintPages = (shortPdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
      shortPdfEvidence.push({ locale, pages: shortPrintPages, path: shortPdfPath });
      verify(shortPrintPages === 1, `${locale}: one-item receipt fits one A4 page without blank pages; actual=${shortPrintPages}; path=${shortPdfPath}`);
    }
    // Exercise overflow onto real PDF pages using repeated copies of the
    // rendered row. This is a layout fixture only, not a changed order record.
    await p.evaluate(() => {
      const line = document.querySelector('.rs-print-receipt .rs-cart-line');
      for (let index = 0; index < 40; index++) {
        const copy = line.cloneNode(true); copy.querySelector('strong').textContent = `Pagination row ${index + 1} — صف اختبار الطباعة`; line.after(copy);
      }
    });
    const pdfPath = '/home/chatbot/wa/AstraCalls/prints/iteration-audit-dark-receipt-multipage.pdf';
    const pdf = await p.pdf({ path: pdfPath, format: 'A4', printBackground: false, displayHeaderFooter: false, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
    const printPages = (pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
    verify(printPages >= 2, 'Long receipt content generates multiple printed pages rather than one clipped page');
    await p.emulateMedia({ media: 'screen' });

    // The appearance preview imports storefront CSS in the admin bundle; its
    // receipt-only print isolation must not blank public/table QR handouts.
    await admin.getByRole('button', { name: 'Tables & QR codes', exact: true }).click();
    await admin.evaluate(() => { window.print = () => {}; });
    await admin.getByRole('button', { name: 'Print QR code', exact: true }).first().click();
    await admin.locator('.ra-print-container').waitFor({ state: 'attached' });
    await admin.emulateMedia({ media: 'print' });
    const qr = await admin.locator('.ra-print-container').evaluate(el => ({ display: getComputedStyle(el).display, visibility: getComputedStyle(el).visibility, heading: getComputedStyle(el.querySelector('h1')).visibility, code: getComputedStyle(el.querySelector('svg')).visibility, width: el.querySelector('svg').getBoundingClientRect().width }));
    verify(qr.display === 'flex' && qr.visibility === 'visible' && qr.heading === 'visible' && qr.code === 'visible' && qr.width === 280, 'Admin QR print remains visible after importing the branded appearance preview');
    const qrShot = '/home/chatbot/wa/AstraCalls/prints/iteration-audit-admin-qr-print.png'; await admin.screenshot({ path: qrShot, fullPage: true }); screenshots.push(qrShot);
    await admin.emulateMedia({ media: 'screen' });
    // Remove only this harness's nonexistent routed image fixture. Keep all
    // real/synthetic merchant data and unrelated image URLs intact for the
    // following regression suites, which do not install our mocked route.
    const stripFixture = value => value === imagePath ? '' : value;
    const cleanBrand = value => ({ ...value, logoUrl: stripFixture(value.logoUrl), coverUrl: stripFixture(value.coverUrl), introImageUrl: stripFixture(value.introImageUrl) });
    await publish(cleanBrand(base));
    const cleanCatalog = await api('/api/restaurant/catalog');
    await api('/api/restaurant/catalog', 'PUT', { ...cleanCatalog, settings: { ...cleanCatalog.settings, logoUrl: stripFixture(cleanCatalog.settings.logoUrl), coverUrl: stripFixture(cleanCatalog.settings.coverUrl) }, items: cleanCatalog.items.map(item => ({ ...item, imageUrl: stripFixture(item.imageUrl) })) });
    verify(!(await api('/api/restaurant/catalog')).items.some(item => item.imageUrl === imagePath), 'Only routed mock image fixture URLs are cleared before later browser suites');
    return { checks, failures, screenshots, fonts, inherited, printEvidence, shortPdfEvidence, printPages, pdfPath };
  } finally { await context.close(); }
}
