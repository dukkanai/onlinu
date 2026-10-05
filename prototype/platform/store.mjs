import { createHash, randomUUID } from 'node:crypto';
import { problem } from './auth.mjs';

export function validateCart(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['items', 'expectedTotalMinor', 'idempotencyKey'].includes(key))
    || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 20) throw problem(400, 'invalid_cart');
  const seen = new Set();
  const items = input.items.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(key => !['itemId', 'quantity'].includes(key))
      || typeof item.itemId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(item.itemId)
      || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20 || seen.has(item.itemId)) {
      throw problem(400, 'invalid_cart');
    }
    seen.add(item.itemId);
    return { itemId: item.itemId, quantity: item.quantity };
  });
  return items.sort((a, b) => a.itemId.localeCompare(b.itemId));
}

export function createStore({ pool, baseUrl, tenantRequest, listRestaurants }) {
  async function init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS demo_checkouts (
        id UUID PRIMARY KEY, principal_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
        idem_key TEXT NOT NULL, request_hash TEXT NOT NULL, items JSONB NOT NULL,
        total_minor BIGINT NOT NULL CHECK(total_minor>=0), currency TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL, order_id TEXT,
        confirmation_state TEXT NOT NULL DEFAULT 'pending'
          CHECK(confirmation_state IN ('pending','dispatching','confirmed')),
        UNIQUE(principal_id,tenant_id,idem_key)
      );
      ALTER TABLE demo_checkouts ADD COLUMN IF NOT EXISTS confirmation_state TEXT NOT NULL DEFAULT 'pending'
        CHECK(confirmation_state IN ('pending','dispatching','confirmed'));
      CREATE TABLE IF NOT EXISTS demo_payment_attempts (
        tenant_id TEXT NOT NULL, order_id TEXT NOT NULL, state TEXT NOT NULL,
        invoice_id TEXT, invoice_url TEXT, error_code TEXT, PRIMARY KEY(tenant_id,order_id)
      );
      CREATE TABLE IF NOT EXISTS demo_outbox_cursors (tenant_id TEXT PRIMARY KEY, sequence BIGINT NOT NULL DEFAULT 0);
    `);
  }
  function customer(principal) {
    if (principal?.role !== 'customer') throw problem(403, 'customer_required');
  }
  function customerScope(principal, scope) {
    customer(principal);
    if (!Array.isArray(principal.scopes) || !principal.scopes.includes(scope)) throw problem(403, 'insufficient_scope');
  }
  function view(row) {
    return { checkoutId: row.id, tenantId: row.tenant_id, totalMinor: Number(row.total_minor), currency: row.currency,
      checkoutUrl: `${baseUrl}/checkout/${row.id}`, expiresAt: new Date(row.expires_at).toISOString() };
  }
  async function prepare(principal, input) {
    customerScope(principal, 'orders:write');
    const tenantId = input.tenantId;
    if (!listRestaurants().some(restaurant => restaurant.id === tenantId)) throw problem(404, 'not_found');
    const cart = { items: input.items, expectedTotalMinor: input.expectedTotalMinor, idempotencyKey: input.idempotencyKey };
    const items = validateCart(cart);
    if (!Number.isSafeInteger(cart.expectedTotalMinor) || cart.expectedTotalMinor < 0
      || typeof cart.idempotencyKey !== 'string' || !/^[A-Za-z0-9:_-]{8,100}$/.test(cart.idempotencyKey)) {
      throw problem(400, 'invalid_checkout');
    }
    const requestHash = createHash('sha256').update(JSON.stringify({ items, total: cart.expectedTotalMinor })).digest('hex');
    const lookup = [principal.id, tenantId, cart.idempotencyKey];
    const existing = await pool.query('SELECT * FROM demo_checkouts WHERE principal_id=$1 AND tenant_id=$2 AND idem_key=$3', lookup);
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== requestHash) throw problem(409, 'idempotency_conflict');
      if (new Date(existing.rows[0].expires_at).getTime() <= Date.now() && !existing.rows[0].order_id
        && existing.rows[0].confirmation_state !== 'dispatching') throw problem(409, 'checkout_expired');
      return view(existing.rows[0]);
    }
    const quote = await tenantRequest(tenantId, '/quote', { method: 'POST', body: { items } });
    if (quote.totalMinor !== cart.expectedTotalMinor || quote.currency !== 'SAR') throw problem(409, 'price_changed');
    await pool.query(`INSERT INTO demo_checkouts
      (id,principal_id,tenant_id,idem_key,request_hash,items,total_minor,currency,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'SAR',now()+interval '15 minutes') ON CONFLICT DO NOTHING`,
    [randomUUID(), ...lookup, requestHash, JSON.stringify(items), quote.totalMinor]);
    const { rows } = await pool.query('SELECT * FROM demo_checkouts WHERE principal_id=$1 AND tenant_id=$2 AND idem_key=$3', lookup);
    if (rows[0].request_hash !== requestHash) throw problem(409, 'idempotency_conflict');
    return view(rows[0]);
  }
  async function ownedCheckout(principal, id) {
    customer(principal);
    if (!/^[a-f0-9-]{36}$/.test(id)) throw problem(404, 'not_found');
    const { rows } = await pool.query('SELECT * FROM demo_checkouts WHERE id=$1 AND principal_id=$2', [id, principal.id]);
    if (!rows[0]) throw problem(404, 'not_found');
    return rows[0];
  }
  async function checkout(principal, id) {
    customerScope(principal, 'orders:read');
    return ownedCheckout(principal, id);
  }
  async function rememberOrder(principal, row, order) {
    const result = await pool.query(`UPDATE demo_checkouts SET order_id=$1,confirmation_state='confirmed'
      WHERE id=$2 AND principal_id=$3 AND (order_id IS NULL OR order_id=$1)`, [order.id, row.id, principal.id]);
    if (result.rowCount !== 1) throw problem(409, 'checkout_confirmation_conflict');
    return order;
  }
  async function recoverOrder(principal, row) {
    let order;
    try {
      order = await tenantRequest(row.tenant_id,
        `/orders/by-idempotency?key=${encodeURIComponent(`checkout:${row.id}`)}`, { principal });
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
    return rememberOrder(principal, row, order);
  }
  async function confirm(principal, id) {
    customerScope(principal, 'orders:write');
    let row = await ownedCheckout(principal, id);
    if (row.order_id) return tenantRequest(row.tenant_id, `/orders/${row.order_id}`, { principal });
    if (row.confirmation_state === 'dispatching' || new Date(row.expires_at).getTime() <= Date.now()) {
      // The tenant may have committed before its reply or our order_id write was
      // lost. Lookup is owner-scoped and read-only, including for expired legacy
      // checkouts whose earlier version had no durable confirmation marker.
      const recovered = await recoverOrder(principal, row);
      if (recovered) return recovered;
      if (new Date(row.expires_at).getTime() <= Date.now()) throw problem(409, 'checkout_expired');
    }
    // Commit intent before network dispatch. The database clock closes a race
    // between the first read and expiry; concurrent dispatches use one tenant
    // idempotency key and cannot reserve stock twice.
    const claim = await pool.query(`UPDATE demo_checkouts SET confirmation_state='dispatching'
      WHERE id=$1 AND principal_id=$2 AND order_id IS NULL AND expires_at>now() RETURNING *`, [row.id, principal.id]);
    if (!claim.rows[0]) {
      row = await ownedCheckout(principal, id);
      if (row.order_id) return tenantRequest(row.tenant_id, `/orders/${row.order_id}`, { principal });
      const recovered = await recoverOrder(principal, row);
      if (recovered) return recovered;
      throw problem(409, 'checkout_expired');
    }
    row = claim.rows[0];
    const order = await tenantRequest(row.tenant_id, '/orders', { principal, method: 'POST', body: {
      items: row.items, expectedTotalMinor: Number(row.total_minor), idempotencyKey: `checkout:${row.id}`,
    } });
    return rememberOrder(principal, row, order);
  }
  return { init, prepare, checkout, confirm };
}
