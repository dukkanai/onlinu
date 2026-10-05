// Independent acceptance of the five layouts on the disposable audit server.
// Invoke with browser_run_code_unsafe({filename: '<absolute path>'}). This test
// writes only synthetic data to the fixed local QA origin; it never deploys.
async (page) => {
  const origin = 'http://127.0.0.1:18083';
  const key = 'restaurant-browser-test-key';
  const context = await page.context().browser().newContext({ viewport: { width: 1440, height: 960 } });
  const checks = [], failures = [], screenshots = [], matrix = [], fontEvidence = [];
  const verify = (ok, message) => { if (!ok) throw new Error(message); checks.push(message); };
  const api = async (path, method = 'GET', data) => {
    if (!path.startsWith('/api/restaurant/') && !path.startsWith('/storefront-api/')) throw new Error('Unexpected audit route');
    const response = await context.request.fetch(origin + path, { method, maxRedirects: 0, headers: { Origin: origin, ...(path.startsWith('/api/') ? { 'X-API-Key': key } : {}) }, ...(data === undefined ? {} : { data }) });
    if (!response.ok()) throw new Error(`${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.status() === 204 ? null : response.json();
  };
  const publish = async brand => {
    let state = await api('/api/restaurant/brand');
    state = await api('/api/restaurant/brand/draft', 'PUT', { version: state.version, brand });
    return api('/api/restaurant/brand/publish', 'POST', { version: state.version });
  };
  const imagePath = '/restaurant-media/iteration-audit-fixture.png';
  const itemName = 'طبق الاختبار الأول — First audit dish';
  const longName = 'طبق عربي طويل للتأكد من التفاف أسماء الوجبات والأسعار والإضافات دون خروج عن البطاقة — Long restaurant item name with multiple words';
  const categoryName = 'وجبات رئيسية — Main dishes';
  const longCategory = 'تصنيف طويل للاختبار مع كلمات متعددة — A long category for responsive checks';
  let p, admin;
  const screenshot = async (target, name) => {
    const file = `/home/chatbot/wa/AstraCalls/prints/iteration-audit-${name}.png`;
    await target.screenshot({ path: file, fullPage: true }); screenshots.push(file);
  };
  const geometry = async target => target.evaluate(() => {
    const rect = selector => { const el = document.querySelector(selector); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const offenders = [...document.querySelectorAll('.restaurant-storefront *')].filter(el => {
      const style = getComputedStyle(el), r = el.getBoundingClientRect();
      return r.width > 0 && style.position !== 'fixed' && style.visibility !== 'hidden' && (r.left < -2 || r.right > innerWidth + 2) && !el.closest('.rs-categories');
    }).slice(0, 8).map(el => ({ tag: el.tagName, class: String(el.className), text: el.textContent?.slice(0, 60) }));
    return { width: innerWidth, scroll: document.documentElement.scrollWidth, dir: document.documentElement.dir, template: document.querySelector('[data-storefront-template]')?.getAttribute('data-storefront-template'), card: rect('.rs-food-card'), hero: rect('.rs-hero'), products: rect('.rs-template-products'), categories: rect('.rs-categories'), cart: rect('.rs-cart'), offenders };
  });
  const noOverflow = async (target, label) => {
    const size = await geometry(target);
    verify(size.scroll <= size.width + 2, `${label}: page has no horizontal overflow (${size.scroll}/${size.width})`);
    return size;
  };
  try {
    await context.addInitScript(() => { if (!localStorage.getItem('restaurant.locale')) localStorage.setItem('restaurant.locale', 'en'); });
    await context.route('**/*', async route => {
      const url = route.request().url();
      if (!url.startsWith(origin + '/')) { failures.push('Unexpected external request: ' + url); return route.abort(); }
      if (url === origin + imagePath) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600"><rect width="960" height="600" fill="#d8b98a"/><circle cx="480" cy="300" r="195" fill="#f7f1e4"/><circle cx="480" cy="300" r="130" fill="#315743"/><circle cx="435" cy="275" r="38" fill="#d2783b"/><circle cx="525" cy="340" r="42" fill="#b92f2f"/></svg>' });
      return route.continue();
    });
    context.on('request', req => { if (req.url().startsWith(origin + '/storefront-api/') && req.headers()['x-api-key']) failures.push('Administrator key leaked to storefront API'); });
    context.on('response', response => {
      if (response.url().startsWith(origin + '/') && ['document', 'script', 'stylesheet', 'font', 'image'].includes(response.request().resourceType()) && response.status() >= 400) failures.push(`Failed browser asset: ${response.status()} ${response.url()}`);
    });
    p = await context.newPage(); p.setDefaultTimeout(12000);
    p.on('pageerror', error => failures.push(error.message));
    const initial = await api('/api/restaurant/catalog');
    await api('/api/restaurant/catalog', 'PUT', {
      ...initial,
      settings: { ...initial.settings, name: 'مطعم الاختبار — Audit restaurant', description: 'وصف المطعم الفعلي لفحص الخط العربي واللاتيني. A short description supplied by this synthetic restaurant.', country: 'SA', currency: 'SAR', defaultLanguage: 'en', menuLanguage: 'ar', demo: true, acceptingOrders: true, deliveryEnabled: true, pickupEnabled: true, tableEnabled: true, deliveryPricingMode: 'flat', deliveryZones: [], deliveryFeeMinor: 500, deliveryMinimumMinor: 0, deliveryAreas: [], deliveryRadiusKm: 0, latitude: null, longitude: null, requireDeliveryLocation: false, paymentMethods: { delivery: ['cash_on_delivery'], table: ['cash_after'], pickup: ['card'] } },
      categories: [{ id: 'audit-main', name: categoryName, sort: 0 }, { id: 'audit-other', name: longCategory, sort: 1 }],
      items: [
        { id: 'audit-dish', categoryId: 'audit-main', name: itemName, description: 'مكونات الطبق ووصفه دون نص تسويقي افتراضي. Ingredients and dish description.', priceMinor: 2500, imageUrl: imagePath, available: true, sort: 0, options: [] },
        { id: 'audit-long', categoryId: 'audit-main', name: longName, description: 'وصف طويل نسبيًا لاختبار التفاف النص داخل القالب وحفظ المسافة بين الوصف والسعر وأزرار الإضافة.', priceMinor: 12345, imageUrl: '', available: true, sort: 1, options: [] },
        { id: 'audit-third', categoryId: 'audit-other', name: 'طبق بدون صورة — No image dish', description: '', priceMinor: 900, imageUrl: '', available: true, sort: 2, options: [] },
        { id: 'audit-fourth', categoryId: 'audit-other', name: 'طبق رابع — Fourth dish', description: 'تعليق قصير — Short description', priceMinor: 1000, imageUrl: imagePath, available: true, sort: 3, options: [] },
      ], tables: [{ id: 'audit-table', name: 'Audit table', code: '', active: true }],
    });
    const initialBrand = (await api('/api/restaurant/brand')).live;
    const brand = { ...initialBrand, storefrontTemplate: 'classic', template: 'classic', primaryColor: '#214e40', primaryTextColor: '#ffffff', secondaryColor: '#d6a85f', secondaryTextColor: '#000000', headingColor: '#1f332e', bodyColor: '#1f332e', pageColor: '#f8f7f2', cardColor: '#fffefa', cartColor: '#fffefa', borderColor: '#798373', logoUrl: '', coverUrl: imagePath, introImageUrl: '', introTitle: 'أطباق المطعم — Our restaurant menu', introText: '', hideHero: false, font: 'system', headingFont: 'amiri', bodyFont: 'cairo', buttonFont: 'tajawal', radius: 'soft', shadow: 'soft', imageFit: 'cover', textSize: 'normal', layout: 'grid' };
    await publish(brand);
    // Existing customers can retain a removed language in localStorage. It
    // must fall back to this merchant's supported default, not crash or make
    // any change to merchant-owned menu text.
    await p.goto(origin + '/');
    for (const removed of ['tr', 'ps', 'fa', 'ru', 'uk', 'fr', 'es', 'sw', 'ha', 'ur', 'hi', 'unknown']) {
      await p.evaluate(locale => localStorage.setItem('restaurant.locale', locale), removed);
      await p.reload();
      await p.locator('.rs-food-card').first().waitFor();
      await p.waitForFunction(() => document.documentElement.lang === 'en' && document.documentElement.dir === 'ltr');
      const picker = p.locator('.restaurant-language select').first();
      verify(await picker.inputValue() === 'en' && JSON.stringify(await picker.locator('option').evaluateAll(options => options.map(option => option.value).sort())) === '["ar","en"]', `Saved ${removed} interface locale safely falls back to configured English; only two languages remain`);
      verify(await p.getByRole('heading', { name: itemName, exact: true }).count() === 1, `Saved ${removed} fallback preserves merchant item text`);
    }
    for (const template of ['classic', 'bistro', 'editorial', 'compact', 'showcase']) {
      await publish({ ...brand, storefrontTemplate: template });
      for (const locale of ['ar', 'en']) {
        for (const width of [1440, 390, 320]) {
          const label = `${template}-${locale}-${width}`;
          try {
            await p.setViewportSize({ width, height: width === 1440 ? 1000 : 900 });
            await p.goto(origin + '/');
            await p.evaluate(language => localStorage.setItem('restaurant.locale', language), locale);
            await p.reload();
            await p.locator('.rs-food-card').first().waitFor();
            await p.evaluate(() => document.fonts.ready);
            const result = await noOverflow(p, label);
            verify(result.template === template && result.dir === (locale === 'ar' ? 'rtl' : 'ltr'), `${label}: correct layout and direction`);
            verify(await p.locator('.rs-food-card').count() === 4, `${label}: all catalog items retained`);
            verify(await p.getByRole('heading', { name: itemName, exact: true }).count() === 1 && await p.getByRole('heading', { name: longName, exact: true }).count() === 1, `${label}: merchant names remain unchanged`);
            const roles = await p.evaluate(() => ({ heading: getComputedStyle(document.querySelector('.rs-hero h1')).fontFamily, body: getComputedStyle(document.querySelector('.rs-food-content p')).fontFamily, button: getComputedStyle(document.querySelector('.rs-categories button')).fontFamily }));
            verify(roles.heading.includes('Astra Amiri') && roles.body.includes('Astra Cairo') && roles.button.includes('Astra Tajawal'), `${label}: independent role fonts applied`);
            if (width === 1440 && locale === 'ar') {
              const cdp = await context.newCDPSession(p);
              await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
              const doc = await cdp.send('DOM.getDocument');
              for (const [role, selector, expected] of [['heading', '.rs-hero h1', 'Amiri'], ['body', '.rs-food-content p', 'Cairo'], ['button', '.rs-categories button', 'Tajawal']]) {
                const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
                const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
                fontEvidence.push({ template, role, fonts });
                verify(fonts.some(font => font.familyName.includes(expected) && font.isCustomFont && font.glyphCount > 0), `${label}: ${role} actually renders ${expected} glyphs`);
              }
              await cdp.detach();
            }
            matrix.push({ label, ...result, roles });
            await screenshot(p, label);
          } catch (error) { failures.push(label + ': ' + error.message); await screenshot(p, label + '-failure').catch(() => {}); }
        }
      }
      // Each structural template must retain category/search/cart/checkout logic.
      try {
        await p.setViewportSize({ width: 390, height: 900 });
        await p.evaluate(() => { localStorage.setItem('restaurant.locale', 'en'); localStorage.removeItem('restaurant-cart-v1'); });
        await p.goto(origin + '/'); await p.locator('.rs-food-card').first().waitFor();
        await p.locator('.rs-categories').getByRole('button', { name: longCategory, exact: true }).click();
        verify(await p.locator('.rs-food-card').count() === 2, `${template}: category filter keeps matching items`);
        verify(await p.locator('.rs-categories').getByRole('button', { name: longCategory, exact: true }).getAttribute('aria-pressed') === 'true', `${template}: selected category has accessible pressed state`);
        await p.locator('.rs-categories button').first().click();
        await p.locator('.rs-search input').fill('First audit dish');
        verify(await p.locator('.rs-food-card').count() === 1, `${template}: search filters correctly`);
        await p.getByRole('button', { name: itemName, exact: true }).focus();
        await p.keyboard.press('Enter');
        await p.getByRole('dialog', { name: itemName, exact: true }).getByRole('button', { name: /^Add to order/ }).click();
        await p.getByRole('button', { name: 'Your order', exact: true }).click();
        await p.getByRole('heading', { name: 'Complete your order', exact: true }).waitFor();
        await p.getByRole('radio', { name: 'Delivery', exact: true }).check();
        await p.getByLabel('Your name', { exact: true }).fill('Iteration audit customer');
        await p.getByLabel('Phone number', { exact: true }).fill('+966500000000');
        await p.getByLabel('Saudi national address / short address', { exact: true }).fill('TEST1234');
        await p.getByLabel(/Order notes/).fill(`Visual acceptance ${template}`);
        await p.getByRole('button', { name: 'Review order', exact: true }).click();
        await p.getByRole('button', { name: /^Confirm order/ }).waitFor();
        await noOverflow(p, `${template} checkout`);
        await screenshot(p, `${template}-checkout`);
        await p.getByRole('button', { name: /^Confirm order/ }).click();
        await p.waitForURL(url => url.pathname === '/track');
        verify(true, `${template}: UI order successfully created and tracking opened`);
      } catch (error) { failures.push(template + ' workflow: ' + error.message); await screenshot(p, template + '-workflow-failure').catch(() => {}); }
    }
    // No-description/no-image layouts must collapse missing hero media.
    let catalog = await api('/api/restaurant/catalog');
    await api('/api/restaurant/catalog', 'PUT', { ...catalog, settings: { ...catalog.settings, description: '' } });
    for (const template of ['classic', 'bistro', 'editorial', 'compact', 'showcase']) {
      try {
        await publish({ ...brand, storefrontTemplate: template, coverUrl: '', introImageUrl: '', introTitle: '', introText: '' });
        await p.setViewportSize({ width: 320, height: 900 }); await p.goto(origin + '/'); await p.locator('.rs-food-card').first().waitFor(); await p.evaluate(() => document.fonts.ready);
        const g = await noOverflow(p, `${template} empty media`);
        verify(await p.locator('.rs-hero h1').innerText() === 'مطعم الاختبار — Audit restaurant', `${template}: absent introduction uses merchant name`);
        verify(await p.locator('.rs-hero-copy p').count() === 0, `${template}: absent description adds no invented marketing copy`);
        verify(await p.locator('.rs-hero img').count() === 0, `${template}: no broken empty hero image`);
        matrix.push({ label: template + '-empty', ...g }); await screenshot(p, template + '-empty');
      } catch (error) { failures.push(template + ' empty: ' + error.message); }
    }
    // Valid high contrast custom colors must apply to real, hovered controls.
    await publish({ ...brand, primaryColor: '#ffe0aa', primaryTextColor: '#000000', secondaryColor: '#111122', secondaryTextColor: '#ffffff', pageColor: '#101820', cardColor: '#162330', cartColor: '#162330', bodyColor: '#ffffff', headingColor: '#ffffff', borderColor: '#91a5b8', textSize: 'large', imageFit: 'contain' });
    await p.goto(origin + '/'); await p.locator('.rs-food-card').first().waitFor();
    const primary = p.locator('.rs-hero .rs-button');
    await primary.hover();
    verify(await primary.evaluate(el => getComputedStyle(el).color) === 'rgb(0, 0, 0)', 'Custom light primary retains black text on hover');
    verify(await primary.evaluate(el => getComputedStyle(el).backgroundColor) === 'rgb(255, 224, 170)', 'Custom primary background retains validated color on hover');
    const secondary = p.locator('.rs-categories button:not(.active)').first();
    verify(await secondary.evaluate(el => getComputedStyle(el).color) === 'rgb(255, 255, 255)', 'Custom dark secondary renders white text');
    verify(await p.locator('.rs-food-image img').first().evaluate(el => getComputedStyle(el).objectFit) === 'contain', 'Image-fit choice reaches actual product image');
    await noOverflow(p, 'Dark large-text appearance'); await screenshot(p, 'dark-large-text');
    // UI draft mutation, same-component preview, publication and rollback.
    await publish(brand);
    admin = await context.newPage(); admin.setDefaultTimeout(12000); admin.on('pageerror', error => failures.push(error.message));
    await admin.goto(origin + '/admin');
    await admin.getByLabel('Administrator access key', { exact: true }).fill(key);
    await admin.getByRole('button', { name: 'Sign in', exact: true }).click();
    await admin.getByRole('button', { name: 'Restaurant appearance', exact: true }).click();
    await admin.getByLabel('Menu template', { exact: true }).selectOption('bistro');
    await admin.getByLabel('Heading font', { exact: true }).selectOption('tajawal');
    await admin.getByLabel('Introduction heading', { exact: true }).fill('Private preview title');
    verify(await admin.locator('.ra-brand-preview [data-storefront-template]').getAttribute('data-storefront-template') === 'bistro', 'Unsaved preview uses selected structural template');
    verify(await admin.locator('.ra-brand-preview h1').evaluate(el => getComputedStyle(el).fontFamily).then(value => value.includes('Astra Tajawal')), 'Preview applies selected independent heading font');
    await admin.getByRole('button', { name: 'Save draft', exact: true }).click();
    await admin.getByText('Draft saved. Customers still see the published appearance.', { exact: true }).waitFor();
    verify((await api('/storefront-api/catalog')).settings.brand.storefrontTemplate === 'classic', 'Saving draft leaves live structural template unchanged');
    await p.reload(); await p.locator('.rs-food-card').first().waitFor();
    verify(await p.locator('[data-storefront-template]').getAttribute('data-storefront-template') === 'classic', 'Public browser retains live layout while draft differs');
    for (const width of [1440, 390, 320]) {
      await admin.setViewportSize({ width, height: 960 });
      await admin.getByRole('button', { name: 'Desktop', exact: true }).click();
      verify(await admin.locator('.ra-brand-preview').evaluate(el => getComputedStyle(el).width) === '1280px', `Brand editor at ${width}: desktop preview uses an actual 1280px canvas`);
      verify(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), `Brand editor at ${width} has no page overflow`);
      await screenshot(admin, `editor-${width}`);
      await admin.getByRole('button', { name: 'Mobile', exact: true }).click();
      verify(await admin.locator('.ra-brand-preview').evaluate(el => getComputedStyle(el).width) === '375px', `Brand editor at ${width}: mobile preview uses an actual 375px canvas`);
      verify(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), `Mobile brand preview at ${width} has no page overflow`);
    }
    await admin.getByRole('button', { name: 'Publish appearance', exact: true }).click();
    await admin.getByText('Appearance published.', { exact: true }).waitFor();
    verify((await api('/storefront-api/catalog')).settings.brand.headingFont === 'tajawal', 'Publication persists independent heading font');
    await p.reload(); await p.locator('.rs-food-card').first().waitFor();
    verify(await p.locator('[data-storefront-template]').getAttribute('data-storefront-template') === 'bistro', 'Published template reaches public browser');
    catalog = await api('/api/restaurant/catalog');
    await api('/api/restaurant/catalog', 'PUT', { ...catalog, settings: { ...catalog.settings, openingHours: 'Synthetic hours retained through brand rollback' } });
    const state = await api('/api/restaurant/brand');
    await api('/api/restaurant/brand/revert', 'POST', { version: state.version });
    catalog = await api('/api/restaurant/catalog');
    verify(catalog.settings.brand.storefrontTemplate === 'classic' && catalog.settings.brand.headingFont === 'amiri', 'Rollback restores prior layout and font');
    verify(catalog.settings.openingHours === 'Synthetic hours retained through brand rollback', 'Appearance rollback preserves unrelated newer catalog edits');
    verify(matrix.filter(entry => !entry.label.endsWith('-empty')).length === 30 && matrix.filter(entry => entry.label.endsWith('-empty')).length === 5, 'All five templates completed both interface languages at all three widths plus empty-media variants');
    verify(failures.length === 0, `No browser errors, failed assets, external requests, credential leakage or incomplete template workflows (${failures.join('; ')})`);
    return { passed: true, checks, failures, screenshots, matrix, fontEvidence };
  } catch (error) {
    return { passed: false, error: String(error), checks, failures, screenshots, matrix, fontEvidence };
  } finally { await context.close(); }
}
