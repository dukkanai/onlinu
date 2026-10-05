// REAL public staging acceptance. Run only after deployment owner confirms ready:
//   node integration/staging-live-check.mjs --run-live
// Uses four authorized synthetic Dex accounts, creates two synthetic orders,
// toggles then restores one synthetic channel setting, and revokes all sessions.
// No screenshots, HAR, traces, cookie export, credentials or raw errors in output.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';

const base = 'https://almujeeb.info';
const credentialsPath = '/home/chatbot/.local/share/almujeeb-staging/testers.json';
const identities = ['customer-alice', 'customer-bob', 'merchant-a', 'merchant-b'];
let stage = 'not_started';
let assertions = 0;
class AcceptanceFailure extends Error {}
const check = (condition, label) => { if (!condition) throw new AcceptanceFailure(label); assertions++; };
const exact = (left, right, label) => check(left === right, label);
const denied = (status, label) => check(status === 403 || status === 404, label);

async function runLive() {
  if (!process.argv.includes('--run-live')) {
    console.log(JSON.stringify({ status: 'not_run', reason: 'Requires --run-live after deployment owner explicitly announces public readiness. No network or credentials accessed.' }));
    return;
  }
  stage = 'validate_authorized_synthetic_accounts';
  const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
  check(credentials.syntheticOnly === true && Array.isArray(credentials.testers), 'synthetic_credentials_required');
  check(new URL(credentials.loginUrl).origin === base, 'unexpected_login_origin');
  const accounts = new Map(credentials.testers.map(value => [value.identity, value]));
  for (const identity of identities) {
    const entry = accounts.get(identity);
    check(entry && typeof entry.email === 'string' && entry.email.length > 0 && typeof entry.password === 'string' && entry.password.length >= 12, 'four_complete_authorized_accounts_required');
  }

  stage = 'verify_public_synthetic_health';
  const healthResponse = await fetch(`${base}/health`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  exact(healthResponse.status, 200, 'public_health_unavailable');
  const health = await healthResponse.json();
  check(health.mode === 'synthetic' && health.authMode === 'oidc' && health.paymentMode === 'local-simulator', 'refuse_non_synthetic_or_non_simulator_environment');

  let browser;
  let watchdog;
  const sessions = new Map();
  const cleanup = [];
  let createdOrders = 0;
  let channelRestored = false;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'] });
    watchdog = setTimeout(() => {
      stage = `timeout_${stage}`;
      void browser.close();
    }, 120000);
    watchdog.unref();

    async function api(actor, path, body, options = {}) {
      check(path.startsWith('/api/') || path === '/auth/logout' || path === '/dev/session', 'unexpected_test_api_path');
      const mutation = body !== undefined;
      const headers = { ...(mutation ? { Origin: base, 'X-CSRF-Token': actor.csrf } : {}), ...options.headers };
      if (options.omitCsrf) delete headers['X-CSRF-Token'];
      const response = await actor.context.request.fetch(`${base}${path}`, {
        method: mutation ? 'POST' : 'GET', headers,
        ...(mutation ? { data: body } : {}), maxRedirects: 0, timeout: 10000
      });
      let value = null;
      if (response.headers()['content-type']?.includes('application/json')) value = await response.json();
      return { status: response.status(), value };
    }

    async function authenticate(identity) {
      stage = `verified_login_${identity}`;
      const account = accounts.get(identity);
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ar-SA' });
      // Dex is mounted on the SAME apex /identity; deny any unrelated origin.
      let blockedNavigation = false;
      await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === base) return route.continue();
        blockedNavigation = true;
        return route.abort();
      });
      const page = await context.newPage(); page.setDefaultTimeout(10000);
      const actor = { identity, context, page, csrf: null, principal: null, cookie: null, loggedOut: false };
      sessions.set(identity, actor);
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.locator('#sign-in').click();
      await page.waitForFunction(() => document.querySelector('input[type="password"]') || document.querySelector('a[href*="/auth/local"]'));
      if (await page.locator('input[type="password"]').count() === 0) await page.locator('a[href*="/auth/local"]').first().click();
      const email = page.locator('input[name="login"],input[name="email"],input[type="email"]').first();
      const password = page.locator('input[type="password"]').first();
      await email.fill(account.email);
      await password.fill(account.password);
      await page.locator('form button[type="submit"],form input[type="submit"],#submit-login').first().click();
      await page.waitForFunction(() => location.pathname === '/' || document.querySelector('#submit-approval') || [...document.querySelectorAll('button')].some(button => /grant access|approve|allow/i.test(button.textContent)), null, { timeout: 15000 });
      if (new URL(page.url()).pathname !== '/') {
        const approval = page.locator('#submit-approval');
        if (await approval.count()) await approval.click();
        else await page.getByRole('button', { name: /grant access|approve|allow/i }).first().click();
      }
      await page.waitForURL(url => url.origin === base && url.pathname === '/', { timeout: 15000 });
      await page.locator('#logout').waitFor({ state: 'visible' });
      check(!blockedNavigation, 'login_attempted_unrelated_origin');
      const sessionResponse = await api(actor, '/api/session');
      exact(sessionResponse.status, 200, 'verified_browser_session_missing');
      const session = sessionResponse.value;
      check(session.authMode === 'oidc' && session.principal?.id === identity && typeof session.csrfToken === 'string' && session.csrfToken.length >= 32, 'verified_session_identity_or_csrf_mismatch');
      check(!Object.hasOwn(session, 'accessToken') && !Object.hasOwn(session, 'refreshToken'), 'browser_api_must_not_return_bearer_tokens');
      actor.csrf = session.csrfToken; actor.principal = session.principal;
      const cookies = await context.cookies(base);
      const cookie = cookies.find(value => value.name === '__Host-restaurant_session');
      check(cookie?.httpOnly === true && cookie.secure === true && cookie.sameSite === 'Lax' && cookie.path === '/' && cookie.domain === 'almujeeb.info' && cookie.expires > Date.now() / 1000, 'session_cookie_security_attributes');
      actor.cookie = `${cookie.name}=${cookie.value}`;
      check(await page.evaluate(() => !document.cookie.includes('__Host-restaurant_session=')), 'session_cookie_visible_to_javascript');
      check(await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0), 'staging_must_not_persist_tokens_in_browser_storage');
      return actor;
    }

    const alice = await authenticate('customer-alice');
    const bob = await authenticate('customer-bob');
    const merchantA = await authenticate('merchant-a');
    const merchantB = await authenticate('merchant-b');
    check(merchantA.principal.tenantIds.length === 1 && merchantA.principal.tenantIds[0] === 'demo-a' && merchantB.principal.tenantIds.length === 1 && merchantB.principal.tenantIds[0] === 'demo-b', 'merchant_membership_binding');

    stage = 'public_auth_and_csrf_boundaries';
    exact((await api(alice, '/dev/session', { identity: 'merchant-a' })).status, 404, 'public_development_login_must_be_disabled');
    exact((await api(alice, '/api/restaurants/demo-a/quote', { items: [{ itemId: 'unused-test-id', quantity: 1 }] }, { omitCsrf: true })).status, 403, 'browser_write_without_csrf_must_fail');
    exact((await api(alice, '/auth/logout', {}, { headers: { Origin: 'https://unrelated.invalid' } })).status, 403, 'cross_origin_logout_must_fail');
    exact((await api(alice, '/api/session')).status, 200, 'rejected_logout_must_not_revoke_session');

    stage = 'customer_browser_checkout_local_simulation';
    const menuA = await api(alice, '/api/restaurants/demo-a/menu');
    exact(menuA.status, 200, 'customer_menu_access');
    const dishA = menuA.value.items.find(item => item.stock > 0);
    check(dishA && /^[A-Za-z0-9_-]+$/.test(dishA.id), 'synthetic_menu_stock_required');
    await alice.page.locator('[data-tenant="demo-a"]').getByRole('button', { name: 'استعراض المنيو', exact: true }).click();
    await alice.page.locator(`input[data-item="${dishA.id}"]`).fill('1');
    await alice.page.locator('#quote').click();
    await alice.page.locator('#checkout').click();
    await alice.page.waitForURL(url => /^\/checkout\/[a-f0-9-]{36}$/.test(url.pathname));
    const checkoutA = new URL(alice.page.url()).pathname.split('/')[2];
    const confirmationResponse = alice.page.waitForResponse(response => new URL(response.url()).pathname === `/api/checkouts/${checkoutA}/confirm`);
    await alice.page.locator('#confirm').click();
    const confirmation = await confirmationResponse;
    exact(confirmation.status(), 200, 'browser_confirm_failed');
    const confirmed = await confirmation.json();
    check(confirmed.paymentMode === 'local-simulator' && confirmed.order.tenantId === 'demo-a' && confirmed.order.totalMinor === dishA.priceMinor, 'server_pricing_and_simulator_binding');
    createdOrders++;
    const aliceOrder = confirmed.order;
    check(typeof confirmed.simulationUrl === 'string' && confirmed.simulationUrl === `/api/restaurants/demo-a/orders/${aliceOrder.id}/simulate-payment`, 'expected_local_simulator_only');
    const paymentResponse = alice.page.waitForResponse(response => new URL(response.url()).pathname === confirmed.simulationUrl);
    await alice.page.locator('#payment button').click();
    const simulated = await paymentResponse;
    exact(simulated.status(), 200, 'local_simulator_failed');
    const paidA = await simulated.json();
    check(paidA.status === 'accepted' && paidA.paymentStatus === 'paid', 'local_simulation_did_not_settle_synthetic_order');
    await alice.page.waitForFunction(() => document.querySelector('#payment button')?.disabled && document.querySelector('#payment p')?.textContent.includes('الإصدار'));
    check(await alice.page.locator('#confirm').isDisabled() && await alice.page.locator('#payment button').isDisabled(), 'settled_browser_actions_remain_disabled');
    const replay = await api(alice, confirmed.simulationUrl, {});
    check(replay.status === 200 && replay.value.version === paidA.version, 'synthetic_payment_replay_must_be_idempotent');

    stage = 'second_customer_order_and_ownership';
    const menuB = await api(bob, '/api/restaurants/demo-b/menu');
    exact(menuB.status, 200, 'second_customer_menu_access');
    const dishB = menuB.value.items.find(item => item.stock > 0);
    check(Boolean(dishB), 'second_synthetic_menu_stock_required');
    const itemsB = [{ itemId: dishB.id, quantity: 1 }];
    const quoteB = await api(bob, '/api/restaurants/demo-b/quote', { items: itemsB });
    exact(quoteB.status, 200, 'second_customer_quote');
    const preparedB = await api(bob, '/api/restaurants/demo-b/checkouts', { items: itemsB, expectedTotalMinor: quoteB.value.totalMinor, idempotencyKey: randomUUID() });
    exact(preparedB.status, 201, 'second_customer_checkout_created');
    const checkoutB = preparedB.value.checkoutId;
    const confirmedB = await api(bob, `/api/checkouts/${checkoutB}/confirm`, {});
    exact(confirmedB.status, 200, 'second_customer_confirmation');
    check(confirmedB.value.paymentMode === 'local-simulator', 'second_order_must_use_local_simulation');
    createdOrders++;
    const bobOrder = confirmedB.value.order;
    const paidB = await api(bob, `/api/restaurants/demo-b/orders/${bobOrder.id}/simulate-payment`, {});
    check(paidB.status === 200 && paidB.value.paymentStatus === 'paid', 'second_customer_synthetic_payment');
    exact((await api(alice, `/api/restaurants/demo-a/orders/${aliceOrder.id}`)).status, 200, 'customer_owns_own_order');
    exact((await api(bob, `/api/restaurants/demo-b/orders/${bobOrder.id}`)).status, 200, 'second_customer_owns_own_order');
    exact((await api(bob, `/api/restaurants/demo-a/orders/${aliceOrder.id}`)).status, 404, 'cross_customer_order_must_be_hidden');
    exact((await api(alice, `/api/restaurants/demo-b/orders/${bobOrder.id}`)).status, 404, 'reverse_cross_customer_order_must_be_hidden');
    exact((await api(bob, `/api/checkouts/${checkoutA}`)).status, 404, 'cross_customer_checkout_must_be_hidden');
    denied((await api(alice, '/api/merchant/restaurants/demo-a/orders')).status, 'customer_must_not_read_merchant_orders');

    stage = 'merchant_membership_and_order_transitions';
    const ownA = await api(merchantA, '/api/merchant/restaurants/demo-a/orders');
    const ownB = await api(merchantB, '/api/merchant/restaurants/demo-b/orders');
    check(ownA.status === 200 && ownA.value.orders.some(value => value.id === aliceOrder.id), 'first_merchant_owns_test_order');
    check(ownB.status === 200 && ownB.value.orders.some(value => value.id === bobOrder.id), 'second_merchant_owns_test_order');
    exact((await api(merchantA, '/api/merchant/restaurants/demo-b/orders')).status, 403, 'cross_merchant_order_list_forbidden');
    exact((await api(merchantB, '/api/merchant/restaurants/demo-a/orders')).status, 403, 'reverse_cross_merchant_order_list_forbidden');
    exact((await api(merchantB, `/api/merchant/restaurants/demo-a/orders/${aliceOrder.id}/status`, { status: 'preparing', expectedVersion: paidA.version })).status, 403, 'cross_merchant_status_change_forbidden');
    for (const [actor, tenantId, original] of [[merchantA, 'demo-a', paidA], [merchantB, 'demo-b', paidB.value]]) {
      let current = original;
      for (const status of ['preparing', 'ready', 'completed']) {
        const result = await api(actor, `/api/merchant/restaurants/${tenantId}/orders/${current.id}/status`, { status, expectedVersion: current.version });
        check(result.status === 200 && result.value.status === status && result.value.version > current.version, 'authorized_versioned_order_transition');
        current = result.value;
      }
    }

    stage = 'versioned_channel_configuration_and_restore';
    const initial = await api(merchantA, '/api/merchant/restaurants/demo-a/channels');
    exact(initial.status, 200, 'owner_channel_read');
    check(initial.value.scope === 'synthetic_configuration_only' && initial.value.whatsapp.configured === false && initial.value.whatsapp.operational === false, 'channel_status_must_not_claim_live_whatsapp');
    exact((await api(merchantB, '/api/merchant/restaurants/demo-a/channels')).status, 403, 'cross_tenant_channel_read_forbidden');
    denied((await api(alice, '/api/merchant/restaurants/demo-a/channels')).status, 'customer_channel_read_forbidden');
    const payload = { enabled: !initial.value.whatsapp.enabled, connectionMode: initial.value.whatsapp.connectionMode === 'qr' ? 'cloud_api' : 'qr', expectedVersion: initial.value.version };
    exact((await api(merchantB, '/api/merchant/restaurants/demo-a/channels', payload)).status, 403, 'cross_tenant_channel_write_forbidden');
    const changed = await api(merchantA, '/api/merchant/restaurants/demo-a/channels', payload);
    check(changed.status === 200 && changed.value.version === initial.value.version + 1 && changed.value.whatsapp.enabled === payload.enabled && changed.value.whatsapp.connectionMode === payload.connectionMode, 'owner_versioned_channel_update');
    let restored = false;
    const restore = async () => {
      if (restored) return;
      const current = await api(merchantA, '/api/merchant/restaurants/demo-a/channels');
      check(current.status === 200 && current.value.version === changed.value.version && current.value.whatsapp.enabled === payload.enabled && current.value.whatsapp.connectionMode === payload.connectionMode, 'channel_restore_conflict_requires_review');
      const result = await api(merchantA, '/api/merchant/restaurants/demo-a/channels', { enabled: initial.value.whatsapp.enabled, connectionMode: initial.value.whatsapp.connectionMode, expectedVersion: current.value.version });
      check(result.status === 200 && result.value.whatsapp.enabled === initial.value.whatsapp.enabled && result.value.whatsapp.connectionMode === initial.value.whatsapp.connectionMode, 'restore_original_synthetic_channel_values');
      restored = true; channelRestored = true;
    };
    cleanup.push(restore);
    exact((await api(merchantA, '/api/merchant/restaurants/demo-a/channels', payload)).status, 409, 'stale_channel_version_must_conflict');
    await restore();
    await merchantA.page.locator('#home').click();
    await merchantA.page.locator('[data-channels="demo-a"]').waitFor();
    check((await merchantA.page.locator('[data-channels="demo-a"]').textContent()).includes('الربط بخدمة واتساب الأصلية لم يُفعّل'), 'public_ui_retains_honest_channel_warning');

    stage = 'logout_and_server_side_revocation';
    for (const actor of sessions.values()) {
      const response = await api(actor, '/auth/logout', {});
      exact(response.status, 200, 'verified_browser_logout');
      actor.loggedOut = true;
      exact((await api(actor, '/api/session')).status, 401, 'logged_out_browser_session_rejected');
      const replay = await api(actor, '/api/session', undefined, { headers: { Cookie: actor.cookie } });
      exact(replay.status, 401, 'revoked_cookie_replay_must_fail');
      actor.csrf = null; actor.cookie = null;
    }
    console.log(JSON.stringify({ status: 'passed', assertions, verifiedLogins: 4, syntheticOrdersCreatedAndCompleted: createdOrders, channelConfigurationRestored: channelRestored, scope: 'Actual public HTTPS and Dex logins; synthetic restaurant records and LOCAL payment simulator only. No real WhatsApp, real PSP, or actual ChatGPT host acceptance.', secretsWritten: false }));
  } finally {
    clearTimeout(watchdog);
    // Best-effort restore only our exact version, never overwrite concurrent edits.
    for (const restore of cleanup) await restore().catch(() => { process.exitCode = 1; });
    for (const actor of sessions.values()) {
      if (!actor.loggedOut && actor.csrf) {
        await actor.context.request.post(`${base}/auth/logout`, { headers: { Origin: base, 'X-CSRF-Token': actor.csrf }, data: {}, maxRedirects: 0, timeout: 5000 }).catch(() => {});
      }
      actor.csrf = null; actor.cookie = null;
      await actor.context.close().catch(() => {});
    }
    if (browser) await browser.close().catch(() => {});
    for (const account of accounts.values()) account.password = '';
  }
}

await runLive().catch(error => {
  process.exitCode = 1;
  // Never print Playwright call logs: they can include filled passwords, OAuth
  // redirect URLs, cookie headers, CSRF values or server response bodies.
  console.error(JSON.stringify({ status: 'failed', stage, assertions, reason: error instanceof AcceptanceFailure ? error.message : 'browser_or_network_failure_details_suppressed', secretsWritten: false }));
});
