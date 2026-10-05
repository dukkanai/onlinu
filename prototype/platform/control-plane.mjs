import {createRequestLimiter} from './request-limits.mjs';
import {createStaffApi} from './staff-api.mjs';
import {createNativeStaff} from './native-staff.mjs';
import {createCoreMedia,publicMenuImages} from './core-media.mjs';
import { randomUUID } from 'node:crypto';
import { checkoutSummary, checkoutErrorPage } from './checkout-pages.mjs';
/** Real subject-based identity and staff control API, separate from demo routes.
 * Deployment still needs approved HTTPS/OIDC configuration. No public bootstrap,
 * Docker socket or production provisioning is exposed by this module. Payment
 * actions reuse the owned original-core handoff rather than accepting money here.
 */
import { createIdentityDirectory, RESTAURANT_PERMISSIONS } from './identity-directory.mjs';
import { createAuth, problem } from './auth.mjs';
import { createOidcLogin } from './oidc.mjs';
import { createCoreAdapter } from './core-adapter.mjs';
import { createMcpHandler } from './mcp.mjs';
import { createCoreOrderClient, paymentFormSources } from './core-order-client.mjs';
import { createCoreCheckouts } from './core-checkouts.mjs';
import { createEvents } from './events.mjs';
import { createCoreEventWorker } from './core-events.mjs';
import { staffRefundPage, refundActions, staffFinancePage, staffServicePage, staffDispatchPage, staffDeliveryPage, staffProfilePage, staffHome, staffMembersPage, staffErrorPage, staffOrdersPage, staffChannelsPage, staffStockPage, staffMenuPage, staffMenuItemPage, menuPriceMinor } from './staff-pages.mjs';

const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const cookieName = '__Host-platform_session';
const bindingName = '__Host-platform_oidc';
function cookie(name, value, age) { return `${name}=${value}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}`; }
function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
function htmlHeaders(res,status=200) {
  // Fetch sets Origin:null for non-CORS form POSTs under no-referrer. Preserve
  // the same-origin Origin check without leaking page URLs to payment providers.
  // https://fetch.spec.whatwg.org/#append-a-request-origin-header
  res.setHeader('referrer-policy','same-origin');
  res.writeHead(status,{'content-type':'text/html; charset=utf-8'});
}
function redirect(res, target, status=302) { res.writeHead(status, { location: target }); res.end(); }
function fields(entries) {
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw problem(400, 'duplicate_parameter');
  return Object.fromEntries(entries);
}
async function body(req,maxBytes=32768) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > maxBytes) throw problem(413, 'body_too_large'); chunks.push(chunk); }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) return fields([...new URLSearchParams(raw)]);
  if (!req.headers['content-type']?.startsWith('application/json')) throw problem(415, 'json_required');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw problem(400, 'invalid_json'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw problem(400, 'invalid_json');
  return parsed;
}

