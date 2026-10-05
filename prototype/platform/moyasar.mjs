// Synthetic prototype only. No import-time network access and no automatic retries.
// API mode is determined by the authenticated key, not an invented invoice flag:
// https://docs.moyasar.com/api/api-introduction
// https://docs.moyasar.com/api/authentication
// https://docs.moyasar.com/api/invoices/01-create-invoice
const API = 'https://api.moyasar.com/v1';
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVOICE_STATUSES = new Set(['initiated', 'paid', 'failed', 'refunded', 'canceled', 'on_hold', 'expired', 'voided']);
const PAYMENT_STATUSES = new Set(['initiated', 'paid', 'authorized', 'failed', 'refunded', 'captured', 'voided', 'verified', 'expired']);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateOrder(order) {
  if (!record(order) || typeof order.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(order.id)
    || !Number.isSafeInteger(order.totalMinor) || order.totalMinor < 100 || order.currency !== 'SAR') {
    throw fail('moyasar_invalid_request');
  }
  // Snapshot only the immutable server-owned identifiers and pricing.
  return { id: order.id, totalMinor: order.totalMinor, currency: 'SAR' };
}

function httpsUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\s\\]/.test(raw)) throw fail('moyasar_invalid_request');
  let url;
  try { url = new URL(raw); } catch { throw fail('moyasar_invalid_request'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash || url.port) {
    throw fail('moyasar_invalid_request');
  }
  return url;
}

function checkoutUrl(raw, invoiceId) {
  const url = httpsUrl(raw);
  if (url.hostname !== 'checkout.moyasar.com' || url.pathname !== `/invoices/${invoiceId}`
    || [...url.searchParams].some(([key, value]) => key !== 'lang' || !['ar', 'en'].includes(value))
    || url.searchParams.getAll('lang').length > 1) throw fail('moyasar_invalid_response');
  return url.href;
}

function rejectModeConflict(value) {
  // These fields are NOT required by the documented invoice/payment schema.
  // If a response does provide one, it must not contradict the test credential.
  for (const field of ['live', 'livemode', 'live_mode']) {
    if (Object.hasOwn(value, field) && value[field] !== false) throw fail('moyasar_test_mode_unverified');
  }
  for (const field of ['test', 'test_mode', 'testMode']) {
    if (Object.hasOwn(value, field) && value[field] !== true) throw fail('moyasar_test_mode_unverified');
  }
  for (const field of ['mode', 'environment']) {
    if (Object.hasOwn(value, field) && !['test', 'sandbox'].includes(value[field])) throw fail('moyasar_test_mode_unverified');
  }
}

function validateInvoice(invoice, order, expectedId) {
  if (!record(invoice) || !UUID.test(invoice.id ?? '') || !INVOICE_STATUSES.has(invoice.status)) {
    throw fail('moyasar_invalid_response');
  }
  rejectModeConflict(invoice);
  if ((expectedId && invoice.id !== expectedId) || invoice.amount !== order.totalMinor
    || invoice.currency !== order.currency || invoice.description !== `Synthetic prototype order ${order.id}`) {
    throw fail('moyasar_payment_mismatch');
  }
}

async function boundedJson(response) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel();
    throw fail('moyasar_invalid_response');
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json' || !response.body) throw fail('moyasar_invalid_response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw fail('moyasar_invalid_response');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    await reader.cancel().catch(() => {});
    throw fail('moyasar_invalid_response');
  } finally {
    reader.releaseLock();
  }
}

