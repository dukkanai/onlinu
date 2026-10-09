// Deterministic Chrome acceptance of staging assets with mocked same-origin
// OIDC session/API responses. This does NOT verify the real identity provider.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const base = 'https://synthetic-staging.invalid';
const assets = Object.fromEntries(await Promise.all(['staging.html', 'staging.js', 'staging.css', 'style.css'].map(async name => [name, await readFile(new URL(`../public/${name}`, import.meta.url), 'utf8')])));
const artifactDir = fileURLToPath(new URL('../../artifacts/staging-browser/', import.meta.url));
await mkdir(artifactDir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'] });
const watchdog = setTimeout(() => { console.error('Staging browser regression exceeded 30 seconds'); process.exitCode = 1; void browser.close(); }, 30000);
watchdog.unref();
let assertions = 0;
const check = (value, label) => { assert.ok(value, label); assertions++; };
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tenant = 'demo-a';
const checkoutId = '11111111-2222-4333-8444-555555555555';
const orderId = '11112222333344445555666677778888';
const initialOrder = { id: orderId, tenantId: tenant, status: 'accepted', paymentStatus: 'paid', version: 2, currency: 'SAR', totalMinor: 2400 };
const restaurants = [{ id: tenant, name: 'مطعم التجربة المحمية', cuisine: 'منيو اصطناعي', template: 'classic' }];

async function createPage({ role = 'customer', override = async () => false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: 'ar-SA' });
  const page = await context.newPage(); page.setDefaultTimeout(7000);
  const requests = [];
  const errors = [];
  let authenticated = role !== null;
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base) return route.abort();
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    const entry = { path: url.pathname, method: request.method(), body, headers: request.headers() };
    requests.push(entry);
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (await override({ route, request, url, body, json })) return;
    if (url.pathname === '/auth/login') return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Mock identity provider. Real OIDC not exercised.</p>' });
    if (request.isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: assets['staging.html'] });
    if (url.pathname === '/staging.js') return route.fulfill({ contentType: 'text/javascript', body: assets['staging.js'] });
    if (url.pathname === '/style.css' || url.pathname === '/staging.css') return route.fulfill({ contentType: 'text/css', body: assets[url.pathname.slice(1)] });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    if (url.pathname === '/api/session') return authenticated ? json({ authMode: 'oidc', csrfToken: 'synthetic-csrf', principal: { id: 'synthetic-subject', role, tenantIds: role === 'merchant' ? [tenant] : [] } }) : json({ error: 'unauthorized' }, 401);
    if (url.pathname === '/auth/logout') { authenticated = false; return json({ ok: true }); }
    if (!authenticated) return json({ error: 'unauthorized' }, 401);
    if (url.pathname === '/api/restaurants' || url.pathname === '/api/merchant/restaurants') return json({ restaurants });
    if (url.pathname === `/api/restaurants/${tenant}/menu`) return json({ tenantId: tenant, name: restaurants[0].name, currency: 'SAR', items: [{ id: 'dish-a', name: 'طبق اصطناعي', priceMinor: 1200, stock: 50 }] });
    if (url.pathname === `/api/restaurants/${tenant}/quote`) return json({ totalMinor: body.items[0].quantity * 1200, currency: 'SAR' });
    if (url.pathname === `/api/restaurants/${tenant}/checkouts`) return json({ checkoutUrl: `${base}/checkout/${checkoutId}` });
    if (url.pathname === `/api/checkouts/${checkoutId}`) return json({ tenantId: tenant, totalMinor: 2400, paymentMode: 'local-simulator' });
    if (url.pathname === `/api/checkouts/${checkoutId}/confirm`) return json({ order: { ...initialOrder, status: 'pending_payment', paymentStatus: 'pending', version: 1 }, simulationUrl: `/api/restaurants/${tenant}/orders/${orderId}/simulate-payment` });
    if (url.pathname.endsWith('/simulate-payment')) return json(initialOrder);
    if (url.pathname === `/api/merchant/restaurants/${tenant}/orders`) return json({ orders: [initialOrder] });
    return json({ error: 'missing_mock_route' }, 404);
  });
  return { page, context, requests, errors };
}

