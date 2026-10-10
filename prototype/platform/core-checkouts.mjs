import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { problem, requireScope } from './auth.mjs';
import { corePreviewInput, coreQuoteInput } from './core-adapter.mjs';
import { coreOrderView } from './core-order-client.mjs';
import { quoteBinding } from './quote-binding.mjs';

const uuid = z.string().uuid();
const prepareSchema = corePreviewInput.extend({ tenantId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  expectedTotalMinor: z.number().int().min(0).max(100_000_000),
  idempotencyKey: z.string().min(8).max(100).regex(/^[A-Za-z0-9:_-]+$/),
}).strict();
export const coreConfirmationInput = z.object({ customerName: z.string().trim().min(1).max(100),
  phone: z.string().max(40), address: coreQuoteInput.shape.address,
  paymentMethod: z.string().min(1).max(40), paymentProvider: z.string().max(40).optional(),
  notes: z.string().max(1000).optional(),
}).strict();
export const coreSupportInput=z.object({requestId:z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
      kind:z.enum(['cancellation','complaint']),version:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1),reviewed:z.literal(true),
      reason:z.string().trim().min(1).max(4000).refine(text=>Array.from(text).length<=1000)}).strict();
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function parse(schema, value) { const result = schema.safeParse(value); if (!result.success) throw problem(400,'invalid_request'); return result.data; }