export function createMoyasarTestGateway({ secretKey, fetchImpl = globalThis.fetch } = {}) {
  // The published authentication format explicitly identifies sandbox keys.
  // Never trim or log a malformed credential, and never accept pk_* or sk_live_*.
  if (typeof secretKey !== 'string' || !/^sk_test_[A-Za-z0-9_-]+$/.test(secretKey) || secretKey.length > 4096) {
    throw fail('moyasar_test_key_required');
  }
  if (typeof fetchImpl !== 'function') throw fail('moyasar_invalid_request');
  const authorization = `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`;

  async function request(method, path, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await fetchImpl(`${API}${path}`, {
        method,
        headers: { authorization, accept: 'application/json', ...(payload ? { 'content-type': 'application/json' } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        redirect: 'error',
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
      });
      if (response.redirected || response.status !== (method === 'POST' ? 201 : 200)) {
        await response.body?.cancel();
        // A server error/redirect can follow a committed POST. Do not retry it.
        if (method === 'POST' && !(response.status >= 400 && response.status < 500)) {
          throw fail('moyasar_outcome_unknown');
        }
        throw fail('moyasar_unavailable');
      }
      return await boundedJson(response);
    } catch {
      // Provider errors may contain keys, PII, URLs or financial payloads.
      throw fail(method === 'POST' ? 'moyasar_outcome_unknown' : 'moyasar_unavailable');
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    async createInvoice({ order: inputOrder, callbackUrl, returnUrl } = {}) {
      const order = validateOrder(inputOrder);
      const callback = httpsUrl(callbackUrl);
      const destination = httpsUrl(returnUrl);
      if (callback.origin !== destination.origin) throw fail('moyasar_invalid_request');
      const invoice = await request('POST', '/invoices', {
        amount: order.totalMinor,
        currency: order.currency,
        description: `Synthetic prototype order ${order.id}`,
        callback_url: callback.href,
        success_url: destination.href,
        back_url: destination.href,
        expired_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      try {
        validateInvoice(invoice, order);
        if (invoice.status !== 'initiated' || !Array.isArray(invoice.payments) || invoice.payments.length !== 0) {
          throw fail('moyasar_invalid_response');
        }
        return { id: invoice.id, url: checkoutUrl(invoice.url, invoice.id) };
      } catch {
        // Even a mismatched successful create response may mean an invoice exists.
        throw fail('moyasar_outcome_unknown');
      }
    },

    async inspectInvoice({ invoiceId, order: inputOrder } = {}) {
      const order = validateOrder(inputOrder);
      if (typeof invoiceId !== 'string' || !UUID.test(invoiceId)) throw fail('moyasar_invalid_request');
      const invoice = await request('GET', `/invoices/${invoiceId}`);
      validateInvoice(invoice, order, invoiceId);
      if (!Array.isArray(invoice.payments) || invoice.payments.length > 100) throw fail('moyasar_invalid_response');
      const seen = new Set();
      const charged = [];
      let incomplete = false;
      for (const payment of invoice.payments) {
        if (!record(payment) || !UUID.test(payment.id ?? '') || seen.has(payment.id) || !PAYMENT_STATUSES.has(payment.status)
          || !Number.isSafeInteger(payment.refunded) || payment.refunded < 0 || payment.refunded > order.totalMinor
          || !Number.isSafeInteger(payment.captured) || payment.captured < 0 || payment.captured > order.totalMinor) {
          throw fail('moyasar_invalid_response');
        }
        seen.add(payment.id);
        rejectModeConflict(payment);
        if (payment.invoice_id !== invoiceId || payment.amount !== order.totalMinor || payment.currency !== order.currency) {
          throw fail('moyasar_payment_mismatch');
        }
        if (['paid', 'captured', 'refunded'].includes(payment.status) || payment.refunded > 0 || payment.captured > 0) charged.push(payment);
        if (['initiated', 'authorized'].includes(payment.status)) incomplete = true;
      }
      let status = ['failed', 'canceled', 'expired', 'voided'].includes(invoice.status) ? 'failed' : 'pending';
      let paymentId = null;
      if (charged.length === 1) {
        const payment = charged[0];
        paymentId = payment.id;
        if (invoice.status === 'paid' && !incomplete && payment.refunded === 0
          && (payment.status === 'paid' && [0, order.totalMinor].includes(payment.captured)
            || payment.status === 'captured' && payment.captured === order.totalMinor)) {
          status = 'paid';
        } else if (invoice.status === 'refunded' && !incomplete && payment.status === 'refunded'
          && payment.refunded === order.totalMinor && [0, order.totalMinor].includes(payment.captured)) {
          status = 'refunded';
        } else {
          status = 'review';
        }
      } else if (charged.length > 1 || ['paid', 'refunded'].includes(invoice.status)) {
        status = 'review';
      }
      return { invoiceId, status, paymentId, amountMinor: order.totalMinor, currency: order.currency, reference: order.id, testMode: true };
    },
  });
}
