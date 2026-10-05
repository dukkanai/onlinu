import { createHash, createPrivateKey, sign } from 'node:crypto';
import { z } from 'zod';
import { coreQuoteInput, coreQuoteSchema, coreCatalogSchema } from './core-adapter.mjs';
import { problem } from './auth.mjs';

const uuid = z.string().uuid();
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const orderInput = coreQuoteInput.extend({ expectedTotalMinor: z.number().int().min(0).max(100_000_000),
  notes: z.string().max(1000).optional(),expectedQuoteHash:z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict();
export const coreOrderView = z.object({ number: z.string().regex(/^R[0-9]{8,20}$/),
  version: z.number().int().positive(), status: z.string().max(40), paymentStatus: z.string().max(40),
  totalMinor: z.number().int().min(0).max(100_000_000), currency: z.literal('SAR'),
  mode: z.enum(['pickup','delivery','table']), updatedAt: z.string().datetime({ offset: true }),
  paymentMethod: z.string().max(40).optional(), paymentProvider: z.string().max(40).optional(),
});
const coreOrderDetails=coreOrderView.extend({items:coreQuoteSchema.shape.items,tax:coreQuoteSchema.shape.tax,
  subtotalMinor:coreQuoteSchema.shape.subtotalMinor,deliveryFeeMinor:coreQuoteSchema.shape.deliveryFeeMinor,
  tableName:coreQuoteSchema.shape.tableName,demo:z.boolean(),createdAt:z.string().datetime({offset:true})});
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
  'channel_ordering_disabled','channel_ordering_unavailable','invalid_order_channel','catalog_changed','quote_changed','image_invalid','image_too_large','body_too_large']);
const channelId=z.enum(['web','chatgpt','whatsapp_qr','whatsapp_cloud']);
const channelPolicy=z.object({channel:channelId,newOrdersEnabled:z.boolean(),adapterImplemented:z.boolean(),
  version:z.number().int().positive(),updatedAt:z.string().datetime({offset:true})});
const stockItem=z.object({itemId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),tracked:z.boolean(),available:z.number().int().nonnegative(),
  held:z.number().int().nonnegative(),version:z.number().int().nonnegative(),updatedAt:z.string().datetime({offset:true})});
const menuId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
const menuItemView=z.object({version:z.number().int().positive(),currency:z.literal('SAR'),categories:coreCatalogSchema.shape.categories,
  item:coreCatalogSchema.shape.items.element});
