// Isolated old -> current -> restart -> old compatibility check. No live data,
// external gateways, sessions or real money. Existing evidence is never reset.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

const root = '/home/chatbot/wa/AstraCalls';
const postgres = 'astracalls-completion-test-postgres';
const app = 'astracalls-iteration-upgrade-app';
const purpose = 'iteration-isolated-upgrade';
const namespace = 'iterationupgrade';
const database = `${namespace}_main`;
const origin = 'http://127.0.0.1:18084';
const legacyImage = 'astracalls-translation:0.5.1-dev-20260927-saudi';
const apiKey = 'restaurant-browser-test-key';
const resume = process.argv.includes('--resume-legacy-fixture');
const startedAt = new Date().toISOString();
const checks = [], stages = [];
const run = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 2 ** 20 }).trim();
const sql = (query, db = database) => run(['exec', postgres, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'astracalls_test', '-d', db, '-At', '-c', query]);
const check = (condition, message) => { assert.ok(condition, message); checks.push(message); };
const hash = value => createHash('sha256').update(value).digest('hex');
const tables = ['restaurant_catalog', 'restaurant_orders', 'restaurant_order_events', 'restaurant_order_secret', 'restaurant_stock', 'restaurant_stock_reservations', 'restaurant_stock_events', 'restaurant_brand_state', 'restaurant_payment_attempts', 'restaurant_refunds', 'restaurant_refund_events'];
let ownsApp = false;

