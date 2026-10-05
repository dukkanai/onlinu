// Standalone Chrome regression check. API/ChatGPT bridge races are synthetic;
// the initial live-page check is the only unmocked platform read.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const origin = new URL(process.env.PROTOTYPE_BROWSER_BASE ?? 'http://127.0.0.1:18787');
assert.ok(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), 'Synthetic browser check requires loopback');
const base = origin.origin;
const assets = Object.fromEntries(await Promise.all(['app.js', 'widget.html', 'index.html', 'style.css'].map(async name => [name, await readFile(new URL(`../public/${name}`, import.meta.url), 'utf8')])));
const artifactDir = fileURLToPath(new URL('../../artifacts/browser/', import.meta.url));
await mkdir(artifactDir, { recursive: true });
const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
assert.equal(health.status, 200);
assert.equal((await health.json()).mode, 'synthetic');

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'] });
const watchdog = setTimeout(() => {
  console.error('Synthetic browser regression exceeded its 30-second deadline.');
  process.exitCode = 1;
  void browser.close();
}, 30000);
watchdog.unref();
let assertions = 0;
const check = (condition, explanation) => { assert.ok(condition, explanation); assertions++; };
const gate = () => {
  let resolve;
  const promise = new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Synthetic delayed response was not released within 10 seconds')), 10000);
    timer.unref();
    resolve = () => { clearTimeout(timer); done(); };
  });
  return { promise, resolve };
};
const restaurants = [
  { id: 'demo-a', name: 'مطعم أ الاصطناعي', cuisine: 'تجربة أ', template: 'classic' },
  { id: 'demo-b', name: 'مطعم ب الاصطناعي', cuisine: 'تجربة ب', template: 'bistro' }
];
const menu = tenant => ({ tenantId: tenant, name: restaurants.find(item => item.id === tenant).name, currency: 'SAR', items: [{ id: `${tenant}-dish`, name: `طبق ${tenant}`, priceMinor: tenant === 'demo-a' ? 1200 : 2100, stock: 99 }] });
const orderId = '11112222333344445555666677778888';
const checkoutId = '11111111-2222-4333-8444-555555555555';
const order = { id: orderId, tenantId: 'demo-a', totalMinor: 1200, currency: 'SAR', status: 'pending_payment', paymentStatus: 'pending', version: 1 };

async function appPage(override = async () => false) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ar-SA' });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const requests = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base) return route.abort();
    const payload = request.postData() ? JSON.parse(request.postData()) : null;
    const entry = { path: url.pathname, payload, authorization: request.headers().authorization };
    requests.push(entry);
    const json = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    if (await override({ route, request, url, payload, json })) return;
    if (request.isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: assets['index.html'] });
    if (url.pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript', body: assets['app.js'] });
    if (url.pathname === '/style.css') return route.fulfill({ contentType: 'text/css', body: assets['style.css'] });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    if (url.pathname === '/dev/session') return json({ accessToken: `token-${payload.identity}`, principal: { id: payload.identity, role: payload.identity.startsWith('merchant') ? 'merchant' : 'customer' } });
    if (url.pathname === '/api/restaurants') return json({ restaurants });
    const menuMatch = /^\/api\/restaurants\/(demo-[ab])\/menu$/.exec(url.pathname);
    if (menuMatch) return json(menu(menuMatch[1]));
    const quoteMatch = /^\/api\/restaurants\/(demo-[ab])\/quote$/.exec(url.pathname);
    if (quoteMatch) return json({ tenantId: quoteMatch[1], currency: 'SAR', totalMinor: payload.items.reduce((sum, item) => sum + item.quantity * menu(quoteMatch[1]).items[0].priceMinor, 0) });
    if (/^\/api\/restaurants\/demo-[ab]\/checkouts$/.test(url.pathname)) return json({ checkoutUrl: `${base}/#synthetic-prepared` });
    if (url.pathname === `/api/checkouts/${checkoutId}`) return json({ tenantId: 'demo-a', totalMinor: 1200, paymentMode: 'local-simulator' });
    if (url.pathname === `/api/checkouts/${checkoutId}/confirm`) return json({ order, simulationUrl: `/api/restaurants/demo-a/orders/${orderId}/simulate-payment` });
    if (url.pathname.endsWith('/simulate-payment')) return json({ ...order, status: 'accepted', paymentStatus: 'paid', version: 2 });
    if (url.pathname.endsWith('/payment-status')) return json({ ...order, status: 'accepted', paymentStatus: 'paid', version: 2 });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"test_route_missing"}' });
  });
  return { context, page, requests, errors };
}

