import test from 'node:test';
import assert from 'node:assert/strict';
import { createMoyasarTestGateway } from './moyasar.mjs';

const secretKey = 'sk_test_synthetic_mock_only';
const order = Object.freeze({ id: 'synthetic-order-1', totalMinor: 2700, currency: 'SAR' });
const invoiceId = 'aabbccdd-0000-4000-8000-000000000001';
const paymentId = 'aabbccdd-0000-4000-8000-000000000002';
const otherId = 'aabbccdd-0000-4000-8000-000000000003';
const callbackUrl = 'https://prototype.example.test/hooks/moyasar';
const returnUrl = 'https://prototype.example.test/checkout/result';
const checkoutUrl = `https://checkout.moyasar.com/invoices/${invoiceId}?lang=ar`;

function invoice(extra = {}) {
  return { id: invoiceId, status: 'initiated', amount: 2700, currency: 'SAR',
    description: 'Synthetic prototype order synthetic-order-1', url: checkoutUrl, payments: [], ...extra };
}

function payment(extra = {}) {
  return { id: paymentId, invoice_id: invoiceId, status: 'paid', amount: 2700,
    currency: 'SAR', captured: 0, refunded: 0, ...extra };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fixture(body, status = 200) {
  const requests = [];
  const gateway = createMoyasarTestGateway({ secretKey, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return response(body, status);
  } });
  return { gateway, requests };
}

function hasCode(code) {
  return error => error instanceof Error && error.code === code && error.message === code && !error.cause;
}

test('factory rejects live/publishable/malformed keys without contacting a provider', () => {
  for (const key of [undefined, '', 'sk_live_synthetic', 'pk_test_synthetic', ' sk_test_synthetic', 'sk_test_', 'sk_test_test\r\nSecret: x']) {
    assert.throws(() => createMoyasarTestGateway({ secretKey: key, fetchImpl: () => assert.fail('network forbidden') }), hasCode('moyasar_test_key_required'));
  }
});

test('hosted invoice sends only server reference and price to fixed HTTPS host', async () => {
  const { gateway, requests } = fixture(invoice(), 201);
  const result = await gateway.createInvoice({ order: { ...order, name: 'DO-NOT-SEND', phone: 'DO-NOT-SEND', address: 'DO-NOT-SEND' }, callbackUrl, returnUrl });
  assert.deepEqual(result, { id: invoiceId, url: checkoutUrl });
  assert.equal(requests.length, 1);
  const { url, options } = requests[0];
  assert.equal(url, 'https://api.moyasar.com/v1/invoices');
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.cache, 'no-store');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.headers.authorization, `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`);
  const sent = JSON.parse(options.body);
  assert.deepEqual(Object.keys(sent).sort(), ['amount', 'currency', 'description', 'callback_url', 'success_url', 'back_url', 'expired_at'].sort());
  assert.equal(sent.amount, order.totalMinor);
  assert.equal(sent.currency, order.currency);
  assert.equal(sent.description, 'Synthetic prototype order synthetic-order-1');
  assert.equal(sent.callback_url, callbackUrl);
  assert.equal(sent.success_url, returnUrl);
  assert.equal(sent.back_url, returnUrl);
  assert.ok(Date.parse(sent.expired_at) > Date.now());
  assert.ok(!options.body.includes('DO-NOT-SEND'));
});

test('invalid prices, references and callback configuration never create a request', async () => {
  const gateway = createMoyasarTestGateway({ secretKey, fetchImpl: () => assert.fail('network forbidden') });
  for (const change of [{ totalMinor: 99 }, { totalMinor: 2.7 }, { totalMinor: Number.MAX_SAFE_INTEGER + 1 }, { currency: 'USD' }, { id: '../escape' }, { id: 'Customer Name' }]) {
    await assert.rejects(gateway.createInvoice({ order: { ...order, ...change }, callbackUrl, returnUrl }), hasCode('moyasar_invalid_request'));
  }
  for (const callback of ['http://prototype.example.test/hook', 'https://user:password@prototype.example.test/hook', 'https://prototype.example.test/hook#fragment', 'https://prototype.example.test:444/hook', 'https://foreign.example.test/hook']) {
    await assert.rejects(gateway.createInvoice({ order, callbackUrl: callback, returnUrl }), hasCode('moyasar_invalid_request'));
  }
  await assert.rejects(gateway.inspectInvoice({ order, invoiceId: 'https://attacker.example.test/steal' }), hasCode('moyasar_invalid_request'));
});