const menuPatch=z.object({expectedVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1),
  name:z.string().min(1).max(320).optional(),description:z.string().max(4000).optional(),categoryId:menuId.optional(),
  priceMinor:z.number().int().min(0).max(100_000_000).optional(),imageUrl:z.string().max(4096).optional(),
  available:z.boolean().optional(),sort:z.number().int().min(0).max(10000).optional(),
  options:z.array(z.object({id:menuId,name:z.string().min(1).max(240),priceMinor:z.number().int().min(0).max(100_000_000),available:z.boolean()}).strict()).max(50).optional(),
}).strict().refine(value=>Object.keys(value).length>1);

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
  async function request(tenantId, subject, method, path, input, idempotencyKey = '', overrideScope, resultSchema=coreOrderView, maxBytes=128_000) {
    if (!routes.has(tenantId)) throw problem(404, 'restaurant_not_found');
    if (!uuid.safeParse(subject).success) throw problem(403, 'invalid_identity');
    const binary=Buffer.isBuffer(input);
    const body = input === undefined ? '' : binary?input:JSON.stringify(input);
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
          ...(method === 'POST' ? { 'content-type': binary?'application/octet-stream':'application/json', 'idempotency-key': idempotencyKey } : {}) },
        ...(method === 'POST' ? { body } : {}) });
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body ?? []) {
        bytes += chunk.length; if (bytes > maxBytes) throw Error('oversized_response'); chunks.push(chunk);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok) throw problem([400,401,403,404,409,413,429].includes(response.status) ? response.status : 503,
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
    uploadImage(tenantId,subject,bytes){
      if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>5*1024*1024)throw problem(400,'image_too_large');
      return request(tenantId,subject,'POST','/platform-api/staff/images',bytes,'','staff:media:write',z.object({url:z.string().regex(/^\/restaurant-media\/[a-f0-9]{64}\.(png|jpg)$/)}));
    },
    menu(tenantId,subject){
      return request(tenantId,subject,'GET','/platform-api/staff/menu',undefined,'','staff:menu:read',z.object({
        version:z.number().int().positive(),name:z.string().max(4096),currency:z.literal('SAR'),categories:coreCatalogSchema.shape.categories,
        items:z.array(z.object({id:menuId,categoryId:menuId,name:z.string().max(4096),priceMinor:z.number().int().min(0).max(100_000_000),available:z.boolean(),sort:z.number().int()})).max(1000),
      }),2_000_000);
    },
    menuItem(tenantId,subject,itemId){
      if(!menuId.safeParse(itemId).success)throw problem(400,'invalid_request');
      return request(tenantId,subject,'GET',`/platform-api/staff/menu/items/${itemId}`,undefined,'','staff:menu:read',menuItemView,2_000_000);
    },
    patchMenuItem(tenantId,subject,itemId,input){
      const parsed=menuPatch.safeParse(input);if(!menuId.safeParse(itemId).success||!parsed.success)throw problem(400,'invalid_request');
      return request(tenantId,subject,'POST',`/platform-api/staff/menu/items/${itemId}`,parsed.data,'','staff:menu:update',menuItemView,2_000_000);
    },
    createMenuItem(tenantId,subject,input){
      const schema=z.object({expectedVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1),item:z.object({
        id:menuId,categoryId:menuId,name:z.string().min(1).max(320),description:z.string().max(4000),priceMinor:z.number().int().min(0).max(100_000_000),
        imageUrl:z.string().max(4096),available:z.boolean(),sort:z.number().int().min(0).max(10000),options:coreCatalogSchema.shape.items.element.shape.options,
      }).strict()}).strict();
      const parsed=schema.safeParse(input);if(!parsed.success)throw problem(400,'invalid_request');
      return request(tenantId,subject,'POST','/platform-api/staff/menu/items',parsed.data,'','staff:menu:update',menuItemView,2_000_000);
    },
    createMenuCategory(tenantId,subject,input){
      const category=z.object({id:menuId,name:z.string().min(1).max(240),sort:z.number().int().min(0).max(10000)}).strict();
      const schema=z.object({expectedVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1),category}).strict();
      const parsed=schema.safeParse(input);if(!parsed.success)throw problem(400,'invalid_request');
      return request(tenantId,subject,'POST','/platform-api/staff/menu/categories',parsed.data,'','staff:menu:update',z.object({version:z.number().int().positive(),category}));
    },
    patchMenuCategory(tenantId,subject,categoryId,input){
      const schema=z.object({expectedVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1),name:z.string().min(1).max(240),sort:z.number().int().min(0).max(10000)}).strict();
      const parsed=schema.safeParse(input);if(!menuId.safeParse(categoryId).success||!parsed.success)throw problem(400,'invalid_request');
      return request(tenantId,subject,'POST',`/platform-api/staff/menu/categories/${categoryId}`,parsed.data,'','staff:menu:update',z.object({version:z.number().int().positive(),category:coreCatalogSchema.shape.categories.element}));
    },
    stock(tenantId,subject){
      return request(tenantId,subject,'GET','/platform-api/staff/stock',undefined,'','staff:stock:read',z.object({items:z.array(stockItem).max(5000)}),2_000_000);
    },
    setStock(tenantId,subject,itemId,input){
      const parsed=z.object({tracked:z.boolean(),available:z.number().int().min(0).max(1_000_000),version:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-1)}).strict().safeParse(input);
      if(!/^[A-Za-z0-9_-]{1,128}$/.test(itemId??'')||!parsed.success)throw problem(400,'invalid_request');
      return request(tenantId,subject,'POST',`/platform-api/staff/stock/${itemId}`,parsed.data,'','staff:stock:update',stockItem);
    },
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
    staffOrder(tenantId,subject,number){
      if(!/^R[0-9]{8,20}$/.test(number??''))throw problem(400,'invalid_request');
      return request(tenantId,subject,'GET',`/platform-api/staff/orders/${number}`,undefined,'','staff:orders:read',
        coreOrderView.extend({items:coreQuoteSchema.shape.items,notes:z.string().max(2000),tableName:z.string().max(4096).optional(),createdAt:z.string().datetime({offset:true})}),2_000_000);
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
    details(tenantId, subject, number) {
      if (!/^R[0-9]{8,20}$/.test(number ?? '')) throw problem(400, 'invalid_request');
      return request(tenantId,subject,'GET',`/platform-api/order-details/${number}`,undefined,'','orders:read',coreOrderDetails,2_000_000);
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
