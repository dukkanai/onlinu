import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { CORE_MENU_UI_HTML } from './core-menu-ui.mjs';
import { openCoreMenuHarness } from './integration/core-menu-browser-harness.mjs';

const menu = {
  tenantId: 'demo-a', version: 1,
  settings: { name: 'منيو الاختبار', description: 'بيانات اختبار معزولة', currency: 'SAR', acceptingOrders: true, pickupEnabled: true, demo: true },
  categories: [{ id: 'main', name: 'وجبات', sort: 0 }],
  items: [
    { id: 'chicken', categoryId: 'main', name: 'كبسة دجاج', description: '', priceMinor: 3200, available: true, sort: 0,
      options: [{ id: 'rice', name: 'أرز إضافي', priceMinor: 600, available: true }, { id: 'sold-out', name: 'غير متاح', priceMinor: 200, available: false }] },
    { id: 'water', categoryId: 'main', name: 'ماء', description: '', priceMinor: 300, available: true, sort: 1, options: [] },
    { id: 'unavailable', categoryId: 'main', name: 'صنف غير متاح', description: '', priceMinor: 700, available: false, sort: 2 },
  ],
};
const success = data => ({ structuredContent: data, content: [] });
function quote(args, totalOverride) {
  const items = args.items.map(selected => {
    const item = menu.items.find(item => item.id === selected.itemId);
    const options = item.options.filter(option => selected.optionIds.includes(option.id));
    const unitPriceMinor = item.priceMinor + options.reduce((sum, option) => sum + option.priceMinor, 0);
    return { itemId: item.id, name: item.name, quantity: selected.quantity, options, unitPriceMinor, totalMinor: unitPriceMinor * selected.quantity };
  });
  const totalMinor = totalOverride ?? items.reduce((sum, item) => sum + item.totalMinor, 0);
  return success({ tenantId: args.tenantId, currency: 'SAR', demo: true, items, totalMinor, subtotalMinor: totalMinor, deliveryFeeMinor: 0,
    paymentMethods: [], tax: { enabled: true, netMinor: totalMinor - 100, taxMinor: 100, grossMinor: totalMinor } });
}
const item = (frame, id) => frame.locator(`[data-item-id="${id}"]`);
const total = (frame, amount) => frame.locator(`#quote[data-total-minor="${amount}"]`).waitFor();
function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { release, promise };
}
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'Expected browser tool call'); await new Promise(resolve => setTimeout(resolve, 20)); }
}