try {
  const anonymous = await createPage({ role: null });
  await anonymous.page.goto(`${base}/checkout/${checkoutId}`);
  await anonymous.page.locator('#sign-in').waitFor();
  check((await anonymous.page.locator('#sign-in').getAttribute('href')) === `/auth/login?returnTo=${encodeURIComponent(`/checkout/${checkoutId}`)}`, 'Login preserves only safe checkout return path');
  check(await anonymous.page.locator('#identity,#login').count() === 0, 'Protected staging has no development identity selector');
  check(anonymous.requests.filter(request => request.path.startsWith('/api/')).every(request => request.path === '/api/session'), 'No anonymous catalog or order API calls');
  check(anonymous.requests.every(request => !request.path.startsWith('/dev/')), 'No development session endpoint');
  await anonymous.page.screenshot({ path: `${artifactDir}/mocked-protected-signin.png`, fullPage: true });
  await anonymous.context.close();

  const customer = await createPage();
  await customer.page.goto(base);
  await customer.page.getByRole('button', { name: 'استعراض المنيو', exact: true }).click();
  await customer.page.locator('input[data-item]').fill('1');
  await customer.page.locator('#quote').click();
  await customer.page.locator('#checkout').waitFor();
  await customer.page.evaluate(() => { window.oldCheckout = document.querySelector('#checkout'); });
  await customer.page.locator('input[data-item]').fill('2');
  await customer.page.locator('#quote').click();
  await customer.page.locator('#checkout').waitFor();
  await customer.page.evaluate(() => window.oldCheckout.onclick());
  check(customer.requests.filter(request => request.path.endsWith('/checkouts')).length === 0, 'Invalidated checkout snapshot cannot submit');
  check(await customer.page.locator('#total article').count() === 1, 'Staging has one current quote card');
  await customer.page.locator('#checkout').click();
  await customer.page.waitForURL(`**/checkout/${checkoutId}`);
  const checkoutRequest = customer.requests.find(request => request.path.endsWith('/checkouts'));
  assert.deepEqual(checkoutRequest.body.items, [{ itemId: 'dish-a', quantity: 2 }]); assertions++;
  check(checkoutRequest.body.expectedTotalMinor === 2400, 'Checkout total matches immutable latest cart');
  await customer.page.locator('#confirm').click();
  await customer.page.locator('#payment button').click();
  await customer.page.waitForFunction(() => document.querySelector('#payment button').disabled && document.querySelector('#payment p').textContent.includes('الإصدار 2'));
  check(await customer.page.locator('#confirm').isDisabled(), 'Confirmed order cannot be resubmitted from the same button');
  check(await customer.page.locator('#payment button').isDisabled(), 'Completed local simulation stays disabled');
  await customer.page.locator('#logout').click();
  await customer.page.locator('#sign-in').waitFor();
  check(await customer.page.locator('#payment').count() === 0, 'Logout clears private order display');
  check(customer.requests.filter(request => request.method === 'POST').every(request => request.headers['x-csrf-token'] === 'synthetic-csrf'), 'Every customer write and logout carries CSRF token');
  check(customer.requests.every(request => request.headers.authorization === undefined), 'Protected browser uses no bearer authorization');
  check(await customer.page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0), 'No session or CSRF token persisted to browser storage');
  check(customer.errors.length === 0, `No customer JS errors: ${customer.errors.join(', ')}`);
  await customer.context.close();

  const pendingMenu = gate();
  const menuStarted = gate();
  const stale = await createPage({ override: async ({ url, json }) => {
    if (url.pathname.endsWith('/menu')) { menuStarted.resolve(); await pendingMenu.promise; await json({ name: 'بيانات قديمة', items: [] }); return true; }
    return false;
  } });
  await stale.page.goto(base);
  await stale.page.getByRole('button', { name: 'استعراض المنيو', exact: true }).click();
  await menuStarted.promise;
  await stale.page.locator('#logout').click();
  await stale.page.locator('#sign-in').waitFor();
  pendingMenu.resolve();
  await stale.page.waitForResponse(response => response.url().endsWith('/menu'));
  check(await stale.page.locator('#sign-in').count() === 1, 'Late menu cannot restore authenticated content after logout');
  check(await stale.page.getByText('بيانات قديمة', { exact: true }).count() === 0, 'Late private data is discarded');
  await stale.context.close();

  const expired = await createPage({ override: async ({ url, json }) => {
    if (url.pathname.endsWith('/quote')) { await json({ error: 'expired' }, 401); return true; }
    return false;
  } });
  await expired.page.goto(base);
  await expired.page.getByRole('button', { name: 'استعراض المنيو', exact: true }).click();
  await expired.page.locator('input[data-item]').fill('1');
  await expired.page.locator('#quote').click();
  await expired.page.locator('#sign-in').waitFor();
  check((await expired.page.locator('#message').textContent()).includes('انتهت الجلسة'), 'Expired session clears UI and requests a new login');
  check(await expired.page.locator('input[data-item]').count() === 0, 'Expired session cannot retain editable private cart');
  await expired.context.close();

  const merchant = await createPage({role:'merchant'});
  await merchant.page.goto(base);
  await merchant.page.locator(`[data-tenant="${tenant}"]`).waitFor();
  check(await merchant.page.locator('[data-channels]').count()===0,'Retired WhatsApp configuration is absent');
  check(merchant.requests.every(request => !request.path.startsWith('/dev/')), 'Merchant uses no fixture-selection endpoint');
  check(merchant.errors.length === 0, `No merchant JS errors: ${merchant.errors.join(', ')}`);
  await merchant.page.screenshot({ path: `${artifactDir}/mocked-owner-orders.png`, fullPage: true });
  await merchant.page.setViewportSize({ width: 390, height: 844 });
  check(await merchant.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Arabic merchant layout fits narrow viewport');
  await merchant.context.close();

  console.log(JSON.stringify({ status: 'passed', assertions, browser: await browser.version(), scope: 'Chrome assets with mocked OIDC/API; no network to real staging, no actual IdP acceptance, no real WhatsApp/payment', artifacts: artifactDir }));
} finally {
  clearTimeout(watchdog);
  await browser.close();
}
