// Explicitly opt-in acceptance against the synthetic, protected staging origin.
// Exercises real HTTPS + Dex login + OAuth/MCP. ChatGPT's callback is intercepted
// before networking: this is NOT an actual ChatGPT account integration test.
// No screenshots, traces, storageState, tokens, passwords, or request URLs saved.
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const BASE = 'https://almujeeb.info';
const RESOURCE = `${BASE}/mcp`;
const CHATGPT_CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect';
const TESTERS_FILE = '/home/chatbot/.local/share/almujeeb-staging/testers.json';
const PROTOCOL = '2026-07-28';

if (process.argv.length !== 3 || process.argv[2] !== '--run-live') {
  console.log(JSON.stringify({ status: 'not_run', reason: 'Explicit --run-live is required. No network or credentials accessed.' }));
} else {
  await runLive();
}

async function runLive() {
  const checks = [];
  const tokens = new Set();
  let browser;
  let context;
  let cdp;
  let page;
  let phase = 'synthetic_health_gate';
  let failed = false;
  let cleanupFailed = false;
  let nextId = 0;
  let callbackSink;
  let callbackReject;
  let capturedCallbacks = 0;
  let blockedExternalRequests = 0;
  let browserErrors = 0;
  let interceptionFailed = false;
  let cspBlockedForm = false;
  const consentPosts = [];
  const callbackSecurity = [];
  let assertions = 0;
  const check = condition => { assertions++; if (!condition) throw new Error('acceptance_failed'); };
  const passed = name => checks.push({ name, status: 'passed' });

  async function api(path, { method = 'GET', token, json, form } = {}) {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('unsafe_api_target');
    const target = new URL(path, BASE);
    if (target.origin !== BASE) throw new Error('unsafe_api_target');
    const response = await fetch(target, {
      method, redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(json === undefined ? {} : { 'content-type': 'application/json' }),
        ...(form === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
      },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      ...(form === undefined ? {} : { body: new URLSearchParams(form).toString() }),
    });
    const text = await response.text();
    const body = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null;
    return { status: response.status, headers: response.headers, body, text };
  }

  async function rpc(method, params = {}, token) {
    const response = await fetch(RESOURCE, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL, 'Mcp-Method': method,
        ...(params.name || params.uri ? { 'Mcp-Name': params.name ?? params.uri } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params: { ...params, _meta: {
        'io.modelcontextprotocol/protocolVersion': PROTOCOL,
        'io.modelcontextprotocol/clientInfo': { name: 'staging-live-acceptance', version: '0.1.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } } }),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: JSON.parse(text), text };
  }

  const tool = (name, args = {}, token) => rpc('tools/call', { name, arguments: args }, token);
  function success(response) {
    check(response.status === 200 && !response.body.error && !response.body.result?.isError);
    return response.body.result.structuredContent;
  }
  function challenge(response, scope, error = 'invalid_token') {
    check(response.status === 200 && response.body.result?.resultType === 'complete' && response.body.result.isError === true);
    check(response.body.result.structuredContent === undefined);
    const challenges = response.body.result._meta?.['mcp/www_authenticate'];
    check(Array.isArray(challenges) && challenges.length === 1);
    check(challenges[0].startsWith(`Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`));
    check(challenges[0].includes(`scope="${scope}"`) && challenges[0].includes(`error="${error}"`) && /error_description="[^"]+"/.test(challenges[0]));
  }
  function minimized(response) {
    check(!/"(?:ownerId|principal_id|phone|email|address|accessToken|access_token|secret|token_hash)"/.test(response.text));
    check(!/customer-(?:alice|bob)|merchant-[ab]|postgres(?:ql)?:\/\//.test(response.text));
  }

  async function grant(clientId, tester, scope) {
    const flow = scope === 'orders:read' ? 'read_grant' : 'full_grant';
    const verifier = randomBytes(48).toString('base64url');
    const state = randomBytes(24).toString('base64url');
    const query = new URLSearchParams({
      client_id: clientId, redirect_uri: CHATGPT_CALLBACK, response_type: 'code', resource: RESOURCE,
      scope, state, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    });
    phase = `${flow}_browser_navigation`;
    await page.goto(`${BASE}/oauth/authorize?${query}`, { waitUntil: 'domcontentloaded' });
    if (new URL(page.url()).pathname.startsWith('/identity/')) {
      phase = `${flow}_dex_login`;
      await page.waitForFunction(() => document.querySelector('input[type="password"]') || document.querySelector('a[href*="/auth/local"]'));
      if (await page.locator('input[type="password"]').count() === 0) await page.locator('a[href*="/auth/local"]').first().click();
      const password = page.locator('input[type="password"]');
      await password.waitFor({ state: 'visible' });
      await page.locator('input[name="login"], input[name="email"], input[type="email"]').first().fill(tester.email);
      await password.fill(tester.password);
      await page.locator('form button[type="submit"], form input[type="submit"], #submit-login').first().click();
      await page.waitForFunction(() => location.pathname === '/oauth/authorize' || document.querySelector('#submit-approval') || [...document.querySelectorAll('button')].some(button => /grant access|approve|allow/i.test(button.textContent)));
      if (new URL(page.url()).pathname.startsWith('/identity/')) {
        const approval = page.locator('#submit-approval');
        if (await approval.count()) await approval.click();
        else await page.getByRole('button', { name: /grant access|approve|allow/i }).first().click();
      }
    }
    const allow = page.locator('form[action="/oauth/authorize"] button[name="decision"][value="allow"]');
    phase = `${flow}_consent_dom`;
    await allow.waitFor({ state: 'visible' });
    check(new URL(page.url()).origin === BASE && new URL(page.url()).pathname === '/oauth/authorize');
    check(await page.locator('select[name="identity"], input[name="identity"]').count() === 0);
    check((await page.locator('main').textContent()).includes('customer-bob'));
    check((await page.locator('main pre').textContent()).trim() === scope);
    let timeout;
    const callback = new Promise((resolve, reject) => {
      callbackSink = resolve;
      callbackReject = reject;
      timeout = setTimeout(() => reject(new Error('callback_not_intercepted')), 15_000);
    });
    let location;
    try {
      phase = `${flow}_consent_callback`;
      [, location] = await Promise.all([allow.click(), callback]);
    } finally {
      clearTimeout(timeout);
      callbackSink = undefined;
      callbackReject = undefined;
    }
    check(location.origin + location.pathname === CHATGPT_CALLBACK);
    check(location.searchParams.get('state') === state && location.searchParams.get('iss') === BASE);
    check(!location.searchParams.has('error'));
    const code = location.searchParams.get('code');
    check(typeof code === 'string' && /^[A-Za-z0-9_-]{43}$/.test(code));
    const request = { grant_type: 'authorization_code', client_id: clientId, redirect_uri: CHATGPT_CALLBACK, resource: RESOURCE, code, code_verifier: verifier };
    phase = `${flow}_code_exchange`;
    const wrongResource = await api('/oauth/token', { method: 'POST', form: { ...request, resource: `${BASE}/wrong-resource` } });
    check(wrongResource.status === 400);
    const wrongVerifier = await api('/oauth/token', { method: 'POST', form: { ...request, code_verifier: randomBytes(48).toString('base64url') } });
    check(wrongVerifier.status === 400);
    const exchange = await api('/oauth/token', { method: 'POST', form: request });
    check(exchange.status === 200 && exchange.body.token_type === 'Bearer' && exchange.body.resource === RESOURCE && exchange.body.scope === scope);
    const token = exchange.body.access_token;
    check(typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token));
    tokens.add(token);
    const replay = await api('/oauth/token', { method: 'POST', form: request });
    check(replay.status === 400);
    return token;
  }

  try {
    const health = await api('/health');
    check(health.status === 200 && health.body.mode === 'synthetic' && health.body.authMode === 'oidc' && health.body.paymentMode === 'local-simulator');
    passed('real_https_synthetic_oidc_gate');

    phase = 'credential_and_browser_setup';
    const stored = JSON.parse(await readFile(TESTERS_FILE, 'utf8'));
    check(stored.syntheticOnly === true);
    const tester = stored.testers.find(item => item.identity === 'customer-bob');
    check(tester?.email?.endsWith('@staging.invalid') && typeof tester.password === 'string' && tester.password.length >= 12);
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-component-update',
      '--disable-domain-reliability', '--disable-sync', '--no-first-run', '--disable-default-apps', '--no-default-browser-check',
      '--disable-features=MediaRouter,OptimizationHints,Translate',
      // Fail closed even if an interception handler regresses. Only our staging
      // hostname may resolve in this browser; ChatGPT is deliberately denied.
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE almujeeb.info',
    ] });
    context = await browser.newContext({ locale: 'ar-SA', serviceWorkers: 'block' });
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
    // Browser routing helpers need not intercept every redirect hop. Pause at
    // the Chrome network Request stage, before DNS/network, including redirects.
    cdp.on('Fetch.requestPaused', async event => {
      try {
        const destination = new URL(event.request.url);
        if (destination.origin + destination.pathname === CHATGPT_CALLBACK && callbackSink) {
          const headers = Object.fromEntries(Object.entries(event.request.headers).map(([name, value]) => [name.toLowerCase(), value]));
          callbackSecurity.push({ isGet: event.request.method === 'GET', referrerAbsent: !headers.referer,
            authorizationAbsent: !headers.authorization, bodyAbsent: !event.request.postData,
            onlyOAuthCodeParameters: [...destination.searchParams.keys()].every(key => ['code', 'state', 'iss'].includes(key)) });
          capturedCallbacks++;
          await cdp.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' },
              { name: 'Content-Security-Policy', value: "default-src 'none'; img-src data:; form-action 'none'; base-uri 'none'" }],
            body: Buffer.from('<!doctype html><title>Local callback interception</title><link rel="icon" href="data:,"><p>Callback captured without contacting ChatGPT.</p>').toString('base64') });
          callbackSink(destination);
          return;
        }
        if (destination.origin !== BASE) {
          blockedExternalRequests++;
          await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
          return;
        }
        await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
      } catch {
        interceptionFailed = true;
        callbackReject?.(new Error('interception_failed'));
        try { await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }); } catch { /* Closing browser. */ }
      }
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(20_000);
    page.on('pageerror', () => { browserErrors++; });
    page.on('console', message => {
      const value = message.text();
      if (/form-action/.test(value) && /content security policy|refused|violates/i.test(value)) cspBlockedForm = true;
    });
    page.on('response', async response => {
      try {
        const url = new URL(response.url());
        if (url.origin === BASE && url.pathname === '/oauth/authorize' && response.request().method() === 'POST') {
          const policy = await response.headerValue('content-security-policy');
          const headers = await response.request().allHeaders();
          const observation = { status: response.status(), callbackAllowedByCsp: typeof policy === 'string' && policy.includes(CHATGPT_CALLBACK),
            exactOrigin: headers.origin === BASE, originNull: headers.origin === 'null', originAbsent: headers.origin === undefined,
            browserCookiePresent: /(?:^|;\s*)__Host-restaurant_session=/.test(headers.cookie ?? ''),
            csrfFieldPresent: new URLSearchParams(response.request().postData() ?? '').has('_csrf') };
          if (response.status() >= 400) {
            const data = await response.json().catch(() => null);
            observation.errorCode = typeof data?.error === 'string' && /^[a-z_]{1,64}$/.test(data.error) ? data.error : 'unclassified';
            consentPosts.push(observation);
            callbackReject?.(new Error('consent_rejected'));
          } else consentPosts.push(observation);
        }
      } catch { /* Diagnostics are deliberately bounded and do not expose URLs. */ }
    });

    phase = 'oauth_metadata_and_registration';
    const metadata = await api('/.well-known/oauth-protected-resource');
    check(metadata.body.resource === RESOURCE && JSON.stringify(metadata.body.authorization_servers) === JSON.stringify([BASE]));
    const serverMetadata = await api('/.well-known/oauth-authorization-server');
    check(serverMetadata.body.issuer === BASE && serverMetadata.body.authorization_response_iss_parameter_supported === true);
    check(serverMetadata.body.code_challenge_methods_supported.includes('S256'));
    check((await api('/oauth/register', { method: 'POST', json: { redirect_uris: ['https://unapproved.invalid/callback'] } })).status === 400);
    const registration = await api('/oauth/register', { method: 'POST', json: {
      redirect_uris: [CHATGPT_CALLBACK], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'],
    } });
    check(registration.status === 201 && typeof registration.body.client_id === 'string');
    const clientId = registration.body.client_id;
    passed('oauth_metadata_and_exact_callback_registration');

    phase = 'real_dex_login_consent_and_full_grant';
    const fullToken = await grant(clientId, tester, 'orders:read orders:write events:read');
    passed('real_dex_login_consent_pkce_state_issuer_and_replay_protection');

    phase = 'mcp_discovery_and_auth_challenges';
    const discover = await rpc('server/discover');
    check(discover.status === 200 && JSON.stringify(discover.body.result.supportedVersions) === JSON.stringify([PROTOCOL]));
    check(discover.body.result.capabilities.events !== undefined);
    const listed = await rpc('tools/list');
    check(listed.status === 200 && listed.body.result.tools.length === 5);
    for (const descriptor of listed.body.result.tools) {
      check(descriptor.securitySchemes?.[0]?.type === 'oauth2');
      check(JSON.stringify(descriptor.securitySchemes) === JSON.stringify(descriptor._meta.securitySchemes));
    }
    challenge(await tool('search_restaurants'), 'orders:read');
    check((await rpc('events/list')).status === 401);
    const listedEvents = await rpc('events/list', {}, fullToken);
    check(listedEvents.status === 200 && listedEvents.body.result.events[0].name === 'order.status_changed');
    minimized(listedEvents);
    passed('actual_mcp2_top_level_security_metadata_and_auth_challenges');

    phase = 'authenticated_browsing_quote_and_checkout_without_order';
    const restaurants = await tool('search_restaurants', {}, fullToken);
    check(success(restaurants).restaurants.length === 2);
    minimized(restaurants);
    for (const [tenantId, price] of [['demo-a', 3000], ['demo-b', 4500]]) {
      const menu = await tool('get_restaurant_menu', { tenantId }, fullToken);
      check(success(menu).items.find(item => item.id === 'meal').priceMinor === price);
      minimized(menu);
    }
    const cart = { tenantId: 'demo-a', items: [{ itemId: 'drink', quantity: 1 }] };
    const quote = await tool('quote_cart', cart, fullToken);
    const total = success(quote).totalMinor;
    check(total === 500);
    minimized(quote);
    const checkoutArgs = { ...cart, expectedTotalMinor: total, idempotencyKey: `live-oauth-check-${randomUUID()}` };
    const checkoutResult = await tool('prepare_checkout', checkoutArgs, fullToken);
    const checkout = success(checkoutResult);
    check(checkout.checkoutUrl === `${BASE}/checkout/${checkout.checkoutId}`);
    minimized(checkoutResult);
    const storedCheckout = await api(`/api/checkouts/${checkout.checkoutId}`, { token: fullToken });
    check(storedCheckout.status === 200 && storedCheckout.body.orderId === null);
    check(success(await tool('prepare_checkout', checkoutArgs, fullToken)).checkoutId === checkout.checkoutId);
    passed('authenticated_two_tenant_browsing_quotes_and_idempotent_handoff_no_order');

    phase = 'narrow_scope_consent_and_permission_checks';
    const readToken = await grant(clientId, tester, 'orders:read');
    check(success(await tool('search_restaurants', {}, readToken)).restaurants.length === 2);
    challenge(await tool('prepare_checkout', checkoutArgs, readToken), 'orders:write', 'insufficient_scope');
    check((await rpc('events/list', {}, readToken)).status === 403);
    const { tenantId, ...checkoutBody } = checkoutArgs;
    check((await api(`/api/restaurants/${tenantId}/checkouts`, { method: 'POST', token: readToken, json: checkoutBody })).status === 403);
    // Never call confirm/payment endpoints here, even as a negative test: a
    // regression in their authorization must not create an order in this run.
    check((await api(`/api/checkouts/${checkout.checkoutId}`, { token: fullToken })).body.orderId === null);
    passed('narrowed_oauth_scope_blocks_mcp_rest_writes_and_events');

    phase = 'revocation_and_browser_logout';
    for (const token of [readToken, fullToken]) {
      check((await api('/oauth/revoke', { method: 'POST', form: { token } })).status === 200);
      tokens.delete(token);
      challenge(await tool('search_restaurants', {}, token), 'orders:read');
      check((await rpc('events/list', {}, token)).status === 401);
    }
    check(capturedCallbacks === 2 && blockedExternalRequests === 0 && browserErrors === 0 && !interceptionFailed);
    check(callbackSecurity.length === 2 && callbackSecurity.every(observation => Object.values(observation).every(value => value === true)));
    check(!cspBlockedForm && consentPosts.length === 2 && consentPosts.every(observation => observation.status === 302 && observation.callbackAllowedByCsp && observation.exactOrigin));
    passed('token_revocation_and_locally_intercepted_callbacks_no_chatgpt_network');
  } catch {
    // Playwright errors can contain authorization URLs/codes. Never print them.
    failed = true;
  } finally {
    for (const token of tokens) {
      try { if ((await api('/oauth/revoke', { method: 'POST', form: { token } })).status !== 200) cleanupFailed = true; }
      catch { cleanupFailed = true; }
    }
    if (context) {
      try {
        const response = await context.request.get(`${BASE}/api/session`, { maxRedirects: 0, timeout: 10_000 });
        if (response.status() === 200) {
          const session = await response.json();
          const logout = await context.request.post(`${BASE}/auth/logout`, { maxRedirects: 0, timeout: 10_000,
            headers: { origin: BASE, 'x-csrf-token': session.csrfToken }, data: {} });
          if (logout.status() !== 200) cleanupFailed = true;
        }
      } catch { cleanupFailed = true; }
      if (cdp) { try { await cdp.detach(); } catch { cleanupFailed = true; } }
      try { await context.close(); } catch { cleanupFailed = true; }
    }
    if (browser) { try { await browser.close(); } catch { cleanupFailed = true; } }
  }
  console.log(JSON.stringify({
    status: failed || cleanupFailed ? 'failed' : 'passed',
    ...(failed ? { phase } : {}), assertions, checks, capturedCallbacks,
    cspBlockedForm, consentPosts, callbackSecurity,
    interception: 'Chrome CDP Fetch Request stage; browser DNS denies all non-staging hostnames',
    cleanup: cleanupFailed ? 'incomplete' : 'complete',
    scope: 'Real protected staging HTTPS, Dex browser login, OAuth and MCP; ChatGPT callback intercepted locally.',
    chatgptAccountVerified: false, ordersCreated: 0, realPayments: false,
    credentialsOrTokensSaved: false,
  }));
  if (failed || cleanupFailed) process.exitCode = 1;
}