export function createCoreCheckouts({ pool, baseUrl, core, orderClient, resolvePrincipal, isTenantActive }) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.origin !== baseUrl || typeof resolvePrincipal !== 'function' || typeof isTenantActive !== 'function') throw new Error('invalid_checkout_dependencies');
  async function principal(input, scope) {
    requireScope(input, scope);
    const live = await resolvePrincipal(input.id);
    if (!live || live.id !== input.id || live.role !== 'customer') throw problem(403, 'identity_disabled');
    return live;
  }
  async function init() {
    await pool.query(`CREATE TABLE IF NOT EXISTS platform_core_checkouts (
      id UUID PRIMARY KEY, principal_id UUID NOT NULL REFERENCES platform_identities(id),
      tenant_id TEXT NOT NULL REFERENCES platform_tenants(id), idem_key TEXT NOT NULL,
      request_hash TEXT NOT NULL, cart JSONB NOT NULL, quote JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '15 minutes',
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','dispatching','confirmed')),
      confirmation_hash TEXT, order_number TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(principal_id,tenant_id,idem_key),
      CHECK((state='confirmed')=(order_number IS NOT NULL))
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS platform_core_support_intents (
      checkout_id UUID NOT NULL REFERENCES platform_core_checkouts(id), request_id UUID NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('cancellation','complaint')), request_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('dispatching','recorded','rejected')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(checkout_id,request_id)
    ); ALTER TABLE platform_core_support_intents ADD COLUMN IF NOT EXISTS review_version BIGINT;
    CREATE UNIQUE INDEX IF NOT EXISTS platform_core_support_one_pending
      ON platform_core_support_intents(checkout_id) WHERE state='dispatching'`);
  }
  function summary(row) {
    return { checkoutId: row.id, tenantId: row.tenant_id, totalMinor: row.quote.totalMinor,
      currency: row.quote.currency, checkoutUrl: `${baseUrl}/checkout/${row.id}`,
      expiresAt: new Date(row.expires_at).toISOString(), state: row.state,
      ...(row.order_number ? { orderId: row.order_number } : {}) };
  }
  async function owned(principalId, checkoutId, db = pool, lock = false) {
    parse(uuid, checkoutId);
    const { rows } = await db.query(`SELECT *,expires_at>now() AS live FROM platform_core_checkouts
      WHERE id=$1 AND principal_id=$2${lock ? ' FOR UPDATE' : ''}`, [checkoutId, principalId]);
    if (!rows[0]) throw problem(404,'not_found');
    return rows[0];
  }
  async function requireDispatchAuthority(row, db = pool) {
    // Evaluate after any awaited lock/authority checks. Transaction now() and
    // a projection evaluated before FOR UPDATE waits are not current clocks.
    // Check identity/tenant in the same read, including after a pool wait.
    const { rows } = await db.query(`SELECT c.expires_at>clock_timestamp() AS live,i.enabled,t.status
      FROM platform_core_checkouts c JOIN platform_identities i ON i.id=c.principal_id
      JOIN platform_tenants t ON t.id=c.tenant_id WHERE c.id=$1 AND c.principal_id=$2`, [row.id,row.principal_id]);
    if (!rows[0]?.live) throw problem(409,'checkout_expired');
    if (!rows[0].enabled) throw problem(403,'identity_disabled');
    if (rows[0].status !== 'active') throw problem(409,'tenant_unavailable');
  }
  async function prepare(identity, value) {
    const who = await principal(identity,'orders:write');
    const input = parse(prepareSchema,value);
    const { tenantId, expectedTotalMinor, idempotencyKey, ...cart } = input;
    const requestHash = digest({ cart, expectedTotalMinor });
    const existing = await pool.query('SELECT * FROM platform_core_checkouts WHERE principal_id=$1 AND tenant_id=$2 AND idem_key=$3', [who.id,tenantId,idempotencyKey]);
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== requestHash) throw problem(409,'idempotency_conflict');
      return summary(existing.rows[0]);
    }
    if (!await isTenantActive(tenantId)) throw problem(409,'tenant_unavailable');
    const quote = await core.preview(tenantId,cart);
    if (quote.totalMinor !== expectedTotalMinor || quote.currency !== 'SAR') throw problem(409,'price_changed');
    await pool.query(`INSERT INTO platform_core_checkouts(id,principal_id,tenant_id,idem_key,request_hash,cart,quote)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(principal_id,tenant_id,idem_key) DO NOTHING`,
      [randomUUID(),who.id,tenantId,idempotencyKey,requestHash,JSON.stringify(cart),JSON.stringify(quote)]);
    const { rows } = await pool.query('SELECT * FROM platform_core_checkouts WHERE principal_id=$1 AND tenant_id=$2 AND idem_key=$3',[who.id,tenantId,idempotencyKey]);
    if (rows[0]?.request_hash !== requestHash) throw problem(409,'idempotency_conflict');
    return summary(rows[0]);
  }
  async function get(identity, checkoutId) {
    const who = await principal(identity,'orders:read'), row = await owned(who.id,checkoutId);
    if (!row.live && row.state === 'pending') throw problem(409,'checkout_expired');
    return { ...summary(row), cart: row.cart, quote: row.quote };
  }
  async function record(row, value) {
    const order = coreOrderView.parse(value);
    if (order.totalMinor !== row.quote.totalMinor || order.currency !== row.quote.currency) throw problem(409,'order_requires_review');
    const result = await pool.query(`UPDATE platform_core_checkouts SET state='confirmed',order_number=$3
      WHERE id=$1 AND principal_id=$2 AND (order_number IS NULL OR order_number=$3) RETURNING id`, [row.id,row.principal_id,order.number]);
    if (!result.rows.length) throw problem(409,'order_requires_review');
    return { tenantId: row.tenant_id,...order };
  }
  async function recovery(row) {
    try { return await record(row,await orderClient.recover(row.tenant_id,row.principal_id,row.id)); }
    catch (error) { if (error.status === 404 && error.code === 'invalid_order_access') return null; throw error; }
  }
  async function confirm(identity, checkoutId, value) {
    const who = await principal(identity,'orders:write');
    let row = await owned(who.id,checkoutId);
    if (row.state === 'confirmed') return record(row,await orderClient.status(row.tenant_id,who.id,row.order_number));
    if (row.state === 'dispatching') { const recovered = await recovery(row); if (recovered) return recovered; }
    if (!row.live) throw problem(409,'checkout_expired');
    if (!await isTenantActive(row.tenant_id)) throw problem(409,'tenant_unavailable');
    const contact = parse(coreConfirmationInput,value);
    const input = { ...row.cart,...contact, ...(row.cart.address || contact.address ? {address:{...row.cart.address,...contact.address}} : {}),
      expectedTotalMinor: row.quote.totalMinor };
    const confirmationHash = digest(input);
    if (row.confirmation_hash && row.confirmation_hash !== confirmationHash) throw problem(409,'confirmation_conflict');
    // Validate contact/coverage/current price before freezing a first attempt.
    // This request is read-only and never submits an order or payment.
    const { expectedTotalMinor,...quoteInput } = input;
    const quote = await core.quote(row.tenant_id,quoteInput);
    if (quote.totalMinor !== expectedTotalMinor || quote.currency !== row.quote.currency) throw problem(409,'price_changed');
    const expectedQuoteHash=quoteBinding(row.quote);
    if(quoteBinding(quote)!==expectedQuoteHash)throw problem(409,'quote_changed');
    const db = await pool.connect();
    try {
      await db.query('BEGIN'); row = await owned(who.id,checkoutId,db,true);
      if (row.state !== 'confirmed') {
        // The quote and row-lock waits can outlive the original authority.
        // Reject known revocation before freezing a previously pending intent.
        // Use this transaction's connection: a resolver borrowing from the pool
        // here can deadlock when other confirmations occupy it waiting on us.
        await requireDispatchAuthority(row,db);
        if (row.confirmation_hash && row.confirmation_hash !== confirmationHash) throw problem(409,'confirmation_conflict');
        await db.query("UPDATE platform_core_checkouts SET state='dispatching',confirmation_hash=$2 WHERE id=$1",[row.id,confirmationHash]);
      }
      await db.query('COMMIT');
    } catch(error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
    if (row.state === 'confirmed') return record(row,await orderClient.status(row.tenant_id,who.id,row.order_number));
    // Never reset dispatching on an ambiguous network or DB failure. Recovery
    // reads the original core using the SAME owner and stable UUID on retry.
    // Recheck after COMMIT too, immediately before signing a new operation.
    // This closes the named waits, not distributed instantaneous revocation.
    await principal(identity,'orders:write');
    if (!await isTenantActive(row.tenant_id)) throw problem(409,'tenant_unavailable');
    await requireDispatchAuthority(row);
    return record(row,await orderClient.create(row.tenant_id,who.id,{...input,expectedQuoteHash},row.id));
  }
  async function status(identity, tenantId, number) {
    const who = await principal(identity,'orders:read');
    // Core ownership is authoritative. No order number alone grants access.
    try { return await orderClient.status(tenantId,who.id,number); }
    catch(error) { if(error.code==='invalid_order_access')throw problem(404,'not_found');throw error; }
  }
  async function details(identity,tenantId,number) {
    const who=await principal(identity,'orders:read');
    try {return await orderClient.details(tenantId,who.id,number);}
    catch(error){if(error.code==='invalid_order_access')throw problem(404,'not_found');throw error;}
  }
  async function payment(identity,checkoutId,action) {
    const who=await principal(identity,action==='start'?'orders:write':'orders:read');
    const row=await owned(who.id,checkoutId);
    if(row.state!=='confirmed')throw problem(409,'order_not_confirmed');
    const order=await orderClient.status(row.tenant_id,who.id,row.order_number);
    if(order.paymentMethod!=='card')throw problem(409,'payment_not_required');
    return orderClient.payment(row.tenant_id,who.id,row.order_number,action,order.paymentProvider);
  }

  async function confirmedSupportOwner(identity, checkoutId, scope) {
    const who=await principal(identity,scope), row=await owned(who.id,checkoutId);
    if(row.state!=='confirmed')throw problem(409,'order_not_confirmed');
    return {who,row};
  }
  async function recoverSupport(row,intent) {
    const result=await orderClient.customerSupportRecovery(row.tenant_id,row.principal_id,row.order_number,intent.kind,intent.request_id);
    if(result.recorded)await pool.query("UPDATE platform_core_support_intents SET state='recorded' WHERE checkout_id=$1 AND request_id=$2",[row.id,intent.request_id]);
    return result;
  }
  async function support(identity,checkoutId) {
    const {who,row}=await confirmedSupportOwner(identity,checkoutId,'orders:read');
    const {rows}=await pool.query("SELECT * FROM platform_core_support_intents WHERE checkout_id=$1 AND state='dispatching'",[row.id]);
    if(rows[0]){
      const recovered=await recoverSupport(row,rows[0]);
      return {order:recovered.order,pending:recovered.recorded?null:{requestId:rows[0].request_id,kind:rows[0].kind,...(rows[0].review_version?{version:Number(rows[0].review_version)}:{})}};
    }
    return {order:await orderClient.customerSupport(row.tenant_id,who.id,row.order_number),pending:null};
  }
  async function reviewedSupportIntent(identity,checkoutId,value) {
    const {row}=await confirmedSupportOwner(identity,checkoutId,'orders:write'),input=parse(coreSupportInput,value);
    const {rows}=await pool.query('SELECT * FROM platform_core_support_intents WHERE checkout_id=$1 AND request_id=$2',[row.id,input.requestId]);
    const intent=rows[0];
    if(!intent||!intent.review_version||Number(intent.review_version)!==input.version||intent.request_hash!==digest(input))throw problem(409,'confirmation_conflict');
    if(intent.state==='rejected')throw problem(409,'support_request_rejected');
    return {row,input,intent};
  }
  async function reviewSupportRetry(identity,checkoutId,value) {
    const {row,intent}=await reviewedSupportIntent(identity,checkoutId,value);
    return recoverSupport(row,intent);
  }
  async function submitSupport(identity,checkoutId,value,explicitRetry=false) {
    const {row}=await confirmedSupportOwner(identity,checkoutId,'orders:write');
    const input=parse(coreSupportInput,value);
    const {requestId,kind,...command}=input,requestHash=digest(input);
    let existing;
    if(explicitRetry){existing=(await reviewedSupportIntent(identity,checkoutId,input)).intent;}
    else {
      // Persist only a hash and review version, never free-text reason. A partial
      // unique index prevents an alternative key bypassing an unknown write.
      const inserted=await pool.query(`INSERT INTO platform_core_support_intents(checkout_id,request_id,kind,request_hash,state,review_version)
        VALUES($1,$2,$3,$4,'dispatching',$5) ON CONFLICT DO NOTHING RETURNING request_id`,[row.id,requestId,kind,requestHash,input.version]);
      if(!inserted.rows.length){
        const {rows}=await pool.query('SELECT * FROM platform_core_support_intents WHERE checkout_id=$1 AND request_id=$2',[row.id,requestId]);
        existing=rows[0];
        if(!existing)throw problem(409,'support_request_pending');
      }
    }
    if(existing){
      if(existing.request_hash!==requestHash)throw problem(409,'confirmation_conflict');
      if(existing.state==='rejected')throw problem(409,'support_request_rejected');
      const recovered=await recoverSupport(row,existing);
      if(recovered.recorded)return recovered;
      if(!explicitRetry)throw problem(503,'order_outcome_unknown');
      // This is a separately reviewed human retry, never a refresh or implicit
      // fallback. The original core's row lock and durable key serialize even
      // overlapping deliveries. The original version/reason cannot be replaced.
    }
    let result;
    try {
      // No automatic replay, including when the process died after claiming.
      await principal(identity,'orders:write');
      result=await orderClient.customerSupportCommand(row.tenant_id,row.principal_id,row.order_number,kind,requestId,command);
    } catch(error) {
      if([400,401,403,404,409,413,429].includes(error.status))await pool.query("UPDATE platform_core_support_intents SET state='rejected' WHERE checkout_id=$1 AND request_id=$2",[row.id,requestId]);
      throw error;
    }
    await pool.query("UPDATE platform_core_support_intents SET state='recorded' WHERE checkout_id=$1 AND request_id=$2",[row.id,requestId]);
    return result;
  }
  return { init, prepare, get, confirm, status, details, payment, support, submitSupport, reviewSupportRetry };
}