test('unsafe checkout URLs and mismatched create responses become unknown outcomes, never retried', async () => {
  for (const change of [
    { url: `https://checkout.moyasar.com.attacker.test/invoices/${invoiceId}` },
    { url: `https://checkout.moyasar.com@attacker.test/invoices/${invoiceId}` },
    { url: `http://checkout.moyasar.com/invoices/${invoiceId}` },
    { url: `https://checkout.moyasar.com/invoices/${otherId}` },
    { url: `${checkoutUrl}&redirect=https://attacker.test` },
    { amount: 2800 }, { currency: 'USD' }, { description: 'different order' },
    { status: 'paid', payments: [payment()] }, { live: true }, { payments: undefined },
  ]) {
    const { gateway, requests } = fixture(invoice(change), 201);
    await assert.rejects(gateway.createInvoice({ order, callbackUrl, returnUrl }), hasCode('moyasar_outcome_unknown'));
    assert.equal(requests.length, 1);
  }
});

test('ambiguous POST failures are redacted and not retried', async () => {
  for (const status of [302, 401, 429, 500]) {
    const { gateway, requests } = fixture({ secret: secretKey, message: 'private provider detail' }, status);
    await assert.rejects(gateway.createInvoice({ order, callbackUrl, returnUrl }), hasCode('moyasar_outcome_unknown'));
    assert.equal(requests.length, 1);
  }
  let attempts = 0;
  const gateway = createMoyasarTestGateway({ secretKey, fetchImpl: async () => {
    attempts++;
    throw new Error(`network failure ${secretKey} private response`);
  } });
  await assert.rejects(gateway.createInvoice({ order, callbackUrl, returnUrl }), hasCode('moyasar_outcome_unknown'));
  assert.equal(attempts, 1);
});

test('request timeout aborts the sole POST without a second money operation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  let capturedSignal;
  const gateway = createMoyasarTestGateway({ secretKey, fetchImpl: async (_url, options) => {
    attempts++;
    capturedSignal = options.signal;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true }));
  } });
  const pending = gateway.createInvoice({ order, callbackUrl, returnUrl });
  const assertion = assert.rejects(pending, hasCode('moyasar_outcome_unknown'));
  t.mock.timers.tick(10_000);
  await assertion;
  assert.equal(capturedSignal.aborted, true);
  assert.equal(attempts, 1);
});