test('core menu MCP Apps browser behavior', { skip: process.env.CORE_BROWSER_TEST !== '1', timeout: 60000 }, async t => {
  const executablePath = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
  await access(executablePath);
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'] });
  t.after(() => browser.close());
  async function open(options = {}) {
    const harness = await openCoreMenuHarness({ browser, html: CORE_MENU_UI_HTML, initialResult: success(menu), callTool: async (name, args) => name === 'quote_cart' ? quote(args) : success(menu), ...options });
    t.after(() => harness.close());
    return harness;
  }

  await t.test('iframe handshake, quantities, per-unit add-ons, zero, reset, and server-only totals', async () => {
    const h = await open(); const f = h.frame;
    assert.equal(await f.locator('html').getAttribute('dir'), 'rtl');
    assert.equal(await item(f, 'unavailable').getByRole('button', { name: 'زيادة صنف غير متاح', exact: true }).isDisabled(), true);
    assert.equal(await item(f, 'chicken').locator('[data-option-id="sold-out"]').isDisabled(), true);
    await item(f, 'chicken').getByRole('button', { name: 'زيادة كبسة دجاج', exact: true }).click({ clickCount: 2 });
    await item(f, 'water').getByRole('button', { name: 'زيادة ماء', exact: true }).click({ clickCount: 2 });
    await total(f, 7000);
    await item(f, 'chicken').locator('[data-option-id="rice"]').check();
    await total(f, 8200);
    assert.match(await f.locator('#quote').textContent(), /لا توجد وسيلة دفع/);
    assert.deepEqual(h.calls.at(-1).args, { tenantId: 'demo-a', mode: 'pickup', items: [{ itemId: 'chicken', quantity: 2, optionIds: ['rice'] }, { itemId: 'water', quantity: 2, optionIds: [] }] });
    const before = h.calls.length;
    await f.locator('#reset').click();
    assert.equal(await f.locator('#quote').getAttribute('data-total-minor'), null);
    assert.equal(await item(f, 'chicken').locator('output').textContent(), '0');
    assert.equal(await item(f, 'chicken').locator('[data-option-id="rice"]').isChecked(), false);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(h.calls.length, before, 'Empty cart must not call quote_cart');
    assert.ok(h.calls.every(call => call.name === 'quote_cart'));
    assert.deepEqual(h.errors, []); assert.deepEqual(h.requests, []);
    const h2 = await open({ callTool: async (_name, args) => quote(args, 12345) });
    await item(h2.frame, 'chicken').getByRole('button', { name: 'زيادة كبسة دجاج', exact: true }).click();
    await total(h2.frame, 12345);
    assert.match(await h2.frame.locator('#quote').textContent(), /123\.45/);
  });

  await t.test('older quote and uncorrelated notifications cannot overwrite newer cart or reset', async () => {
    const first = gate(); let n = 0;
    const h = await open({ callTool: async (_name, args) => { if (++n === 1) await first.promise; return quote(args); } });
    const f = h.frame, plus = item(f, 'chicken').getByRole('button', { name: 'زيادة كبسة دجاج', exact: true });
    await plus.click(); await until(() => n === 1);
    await plus.click(); await total(f, 6400);
    first.release();
    await h.page.evaluate(data => window.harness.send({ method: 'ui/notifications/tool-result', params: data }), quote({ tenantId: 'demo-a', items: [{ itemId: 'chicken', quantity: 1, optionIds: [] }] }));
    await new Promise(resolve => setTimeout(resolve, 100));
    await total(f, 6400);
    const second = gate(); let waiting = false;
    const h2 = await open({ callTool: async (_name, args) => { waiting = true; await second.promise; return quote(args); } });
    await item(h2.frame, 'chicken').getByRole('button', { name: 'زيادة كبسة دجاج', exact: true }).click(); await until(() => waiting);
    await h2.frame.locator('#reset').click(); second.release();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await h2.frame.locator('#quote').getAttribute('data-total-minor'), null);
    assert.match(await h2.frame.locator('#quote').textContent(), /السلة فارغة/);
    assert.deepEqual(h.errors.concat(h2.errors), []);
  });

  await t.test('quote errors, input mismatch, and denied access fail closed with a working retry', async () => {
    let n = 0;
    const h = await open({ callTool: async (_name, args) => ++n === 1 ? { isError: true, content: [{ type: 'text', text: 'authentication_required' }] } : quote(args) });
    const f = h.frame;
    await item(f, 'chicken').getByRole('button', { name: 'زيادة كبسة دجاج', exact: true }).click();
    await f.locator('#retry').waitFor();
    assert.match(await f.locator('#status').textContent(), /أعد ربط Onlinu/);
    assert.equal(await f.locator('#quote').getAttribute('data-total-minor'), null);
    await f.locator('#retry').click(); await total(f, 3200);
    const bad = await open({ callTool: async (_name, args) => { const result = quote(args); result.structuredContent.items[0].quantity = 55; return result; } });
    await item(bad.frame, 'chicken').getByRole('button', { name: 'زيادة كبسة دجاج', exact: true }).click();
    await bad.frame.locator('#retry').waitFor();
    assert.equal(await bad.frame.locator('#quote').getAttribute('data-total-minor'), null);
    assert.deepEqual(h.errors.concat(bad.errors), []);
  });

  await t.test('initial authentication errors, server errors, and malformed menus leave loading and can retry', async () => {
    for (const initialResult of [
      { isError: true, content: [{ type: 'text', text: 'authentication_required' }] },
      { isError: true, content: [{ type: 'text', text: 'private database error that must not render' }] },
      { structuredContent: { tenantId: 'demo-a', settings: { currency: 'SAR' }, items: [] } },
    ]) {
      const h = await open({ initialResult, initialTenant: 'demo-a' });
      assert.match(await h.frame.locator('#menu').textContent(), /لم يكتمل تحميل/);
      assert.doesNotMatch(await h.frame.locator('body').textContent(), /private database/);
      assert.equal(await h.frame.locator('#refresh').isDisabled(), false);
      await h.frame.locator('#refresh').click();
      await h.frame.locator('#title').filter({ hasText: menu.settings.name }).waitFor();
      assert.deepEqual(h.calls, [{ name: 'get_restaurant_menu', args: { tenantId: 'demo-a' } }]);
      assert.deepEqual(h.errors, []);
    }
  });

  await t.test('refresh invalidates an in-flight quote and stale opening notifications', async () => {
    const delayed = gate(); let quoted = false;
    const freshMenu = structuredClone(menu); freshMenu.items[0].priceMinor = 4800;
    const h = await open({ callTool: async (name, args) => {
      if (name === 'get_restaurant_menu') return success(freshMenu);
      quoted = true; await delayed.promise; return quote(args);
    } });
    const f = h.frame;
    await item(f, 'chicken').getByRole('button', { name: 'زيادة كبسة دجاج', exact: true }).click(); await until(() => quoted);
    await f.locator('#refresh').click();
    await f.locator('#status').filter({ hasText: 'تم تحديث المنيو' }).waitFor();
    delayed.release();
    await h.page.evaluate(data => window.harness.send({ method: 'ui/notifications/tool-result', params: data }), success(menu));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.match(await item(f, 'chicken').textContent(), /48\.00/);
    assert.equal(await item(f, 'chicken').locator('output').textContent(), '0');
    assert.equal(await f.locator('#quote').getAttribute('data-total-minor'), null);
    assert.equal(h.calls.filter(call => call.name === 'get_restaurant_menu').length, 1);
  });

  await t.test('cancelled opening ignores late success until an explicit correlated refresh', async () => {
    const h = await open({ cancelOpening: true });
    assert.match(await h.frame.locator('#menu').textContent(), /أُلغيت/);
    assert.equal(await h.frame.locator('[data-item-id]').count(), 0);
    await h.page.evaluate(data => window.harness.send({ method: 'ui/notifications/tool-result', params: data }), success(menu));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await h.frame.locator('[data-item-id]').count(), 0);
    await h.frame.locator('#refresh').click();
    await h.frame.locator('#title').filter({ hasText: menu.settings.name }).waitFor();
    assert.equal(await h.frame.locator('[data-item-id]').count(), 3);
    assert.deepEqual(h.calls, [{ name: 'get_restaurant_menu', args: { tenantId: 'demo-a' } }]);
  });

  await t.test('unavailable pickup, hostile menu text, narrow viewport, and legacy bridge', async () => {
    const closedMenu = structuredClone(menu); closedMenu.settings.pickupEnabled = false;
    const disabled = await open({ initialResult: success(closedMenu) });
    assert.equal(await item(disabled.frame, 'chicken').getByRole('button', { name: 'زيادة كبسة دجاج', exact: true }).isDisabled(), true);
    assert.match(await disabled.frame.locator('#availability').textContent(), /غير متاحة/);
    const hostileMenu = structuredClone(menu); hostileMenu.items[0].description = '<img src="https://invalid.example" onerror="window.hacked=true">';
    const narrow = await open({ initialResult: success(hostileMenu), viewport: { width: 360, height: 900 } });
    assert.equal(await narrow.frame.locator('img').count(), 0);
    assert.match(await item(narrow.frame, 'chicken').textContent(), /<img/);
    assert.equal(await narrow.frame.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.deepEqual(narrow.requests, []);
    const legacy = await open({ legacy: true });
    await item(legacy.frame, 'chicken').getByRole('button', { name: 'زيادة كبسة دجاج', exact: true }).click(); await total(legacy.frame, 3200);
    assert.equal(legacy.calls.length, 1);
    assert.deepEqual(legacy.errors, []);
  });

  await t.test('teardown blocks delayed results and disables all actions', async () => {
    const delayed = gate(); let waiting = false;
    const h = await open({ callTool: async (_name, args) => { waiting = true; await delayed.promise; return quote(args); } });
    const f = h.frame;
    await item(f, 'chicken').getByRole('button', { name: 'زيادة كبسة دجاج', exact: true }).click(); await until(() => waiting);
    await h.page.evaluate(() => window.harness.send({ id: 'teardown', method: 'ui/resource-teardown', params: {} }));
    await h.page.waitForFunction(() => window.harness.events.some(event => event.id === 'teardown' && event.result));
    delayed.release(); await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await f.locator('#quote').getAttribute('data-total-minor'), null);
    assert.equal(await f.locator('#refresh').isDisabled(), true);
    assert.equal(await item(f, 'chicken').getByRole('button', { name: 'زيادة كبسة دجاج', exact: true }).isDisabled(), true);
    assert.deepEqual(h.errors, []);
  });
});
