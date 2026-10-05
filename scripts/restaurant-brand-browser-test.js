// Only run against the disposable completion QA server. This changes its
// appearance and menu name; no production URL or credential is accepted.
async (page) => {
  const origin = 'http://127.0.0.1:18083';
  const context = await page.context().browser().newContext({ viewport: { width: 1280, height: 960 } });
  const checks = [], failures = [];
  const key = 'restaurant-browser-test-key';
  const verify = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const api = async (path, method = 'GET', data) => {
    if (!path.startsWith('/api/restaurant/') && path !== '/storefront-api/catalog') throw new Error('Unexpected isolated route');
    const response = await context.request.fetch(origin + path, { method, headers: { Origin: origin, ...(path.startsWith('/api/') ? { 'X-API-Key': key } : {}) }, ...(data === undefined ? {} : { data }) });
    if (!response.ok()) throw new Error(`${method} ${path}: ${response.status()}`);
    return response.json();
  };
  try {
    await context.addInitScript(() => localStorage.setItem('restaurant.locale', 'en'));
    await context.route('**/*', async route => { if (!route.request().url().startsWith(origin + '/')) { failures.push('Unexpected external request'); await route.abort(); } else await route.continue(); });
    const p = await context.newPage(); p.setDefaultTimeout(12000);
    p.on('pageerror', error => failures.push(error.message)); p.on('dialog', dialog => dialog.accept());
    await p.goto(origin + '/admin');
    await p.getByLabel('Administrator access key', { exact: true }).fill(key);
    await p.getByRole('button', { name: 'Sign in', exact: true }).click();
    await p.getByRole('button', { name: 'Restaurant appearance', exact: true }).click();
    await p.getByLabel('Introduction heading', { exact: true }).waitFor();
    const title = `Private draft ${Date.now()}`;
    const before = await api('/api/restaurant/brand');
    await p.getByLabel('Introduction heading', { exact: true }).fill(title);
    await p.getByRole('button', { name: 'Save draft', exact: true }).click();
    await p.getByText('Draft saved. Customers still see the published appearance.', { exact: true }).waitFor();
    const draft = await api('/api/restaurant/brand'), publicBefore = await api('/storefront-api/catalog');
    verify(draft.draft.introTitle === title && draft.live.introTitle === before.live.introTitle, 'Saved draft is private');
    verify(publicBefore.settings.brand?.introTitle !== title, 'Public catalog never reveals draft');
    await p.getByRole('button', { name: 'Publish appearance', exact: true }).click();
    await p.getByText('Appearance published.', { exact: true }).waitFor();
    verify((await api('/storefront-api/catalog')).settings.brand.introTitle === title, 'Explicit publication updates public appearance');
    await p.getByRole('button', { name: 'Advanced appearance options', exact: true }).click();
    verify(await p.getByLabel('Primary button background', { exact: true }).count() === 1, 'Primary color has one unambiguous accessible text label');
    await p.getByLabel('Primary button text', { exact: true }).fill((await api('/api/restaurant/brand')).live.primaryColor);
    await p.getByText('These text/background pairs need more contrast before saving:', { exact: true }).waitFor();
    verify(await p.getByRole('button', { name: 'Save draft', exact: true }).isDisabled(), 'Unreadable color pair cannot be saved from UI');
    await p.getByRole('button', { name: 'Refresh', exact: true }).click();
    await p.getByText('Text contrast passes the 4.5:1 readability check.', { exact: true }).waitFor();
    let state = await api('/api/restaurant/brand');
    state = await api('/api/restaurant/brand/draft', 'PUT', { version: state.version, brand: { ...state.live, primaryColor: '#ffe0aa', primaryTextColor: '#000000', secondaryColor: '#111122', secondaryTextColor: '#ffffff', hideHero: false } });
    state = await api('/api/restaurant/brand/publish', 'POST', { version: state.version });
    const customer = await context.newPage(); await customer.goto(origin + '/');
    await customer.getByRole('heading', { name: title, exact: true }).waitFor();
    const mainButton = customer.locator('.rs-hero .rs-button');
    verify(await mainButton.evaluate(el => getComputedStyle(el).color) === 'rgb(0, 0, 0)', 'Light primary button uses validated dark text');
    await mainButton.hover();
    verify(await mainButton.evaluate(el => getComputedStyle(el).backgroundColor) === 'rgb(255, 224, 170)', 'Primary hover preserves validated contrast');
    const inactiveCategory = customer.locator('.rs-categories button:not(.active)').first();
    verify(await inactiveCategory.evaluate(el => getComputedStyle(el).color) === 'rgb(255, 255, 255)', 'Dark secondary button uses validated light text');
    let catalog = await api('/api/restaurant/catalog');
    const renamed = `Preserved menu ${Date.now()}`;
    await api('/api/restaurant/catalog', 'PUT', { ...catalog, items: catalog.items.map((item, index) => index ? item : { ...item, name: renamed }) });
    await api('/api/restaurant/brand/revert', 'POST', { version: state.version });
    catalog = await api('/api/restaurant/catalog');
    verify(catalog.items[0].name === renamed, 'Revert changes appearance only, not menu edits');
    await p.reload(); await p.getByRole('button', { name: 'Restaurant appearance', exact: true }).click();
    await p.getByLabel('Introduction heading', { exact: true }).waitFor();
    await p.getByRole('button', { name: 'Desktop', exact: true }).click();
    await p.screenshot({ path: '/tmp/restaurant-completion-brand-desktop.png', fullPage: true });
    await p.setViewportSize({ width: 390, height: 844 });
    await p.getByRole('button', { name: 'Mobile', exact: true }).click();
    await p.getByRole('combobox', { name: 'Interface language', exact: true }).selectOption('ar');
    verify(await p.evaluate(() => document.documentElement.dir) === 'rtl', 'Arabic brand editor is RTL');
    verify(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'Brand mobile editor has no page overflow');
    await p.screenshot({ path: '/tmp/restaurant-completion-brand-mobile-ar.png', fullPage: true });
    await customer.setViewportSize({ width: 390, height: 844 }); await customer.reload();
    await customer.getByRole('heading', { name: renamed, exact: true }).waitFor();
    verify(await customer.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'Branded storefront has no mobile overflow');
    await customer.screenshot({ path: '/tmp/restaurant-completion-brand-storefront.png', fullPage: true });
    verify(failures.length === 0, 'No browser exceptions or unexpected external requests');
    return { checks, screenshots: ['/tmp/restaurant-completion-brand-desktop.png', '/tmp/restaurant-completion-brand-mobile-ar.png', '/tmp/restaurant-completion-brand-storefront.png'] };
  } finally { await context.close(); }
}