async function api(path, method = 'GET', body, admin = true, extraHeaders = {}, expected = 200) {
  // Restrict mutations to the exact synthetic fixture APIs used below.
  if (!/^\/(api\/restaurant\/(catalog|stock(?:\/[^/]+)?|brand(?:\/(draft|publish))?|orders(?:\/[^/]+(?:\/cash)?)?)|storefront-api\/(catalog|quote|orders(?:\/[^/]+)?))$/.test(path)) throw Error(`Unapproved test route: ${path}`);
  const response = await fetch(origin + path, {
    method, redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { Origin: origin, ...(admin ? { 'X-API-Key': apiKey } : {}), ...extraHeaders, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`);
  return value;
}

function removeOwnApp() {
  if (!ownsApp) return;
  assert.equal(run(['inspect', '--format', '{{index .Config.Labels "astracalls.purpose"}}', app]), purpose, 'Refuse a container with another owner');
  run(['stop', '--time', '5', app]);
  run(['rm', app]);
  ownsApp = false;
}

async function ready() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(origin + '/healthz', { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* Readiness is polled only against the fixed test port. */ }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw Error(`Test application did not become healthy: ${run(['logs', '--tail', '20', app])}`);
}

async function start(kind) {
  assert.equal(ownsApp, false);
  const args = ['run', '-d', '--name', app, '--pull', 'never', '--label', `astracalls.purpose=${purpose}`, '--network', 'host',
    '--tmpfs', '/audit-data:rw,nosuid,nodev,size=128m',
    '-e', 'WACALLS_PG_URL=postgres://astracalls_test:completion-test-only@127.0.0.1:15433/astracalls_restaurant_test?sslmode=disable',
    '-e', `WACALLS_PG_NAMESPACE=${namespace}`, '-e', `WACALLS_API_KEY=${apiKey}`, '-e', 'WACALLS_RECORDING_DIR=/audit-data'];
  if (kind === 'legacy') {
    args.push(legacyImage, '-addr', '127.0.0.1:18084', '-static', '/app/client/dist');
  } else {
    args.push('--mount', `type=bind,source=${root},target=/src,readonly`, '-e', 'LD_LIBRARY_PATH=/src/native',
      '-e', 'RESTAURANT_GEOGRAPHY_DATA_DIR=/src/data/saudi-geography', '-w', '/src',
      'golang:1.26.9', '/src/bin/iteration-audit-server', '-addr', '127.0.0.1:18084', '-static', '/src/client/dist');
  }
  run(args);
  ownsApp = true;
  await ready();
}

const fingerprint = () => Object.fromEntries(tables.map(table => [table, sql(`SELECT md5(COALESCE(jsonb_agg(row_data ORDER BY row_data::text)::text,'[]')) FROM (SELECT to_jsonb(t) AS row_data FROM ${table} t) rows`)]));
// Compare all legacy fields, allowing additive defaults in newer API responses.
function project(actual, expected) {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual)); assert.equal(actual.length, expected.length);
    return expected.map((value, index) => project(actual[index], value));
  }
  if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object');
    return Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, project(actual[key], value)]));
  }
  return actual;
}

let baseline, receipts = [];
async function snapshot() {
  const [catalog, publicCatalog, brand, stock, orders] = await Promise.all([
    api('/api/restaurant/catalog'), api('/storefront-api/catalog', 'GET', undefined, false),
    api('/api/restaurant/brand'), api('/api/restaurant/stock'),
    api('/api/restaurant/orders').then(result => result.orders.sort((a, b) => a.number.localeCompare(b.number))),
  ]);
  return { catalog, publicCatalog, brand, stock, orders };
}

async function preserved(stage, current = false) {
  const state = await snapshot();
  assert.deepEqual(project(state, baseline.api), baseline.api, `${stage}: legacy API fields changed`);
  assert.deepEqual(fingerprint(), baseline.fingerprints, `${stage}: persisted legacy rows changed`);
  check(state.stock.items.find(item => item.itemId === 'iteration_upgrade_dish').available === 8, `${stage}: available stock preserved`);
  check(state.stock.items.find(item => item.itemId === 'iteration_upgrade_dish').held === 2, `${stage}: outstanding reservations preserved`);
  check(sql("SELECT COALESCE(sum(quantity),0) FROM restaurant_stock_reservations WHERE item_id='iteration_upgrade_dish' AND state='committed'") === '2', `${stage}: committed stock preserved`);
  check(sql('SELECT count(*) FROM restaurant_payment_attempts') === '0', `${stage}: no gateway payment attempts created`);
  const unpaid = state.orders.find(order => order.payment.method === 'cash_before');
  const refusal = await api(`/api/restaurant/orders/${unpaid.number}`, 'PATCH', { status: 'preparing', version: unpaid.version }, true, {}, 409);
  check(refusal.error === 'payment_required', `${stage}: unpaid cash-before preparation stays blocked`);
  assert.deepEqual(fingerprint(), baseline.fingerprints, `${stage}: rejected transition changed storage`);
  if (current) {
    check((state.catalog.settings.deliveryPricingMode || 'flat') === 'flat', `${stage}: absent district mode remains flat`);
    check(state.brand.live.storefrontTemplate === 'classic', `${stage}: legacy brand uses classic structural template`);
    for (const role of ['headingFont', 'bodyFont', 'buttonFont']) {
      check((state.brand.live[role] || state.brand.live.font) === 'serif', `${stage}: ${role} inherits legacy serif font`);
      check((state.brand.draft[role] || state.brand.draft.font) === 'system', `${stage}: draft ${role} inherits its own legacy font`);
    }
  }
  check(state.publicCatalog.settings.brand.introTitle === 'Published legacy identity', `${stage}: unpublished draft remains private`);
  stages.push({ stage, fingerprint: hash(JSON.stringify(fingerprint())), catalogVersion: state.catalog.version, orderCount: state.orders.length });
}

try {
  assert.equal(process.cwd(), root, 'Run from the development workspace');
  assert.equal(run(['inspect', '--format', '{{index .Config.Labels "astracalls.purpose"}}', postgres]), 'completion-isolated-test');
  const ports = JSON.parse(run(['inspect', '--format', '{{json .NetworkSettings.Ports}}', postgres]));
  assert.ok(ports['5432/tcp'].some(port => port.HostIp === '127.0.0.1' && port.HostPort === '15433'));
  assert.equal(sql(`SELECT count(*) FROM pg_database WHERE datname LIKE '${namespace}%'`, 'postgres'), resume ? '1' : '0', 'Fresh namespace required unless explicitly resuming the existing synthetic fixture');
  assert.equal(run(['ps', '-a', '--filter', `name=^/${app}$`, '--format', '{{.Names}}']), '', 'Test application name must be unused');
  const oldImageId = run(['image', 'inspect', legacyImage, '--format', '{{.Id}}']);
  await start('legacy');
  let catalog = await api('/api/restaurant/catalog');
  if (resume) {
    check(catalog.settings.name === 'Synthetic legacy upgrade restaurant' && catalog.items.length === 1 && catalog.items[0].id === 'iteration_upgrade_dish', 'Resume targets only this helper’s synthetic fixture');
    check(sql('SELECT count(*) FROM restaurant_orders') === '4', 'Resume retains exactly four original synthetic orders');
    check(sql("SELECT count(*) FROM restaurant_orders WHERE document->>'notes' = 'ISOLATED QA: no real food, customers, cash or financial transfer.'") === '4', 'Every resumed order belongs to the isolated fixture');
  } else {
  catalog = await api('/api/restaurant/catalog', 'PUT', {
    ...catalog,
    settings: { ...catalog.settings, name: 'Synthetic legacy upgrade restaurant', demo: true, acceptingOrders: true,
      country: 'SA', currency: 'SAR', deliveryEnabled: true, tableEnabled: true, pickupEnabled: false,
      deliveryFeeMinor: 750, deliveryMinimumMinor: 0, deliveryAreas: [], deliveryRadiusKm: 0, requireDeliveryLocation: false,
      taxEnabled: true, taxRateBps: 1500, taxNumber: '300000000000003',
      paymentMethods: { delivery: ['cash_on_delivery'], table: ['cash_before', 'cash_after'], pickup: ['card'] } },
    categories: [{ id: 'iteration_upgrade_category', name: 'Synthetic legacy menu', sort: 0 }],
    items: [{ id: 'iteration_upgrade_dish', categoryId: 'iteration_upgrade_category', name: 'طبق اختبار قديم', description: 'Synthetic fixture: no real order', priceMinor: 2300, imageUrl: '', available: true, sort: 0, options: [] }],
    tables: [{ id: 'iteration_upgrade_table', name: 'Synthetic legacy table', code: '', active: true }],
  });
  await api('/api/restaurant/stock/iteration_upgrade_dish', 'PUT', { tracked: true, available: 12, version: 0 });
  let brand = await api('/api/restaurant/brand');
  brand = await api('/api/restaurant/brand/draft', 'PUT', { version: brand.version, brand: { ...brand.live, font: 'serif', layout: 'list', introTitle: 'Published legacy identity', introText: 'Merchant-owned legacy text' } });
  brand = await api('/api/restaurant/brand/publish', 'POST', { version: brand.version });
  await api('/api/restaurant/brand/draft', 'PUT', { version: brand.version, brand: { ...brand.live, font: 'system', introTitle: 'PRIVATE unpublished legacy draft' } });
  check(!Object.hasOwn(brand.live, 'headingFont') && !Object.hasOwn(brand.live, 'storefrontTemplate'), 'Fixture is genuinely from the legacy API without new presentation fields');
  async function order(method, quantity = 1) {
    const mode = method === 'cash_on_delivery' ? 'delivery' : 'table';
    const input = { mode, paymentMethod: method, customerName: `Synthetic ${method}`, phone: mode === 'delivery' ? '+966500000000' : '',
      address: mode === 'delivery' ? { country: 'SA', city: 'الرياض', district: 'حي اختباري', nationalAddress: 'TEST1234' } : {},
      tableCode: mode === 'table' ? catalog.tables[0].code : '',
      items: [{ itemId: 'iteration_upgrade_dish', quantity, optionIds: [] }],
      notes: 'ISOLATED QA: no real food, customers, cash or financial transfer.' };
    const quote = await api('/storefront-api/quote', 'POST', input, false);
    const receipt = await api('/storefront-api/orders', 'POST', { ...input, expectedTotalMinor: quote.totalMinor }, false, { 'Idempotency-Key': randomUUID() }, 201);
    receipts.push(receipt); return receipt.order;
  }
  await order('cash_on_delivery', 2);
  let before = await order('cash_before');
  before = await api(`/api/restaurant/orders/${before.number}`, 'PATCH', { status: 'accepted', version: before.version });
  let paid = await order('cash_after');
  // Records synthetic cash in this isolated ledger; no provider route is called.
  paid = await api(`/api/restaurant/orders/${paid.number}/cash`, 'POST', { version: paid.version });
  check(paid.payment.status === 'paid', 'Synthetic legacy cash ledger contains a paid record');
  for (const status of ['accepted', 'preparing']) paid = await api(`/api/restaurant/orders/${paid.number}`, 'PATCH', { status, version: paid.version });
  let cancelled = await order('cash_after');
  cancelled = await api(`/api/restaurant/orders/${cancelled.number}`, 'PATCH', { status: 'cancelled', version: cancelled.version });
  check(cancelled.status === 'cancelled', 'Legacy cancelled order and released reservation retained');
  }
  check(sql('SELECT count(*) FROM restaurant_payment_attempts') === '0', 'No gateway payment attempts created');
  baseline = { api: await snapshot(), fingerprints: fingerprint() };
  await preserved('legacy baseline');
  console.log(JSON.stringify({ stage: 'legacy-seeded', namespace, checks: checks.length, orderCount: baseline.api.orders.length }));
  removeOwnApp();
  if (process.argv.includes('--pause-before-upgrade')) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    await input.question('Legacy fixture is retained. Press Enter once the current audit binary is rebuilt: ');
    input.close();
  }
  const currentBinarySHA256 = hash(readFileSync(`${root}/bin/iteration-audit-server`));
  await start('current');
  await preserved('upgraded current binary', true);
  run(['restart', '--time', '5', app]);
  await ready();
  await preserved('current binary restarted', true);
  removeOwnApp();
  await start('legacy');
  await preserved('rolled back legacy image');
  console.log(JSON.stringify({ ok: true, startedAt, completedAt: new Date().toISOString(), namespace, database, oldImageId, currentBinarySHA256,
    verifiedTables: tables, stages, checks, noGatewayCalls: true,
    syntheticCashOnly: true, productionTouched: false, evidenceRetainedInTestDatabase: true,
    limitations: ['Checks pre-existing legacy data through upgrade and rollback; does not downgrade newly authored district fees, font choices or reopened-order history.', 'No external providers or real financial transactions exercised.'] }, null, 2));
} finally {
  removeOwnApp();
}