async function login(page, identity = 'customer-alice') {
  await page.locator('#identity').selectOption(identity);
  await page.locator('#login').click();
  await page.waitForFunction(value => document.querySelector('#session').textContent.includes(value), identity);
}
async function selectRestaurant(page, tenant = 'demo-a') {
  await page.locator('#content article').filter({ hasText: tenant }).getByRole('button').click();
  await page.locator('input[data-item]').waitFor();
}

try {
  // Unmocked, read-only smoke: local synthetic health and HTML/JS rendering.
  const smoke = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const smokePage = await smoke.newPage();
  smokePage.setDefaultTimeout(8000);
  await smoke.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await smokePage.goto(base);
  await smokePage.locator('#content article').first().waitFor();
  check(await smokePage.locator('html').getAttribute('dir') === 'rtl', 'Live local page must render RTL');
  await smokePage.screenshot({ path: `${artifactDir}/live-directory.png`, fullPage: true });
  await smoke.close();

  // A late login must not restore a previously selected identity or its token.
  const loginGate = gate();
  const loginStarted = gate();
  const loginRace = await appPage(async ({ url, payload, json }) => {
    if (url.pathname === '/dev/session' && payload.identity === 'customer-alice') {
      loginStarted.resolve(); await loginGate.promise;
      await json({ accessToken: 'token-customer-alice', principal: { id: 'customer-alice', role: 'customer' } }); return true;
    }
    return false;
  });
  await loginRace.page.goto(base);
  await loginRace.page.locator('#login').click();
  await loginStarted.promise;
  await login(loginRace.page, 'customer-bob');
  loginGate.resolve();
  await loginRace.page.waitForResponse(response => response.url().endsWith('/dev/session') && response.request().postDataJSON().identity === 'customer-alice');
  await selectRestaurant(loginRace.page, 'demo-b');
  await loginRace.page.locator('input[data-item]').fill('1');
  await loginRace.page.locator('#quote').click();
  await loginRace.page.locator('#checkout').waitFor();
  check((await loginRace.page.locator('#session').textContent()).includes('customer-bob'), 'Late Alice login cannot replace Bob');
  check(loginRace.requests.findLast(request => request.path.endsWith('/quote')).authorization === 'Bearer token-customer-bob', 'Latest identity token must authorize quote');
  check(loginRace.errors.length === 0, `No login race JS errors: ${loginRace.errors.join(', ')}`);
  await loginRace.context.close();

  // A response for restaurant A cannot replace B after identity/navigation.
  const menuGate = gate();
  const menuStarted = gate();
  const menuRace = await appPage(async ({ url, json }) => {
    if (url.pathname === '/api/restaurants/demo-a/menu') { menuStarted.resolve(); await menuGate.promise; await json(menu('demo-a')); return true; }
    return false;
  });
  await menuRace.page.goto(base);
  await login(menuRace.page);
  await menuRace.page.locator('#content article').filter({ hasText: 'demo-a' }).getByRole('button').click();
  await menuStarted.promise;
  await login(menuRace.page, 'customer-bob');
  await selectRestaurant(menuRace.page, 'demo-b');
  menuGate.resolve();
  await menuRace.page.waitForResponse(response => response.url().endsWith('/demo-a/menu'));
  await menuRace.page.locator('input[data-item="demo-b-dish"]').waitFor();
  check(await menuRace.page.locator('input[data-item="demo-a-dish"]').count() === 0, 'Old A menu cannot overwrite B');
  check(menuRace.errors.length === 0, 'No menu race JS errors');
  await menuRace.context.close();

  // Changed quantities invalidate a pending quote and old checkout closures.
  const quoteGate = gate();
  const quoteStarted = gate();
  let holdQuote = true;
  const quoteRace = await appPage(async ({ url, payload, json }) => {
    if (url.pathname.endsWith('/quote') && holdQuote) { holdQuote = false; quoteStarted.resolve(); await quoteGate.promise; await json({ totalMinor: payload.items[0].quantity * 1200 }); return true; }
    return false;
  });
  await quoteRace.page.goto(base);
  await login(quoteRace.page);
  await selectRestaurant(quoteRace.page);
  await quoteRace.page.locator('input[data-item]').fill('1');
  await quoteRace.page.locator('#quote').click();
  await quoteStarted.promise;
  await quoteRace.page.locator('input[data-item]').fill('2');
  quoteGate.resolve();
  await quoteRace.page.waitForFunction(() => !document.querySelector('#quote').disabled);
  check(await quoteRace.page.locator('#checkout').count() === 0, 'A quote for old quantities must be discarded');
  await quoteRace.page.locator('#quote').click();
  await quoteRace.page.locator('#checkout').waitFor();
  await quoteRace.page.evaluate(() => { window.oldCheckout = document.querySelector('#checkout'); });
  await quoteRace.page.locator('input[data-item]').fill('3');
  await quoteRace.page.locator('#quote').click();
  await quoteRace.page.locator('#checkout').waitFor();
  await quoteRace.page.evaluate(() => window.oldCheckout.onclick());
  check(quoteRace.requests.filter(request => request.path.endsWith('/checkouts')).length === 0, 'Detached old checkout cannot submit');
  check(await quoteRace.page.locator('#total .total').count() === 1, 'Only one quote card is rendered');
  await quoteRace.page.screenshot({ path: `${artifactDir}/mocked-web-quote.png`, fullPage: true });
  await quoteRace.page.locator('#checkout').click();
  await quoteRace.page.waitForURL('**/#synthetic-prepared');
  const prepared = quoteRace.requests.findLast(request => request.path.endsWith('/checkouts'));
  assert.deepEqual(prepared.payload.items, [{ itemId: 'demo-a-dish', quantity: 3 }]); assertions++;
  check(prepared.payload.expectedTotalMinor === 3600 && prepared.path.includes('demo-a'), 'Checkout binds tenant, items and total to one snapshot');
  check(quoteRace.errors.length === 0, 'No quote race JS errors');
  await quoteRace.context.close();

  const payment = await appPage();
  await payment.page.goto(`${base}/checkout/${checkoutId}`);
  await login(payment.page);
  await payment.page.locator('#confirm').click();
  await payment.page.locator('#payment button').waitFor();
  await payment.page.locator('#payment button').click();
  await payment.page.waitForFunction(() => document.querySelector('#payment button').disabled && document.querySelector('#payment p').textContent.includes('الإصدار 2'));
  check(await payment.page.locator('#confirm').isDisabled(), 'Successful confirm remains disabled');
  check(await payment.page.locator('#payment button').isDisabled(), 'Successful simulated payment remains disabled after finally');
  await payment.page.evaluate(() => document.querySelector('#payment button').onclick());
  check(payment.requests.filter(request => request.path.endsWith('/simulate-payment')).length === 1, 'Settled payment closure cannot send twice');
  await payment.page.goto(`${base}/payment-return/demo-a/${orderId}`);
  await payment.page.locator('#verify').waitFor();
  check(await payment.page.locator('#verify').count() === 1, 'Payment return recognizes opaque 32-character Go order ID');
  check(payment.errors.length === 0, 'No payment JS errors');
  await payment.context.close();

  // Widget host is a deterministic bridge mock, NOT an actual ChatGPT session.
  const widgetContext = await browser.newContext({ viewport: { width: 600, height: 860 } });
  const widget = await widgetContext.newPage();
  widget.setDefaultTimeout(8000);
  const widgetErrors = [];
  widget.on('pageerror', error => widgetErrors.push(error.message));
  await widgetContext.route('**/*', route => new URL(route.request().url()).origin === base
    ? route.fulfill({ contentType: 'text/html', body: assets['widget.html'] }) : route.abort());
  await widget.addInitScript(({ restaurants, base }) => {
    window.bridgeCalls = [];
    window.openedUrls = [];
    window.holdMenuA = true;
    window.holdQuote = false;
    const result = (name, args) => {
      if (name === 'search_restaurants') return { restaurants };
      if (name === 'get_restaurant_menu') return { tenantId: args.tenantId, name: restaurants.find(item => item.id === args.tenantId).name, items: [{ id: `${args.tenantId}-dish`, name: 'طبق اصطناعي', priceMinor: args.tenantId === 'demo-a' ? 1200 : 2100 }] };
      if (name === 'quote_cart') return { totalMinor: args.items.reduce((sum, item) => sum + item.quantity * (args.tenantId === 'demo-a' ? 1200 : 2100), 0) };
      if (name === 'prepare_checkout') return { checkoutUrl: `${base}/#widget-checkout` };
      throw new Error('unknown_mock_tool');
    };
    window.openai = {
      toolOutput: { restaurants },
      openExternal: value => window.openedUrls.push(value.href),
      callTool: async (name, args) => {
        window.bridgeCalls.push({ name, args: structuredClone(args) });
        if (name === 'get_restaurant_menu' && args.tenantId === 'demo-a' && window.holdMenuA) {
          window.holdMenuA = false;
          await new Promise(resolve => { window.releaseMenuA = resolve; });
        }
        if (name === 'quote_cart' && window.holdQuote) {
          window.holdQuote = false;
          await new Promise(resolve => { window.releaseQuote = resolve; });
        }
        return { structuredContent: result(name, args) };
      }
    };
  }, { restaurants, base });
  await widget.goto(`${base}/__widget_preview`);
  await widget.locator('#result article').first().getByRole('button').click();
  await widget.waitForFunction(() => typeof window.releaseMenuA === 'function');
  await widget.locator('#browse').click();
  await widget.locator('#result article').nth(1).getByRole('button').click();
  await widget.locator('input[data-item="demo-b-dish"]').waitFor();
  await widget.evaluate(() => window.releaseMenuA());
  check(await widget.locator('input[data-item="demo-a-dish"]').count() === 0, 'Late widget menu cannot replace selected tenant');
  await widget.locator('input').fill('1');
  await widget.evaluate(() => { window.holdQuote = true; });
  await widget.getByRole('button', { name: 'حساب السلة', exact: true }).click();
  await widget.waitForFunction(() => typeof window.releaseQuote === 'function');
  await widget.locator('input').fill('2');
  await widget.evaluate(() => window.releaseQuote());
  await widget.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'حساب السلة' && !button.disabled));
  check(await widget.locator('#quote-slot article').count() === 0, 'Late widget quote is invalidated by quantity change');
  await widget.getByRole('button', { name: 'حساب السلة', exact: true }).click();
  await widget.locator('#quote-slot button').waitFor();
  await widget.evaluate(() => { window.oldWidgetCheckout = document.querySelector('#quote-slot button'); });
  await widget.locator('input').fill('3');
  await widget.getByRole('button', { name: 'حساب السلة', exact: true }).click();
  await widget.locator('#quote-slot button').waitFor();
  await widget.evaluate(() => window.oldWidgetCheckout.onclick());
  check(await widget.evaluate(() => window.bridgeCalls.filter(call => call.name === 'prepare_checkout').length) === 0, 'Old widget quote cannot create checkout');
  await widget.getByRole('button', { name: 'حساب السلة', exact: true }).click();
  await widget.locator('#quote-slot button').waitFor();
  check(await widget.locator('#quote-slot article').count() === 1, 'Requoting replaces old widget cards');
  await widget.locator('#quote-slot button').click();
  const widgetPrepared = await widget.evaluate(() => window.bridgeCalls.findLast(call => call.name === 'prepare_checkout'));
  assert.deepEqual(widgetPrepared.args.items, [{ itemId: 'demo-b-dish', quantity: 3 }]); assertions++;
  check(widgetPrepared.args.tenantId === 'demo-b' && widgetPrepared.args.expectedTotalMinor === 6300 && typeof widgetPrepared.args.idempotencyKey === 'string', 'Widget checkout uses immutable full quote snapshot');
  check(await widget.evaluate(() => window.openedUrls.length) === 1, 'Latest widget checkout opens once');
  check(widgetErrors.length === 0, `No widget JS errors: ${widgetErrors.join(', ')}`);
  await widget.screenshot({ path: `${artifactDir}/mocked-widget-quote.png`, fullPage: true });
  await widgetContext.close();
  console.log(JSON.stringify({ status: 'passed', assertions, browser: await browser.version(), liveScope: 'synthetic loopback health and directory rendering only', regressionScope: 'mocked REST and ChatGPT bridge; no provider, real user, or actual ChatGPT acceptance', artifacts: artifactDir }));
} finally {
  clearTimeout(watchdog);
  await browser.close();
}
