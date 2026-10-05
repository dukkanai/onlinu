/** Read-only bridge to the existing restaurant application, not the toy tenant.
 * Routing is deployment-owned. No caller can supply a URL, credentials or path.
 * Orders/payments remain unavailable here until an owned checkout is integrated.
 */
import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const money = z.number().int().min(0).max(40_000_000_000);
const text = z.string().max(4096);
const strings = z.array(text).max(100);
const option = z.object({ id, name: text, priceMinor: money, available: z.boolean() });
const brandFields = ['template', 'storefrontTemplate', 'primaryColor', 'primaryTextColor',
  'secondaryColor', 'secondaryTextColor', 'headingColor', 'bodyColor', 'pageColor',
  'cardColor', 'cartColor', 'borderColor', 'logoUrl', 'coverUrl', 'introImageUrl',
  'introTitle', 'introText', 'radius', 'shadow', 'font', 'headingFont', 'bodyFont',
  'buttonFont', 'imageFit', 'textSize', 'layout'];
const brand = z.object({ ...Object.fromEntries(brandFields.map(key => [key, text.optional()])), hideHero: z.boolean().optional() });
export const coreCatalogSchema = z.object({
  version: z.number().int().positive(),
  settings: z.object({ name: text, description: text, currency: z.literal('SAR'),
    acceptingOrders: z.boolean(), deliveryEnabled: z.boolean(), pickupEnabled: z.boolean(),
    tableEnabled: z.boolean(), demo: z.boolean(), openingHours: text,
    defaultLanguage: text, menuLanguage: text, brand: brand.nullish(),
    paymentMethods: z.record(z.string(), strings), taxEnabled: z.boolean(),
    taxRateBps: z.number().int().min(0).max(10000), deliveryFeeMinor: money,
    deliveryMinimumMinor: money, deliveryPricingMode: text.optional(),
  }),
  categories: z.array(z.object({ id, name: text, sort: z.number().int() })).max(1000),
  items: z.array(z.object({ id, categoryId: id, name: text, description: text,
    priceMinor: money, imageUrl: text, available: z.boolean(), sort: z.number().int(),
    options: z.array(option).max(100).nullish(),
  })).max(5000),
});
const address = z.object({ country: z.string().max(2), regionId: id.optional(), cityId: id.optional(),
  districtId: id.optional(), city: text.optional(), district: text.optional(), street: text.optional(),
  building: text.optional(), postalCode: text.optional(), additionalNumber: text.optional(),
  nationalAddress: text.optional(), addressLine: text.optional(), area: text.optional(),
  latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(),
}).strict();
export const coreQuoteInput = z.object({
  mode: z.enum(['pickup', 'delivery', 'table']),
  customerName: z.string().max(100), phone: z.string().max(40),
  items: z.array(z.object({ itemId: id, quantity: z.number().int().min(1).max(99),
    optionIds: z.array(id).max(30).optional(), }).strict()).min(1).max(50),
  address: address.optional(), tableCode: z.string().max(128).optional(),
  paymentMethod: z.string().max(40).optional(), paymentProvider: z.string().max(40).optional(),
  notes: z.string().max(1000).optional(),
}).strict();
export const corePreviewInput = z.object({
  mode: z.enum(['pickup', 'delivery', 'table']), items: coreQuoteInput.shape.items,
  address: z.object({ country: z.literal('SA'), regionId: id.optional(), cityId: id.optional(),
    districtId: id.optional(), area: z.string().max(120).optional(),
    latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(),
  }).strict().optional(), tableCode: z.string().max(128).optional(),
}).strict();
const taxSchema = z.object({ enabled: z.boolean(), rateBps: z.number().int().min(0).max(10000),
  number: text, netMinor: money, taxMinor: money, grossMinor: money });
