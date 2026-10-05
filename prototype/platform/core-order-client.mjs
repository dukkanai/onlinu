import { createHash, createPrivateKey, sign } from 'node:crypto';
import { z } from 'zod';
import { coreQuoteInput } from './core-adapter.mjs';
import { problem } from './auth.mjs';

const uuid = z.string().uuid();
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const orderInput = coreQuoteInput.extend({ expectedTotalMinor: z.number().int().min(0).max(100_000_000),
  notes: z.string().max(1000).optional() }).strict();
export const coreOrderView = z.object({ number: z.string().regex(/^R[0-9]{8,20}$/),
  version: z.number().int().positive(), status: z.string().max(40), paymentStatus: z.string().max(40),
  totalMinor: z.number().int().min(0).max(100_000_000), currency: z.literal('SAR'),
  mode: z.enum(['pickup','delivery','table']), updatedAt: z.string().datetime({ offset: true }),
  paymentMethod: z.string().max(40).optional(), paymentProvider: z.string().max(40).optional(),
});
const paymentHosts={stripe:['checkout.stripe.com'],moyasar:['checkout.moyasar.com'],tap:['checkout.tap.company','payment.tap.company','tap.company'],
    paytabs:['secure.paytabs.sa'],geidea:['www.ksamerchant.geidea.net','ksamerchant.geidea.net','merchant.geidea.net'],
    myfatoorah:['sa.myfatoorah.com','demo.myfatoorah.com','portal.myfatoorah.com']};