export async function createControlPlane({ pool, baseUrl, oidc, csrfKey, restaurants = [], redirectAllowlist = [], serviceSigningKey, eventsEncryptionKey, nativeStaffEnabled=false, trustedProxyCidrs=[] }, { oidcClientAdapter, webhookFetch } = {}) {
  if(typeof nativeStaffEnabled!=='boolean')throw new Error('invalid_native_staff_configuration');
  const rate = createRequestLimiter({trustedProxyCidrs});
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.username || base.password || base.search || base.hash) throw new Error('control_plane_requires_https_origin');
  const directory = createIdentityDirectory({ pool, trustedIssuers: [new URL(oidc.issuer).href] });
  await directory.init();
  let events=null,eventWorker=null,timer;
  const auth = createAuth({ pool, baseUrl: base.origin, cookieName, allowSyntheticAuthorization: false,
    csrfKey, principalResolver: directory.resolve, redirectAllowlist,
    onGrantRevoked:async(id,db)=>{if(events)await events.revokeAll(id,db);} });
  await auth.init();
  const login = createOidcLogin({ pool, ...oidc, baseUrl: base.origin,
    identityResolver: directory.verifiedIdentity, clientAdapter: oidcClientAdapter });
  await login.init();
  const core = createCoreAdapter({ restaurants });
  const media=createCoreMedia({restaurants}),uploads={active:0};
  const publicCore = {
    async listRestaurants(args) {
      const configured = core.listRestaurants(args);
      const published = new Map((await directory.published(configured.map(row => row.id))).map(row => [row.id, row]));
      return configured.filter(row => published.has(row.id)).map(row => ({ ...row, name: published.get(row.id).name }));
    },
    async getMenu(tenantId) {
      if (!(await directory.published([tenantId])).length) throw problem(404, 'restaurant_not_found');
      return publicMenuImages(base.origin,tenantId,await core.getMenu(tenantId));
    },
    async preview(tenantId, input) {
      if (!(await directory.published([tenantId])).length) throw problem(404, 'restaurant_not_found');
      return core.preview(tenantId, input);
    },
  };
  const orderClient = serviceSigningKey ? createCoreOrderClient({ issuer: base.origin, privateKey: serviceSigningKey,
    restaurants: restaurants.map(({id,baseUrl})=>({id,baseUrl})) }) : null;
  const checkouts = orderClient ? createCoreCheckouts({ pool, baseUrl: base.origin, core, orderClient,
    resolvePrincipal: directory.resolve, isTenantActive: async id=>(await directory.published([id])).length===1 }) : null;
  if(checkouts)await checkouts.init();
  if(eventsEncryptionKey){
    if(!orderClient)throw new Error('events_require_owned_core_integration');
    events=createEvents({pool,encryptionKey:eventsEncryptionKey,webhookFetch,authorizeOrder:async(identity,args)=>{
      if(!await directory.resolve(identity.id))throw problem(403,'identity_disabled');
      const consent=await pool.query(`SELECT 1 FROM demo_sessions s LEFT JOIN demo_oauth_grants g ON g.id=s.oauth_family_id
        WHERE s.principal_id=$1 AND s.session_kind='oauth' AND s.expires_at>now() AND s.scopes ? 'events:read'
          AND (s.oauth_family_id IS NULL OR (g.revoked=FALSE AND g.expires_at>now()))
        UNION SELECT 1 FROM demo_oauth_grants WHERE principal_id=$1 AND revoked=FALSE AND expires_at>now() AND scopes ? 'events:read' LIMIT 1`,[identity.id]);
      if(!consent.rows.length)throw problem(403,'event_grant_expired');
      return orderClient.status(args.tenantId,identity.id,args.orderId);
    }});await events.init();
    eventWorker=createCoreEventWorker({pool,orderClient,events,resolvePrincipal:directory.resolve});await eventWorker.init();
  }
  const mcp = createMcpHandler({ baseUrl: base.origin, authenticate: req => auth.authenticate(req, { bearerOnly: true }), coreAdapter: publicCore, coreCheckouts: checkouts,events });
  const staffApi=createStaffApi({directory,orderClient,body,json,uploadSlots:uploads});
  if(nativeStaffEnabled&&!orderClient)throw new Error('native_staff_requires_core_signing');
  const nativeStaff=nativeStaffEnabled?await createNativeStaff({pool,baseUrl:base.origin,csrfKey,directory,browserAuth:auth,staffApi,body,json,htmlHeaders,redirect}):null;
  async function browser(req) {
    // Customer OAuth grants never confer staff/control-plane privileges.
    if (req.headers.authorization) throw problem(403, 'browser_session_required');
    const who = await auth.authenticate(req, { cookieOnly: true });
    if (!who) throw problem(401, 'authentication_required');
    return who;
  }
  async function handle(req, res) {
    res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    try {
      if (req.headers.host !== base.host || (req.headers.origin && req.headers.origin !== base.origin)) throw problem(403, 'origin_rejected');
      const url = new URL(req.url, base);
      if (url.searchParams.has('access_token')) throw problem(400, 'token_in_url_forbidden');
      rate(req);
      if (req.url === '/health' && req.method === 'GET') { await pool.query('SELECT 1'); return json(res, 200, { status: 'ok', mode: 'core_control_plane', ordersEnabled: !!checkouts }); }
      const publicImage=/^\/restaurant-media\/([a-z0-9-]{1,64})\/([a-f0-9]{64}\.(?:png|jpg))$/.exec(url.pathname);
      if(publicImage&&req.method==='GET'){
        const [,tenantId,name]=publicImage;if(url.search)throw problem(400,'invalid_request');
        if(!(await directory.published([tenantId])).length)throw problem(404,'not_found');
        const result=await media.image(tenantId,name);
        res.writeHead(200,{'content-type':result.type,'content-length':result.bytes.length,'cache-control':'public, max-age=300','content-security-policy':"default-src 'none'; sandbox"});res.end(result.bytes);return;
      }
      if(nativeStaff&&(url.pathname.startsWith('/native/')||['/.well-known/oauth-authorization-server/native','/.well-known/oauth-protected-resource/native/api'].includes(url.pathname)))return await nativeStaff.handle(req,res,url);
      if (url.pathname === '/mcp') return await mcp(req, res);
      if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') return json(res, 200, auth.resourceMetadata);
      if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') return json(res, 200, auth.metadata);
      if (req.method === 'POST' && ['/oauth/register','/oauth/token','/oauth/revoke'].includes(url.pathname)) {
        const input = await body(req);
        if (url.pathname === '/oauth/register') return json(res, 201, await auth.register(input));
        if (url.pathname === '/oauth/token') return json(res, 200, await auth.exchange(input));
        await auth.revoke(input.token); return json(res, 200, {});
      }
      if (req.method === 'GET' && url.pathname === '/auth/login') {
        const params = fields([...url.searchParams]);
        if (Object.keys(params).some(key => key !== 'returnTo')) throw problem(400, 'invalid_request');
        const flow = await login.begin(params.returnTo ?? '/');
        res.setHeader('set-cookie', cookie(bindingName, flow.bindingCookie, 600));
        return redirect(res, flow.authorizationUrl);
      }
      if (req.method === 'GET' && url.pathname === '/auth/callback') {
        const matches = (req.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(bindingName + '='));
        const binding = matches.length === 1 ? matches[0].slice(bindingName.length + 1) : '';
        res.setHeader('set-cookie', cookie(bindingName, '', 0));
        const identity = await login.complete(url.href, binding);
        await auth.revoke(auth.browserToken(req));
        const session = await auth.issue(identity.principalId, undefined, { kind: 'browser' });
        res.setHeader('set-cookie', [cookie(bindingName, '', 0), cookie(cookieName, session.accessToken, 1800)]);
        return redirect(res, identity.returnTo);
      }
      if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
        const input = fields([...url.searchParams]); await auth.validateAuthorization(input);
        const who = await auth.authenticate(req, { cookieOnly: true });
        if (!who) return redirect(res, '/auth/login?returnTo=' + encodeURIComponent(url.pathname + url.search));
        const hidden = Object.entries(input).map(([key, value]) => `<input type="hidden" name="${escape(key)}" value="${escape(value)}">`).join('');
        // validateAuthorization checked the registered exact redirect URI.
        // Allow only that client's origin for the form's authorization redirect.
        res.setHeader('content-security-policy',`default-src 'none'; form-action 'self' ${new URL(input.redirect_uri).origin}; frame-ancestors 'none'; base-uri 'none'`);
        htmlHeaders(res);
        res.end(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>موافقة الربط</title><h1>ربط حسابك</h1><p>الصلاحيات المطلوبة: ${escape(input.scope)}</p><p>العميل: ${escape(input.client_id)}</p><form method="post" action="/oauth/authorize">${hidden}<input type="hidden" name="csrf" value="${escape(auth.csrfToken(req))}"><button name="approve" value="yes">موافقة</button><button name="approve" value="no">رفض</button></form></html>`); return;
      }
      if (['POST','PATCH','PUT','DELETE'].includes(req.method)) {
        if (req.headers.origin !== base.origin) throw problem(403, 'origin_required');
      }
      if (req.method === 'POST' && url.pathname === '/oauth/authorize') {
        const who = await browser(req), input = await body(req);
        auth.verifyCsrf(req, input.csrf);
        const { csrf, approve, ...grant } = input;
        if (approve !== 'yes') throw problem(403, 'consent_declined');
        const destination=await auth.authorize(grant, who);
        res.setHeader('content-security-policy',`default-src 'none'; form-action 'self' ${new URL(destination).origin}; frame-ancestors 'none'; base-uri 'none'`);
        return redirect(res, destination);
      }
      if (req.method === 'POST' && url.pathname === '/auth/logout') {
        auth.verifyCsrf(req); await auth.revoke(auth.browserToken(req));
        res.setHeader('set-cookie', cookie(cookieName, '', 0)); return json(res, 200, { loggedOut: true });
      }
      const checkoutRoute=/^\/checkout\/([a-f0-9-]{36})(?:\/(confirm|payment|refresh-payment))?$/.exec(url.pathname);
      if(checkoutRoute && checkouts) {
        // Browsers also apply form-action to the payment POST's redirect target.
        // Keep the allowlist identical to the validated provider URL policy.
        res.setHeader('content-security-policy', `default-src 'none'; form-action 'self' ${paymentFormSources}; frame-ancestors 'none'; base-uri 'none'`);
        const who=await auth.authenticate(req,{cookieOnly:true});
        if(!who) {
          if(req.method==='GET')return redirect(res,'/auth/login?returnTo='+encodeURIComponent('/checkout/'+checkoutRoute[1]));
          throw problem(401,'authentication_required');
        }
        if(req.headers.authorization)throw problem(403,'browser_session_required');
        const checkoutId=checkoutRoute[1];
        if(req.method==='GET'&&!checkoutRoute[2]) {
          const checkout=await checkouts.get(who,checkoutId);
          const csrf=auth.csrfToken(req);
          const methods=checkout.quote.paymentMethods.map(value=>`<option value="${escape(value)}">${escape(value)}</option>`).join('');

          if(checkout.state==='confirmed') {
            const order=await checkouts.details(who,checkout.tenantId,checkout.orderId);
            const button=(action,label)=>`<form method="post" action="/checkout/${checkoutId}/${action}"><input type="hidden" name="csrf" value="${escape(csrf)}"><button>${label}</button></form>`;
            const pay=order.paymentMethod==='card'&&['unpaid','pending'].includes(order.paymentStatus)?button('payment','الانتقال لصفحة الدفع'):'';
            const refresh=order.paymentMethod==='card'?button('refresh-payment','التحقق من حالة الدفع'):'';
            htmlHeaders(res);
            res.end(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>طلبك</title><h1>طلب ${escape(order.number)}</h1><p>حالة الطلب: ${escape(order.status)}</p><p>حالة الدفع: ${escape(order.paymentStatus)}</p>${checkoutSummary(order)}${pay}${refresh}<p>لا يعتبر الدفع مكتملًا إلا بعد التحقق لدى مزود الدفع.</p></html>`);return;
          }
          const providers=(await core.payments(checkout.tenantId)).providers.filter(row=>['stripe','moyasar','tap','paytabs','geidea','myfatoorah'].includes(row.id));
          const providerOptions=providers.map(row=>`<option value="${escape(row.id)}">${escape(row.name)}${row.mode==='test'?' (اختبار)':''}</option>`).join('');
          htmlHeaders(res);
          const delivery=checkout.cart.mode==='delivery'?'<fieldset><legend>عنوان التوصيل</legend><label>العنوان التفصيلي <textarea name="addressLine" maxlength="500"></textarea></label><label>العنوان الوطني أو المختصر <input name="nationalAddress" maxlength="300"></label></fieldset>':'';
          res.end(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>تأكيد الطلب</title><h1>راجع الطلب ثم أكّد</h1>${checkoutSummary(checkout.quote)}<form method="post" action="/checkout/${checkoutId}/confirm"><input type="hidden" name="csrf" value="${escape(csrf)}"><label>الاسم <input name="customerName" required maxlength="100" autocomplete="name"></label><label>الهاتف <input name="phone" type="tel" maxlength="40" autocomplete="tel"></label>${delivery}<label>طريقة الدفع <select name="paymentMethod">${methods}</select></label><label>مزود الدفع الإلكتروني <select name="paymentProvider"><option value="">اختر المزود عند الدفع الإلكتروني</option>${providerOptions}</select></label><label>ملاحظات <textarea name="notes" maxlength="1000"></textarea></label><button type="submit">تأكيد وإنشاء الطلب</button></form><p>هذه الخطوة تنشئ الطلب فقط، ولا تثبت سدادًا إلكترونيًا.</p></html>`);return;
        }
        if(req.method==='POST'&&['payment','refresh-payment'].includes(checkoutRoute[2])) {
          const input=await body(req);auth.verifyCsrf(req,input.csrf);
          if(Object.keys(input).some(key=>key!=='csrf'))throw problem(400,'invalid_request');
          const payment=await checkouts.payment(who,checkoutId,checkoutRoute[2]==='payment'?'start':'refresh');
          if(checkoutRoute[2]==='refresh-payment'||payment.status==='paid')return redirect(res,'/checkout/'+checkoutId,303);
          if(payment.status==='review')throw problem(409,'payment_requires_review');
          if(!payment.url)throw problem(409,'payment_link_unavailable');
          res.writeHead(303,{location:payment.url});res.end();return;
        }
        if(req.method==='POST'&&checkoutRoute[2]==='confirm') {
          const input=await body(req);auth.verifyCsrf(req,input.csrf);
          const {csrf,...submitted}=input;
          let contact=submitted;
          if(req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
            const allowed=['customerName','phone','paymentMethod','paymentProvider','notes','addressLine','nationalAddress'];
            if(Object.keys(submitted).some(key=>!allowed.includes(key)))throw problem(400,'invalid_request');
            const {addressLine,nationalAddress,...rest}=submitted;contact=rest;
            if(addressLine||nationalAddress)contact.address={country:'SA',...(addressLine?{addressLine}:{}),...(nationalAddress?{nationalAddress}:{})};
            if(contact.paymentMethod!=='card')contact.paymentProvider='';
          }
          const order=await checkouts.confirm(who,checkoutId,contact);
          if(req.headers.accept?.includes('application/json'))return json(res,200,{order});
          return redirect(res,'/checkout/'+checkoutId,303);
        }
      }
      const managementDispatch=/^\/manage\/([a-z0-9-]{1,64})\/orders\/(R[0-9]{8,20})\/courier$/.exec(url.pathname);
      if(managementDispatch&&orderClient&&['GET','POST'].includes(req.method)){
        if(req.headers.authorization||url.search)throw problem(403,'browser_session_required');
        if(req.method==='GET'&&!await auth.authenticate(req,{cookieOnly:true}))return redirect(res,'/auth/login?returnTo='+encodeURIComponent(url.pathname));
        const who=await browser(req),[,tenantId,number]=managementDispatch;
        await directory.authorize(who.id,tenantId,'orders:read');await directory.authorize(who.id,tenantId,'delivery:assign');
        if(req.method==='GET'){
          const order=await orderClient.staffOrder(tenantId,who.id,number);
          if(order.mode!=='delivery'||['completed','cancelled'].includes(order.status)||order.deliveryStatus==='delivered')throw problem(409,'invalid_status');
          const {couriers}=await orderClient.couriers(tenantId,who.id);htmlHeaders(res);res.end(staffDispatchPage({tenantId,order,couriers,csrf:auth.csrfToken(req)}));return;
        }
        const input=await body(req);auth.verifyCsrf(req,input.csrf);
        if(input.reviewed!=='yes'||typeof input.courierId!=='string'||input.courierId===''||Object.keys(input).some(k=>!['csrf','version','courierId','reviewed'].includes(k)))throw problem(400,'invalid_request');
        await orderClient.assignCourier(tenantId,who.id,number,{version:Number(input.version),courierId:input.courierId==='__remove__'?'':input.courierId});
        return redirect(res,'/manage/'+tenantId+'/orders/'+number,303);
      }
      const managementDelivery=/^\/manage\/([a-z0-9-]{1,64})\/delivery(?:\/(pricing|zone))?$/.exec(url.pathname);
      if(managementDelivery&&orderClient){
        const [,tenantId,action]=managementDelivery;
        if(req.headers.authorization)throw problem(403,'browser_session_required');
        if(!(req.method==='GET'&&!action||req.method==='POST'&&action))throw problem(400,'invalid_request');
        if(req.method==='GET'&&!await auth.authenticate(req,{cookieOnly:true}))return redirect(res,'/auth/login?returnTo='+encodeURIComponent(url.pathname+url.search));
        const who=await browser(req),membership=await directory.authorize(who.id,tenantId,req.method==='GET'?'settings:read':'settings:update');
        if(req.method==='GET'){
          const query=fields([...url.searchParams]),region=query.region||'',city=query.city||'',search=query.filter||'',pageIndex=Number(query.page||'1')-1;
          if(Object.keys(query).some(k=>!['region','city','filter','page'].includes(k))||search.length>120||!Number.isInteger(pageIndex)||pageIndex<0||pageIndex>199||city&&!region)throw problem(400,'invalid_request');
          const data=await orderClient.delivery(tenantId,who.id),regions=await orderClient.geography(tenantId,who.id,'regions');
          if(region&&!regions.regions.some(v=>v.id===region))throw problem(400,'invalid_request');
          const cities=region?await orderClient.geography(tenantId,who.id,'cities',region):null;
          if(city&&!cities.cities.some(v=>v.id===city))throw problem(400,'invalid_request');
          const districts=city?await orderClient.geography(tenantId,who.id,'districts',city):null;
          htmlHeaders(res);res.end(staffDeliveryPage({tenantId,data,regions,cities,districts,region,city,search,pageIndex,canUpdate:membership.permissions.includes('settings:update'),csrf:auth.csrfToken(req)}));return;
        }
        if(url.search)throw problem(400,'invalid_request');
        const input=await body(req);auth.verifyCsrf(req,input.csrf);
        const allowed=action==='pricing'?['csrf','expectedVersion','reviewed','mode','feeMinor','minimumMinor']:['csrf','expectedVersion','reviewed','districtId','enabled','feeMinor'];
        if(input.reviewed!=='yes'||Object.keys(input).some(k=>!allowed.includes(k)))throw problem(400,'invalid_request');
        const fee=input.feeMinor===''?null:menuPriceMinor(input.feeMinor);
        if(action==='pricing'){
          const minimum=menuPriceMinor(input.minimumMinor);if(fee===null||minimum===null)throw problem(400,'invalid_request');
          await orderClient.patchDelivery(tenantId,who.id,action,{expectedVersion:Number(input.expectedVersion),mode:input.mode,feeMinor:fee,minimumMinor:minimum});
        }else{
          if(!['true','false'].includes(input.enabled)||typeof input.feeMinor!=='string'||input.feeMinor!==''&&fee===null||input.enabled==='true'&&fee===null)throw problem(400,'invalid_request');
          await orderClient.patchDelivery(tenantId,who.id,action,{expectedVersion:Number(input.expectedVersion),zone:{districtId:input.districtId,enabled:input.enabled==='true',feeMinor:fee}});
        }
        return redirect(res,'/manage/'+tenantId+'/delivery'+(action==='zone'?'?filter='+encodeURIComponent(input.districtId):''),303);
      }
      const managementRefund=/^\/manage\/([a-z0-9-]{1,64})\/orders\/(R[0-9]{8,20})\/refunds\/([a-f0-9-]{36})(?:\/(review|execute))?$/.exec(url.pathname);
      if(managementRefund&&orderClient){
        const [,tenantId,number,refundId,stage]=managementRefund,path='/manage/'+tenantId+'/orders/'+number+'/refunds/'+refundId;
        if(req.headers.authorization||!(req.method==='GET'&&!stage||req.method==='POST'&&stage)||url.search&&!(req.method==='GET'&&url.search==='?outcome=unknown'))throw problem(400,'invalid_request');
        if(req.method==='GET'&&!await auth.authenticate(req,{cookieOnly:true}))return redirect(res,'/auth/login?returnTo='+encodeURIComponent(path));
        const who=await browser(req),authorize=async()=>{for(const grant of ['orders:read','payments:read','refunds:manage'])await directory.authorize(who.id,tenantId,grant);};
        await authorize();
        if(req.method==='GET'){const data=await orderClient.refund(tenantId,who.id,number,refundId);htmlHeaders(res);res.end(staffRefundPage({tenantId,data,csrf:auth.csrfToken(req),unknown:!!url.search}));return;}
        const input=await body(req);auth.verifyCsrf(req,input.csrf);await authorize();
        if(!['authorize','manual','verify','refresh'].includes(input.action))throw problem(400,'invalid_request');
        const allowed=stage==='review'?['csrf','action','reference','reason']:['csrf','action','reference','reason','version','amountMinor','currency','provider','demo','reviewed'];
        if(Object.keys(input).some(key=>!allowed.includes(key)))throw problem(400,'invalid_request');
        const references=['manual','verify'].includes(input.action);
        if(references&&(typeof input.reference!=='string'||typeof input.reason!=='string'||input.reference.trim().length<3||input.reason.trim().length<3)||!references&&(input.reference||input.reason))throw problem(400,'invalid_request');
        if(stage==='review'){
          const data=await orderClient.refund(tenantId,who.id,number,refundId);if(!refundActions(data).includes(input.action))throw problem(409,'invalid_status');
          htmlHeaders(res);res.end(staffRefundPage({tenantId,data,csrf:auth.csrfToken(req),review:input}));return;
        }
        if(input.reviewed!=='yes'||!['true','false'].includes(input.demo)||typeof input.provider!=='string')throw problem(400,'invalid_request');
        try{await orderClient.refundCommand(tenantId,who.id,number,refundId,input.action,{version:Number(input.version),reviewed:true,amountMinor:Number(input.amountMinor),currency:input.currency,provider:input.provider,demo:input.demo==='true',...(references?{reference:input.reference.trim(),reason:input.reason.trim()}:{})});}
        catch(error){if(error?.code==='order_outcome_unknown'||error?.status>=500)return redirect(res,path+'?outcome=unknown',303);throw error;}
        return redirect(res,path,303);
      }
      const managementFinance=/^\/manage\/([a-z0-9-]{1,64})\/orders\/(R[0-9]{8,20})\/finance$/.exec(url.pathname);
      if(managementFinance&&orderClient&&req.method==='GET'){
        if(req.headers.authorization||url.search)throw problem(403,'browser_session_required');
        if(!await auth.authenticate(req,{cookieOnly:true}))return redirect(res,'/auth/login?returnTo='+encodeURIComponent(url.pathname));
        const who=await browser(req),[,tenantId,number]=managementFinance;await directory.authorize(who.id,tenantId,'orders:read');const membership=await directory.authorize(who.id,tenantId,'payments:read');const data=await orderClient.finance(tenantId,who.id,number);htmlHeaders(res);res.end(staffFinancePage({tenantId,data,canManage:membership.permissions.includes('refunds:manage')}));return;
      }
      const managementService=/^\/manage\/([a-z0-9-]{1,64})\/service$/.exec(url.pathname);
      if(managementService&&orderClient&&['GET','POST'].includes(req.method)){
        if(req.headers.authorization||url.search)throw problem(403,'browser_session_required');
        if(req.method==='GET'&&!await auth.authenticate(req,{cookieOnly:true}))return redirect(res,'/auth/login?returnTo='+encodeURIComponent(url.pathname));
        const who=await browser(req),tenantId=managementService[1],membership=await directory.authorize(who.id,tenantId,req.method==='GET'?'settings:read':'settings:update');
        if(req.method==='GET'){const data=await orderClient.service(tenantId,who.id);htmlHeaders(res);res.end(staffServicePage({tenantId,data,canUpdate:membership.permissions.includes('settings:update'),csrf:auth.csrfToken(req)}));return;}
        const input=await body(req);auth.verifyCsrf(req,input.csrf);const fields=['acceptingOrders','deliveryEnabled','pickupEnabled','tableEnabled'];
        if(input.reviewed!=='yes'||Object.keys(input).some(key=>!['csrf','expectedVersion','reviewed',...fields].includes(key))||fields.some(key=>!['true','false'].includes(input[key])))throw problem(400,'invalid_request');
        await orderClient.patchService(tenantId,who.id,{expectedVersion:Number(input.expectedVersion),...Object.fromEntries(fields.map(key=>[key,input[key]==='true']))});return redirect(res,url.pathname,303);
      }
      const managementProfile=/^\/manage\/([a-z0-9-]{1,64})\/profile$/.exec(url.pathname);
      if(managementProfile&&orderClient&&['GET','POST'].includes(req.method)){
        if(req.headers.authorization||url.search)throw problem(403,'browser_session_required');
        if(req.method==='GET'&&!await auth.authenticate(req,{cookieOnly:true}))return redirect(res,'/auth/login?returnTo='+encodeURIComponent(url.pathname));
        const who=await browser(req),tenantId=managementProfile[1];
        const membership=await directory.authorize(who.id,tenantId,req.method==='GET'?'settings:read':'settings:update');
        if(req.method==='GET'){const profile=await orderClient.profile(tenantId,who.id);htmlHeaders(res);res.end(staffProfilePage({tenantId,profile,canUpdate:membership.permissions.includes('settings:update'),csrf:auth.csrfToken(req)}));return;}
        const input=await body(req);auth.verifyCsrf(req,input.csrf);
        const fields=['name','description','address','phone','openingHours','pickupInstructions'];
        if(input.reviewed!=='yes'||Object.keys(input).some(key=>!['csrf','expectedVersion','reviewed',...fields].includes(key))||fields.some(key=>typeof input[key]!=='string'))throw problem(400,'invalid_request');
        await orderClient.patchProfile(tenantId,who.id,{expectedVersion:Number(input.expectedVersion),...Object.fromEntries(fields.map(key=>[key,input[key].trim()]))});
        return redirect(res,url.pathname,303);
      }
      const managementMembers=/^\/manage\/([a-z0-9-]{1,64})\/members(?:\/([a-f0-9-]{36}))?$/.exec(url.pathname);
      if(managementMembers){
        if(req.headers.authorization)throw problem(403,'browser_session_required');
        const [,tenantId,targetId]=managementMembers;
        if(url.search)throw problem(400,'invalid_request');
        if(req.method==='GET'&&!await auth.authenticate(req,{cookieOnly:true}))return redirect(res,'/auth/login?returnTo='+encodeURIComponent(url.pathname));
        const who=await browser(req);
        if(req.method==='GET'&&!targetId){const members=await directory.members(who.id,tenantId);htmlHeaders(res);res.end(staffMembersPage({tenantId,members,actorId:who.id,csrf:auth.csrfToken(req)}));return;}
        if(req.method==='POST'){
          const input=await body(req);auth.verifyCsrf(req,input.csrf);
          const allowed=['csrf','expectedVersion','role','enabled','permissionsMode','displayName',...(!targetId?['principalId']:[]),...RESTAURANT_PERMISSIONS.map(permission=>'perm:'+permission)];
          if(Object.keys(input).some(key=>!allowed.includes(key))||!['true','false'].includes(input.enabled)||!['role','custom'].includes(input.permissionsMode)||
            (targetId?!/^\d{1,16}$/.test(input.expectedVersion??''):input.expectedVersion!==''))throw problem(400,'invalid_request');
          const permissions=RESTAURANT_PERMISSIONS.filter(permission=>input['perm:'+permission]==='yes');
          if(RESTAURANT_PERMISSIONS.some(permission=>input['perm:'+permission]!==undefined&&input['perm:'+permission]!=='yes'))throw problem(400,'invalid_request');
          await directory.setMembership(who.id,tenantId,targetId??input.principalId,{role:input.role,enabled:input.enabled==='true',displayName:input.displayName,
            expectedVersion:targetId?Number(input.expectedVersion):null,...(input.permissionsMode==='custom'?{permissions}:{})});
          return redirect(res,`/manage/${tenantId}/members`,303);
        }
      }
      const createMenu=/^\/manage\/([a-z0-9-]{1,64})\/menu\/new-(item|category)$/.exec(url.pathname);
      if(createMenu&&orderClient&&req.method==='POST'){
        const who=await browser(req),[,tenantId,kind]=createMenu;
        if(url.search)throw problem(400,'invalid_request');
        const input=await body(req);auth.verifyCsrf(req,input.csrf);await directory.authorize(who.id,tenantId,'menu:update');
        const allowed=kind==='item'?['csrf','expectedVersion','id','name','categoryId','price']:['csrf','expectedVersion','id','name','sort'];
        if(Object.keys(input).some(key=>!allowed.includes(key))||!/^\d{1,16}$/.test(input.expectedVersion??''))throw problem(400,'invalid_request');
        if(kind==='item'){
          const priceMinor=menuPriceMinor(input.price);if(priceMinor===null)throw problem(400,'invalid_request');
          const created=await orderClient.createMenuItem(tenantId,who.id,{expectedVersion:Number(input.expectedVersion),
            item:{id:input.id,name:input.name,categoryId:input.categoryId,priceMinor,description:'',imageUrl:'',available:false,sort:0,options:[]}});
          return redirect(res,`/manage/${tenantId}/menu/items/${created.item.id}`,303);
        }
        if(!/^\d{1,5}$/.test(input.sort??''))throw problem(400,'invalid_request');
        await orderClient.createMenuCategory(tenantId,who.id,{expectedVersion:Number(input.expectedVersion),category:{id:input.id,name:input.name,sort:Number(input.sort)}});
        return redirect(res,`/manage/${tenantId}/menu`,303);
      }
      const menuImage=/^\/manage\/([a-z0-9-]{1,64})\/menu\/items\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})\/image$/.exec(url.pathname);
      if(menuImage&&orderClient&&req.method==='POST'){
        const who=await browser(req),[,tenantId,itemId]=menuImage;
        if(url.search||!req.headers['content-type']?.startsWith('multipart/form-data;'))throw problem(400,'invalid_request');
        await directory.authorize(who.id,tenantId,'menu:update');
        if(uploads.active>=2)throw problem(429,'rate_limited');uploads.active++;
        try{
          const chunks=[];let size=0;
          for await(const chunk of req){size+=chunk.length;if(size>5*1024*1024+65536)throw problem(413,'image_too_large');chunks.push(chunk);}
          let form;try{form=await new Response(Buffer.concat(chunks),{headers:{'content-type':req.headers['content-type']}}).formData();}catch{throw problem(400,'image_invalid');}
          if([...form.keys()].some(key=>!['csrf','expectedVersion','image'].includes(key))||['csrf','expectedVersion','image'].some(key=>form.getAll(key).length!==1))throw problem(400,'invalid_request');
          auth.verifyCsrf(req,form.get('csrf'));
          const version=form.get('expectedVersion'),file=form.get('image');
          if(typeof version!=='string'||!/^\d{1,16}$/.test(version)||!(file instanceof File)||file.size<1||file.size>5*1024*1024)throw problem(400,'image_invalid');
          const current=await orderClient.menuItem(tenantId,who.id,itemId);
          if(current.version!==Number(version))throw problem(409,'catalog_changed');
          const uploaded=await orderClient.uploadImage(tenantId,who.id,Buffer.from(await file.arrayBuffer()));
          await orderClient.patchMenuItem(tenantId,who.id,itemId,{expectedVersion:current.version,imageUrl:uploaded.url});
          return redirect(res,`/manage/${tenantId}/menu/items/${itemId}`,303);
        }finally{uploads.active--;}
      }
      const menuCategory=/^\/manage\/([a-z0-9-]{1,64})\/menu\/categories\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})$/.exec(url.pathname);
      if(menuCategory&&orderClient&&req.method==='POST'){
        const who=await browser(req),[,tenantId,categoryId]=menuCategory;
        if(url.search)throw problem(400,'invalid_request');
        const input=await body(req);auth.verifyCsrf(req,input.csrf);await directory.authorize(who.id,tenantId,'menu:update');
        if(Object.keys(input).some(key=>!['csrf','expectedVersion','name','sort'].includes(key))||!/^\d{1,16}$/.test(input.expectedVersion??'')||!/^\d{1,5}$/.test(input.sort??''))throw problem(400,'invalid_request');
        await orderClient.patchMenuCategory(tenantId,who.id,categoryId,{expectedVersion:Number(input.expectedVersion),name:input.name,sort:Number(input.sort)});
        return redirect(res,`/manage/${tenantId}/menu`,303);
      }
      const menuOption=/^\/manage\/([a-z0-9-]{1,64})\/menu\/items\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})\/options(?:\/([A-Za-z0-9][A-Za-z0-9_-]{0,79}))?$/.exec(url.pathname);
      if(menuOption&&orderClient&&req.method==='POST'){
        const who=await browser(req),[,tenantId,itemId,optionId]=menuOption;
        if(url.search)throw problem(400,'invalid_request');
        const input=await body(req);auth.verifyCsrf(req,input.csrf);await directory.authorize(who.id,tenantId,'menu:update');
        const allowed=optionId?['csrf','expectedVersion','name','price','available']:['csrf','expectedVersion','name','price','available','id'];
        const priceMinor=menuPriceMinor(input.price);
        if(Object.keys(input).some(key=>!allowed.includes(key))||priceMinor===null||!['true','false'].includes(input.available)||!/^\d{1,16}$/.test(input.expectedVersion??''))throw problem(400,'invalid_request');
        const menu=await orderClient.menuItem(tenantId,who.id,itemId);
        if(menu.version!==Number(input.expectedVersion))throw problem(409,'catalog_changed');
        const options=[...(menu.item.options??[])],option={id:optionId??input.id,name:input.name,priceMinor,available:input.available==='true'};
        if(optionId){const index=options.findIndex(value=>value.id===optionId);if(index<0)throw problem(404,'not_found');options[index]=option;}
        else {if(options.some(value=>value.id===input.id))throw problem(409,'conflict');options.push(option);}
        await orderClient.patchMenuItem(tenantId,who.id,itemId,{expectedVersion:menu.version,options});
        return redirect(res,`/manage/${tenantId}/menu/items/${itemId}`,303);
      }
      const managementMenu=/^\/manage\/([a-z0-9-]{1,64})\/menu(?:\/items\/([A-Za-z0-9][A-Za-z0-9_-]{0,79}))?$/.exec(url.pathname);
      if(managementMenu&&orderClient){
        const [,tenantId,itemId]=managementMenu;
        if(req.method==='GET'&&!await auth.authenticate(req,{cookieOnly:true}))return redirect(res,'/auth/login?returnTo='+encodeURIComponent(url.pathname));
        const who=await browser(req);if(url.search)throw problem(400,'invalid_request');
        if(req.method==='GET'){
          const membership=await directory.authorize(who.id,tenantId,'menu:read');
          const menu=itemId?await orderClient.menuItem(tenantId,who.id,itemId):await orderClient.menu(tenantId,who.id);
          if(itemId)res.setHeader('content-security-policy',"default-src 'none'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
          htmlHeaders(res);res.end(itemId?staffMenuItemPage({tenantId,membership,menu,csrf:auth.csrfToken(req),newOptionId:randomUUID()}):staffMenuPage({tenantId,menu,membership,csrf:auth.csrfToken(req),newItemId:randomUUID(),newCategoryId:randomUUID()}));return;
        }
        if(req.method==='POST'&&itemId){
          const input=await body(req);auth.verifyCsrf(req,input.csrf);
          await directory.authorize(who.id,tenantId,'menu:update');
          const priceMinor=menuPriceMinor(input.price);
          if(Object.keys(input).some(key=>!['csrf','expectedVersion','name','description','price','categoryId','available','sort'].includes(key))||priceMinor===null||!['true','false'].includes(input.available)||!/^\d{1,16}$/.test(input.expectedVersion??'')||!/^\d{1,5}$/.test(input.sort??''))throw problem(400,'invalid_request');
          await orderClient.patchMenuItem(tenantId,who.id,itemId,{expectedVersion:Number(input.expectedVersion),name:input.name,description:input.description,priceMinor,
            categoryId:input.categoryId,available:input.available==='true',sort:Number(input.sort)});
          return redirect(res,`/manage/${tenantId}/menu/items/${itemId}`,303);
        }
      }
      const managementStock=/^\/manage\/([a-z0-9-]{1,64})\/stock(?:\/([A-Za-z0-9_-]{1,128}))?$/.exec(url.pathname);
      if(managementStock&&orderClient){
        const [,tenantId,itemId]=managementStock;
        if(req.method==='GET'&&!await auth.authenticate(req,{cookieOnly:true}))return redirect(res,'/auth/login?returnTo='+encodeURIComponent(`/manage/${tenantId}/stock`));
        const who=await browser(req);
        if(url.search)throw problem(400,'invalid_request');
        if(req.method==='GET'&&!itemId){
          const membership=await directory.authorize(who.id,tenantId,'stock:read');
          const [stock,catalog]=await Promise.all([orderClient.stock(tenantId,who.id),core.getMenu(tenantId)]);
          htmlHeaders(res);res.end(staffStockPage({tenantId,membership,items:stock.items,catalog,csrf:auth.csrfToken(req)}));return;
        }
        if(req.method==='POST'&&itemId){
          const input=await body(req);auth.verifyCsrf(req,input.csrf);
          if(Object.keys(input).some(key=>!['csrf','version','available','tracked'].includes(key))||!['true','false'].includes(input.tracked)||!/^\d{1,16}$/.test(input.version??'')||!/^\d{1,7}$/.test(input.available??''))throw problem(400,'invalid_request');
          await directory.authorize(who.id,tenantId,'stock:update');
          await orderClient.setStock(tenantId,who.id,itemId,{version:Number(input.version),tracked:input.tracked==='true',available:Number(input.available)});
          return redirect(res,`/manage/${tenantId}/stock`,303);
        }
      }
      const managementChannels=/^\/manage\/([a-z0-9-]{1,64})\/channels(?:\/(web|chatgpt|whatsapp_qr|whatsapp_cloud))?$/.exec(url.pathname);
      if(managementChannels&&orderClient){
        const [,tenantId,channel]=managementChannels;
        if(req.method==='GET'&&!await auth.authenticate(req,{cookieOnly:true}))return redirect(res,'/auth/login?returnTo='+encodeURIComponent(`/manage/${tenantId}/channels`));
        const who=await browser(req);
        if(url.search)throw problem(400,'invalid_request');
        await directory.authorize(who.id,tenantId,'channels:manage');
        if(req.method==='GET'&&!channel){
          const {channels}=await orderClient.channels(tenantId,who.id);
          htmlHeaders(res);res.end(staffChannelsPage({tenantId,channels,csrf:auth.csrfToken(req)}));return;
        }
        if(req.method==='POST'&&channel){
          const input=await body(req);auth.verifyCsrf(req,input.csrf);
          if(Object.keys(input).some(key=>!['csrf','newOrdersEnabled','expectedVersion'].includes(key))||!['true','false'].includes(input.newOrdersEnabled)||!/^\d{1,16}$/.test(input.expectedVersion??''))throw problem(400,'invalid_request');
          await orderClient.setChannel(tenantId,who.id,channel,{newOrdersEnabled:input.newOrdersEnabled==='true',expectedVersion:Number(input.expectedVersion)});
          return redirect(res,`/manage/${tenantId}/channels`,303);
        }
      }
      const management=/^\/manage(?:\/([a-z0-9-]{1,64})\/orders(?:\/(R[0-9]{8,20})(?:\/(status|cash))?)?)?$/.exec(url.pathname);
      if(management&&(orderClient||!management[1])){
        if(req.method==='GET'&&!await auth.authenticate(req,{cookieOnly:true}))return redirect(res,'/auth/login?returnTo='+encodeURIComponent(url.pathname));
        const who=await browser(req),[,tenantId,number,action]=management;
        if(url.search)throw problem(400,'invalid_request');
        if(req.method==='GET'&&!action){
          let html;
          if(!tenantId)html=staffHome(who,{coreEnabled:!!orderClient,nativeEnabled:!!nativeStaff});
          else{
            const membership=await directory.authorize(who.id,tenantId,'orders:read');
            const {orders}=number?{orders:[await orderClient.staffOrder(tenantId,who.id,number)]}:await orderClient.staffOrders(tenantId,who.id);
            html=staffOrdersPage({tenantId,membership,orders,csrf:auth.csrfToken(req)});
          }
          htmlHeaders(res);res.end(html);return;
        }
        if(req.method==='POST'&&number){
          const input=await body(req);auth.verifyCsrf(req,input.csrf);
          const allowed=action==='status'?['csrf','version','status']:['csrf','version'];
          if(Object.keys(input).some(key=>!allowed.includes(key))||!/^\d{1,16}$/.test(input.version??''))throw problem(400,'invalid_request');
          await directory.authorize(who.id,tenantId,action==='status'?'orders:update':'payments:collect');
          await orderClient.staffChange(tenantId,who.id,number,action,{version:Number(input.version),...(action==='status'?{status:input.status}:{})});
          return redirect(res,`/manage/${tenantId}/orders`,303);
        }
      }
      if (req.method === 'GET' && url.pathname === '/') {
        htmlHeaders(res);
        res.end('<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>منصة المطاعم</title><h1>منصة المطاعم</h1><a href="/manage">دخول إدارة المطاعم</a></html>'); return;
      }
      if (url.pathname.startsWith('/api/')) {
        const who = await browser(req);
        if (req.method !== 'GET') auth.verifyCsrf(req);
        if (req.method === 'GET' && url.pathname === '/api/me') return json(res, 200, { principal: who, csrfToken: auth.csrfToken(req) });
        if (req.method === 'POST' && url.pathname === '/api/platform/restaurants') return json(res, 201, await directory.createTenant(who.id, await body(req)));
        let match = /^\/api\/platform\/restaurants\/([a-z0-9-]{1,64})\/status$/.exec(url.pathname);
        if (match && req.method === 'PATCH') return json(res, 200, await directory.setTenantStatus(who.id, match[1], await body(req)));
        return await staffApi(req,res,who,url);
      }
      throw problem(404, 'not_found');
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const status = [400,401,403,404,409,413,415,429,503].includes(error.status) ? error.status : 500;
      if(status===429)res.setHeader('retry-after',String(Number.isInteger(error.retryAfter)&&error.retryAfter>0?Math.min(error.retryAfter,60):1));
      const code = status === 500 || !/^[a-z_]{1,80}$/.test(error.code ?? '') ? 'request_failed' : error.code;
      const checkoutError=req.url?.startsWith('/checkout/') && req.headers.accept?.includes('text/html') ? checkoutErrorPage(code) : null;
      if(checkoutError){htmlHeaders(res,status);res.end(checkoutError);return;}
      const staffError=req.url?.startsWith('/manage/')&&req.headers.accept?.includes('text/html')?staffErrorPage(code):null;
      if(staffError){htmlHeaders(res,status);res.end(staffError);return;}
      json(res, status, { error: code });
    }
  }
  return { handle, auth, directory, login, core: publicCore, checkouts,events,eventWorker,nativeStaff,
    startWorkers(){if(eventWorker&&!timer){timer=setInterval(()=>eventWorker.tick(),1000);timer.unref();}},
    async stopWorkers(){clearInterval(timer);timer=undefined;await eventWorker?.settle();},
  };
}