export const coreQuoteSchema = z.object({ currency: z.literal('SAR'), totalMinor: money,
  subtotalMinor: money, deliveryFeeMinor: money, demo: z.boolean(),
  paymentMethods: strings, tax: taxSchema, tableName: text.optional(),
  items: z.array(z.object({ itemId: id, name: text, quantity: z.number().int().positive(),
    unitPriceMinor: money, totalMinor: money, options: z.array(option).nullish(),
  })).min(1).max(50),
});
const publicErrors = new Set(['invalid_request', 'invalid_quantity', 'invalid_option', 'phone_required',
  'store_closed', 'mode_unavailable', 'item_unavailable', 'out_of_stock', 'invalid_address',
  'delivery_unavailable', 'delivery_minimum', 'table_unavailable', 'payment_unavailable',
  'invalid_geography', 'invalid_district', 'district_unavailable', 'country_required',
  'address_required', 'location_required', 'outside_delivery_area', 'delivery_area_unavailable', 'rate_limited']);
function failure(code, status = 503) { return Object.assign(new Error(code), { code, status }); }

export function createCoreAdapter({ restaurants, fetchImpl = fetch, timeoutMs = 5000, maxBytes = 2_000_000 }) {
  if (!Array.isArray(restaurants) || restaurants.length > 1000
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
      || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 4_000_000) throw new Error('invalid_core_configuration');
  const routes = new Map();
  for (const entry of restaurants) {
    const parsed = z.object({ id, name: text, cuisine: text, baseUrl: z.string().url() }).strict().parse(entry);
    const url = new URL(parsed.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash || routes.has(parsed.id)
        || [...routes.values()].some(row => row.baseUrl === url.origin)) throw new Error('invalid_core_configuration');
    routes.set(parsed.id, Object.freeze({ ...parsed, baseUrl: url.origin }));
  }
  function route(tenantId) {
    if (typeof tenantId !== 'string' || !routes.has(tenantId)) throw failure('restaurant_not_found', 404);
    return routes.get(tenantId);
  }
  async function read(tenantId, path, schema, input) {
    const target = route(tenantId);
    let response;
    try {
      response = await fetchImpl(target.baseUrl + path, {
        method: input === undefined ? 'GET' : 'POST', redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json', ...(input === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw failure('invalid_restaurant_response', 502);
      const length = Number(response.headers.get('content-length'));
      if (length > maxBytes) { await response.body?.cancel(); throw failure('invalid_restaurant_response', 502); }
      const chunks = []; let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > maxBytes) throw failure('invalid_restaurant_response', 502);
        chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok) {
        const code = publicErrors.has(data?.error) ? data.error : 'restaurant_unavailable';
        throw failure(code, [400, 404, 409, 429].includes(response.status) ? response.status : 503);
      }
      return { tenantId, ...schema.parse(data) };
    } catch (error) {
      if (error?.code && (publicErrors.has(error.code) || ['invalid_restaurant_response', 'restaurant_unavailable'].includes(error.code))) throw error;
      throw failure(response?.ok ? 'invalid_restaurant_response' : 'restaurant_unavailable', response?.ok ? 502 : 503);
    }
  }
  return Object.freeze({
    listRestaurants({ query = '', cuisine } = {}) {
      if (typeof query !== 'string' || query.length > 100 || (cuisine !== undefined && typeof cuisine !== 'string')) throw failure('invalid_request', 400);
      const term = query.trim().toLocaleLowerCase();
      return [...routes.values()].filter(row => (!term || `${row.name} ${row.cuisine}`.toLocaleLowerCase().includes(term))
        && (!cuisine || row.cuisine === cuisine)).map(({ id, name, cuisine }) => ({ id, name, cuisine }));
    },
    getMenu: tenantId => read(tenantId, '/storefront-api/catalog', coreCatalogSchema),
    quote(tenantId, input) {
      route(tenantId);
      const parsed = coreQuoteInput.safeParse(input);
      if (!parsed.success) throw failure('invalid_request', 400);
      return read(tenantId, '/storefront-api/quote', coreQuoteSchema, parsed.data);
    },
    capabilities(tenantId) {
      route(tenantId);
      return { tenantId, source: 'existing_restaurant_core', readMenu: true, quote: true,
        quoteRequiresContact: true, cartPreviewWithoutContact: true,
        createOrder: false, payment: false, whatsappOrderIngress: false };
    },
    preview(tenantId, input) {
      route(tenantId);
      const parsed = corePreviewInput.safeParse(input);
      if (!parsed.success) throw failure('invalid_request', 400);
      return read(tenantId, '/storefront-api/preview', coreQuoteSchema, parsed.data);
    },
  });
}
