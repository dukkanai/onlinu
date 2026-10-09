import {openingScheduleView,openingSchedulePatch,openingScheduleMatches} from './opening-schedule.mjs';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { z } from 'zod';
import { coreQuoteInput, coreQuoteSchema, coreCatalogSchema } from './core-adapter.mjs';
import { problem } from './auth.mjs';

const uuid = z.string().uuid();
const courierId=z.string().regex(/^[a-f0-9]{32}$/);
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const orderInput = coreQuoteInput.extend({ expectedTotalMinor: z.number().int().min(0).max(100_000_000),
  notes: z.string().max(1000).optional(),expectedQuoteHash:z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict();
export const coreOrderView = z.object({ number: z.string().regex(/^R[0-9]{8,20}$/),
  version: z.number().int().positive(), status: z.string().max(40), paymentStatus: z.string().max(40),
  totalMinor: z.number().int().min(0).max(100_000_000), currency: z.literal('SAR'),
  mode: z.enum(['pickup','delivery','table']), updatedAt: z.string().datetime({ offset: true }),
  paymentMethod: z.string().max(40).optional(), paymentProvider: z.string().max(40).optional(),
  courierId:z.union([courierId,z.literal('')]).optional(),courierName:z.string().max(4096).optional(),deliveryStatus:z.string().max(40).optional(),
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
const safeCodes = new Set(['brand_changed','brand_invalid','brand_contrast','brand_no_draft','invalid_service_modes','forbidden','unauthorized','invalid_request','invalid_delivery_zones','invalid_geography','invalid_quantity','invalid_option','phone_required',
  'address_required','country_required','location_required','outside_delivery_area','invalid_district',
  'district_unavailable','delivery_minimum','delivery_unavailable','store_closed','mode_unavailable',
  'item_unavailable','out_of_stock','payment_required','payment_unavailable','price_changed','conflict',
  'invalid_order_access','platform_unauthorized','not_found','order_not_found','invalid_status','invalid_payment_method',
  'channel_ordering_disabled','channel_ordering_unavailable','invalid_order_channel','catalog_changed','quote_changed','image_invalid','image_too_large','body_too_large']);
const channelId=z.enum(['web','chatgpt']);
const channelPolicy=z.object({channel:channelId,newOrdersEnabled:z.boolean(),adapterImplemented:z.boolean(),
  version:z.number().int().positive(),updatedAt:z.string().datetime({offset:true})});
const stockItem=z.object({itemId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),name:z.string().max(4096).optional(),tracked:z.boolean(),available:z.number().int().nonnegative(),
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

const financeAmount=z.number().int().min(0).max(100_000_000);
const financeView=z.object({number:z.string().regex(/^R[0-9]{8,20}$/),orderVersion:z.number().int().positive(),totalMinor:financeAmount,currency:z.literal('SAR'),paymentMethod:z.string().max(40),paymentStatus:z.string().max(40),provider:z.string().max(40),demo:z.boolean(),capturedMinor:financeAmount,reservedMinor:financeAmount,refundedMinor:financeAmount,availableMinor:financeAmount,limit:z.literal(100),capability:z.object({automatic:z.boolean(),partial:z.boolean(),manual:z.boolean(),reason:z.string().max(100)}),refunds:z.array(z.object({id:z.string().uuid(),version:z.number().int().positive(),status:z.enum(['requested','processing','succeeded','failed','review','manual_reported']),provider:z.string().max(40),currency:z.literal('SAR'),amountMinor:financeAmount,taxMinor:financeAmount,confirmation:z.string().max(40),authorized:z.boolean(),submitted:z.boolean(),createdAt:z.string().datetime({offset:true}),updatedAt:z.string().datetime({offset:true})})).max(100)});
const refundDetail=financeView.shape.refunds.element.extend({number:coreOrderView.shape.number,orderVersion:coreOrderView.shape.version,orderTotalMinor:financeAmount,capturedMinor:financeAmount,demo:z.boolean(),reason:z.string().max(4000),providerReference:z.string().max(4096),manualReference:z.string().max(4096),resolutionReason:z.string().max(4000),capability:financeView.shape.capability});
const refundCommand=z.object({version:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1),reviewed:z.literal(true),amountMinor:financeAmount.refine(n=>n>0),currency:z.literal('SAR'),provider:z.string().max(40),demo:z.boolean(),reference:z.string().max(200).optional(),reason:z.string().max(1000).optional()}).strict();
function refundPath(number,refundId){if(!/^R[0-9]{8,20}$/.test(number??'')||!uuid.safeParse(refundId).success)throw problem(400,'invalid_request');return '/platform-api/staff/orders/'+number+'/refunds/'+refundId;}
const brandVersion=z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1);
const brandEditFields={storefrontTemplate:z.enum(['classic','bistro','editorial','compact','showcase']),font:z.enum(['system','serif']),headingFont:z.enum(['','system','serif','cairo','amiri','tajawal']),bodyFont:z.enum(['','system','serif','cairo','amiri','tajawal']),buttonFont:z.enum(['','system','serif','cairo','amiri','tajawal']),layout:z.enum(['grid','list']),textSize:z.enum(['normal','large']),radius:z.enum(['square','soft','round']),shadow:z.enum(['none','soft']),imageFit:z.enum(['cover','contain']),hideHero:z.boolean(),introTitle:z.string().max(640),introText:z.string().max(8000)};
const brandView=z.object({...brandEditFields,template:z.enum(['classic','warm','modern']),...Object.fromEntries(['primaryColor','primaryTextColor','secondaryColor','secondaryTextColor','headingColor','bodyColor','pageColor','cardColor','cartColor','borderColor'].map(key=>[key,z.string().regex(/^#[0-9a-fA-F]{6}$/)])),logoUrl:z.string().max(4096),coverUrl:z.string().max(4096),introImageUrl:z.string().max(4096)});
const brandState=z.object({version:brandVersion,catalogVersion:brandVersion,live:brandView,draft:brandView.nullable(),hasPrevious:z.boolean()});
const brandReview=z.object({version:brandVersion,catalogVersion:brandVersion,reviewed:z.literal(true)}).strict();
const brandPatch=brandReview.extend(Object.fromEntries(Object.entries(brandEditFields).map(([key,value])=>[key,value.optional()]))).strict().refine(v=>Object.keys(v).length>3);
const taxView=z.object({version:z.number().int().positive(),enabled:z.boolean(),rateBps:z.number().int().min(0).max(10000),taxNumber:z.string().max(320),currency:z.literal('SAR'),pricesIncludeTax:z.literal(true)});
const taxPatch=z.object({expectedVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1),reviewed:z.literal(true),enabled:z.boolean(),rateBps:z.number().int().min(0).max(10000),taxNumber:z.string().max(320).refine(text=>Array.from(text).length<=80)}).strict().refine(value=>!value.enabled||!!value.taxNumber.trim());
const supportCancellation=z.object({id:uuid,status:z.enum(['requested','approved','rejected']),reason:z.string().max(4000),decisionReason:z.string().max(4000),requestedAt:z.string().datetime({offset:true}),decidedAt:z.string().datetime({offset:true}).optional(),requestedBeforePreparation:z.boolean()});
const supportComplaint=z.object({id:uuid,status:z.enum(['open','resolved']),reason:z.string().max(4000),resolution:z.string().max(4000),requestedAt:z.string().datetime({offset:true}),resolvedAt:z.string().datetime({offset:true}).optional()});
const supportSummary=coreOrderView.extend({cancellationPending:z.boolean(),openComplaints:z.number().int().min(0).max(10)});
const supportDetail=supportSummary.extend({demo:z.boolean(),cancellation:supportCancellation.nullable(),complaints:z.array(supportComplaint).max(10),cancellationHistory:z.array(supportCancellation).max(20),historyLimit:z.literal(20),historyTruncated:z.boolean()});
const customerSupportDetail=coreOrderView.extend({demo:z.boolean(),cancellation:supportCancellation.nullable(),complaints:z.array(supportComplaint).max(10),cancellationHistory:z.array(supportCancellation).max(20),historyLimit:z.literal(20),historyTruncated:z.boolean()});
const customerSupportReceipt=z.object({order:customerSupportDetail,requestId:uuid,kind:z.enum(['cancellation','complaint']),recorded:z.boolean()});
const customerSupportCommand=z.object({version:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1),reviewed:z.literal(true),reason:z.string().trim().min(1).max(4000).refine(text=>Array.from(text).length<=1000)}).strict();
function customerSupportPath(number,kind,key){
  if(!/^R[0-9]{8,20}$/.test(number??'')||kind!==undefined&&!['cancellation','complaint'].includes(kind)||key!==undefined&&!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(key))throw problem(400,'invalid_request');
  return '/platform-api/customer-support/'+number+(kind?'/'+kind:'')+(key?'/'+key:'');
}
const supportCommand=z.object({version:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1),reviewed:z.literal(true),approve:z.boolean().optional(),reason:z.string().trim().min(1).max(4000)}).strict();
const serviceFields={acceptingOrders:z.boolean(),deliveryEnabled:z.boolean(),pickupEnabled:z.boolean(),tableEnabled:z.boolean()};
const serviceView=z.object({version:z.number().int().positive(),...serviceFields});
const servicePatch=z.object({expectedVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1),...Object.fromEntries(Object.entries(serviceFields).map(([key,value])=>[key,value.optional()]))}).strict().refine(v=>Object.keys(v).length>1);
const profileFields={name:z.string().min(1).max(120),description:z.string().max(2000),address:z.string().max(1000),phone:z.string().max(40),openingHours:z.string().max(1000),pickupInstructions:z.string().max(2000)};
const profileView=z.object({version:z.number().int().positive(),...profileFields});
const profilePatch=z.object({expectedVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1),...Object.fromEntries(Object.entries(profileFields).map(([key,value])=>[key,value.optional()]))}).strict().refine(value=>Object.keys(value).length>1);

const paymentMode=z.enum(['delivery','pickup','table']);
const configuredPaymentMethods=z.array(z.enum(['card','cash_on_delivery','cash_before','cash_after'])).max(3);
const validConfiguredMethods=v=>new Set(v.methods).size===v.methods.length&&v.methods.every(method=>method==='card'||v.mode==='delivery'&&method==='cash_on_delivery'||v.mode==='table'&&['cash_before','cash_after'].includes(method));
const paymentMethodsPatch=z.object({expectedVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1),mode:paymentMode,methods:configuredPaymentMethods}).strict().refine(validConfiguredMethods);
const paymentMethodsView=z.object({version:z.number().int().positive(),currency:z.literal('SAR'),demo:z.boolean(),modes:z.array(z.object({mode:paymentMode,enabled:z.boolean(),methods:configuredPaymentMethods}).refine(v=>validConfiguredMethods(v)&&(!v.enabled||v.methods.length>0))).length(3)}).refine(v=>new Set(v.modes.map(m=>m.mode)).size===3);

const deliveryLocationPatch=z.object({expectedVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1),origin:z.object({latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180)}).strict().nullable().optional(),radiusKm:z.number().min(0).max(500).optional(),requireLocation:z.boolean().optional()}).strict().refine(v=>Object.keys(v).some(k=>k!=='expectedVersion'));
const deliveryZone=z.object({districtId:menuId,enabled:z.boolean(),feeMinor:z.number().int().min(0).max(100_000_000).nullable()}).strict();
const deliveryView=z.object({version:z.number().int().positive(),currency:z.literal('SAR'),mode:z.enum(['flat','district']),feeMinor:z.number().int().min(0).max(100_000_000),minimumMinor:z.number().int().min(0).max(100_000_000),enabled:z.boolean(),acceptingOrders:z.boolean(),requireLocation:z.boolean(),radiusKm:z.number().min(0).max(500),latitude:z.number().min(-90).max(90).nullable().optional(),longitude:z.number().min(-180).max(180).nullable().optional(),zones:z.array(deliveryZone.extend({nameAr:z.string().max(4096),nameEn:z.string().max(4096),cityName:z.string().max(4096),regionName:z.string().max(4096),active:z.boolean()})).max(10000)}).refine(v=>{
 if(v.latitude===undefined&&v.longitude===undefined)return true; // Older read-only core responses.
 if(v.latitude===undefined||v.longitude===undefined)return false;
 if(v.latitude===null||v.longitude===null)return v.latitude===null&&v.longitude===null&&v.radiusKm===0;
 return true;
});
const geographyName={id:menuId,nameAr:z.string().max(4096),nameEn:z.string().max(4096)};
const geographyView=z.object({version:z.number().int().positive(),source:z.object({name:z.string().max(4096),revision:z.string().max(4096),license:z.string().max(100),notice:z.string().max(4096)}),regions:z.array(z.object(geographyName)).max(10000),cities:z.array(z.object({...geographyName,regionId:menuId})).max(10000),districts:z.array(z.object({...geographyName,regionId:menuId,cityId:menuId,custom:z.boolean()})).max(10000)});

const courierProfile=z.object({id:courierId,name:z.string().max(4096),active:z.boolean(),availability:z.enum(['available','busy','offline'])});
const courierLink=courierProfile.extend({version:z.number().int().nonnegative(),ownerRef:z.string().regex(/^platform:[a-f0-9]{64}$/).nullable(),activeOrders:z.number().int().nonnegative()});
const courierWork=z.object({courier:courierProfile.nullable(),bindingVersion:z.number().int().nonnegative(),orders:z.array(coreOrderView).max(100),limit:z.literal(100)});
const courierDetail=coreOrderView.extend({bindingVersion:z.number().int().positive(),customerName:z.string().max(4096),phone:z.string().max(4096),notes:z.string().max(2000),items:coreQuoteSchema.shape.items,
 address:z.object({addressLine:z.string().max(4096),nationalAddress:z.string().max(4096),city:z.string().max(4096),district:z.string().max(4096),street:z.string().max(4096),building:z.string().max(4096),postalCode:z.string().max(4096),additionalNumber:z.string().max(4096),latitude:z.number().min(-90).max(90).nullable(),longitude:z.number().min(-180).max(180).nullable()})});
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
    tax(tenantId,subject){return request(tenantId,subject,'GET','/platform-api/staff/tax',undefined,'','staff:tax:read',taxView);},
    patchTax(tenantId,subject,input){const parsed=taxPatch.safeParse(input);if(!parsed.success)throw problem(400,'invalid_request');return request(tenantId,subject,'POST','/platform-api/staff/tax',parsed.data,'','staff:tax:update',taxView).then(value=>{if(value.version!==parsed.data.expectedVersion+1||value.enabled!==parsed.data.enabled||value.rateBps!==parsed.data.rateBps||value.taxNumber!==parsed.data.taxNumber)throw problem(503,'order_outcome_unknown');return value;});},
    async customerSupport(tenantId,subject,number){
      const value=await request(tenantId,subject,'GET',customerSupportPath(number),undefined,'','customer:support:read',customerSupportDetail,512_000);
      if(value.number!==number)throw problem(503,'restaurant_unavailable');return value;
    },
    async customerSupportRecovery(tenantId,subject,number,kind,key){
      const path=customerSupportPath(number,kind,key);
      if(!kind||!key)throw problem(400,'invalid_request');
      const value=await request(tenantId,subject,'GET',path,undefined,'','customer:support:read',customerSupportReceipt,512_000);
      if(value.order.number!==number||value.requestId!==key||value.kind!==kind)throw problem(503,'restaurant_unavailable');return value;
    },
    customerSupportCommand(tenantId,subject,number,kind,key,input){
      customerSupportPath(number,kind,key);const parsed=customerSupportCommand.safeParse(input);
      if(!kind||!key||!parsed.success)throw problem(400,'invalid_request');
      return request(tenantId,subject,'POST',customerSupportPath(number,kind),parsed.data,key,'customer:support:write',customerSupportReceipt,512_000).then(value=>{
        if(value.order.number!==number||value.requestId!==key||value.kind!==kind||!value.recorded||value.order.version<=parsed.data.version)throw problem(503,'order_outcome_unknown');return value;
      });
    },
    async refund(tenantId,subject,number,refundId){const value=await request(tenantId,subject,'GET',refundPath(number,refundId),undefined,'','staff:refunds:read',refundDetail);if(value.number!==number||value.id!==refundId)throw problem(503,'restaurant_unavailable');return value;},
    refundCommand(tenantId,subject,number,refundId,action,input){
      const path=refundPath(number,refundId),parsed=refundCommand.safeParse(input);
      if(!['authorize','manual','verify','refresh'].includes(action)||!parsed.success)throw problem(400,'invalid_request');
      if(['authorize','refresh'].includes(action)&&(parsed.data.reference||parsed.data.reason))throw problem(400,'invalid_request');
      if(['manual','verify'].includes(action)&&(!parsed.data.reference?.trim()||!parsed.data.reason?.trim()))throw problem(400,'invalid_request');
      return request(tenantId,subject,'POST',path+'/'+action,parsed.data,'','staff:refunds:'+action,refundDetail).then(value=>{if(value.number!==number||value.id!==refundId||value.amountMinor!==parsed.data.amountMinor||value.currency!==parsed.data.currency||value.provider!==parsed.data.provider||value.demo!==parsed.data.demo)throw problem(503,'order_outcome_unknown');return value;});
    },
    brand(tenantId,subject){return request(tenantId,subject,'GET','/platform-api/staff/brand',undefined,'','staff:settings:read',brandState);},
    brandCommand(tenantId,subject,action,input){if(!['draft','publish','revert'].includes(action))throw problem(400,'invalid_request');const parsed=(action==='draft'?brandPatch:brandReview).safeParse(input);if(!parsed.success)throw problem(400,'invalid_request');return request(tenantId,subject,'POST','/platform-api/staff/brand/'+action,parsed.data,'','staff:brand:'+action,brandState);},
    support(tenantId,subject){return request(tenantId,subject,'GET','/platform-api/staff/support',undefined,'','staff:support:read',z.object({orders:z.array(supportSummary).max(100),limit:z.literal(100),hasMore:z.boolean()}),2_000_000);},
    async supportDetail(tenantId,subject,number){if(!/^R[0-9]{8,20}$/.test(number??''))throw problem(400,'invalid_request');const result=await request(tenantId,subject,'GET','/platform-api/staff/support/orders/'+number,undefined,'','staff:support:read',supportDetail,512_000);if(result.number!==number)throw problem(503,'restaurant_unavailable');return result;},
    supportCommand(tenantId,subject,number,id,action,input){
      const parsed=supportCommand.safeParse(input);
      if(!/^R[0-9]{8,20}$/.test(number??'')||!uuid.safeParse(id).success||!['decide','resolve'].includes(action)||!parsed.success||action==='decide'&&parsed.data.approve===undefined||action==='resolve'&&parsed.data.approve!==undefined)throw problem(400,'invalid_request');
      return request(tenantId,subject,'POST','/platform-api/staff/support/orders/'+number+'/'+id+'/'+action,parsed.data,'','staff:support:'+action,supportDetail,512_000).then(value=>{
        if(value.number!==number||value.version!==parsed.data.version+1||action==='decide'&&(value.cancellation?.id!==id||value.cancellation?.status!==(parsed.data.approve?'approved':'rejected'))||action==='resolve'&&!value.complaints.some(c=>c.id===id&&c.status==='resolved'))throw problem(503,'order_outcome_unknown');return value;
      });
    },
    finance(tenantId,subject,number){if(!/^R[0-9]{8,20}$/.test(number??''))throw problem(400,'invalid_request');return request(tenantId,subject,'GET','/platform-api/staff/orders/'+number+'/finance',undefined,'','staff:payments:read',financeView,2_000_000);},
    openingSchedule(tenantId,subject){return request(tenantId,subject,'GET','/platform-api/staff/opening-schedule',undefined,'','staff:settings:read',openingScheduleView);},
    patchOpeningSchedule(tenantId,subject,input){
      const parsed=openingSchedulePatch.safeParse(input);if(!parsed.success)throw problem(400,'invalid_request');
      return request(tenantId,subject,'POST','/platform-api/staff/opening-schedule',parsed.data,'','staff:settings:update',openingScheduleView).then(result=>{
        if(!openingScheduleMatches(result,parsed.data))throw problem(503,'order_outcome_unknown');return result;
      });
    },
    service(tenantId,subject){return request(tenantId,subject,'GET','/platform-api/staff/service',undefined,'','staff:settings:read',serviceView);},
    patchService(tenantId,subject,input){const parsed=servicePatch.safeParse(input);if(!parsed.success)throw problem(400,'invalid_request');return request(tenantId,subject,'POST','/platform-api/staff/service',parsed.data,'','staff:settings:update',serviceView);},
    principalRef(tenantId,subject){if(!routes.has(tenantId)||!uuid.safeParse(subject).success)throw problem(400,'invalid_request');return 'platform:'+createHash('sha256').update(issuer+'\0'+tenantId+'\0'+subject).digest('hex');},
    courierLinks(tenantId,subject){return request(tenantId,subject,'GET','/platform-api/staff/courier-links',undefined,'','staff:couriers:link',z.object({links:z.array(courierLink).max(500),limit:z.literal(500)}),2_000_000);},
    setCourierLink(tenantId,subject,id,input){const parsed=z.object({expectedVersion:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-1),ownerRef:z.union([z.string().regex(/^platform:[a-f0-9]{64}$/),z.literal('')])}).strict().safeParse(input);if(!courierId.safeParse(id).success||!parsed.success)throw problem(400,'invalid_request');return request(tenantId,subject,'POST','/platform-api/staff/courier-links/'+id,parsed.data,'','staff:couriers:link',courierLink);},
    courierWork(tenantId,subject){return request(tenantId,subject,'GET','/platform-api/courier/work',undefined,'','courier:read',courierWork,2_000_000);},
    courierDetail(tenantId,subject,number){if(!/^R[0-9]{8,20}$/.test(number??''))throw problem(400,'invalid_request');return request(tenantId,subject,'GET','/platform-api/courier/orders/'+number,undefined,'','courier:read',courierDetail,2_000_000);},
    courierChange(tenantId,subject,number,action,input){const version=z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1);const shape={version,bindingVersion:version,...(action==='status'?{status:z.enum(['picked_up','on_the_way','nearby','at_door','delivered'])}:{})};const parsed=z.object(shape).strict().safeParse(input);if(!['status','cash'].includes(action)||!/^R[0-9]{8,20}$/.test(number??'')||!parsed.success)throw problem(400,'invalid_request');return request(tenantId,subject,'POST','/platform-api/courier/orders/'+number+'/'+action,parsed.data,'',action==='status'?'courier:orders:update':'courier:cash:collect',coreOrderView);},
    courierAvailability(tenantId,subject,input){const parsed=z.object({bindingVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1),availability:z.enum(['available','busy','offline'])}).strict().safeParse(input);if(!parsed.success)throw problem(400,'invalid_request');return request(tenantId,subject,'POST','/platform-api/courier/availability',parsed.data,'','courier:availability:update',courierProfile);},
    couriers(tenantId,subject){return request(tenantId,subject,'GET','/platform-api/staff/couriers',undefined,'','staff:delivery:assign',z.object({limit:z.literal(500),couriers:z.array(z.object({id:courierId,name:z.string().max(4096),active:z.boolean(),availability:z.enum(['available','busy','offline'])})).max(500)}),2_000_000);},
    assignCourier(tenantId,subject,number,input){
      const parsed=z.object({version:z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1),courierId:z.union([courierId,z.literal('')])}).strict().safeParse(input);
      if(!/^R[0-9]{8,20}$/.test(number??'')||!parsed.success)throw problem(400,'invalid_request');
      return request(tenantId,subject,'POST',`/platform-api/staff/orders/${number}/courier`,parsed.data,'','staff:delivery:assign',coreOrderView.extend({courierId:z.union([courierId,z.literal('')]),courierName:z.string().max(4096),deliveryStatus:z.string().max(40)}));
    },
    paymentMethods(tenantId,subject){return request(tenantId,subject,'GET','/platform-api/staff/payment-methods',undefined,'','staff:settings:read',paymentMethodsView);},
    patchPaymentMethods(tenantId,subject,input){
      const parsed=paymentMethodsPatch.safeParse(input);if(!parsed.success)throw problem(400,'invalid_request');
      return request(tenantId,subject,'POST','/platform-api/staff/payment-methods',parsed.data,'','staff:settings:update',paymentMethodsView).then(result=>{
        const mode=result.modes.find(v=>v.mode===parsed.data.mode);
        if(result.version!==parsed.data.expectedVersion+1||JSON.stringify(mode?.methods)!==JSON.stringify(parsed.data.methods))throw problem(503,'order_outcome_unknown');
        return result;
      });
    },
    delivery(tenantId,subject){return request(tenantId,subject,'GET','/platform-api/staff/delivery',undefined,'','staff:settings:read',deliveryView,2_000_000);},
    patchDelivery(tenantId,subject,action,input){
      const version=z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1);
      const schema=action==='location'?deliveryLocationPatch:action==='pricing'?z.object({expectedVersion:version,mode:z.enum(['flat','district']),feeMinor:z.number().int().min(0).max(100_000_000),minimumMinor:z.number().int().min(0).max(100_000_000)}).strict():z.object({expectedVersion:version,zone:deliveryZone}).strict();
      const parsed=schema.safeParse(input);if(!['pricing','zone','location'].includes(action)||!parsed.success)throw problem(400,'invalid_request');
      return request(tenantId,subject,'POST','/platform-api/staff/delivery/'+action,parsed.data,'','staff:settings:update',deliveryView,2_000_000).then(result=>{
        if(action==='location'){
          const p=parsed.data;
          if(result.version!==p.expectedVersion+1||result.latitude===undefined||result.longitude===undefined||
            p.origin!==undefined&&(p.origin===null?result.latitude!==null||result.longitude!==null:result.latitude!==p.origin.latitude||result.longitude!==p.origin.longitude)||
            p.radiusKm!==undefined&&result.radiusKm!==p.radiusKm||p.requireLocation!==undefined&&result.requireLocation!==p.requireLocation)throw problem(503,'order_outcome_unknown');
        }
        return result;
      });
    },
    geography(tenantId,subject,kind,parent){
      if(!['regions','cities','districts'].includes(kind)||(kind==='regions'?parent!==undefined:!menuId.safeParse(parent).success))throw problem(400,'invalid_request');
      return request(tenantId,subject,'GET','/platform-api/staff/geography/'+kind+(parent?'/'+parent:''),undefined,'','staff:settings:read',geographyView,2_000_000);
    },
    profile(tenantId,subject){return request(tenantId,subject,'GET','/platform-api/staff/profile',undefined,'','staff:settings:read',profileView);},
    patchProfile(tenantId,subject,input){const parsed=profilePatch.safeParse(input);if(!parsed.success)throw problem(400,'invalid_request');return request(tenantId,subject,'POST','/platform-api/staff/profile',parsed.data,'','staff:settings:update',profileView);},
    uploadImage(tenantId,subject,bytes){
      if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>5*1024*1024)throw problem(400,'image_too_large');
      return request(tenantId,subject,'POST','/platform-api/staff/images',bytes,'','staff:media:write',z.object({url:z.string().regex(/^\/restaurant-media\/[a-f0-9]{64}\.(png|jpg)$/)}));
    },
    menu(tenantId,subject){
      return request(tenantId,subject,'GET','/platform-api/staff/menu',undefined,'','staff:menu:read',z.object({
        version:z.number().int().positive(),name:z.string().max(4096),currency:z.literal('SAR'),categories:coreCatalogSchema.shape.categories,
        items:z.array(z.object({id:menuId,categoryId:menuId,name:z.string().max(4096),priceMinor:z.number().int().min(0).max(100_000_000),available:z.boolean(),sort:z.number().int()})).max(5000),
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
      return request(tenantId,subject,'GET','/platform-api/staff/channels',undefined,'','staff:channels:manage',z.object({channels:z.array(channelPolicy).length(2)}));
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