test('authenticated inspection proves exact settled payment and strips raw data', async () => {
  const { gateway, requests } = fixture(invoice({ status: 'paid', payments: [payment({ source: { name: 'PRIVATE', number: 'MASKED', token: 'TOKEN' }, ip: 'PRIVATE-IP' })] }));
  const result = await gateway.inspectInvoice({ invoiceId, order });
  assert.deepEqual(result, { invoiceId, status: 'paid', paymentId, amountMinor: 2700, currency: 'SAR', reference: order.id, testMode: true });
  assert.equal(requests[0].url, `https://api.moyasar.com/v1/invoices/${invoiceId}`);
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.body, undefined);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

test('invoice linkage, currency, amount and reference must all match the order', async () => {
  for (const body of [
    invoice({ id: otherId, status: 'paid', payments: [payment()] }),
    invoice({ description: 'foreign-order', status: 'paid', payments: [payment()] }),
    invoice({ amount: 2600, status: 'paid', payments: [payment()] }),
    invoice({ currency: 'USD', status: 'paid', payments: [payment()] }),
    ...[{ invoice_id: otherId }, { amount: 2600 }, { currency: 'USD' }].map(change => invoice({ status: 'paid', payments: [payment(change)] })),
  ]) {
    const { gateway } = fixture(body);
    await assert.rejects(gateway.inspectInvoice({ invoiceId, order }), hasCode('moyasar_payment_mismatch'));
  }
});

test('explicit response environment contradictions prevent sandbox settlement', async () => {
  for (const change of [{ live: true }, { live: 'false' }, { mode: 'live' }, { environment: 'production' }, { test_mode: false }]) {
    for (const body of [invoice({ status: 'paid', payments: [payment()], ...change }), invoice({ status: 'paid', payments: [payment(change)] })]) {
      const { gateway } = fixture(body);
      await assert.rejects(gateway.inspectInvoice({ invoiceId, order }), hasCode('moyasar_test_mode_unverified'));
    }
  }
  const { gateway } = fixture(invoice({ live: false, status: 'paid', payments: [payment({ live: false })] }));
  assert.equal((await gateway.inspectInvoice({ invoiceId, order })).status, 'paid');
});

test('paid invoice without unique unrefunded captured payment cannot settle', async () => {
  for (const body of [
    invoice({ status: 'paid' }),
    invoice({ status: 'paid', payments: [payment({ status: 'authorized' })] }),
    invoice({ status: 'paid', payments: [payment({ refunded: 100 })] }),
    invoice({ status: 'paid', payments: [payment({ captured: 100 })] }),
    invoice({ status: 'paid', payments: [payment({ status: 'captured', captured: 100 })] }),
    invoice({ status: 'paid', payments: [payment(), payment({ id: otherId })] }),
    invoice({ status: 'paid', payments: [payment(), payment({ id: otherId, status: 'initiated' })] }),
    invoice({ status: 'expired', payments: [payment()] }),
  ]) {
    const { gateway } = fixture(body);
    assert.equal((await gateway.inspectInvoice({ invoiceId, order })).status, 'review');
  }
});

test('pending, failed, fully captured and refunded outcomes normalize without provider payloads', async () => {
  for (const [body, expected] of [
    [invoice(), 'pending'],
    [invoice({ status: 'expired' }), 'failed'],
    [invoice({ status: 'paid', payments: [payment({ id: otherId, status: 'failed' }), payment()] }), 'paid'],
    [invoice({ status: 'paid', payments: [payment({ status: 'captured', captured: 2700 })] }), 'paid'],
    [invoice({ status: 'refunded', payments: [payment({ status: 'refunded', refunded: 2700 })] }), 'refunded'],
  ]) {
    const { gateway } = fixture(body);
    assert.equal((await gateway.inspectInvoice({ invoiceId, order })).status, expected);
  }
});

test('malformed monetary fields and duplicate payment IDs are rejected', async () => {
  for (const payments of [
    undefined, {}, [payment(), payment()],
    [payment({ refunded: -1 })], [payment({ refunded: '0' })],
    [payment({ captured: undefined })], [payment({ status: 'unknown' })],
  ]) {
    const { gateway } = fixture(invoice({ status: 'paid', payments }));
    await assert.rejects(gateway.inspectInvoice({ invoiceId, order }), hasCode('moyasar_invalid_response'));
  }
});

test('provider error, HTML, malformed and oversized response bodies never leak', async () => {
  for (const createResponse of [
    () => new Response('<html>private</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('{private', { headers: { 'content-type': 'application/json' } }),
    () => new Response('x'.repeat(128 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '999999' } }),
    () => response({ message: `private ${secretKey}` }, 500),
  ]) {
    const gateway = createMoyasarTestGateway({ secretKey, fetchImpl: async () => createResponse() });
    await assert.rejects(gateway.inspectInvoice({ invoiceId, order }), hasCode('moyasar_unavailable'));
  }
});