export const paymentFormSources=Object.values(paymentHosts).flat().map(host=>'https://'+host).join(' ');
export function allowedPaymentURL(provider, raw) {
  if(typeof raw!=='string'||!raw.startsWith('https://'))return false;
  try {const url=new URL(raw),authority=raw.slice(8).split(/[/?#]/)[0];return !url.username&&!url.password&&!authority.includes(':')&&!!paymentHosts[provider]?.includes(url.hostname);}
  catch{return false;}
}
const paymentView=z.object({attemptId:z.string().max(128),status:z.string().max(40),provider:z.string().max(40),mode:z.enum(['','test','live']),
  url:z.string().url().optional(),widget:z.object({checkoutId:z.string().max(512),scriptUrl:z.string().url(),brands:z.array(z.string().max(40)),returnUrl:z.string().url()}).optional(),
});
const safeCodes = new Set(['invalid_request','invalid_quantity','invalid_option','phone_required',
  'address_required','country_required','location_required','outside_delivery_area','invalid_district',
  'district_unavailable','delivery_minimum','delivery_unavailable','store_closed','mode_unavailable',
  'item_unavailable','out_of_stock','payment_required','payment_unavailable','price_changed','conflict',
  'invalid_order_access','platform_unauthorized','not_found','order_not_found','invalid_status','invalid_payment_method',
  'channel_ordering_disabled','channel_ordering_unavailable','invalid_order_channel']);
const channelId=z.enum(['web','chatgpt','whatsapp_qr','whatsapp_cloud']);
const channelPolicy=z.object({channel:channelId,newOrdersEnabled:z.boolean(),adapterImplemented:z.boolean(),
  version:z.number().int().positive(),updatedAt:z.string().datetime({offset:true})});

export function createCoreOrderClient({ issuer, privateKey, restaurants, fetchImpl = fetch, now = Date.now }) {
  const source = new URL(issuer);
  if (source.protocol !== 'https:' || source.origin !== issuer) throw new Error('invalid_service_issuer');
  const signingKey = privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey);
  if (signingKey.asymmetricKeyType !== 'ed25519') throw new Error('ed25519_key_required');
  if (!Array.isArray(restaurants) || restaurants.length > 1000) throw new Error('invalid_restaurant_routes');
  const routes = new Map();
  for (const row of restaurants) {
    const parsed = z.object({ id, baseUrl: z.string().url() }).strict().parse(row);
    const url = new URL(parsed.baseUrl);
    if (!['https:','http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/'
        || url.search || url.hash || routes.has(parsed.id) || [...routes.values()].includes(url.origin)) throw new Error('invalid_restaurant_routes');
    routes.set(parsed.id, url.origin);
  }
  async function request(tenantId, subject, method, path, input, idempotencyKey = '', overrideScope, resultSchema=coreOrderView) {
    if (!routes.has(tenantId)) throw problem(404, 'restaurant_not_found');
    if (!uuid.safeParse(subject).success) throw problem(403, 'invalid_identity');
    const body = input === undefined ? '' : JSON.stringify(input);
    const issuedAt = Math.floor(now() / 1000);
    const claims = Buffer.from(JSON.stringify({ issuer, audience: tenantId, subject,
      scope: overrideScope ?? (method === 'POST' ? 'orders:write' : 'orders:read'), method, path,
      bodySha256: createHash('sha256').update(body).digest('hex'), idempotencyKey,
      issuedAt, expiresAt: issuedAt + 60 }));
    const authorization = `Platform ${claims.toString('base64url')}.${sign(null, claims, signingKey).toString('base64url')}`;
    let response;
    try {
      response = await fetchImpl(routes.get(tenantId) + path, { method, redirect: 'error',
        signal: AbortSignal.timeout(10_000), headers: { authorization, accept: 'application/json',
          ...(method === 'POST' ? { 'content-type': 'application/json', 'idempotency-key': idempotencyKey } : {}) },
        ...(method === 'POST' ? { body } : {}) });
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body ?? []) {
        bytes += chunk.length; if (bytes > 128_000) throw Error('oversized_response'); chunks.push(chunk);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok) throw problem([400,401,403,404,409].includes(response.status) ? response.status : 503,
        safeCodes.has(value?.error) ? value.error : 'restaurant_unavailable');
      const parsed=resultSchema.parse(value);
      if(resultSchema===paymentView&&parsed.attemptId&&!['test','live'].includes(parsed.mode))throw Error('invalid_payment_mode');
      if(resultSchema===paymentView&&parsed.url&&!allowedPaymentURL(parsed.provider,parsed.url))throw Error('unsafe_payment_url');
      return { tenantId, ...parsed };
    } catch (error) {
      if (safeCodes.has(error?.code) || error?.code === 'restaurant_unavailable') throw error;
      throw problem(503, method === 'POST' ? 'order_outcome_unknown' : 'restaurant_unavailable');
    }
  }
  return Object.freeze({
    channels(tenantId,subject){
      return request(tenantId,subject,'GET','/platform-api/staff/channels',undefined,'','staff:channels:manage',z.object({channels:z.array(channelPolicy).length(4)}));
    },
    setChannel(tenantId,subject,channel,input){
      const target=channelId.safeParse(channel),change=z.object({newOrdersEnabled:z.boolean(),expectedVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1)}).strict().safeParse(input);
      if(!target.success||!change.success)throw problem(400,'invalid_request');
      return request(tenantId,subject,'POST',`/platform-api/staff/channels/${target.data}`,change.data,'','staff:channels:manage',channelPolicy);
    },
    staffOrders(tenantId,subject) {
      return request(tenantId,subject,'GET','/platform-api/staff/orders',undefined,'','staff:orders:read',
        z.object({orders:z.array(coreOrderView).max(100),limit:z.literal(100)}));
    },
    staffChange(tenantId,subject,number,action,input) {
      if(!/^R[0-9]{8,20}$/.test(number??'')||!['status','cash'].includes(action))throw problem(400,'invalid_request');
      const version=z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1);
      const schema=action==='status'?z.object({version,status:z.enum(['new','accepted','preparing','ready','out_for_delivery','completed','cancelled'])}).strict():z.object({version}).strict();
      const parsed=schema.safeParse(input);if(!parsed.success)throw problem(400,'invalid_request');
      return request(tenantId,subject,'POST',`/platform-api/staff/orders/${number}/${action}`,parsed.data,'',
        action==='status'?'staff:orders:update':'staff:payments:collect');
    },
    create(tenantId, subject, input, idempotencyKey) {
      const parsed = orderInput.safeParse(input), key = uuid.safeParse(idempotencyKey);
      if (!parsed.success || !key.success || idempotencyKey[14] !== '4') throw problem(400, 'invalid_request');
      return request(tenantId, subject, 'POST', '/platform-api/orders', parsed.data, idempotencyKey);
    },
    status(tenantId, subject, number) {
      if (!/^R[0-9]{8,20}$/.test(number ?? '')) throw problem(400, 'invalid_request');
      return request(tenantId, subject, 'GET', `/platform-api/orders/${number}`);
    },
    recover(tenantId, subject, idempotencyKey) {
      if (!uuid.safeParse(idempotencyKey).success || idempotencyKey[14] !== '4') throw problem(400, 'invalid_request');
      return request(tenantId, subject, 'GET', `/platform-api/orders/by-idempotency/${idempotencyKey}`);
    },
    payment(tenantId,subject,number,action,provider) {
      if(!/^R[0-9]{8,20}$/.test(number??'')||!['status','start','refresh'].includes(action))throw problem(400,'invalid_request');
      if(action==='start'&&(typeof provider!=='string'||!/^[a-z]{1,40}$/.test(provider)))throw problem(400,'invalid_request');
      const path=`/platform-api/payments/${number}${action==='refresh'?'/refresh':''}`;
      return request(tenantId,subject,action==='status'?'GET':'POST',path,action==='status'?undefined:action==='start'?{provider}:{},'',
        action==='start'?'payments:write':'payments:read',paymentView);
    },
    async events(tenantId,subject,after=0,limit=100) {
      if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>100)throw problem(400,'invalid_request');
      const schema=z.object({events:z.array(z.object({sequence:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),order:coreOrderView})).max(100)});
      const result=await request(tenantId,subject,'GET',`/platform-api/order-events?after=${after}&limit=${limit}`,undefined,'','events:read',schema);
      let cursor=after;
      for(const event of result.events){if(event.sequence<=cursor)throw problem(502,'invalid_event_order');cursor=event.sequence;}
      return result;
    },
  });
}
