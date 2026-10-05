/** Real subject-based identity and staff control API, separate from demo routes.
 * Deployment still needs approved HTTPS/OIDC configuration. No public bootstrap,
 * Docker socket or production provisioning is exposed by this module. Payment
 * actions reuse the owned original-core handoff rather than accepting money here.
 */
import { createIdentityDirectory } from './identity-directory.mjs';
import { createAuth, problem } from './auth.mjs';
import { createOidcLogin } from './oidc.mjs';
import { createCoreAdapter } from './core-adapter.mjs';
import { createMcpHandler } from './mcp.mjs';
import { createCoreOrderClient, paymentFormSources } from './core-order-client.mjs';
import { createCoreCheckouts } from './core-checkouts.mjs';
import { createEvents } from './events.mjs';
import { createCoreEventWorker } from './core-events.mjs';
import { staffHome, staffOrdersPage, staffChannelsPage } from './staff-pages.mjs';

const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const cookieName = '__Host-platform_session';
const bindingName = '__Host-platform_oidc';
function cookie(name, value, age) { return `${name}=${value}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}`; }
function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
function htmlHeaders(res) {
  // Fetch sets Origin:null for non-CORS form POSTs under no-referrer. Preserve
  // the same-origin Origin check without leaking page URLs to payment providers.
  // https://fetch.spec.whatwg.org/#append-a-request-origin-header
  res.setHeader('referrer-policy','same-origin');
  res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
}
function redirect(res, target, status=302) { res.writeHead(status, { location: target }); res.end(); }
function fields(entries) {
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw problem(400, 'duplicate_parameter');
  return Object.fromEntries(entries);
}
async function body(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 32768) throw problem(413, 'body_too_large'); chunks.push(chunk); }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) return fields([...new URLSearchParams(raw)]);
  if (!req.headers['content-type']?.startsWith('application/json')) throw problem(415, 'json_required');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw problem(400, 'invalid_json'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw problem(400, 'invalid_json');
  return parsed;
}

export async function createControlPlane({ pool, baseUrl, oidc, csrfKey, restaurants = [], redirectAllowlist = [], serviceSigningKey, eventsEncryptionKey }, { oidcClientAdapter, webhookFetch } = {}) {
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
  const publicCore = {
    async listRestaurants(args) {
      const configured = core.listRestaurants(args);
      const published = new Map((await directory.published(configured.map(row => row.id))).map(row => [row.id, row]));
      return configured.filter(row => published.has(row.id)).map(row => ({ ...row, name: published.get(row.id).name }));
    },
    async getMenu(tenantId) {
      if (!(await directory.published([tenantId])).length) throw problem(404, 'restaurant_not_found');
      return core.getMenu(tenantId);
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
  const limits = new Map();
  function rate(req) {
    const now = Date.now(), key = req.socket.remoteAddress;
    if (limits.size > 1000) for (const [key, row] of limits) if (row.until < now) limits.delete(key);
    if (limits.size > 10000 && !limits.has(key)) throw problem(429, 'rate_limited');
    let row = limits.get(key);
    if (!row || row.until < now) { row = { until: now + 60000, count: 0 }; limits.set(key, row); }
    if (++row.count > 240) throw problem(429, 'rate_limited');
  }
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
          const items=(checkout.quote.items??[]).map(item=>`<li>${escape(item.name)} × ${escape(item.quantity)}: ${escape((item.totalMinor/100).toFixed(2))} SAR</li>`).join('');
          if(checkout.state==='confirmed') {
            const order=await checkouts.status(who,checkout.tenantId,checkout.orderId);
            const button=(action,label)=>`<form method="post" action="/checkout/${checkoutId}/${action}"><input type="hidden" name="csrf" value="${escape(csrf)}"><button>${label}</button></form>`;
            const pay=order.paymentMethod==='card'&&['unpaid','pending'].includes(order.paymentStatus)?button('payment','الانتقال لصفحة الدفع'):'';
            const refresh=order.paymentMethod==='card'?button('refresh-payment','التحقق من حالة الدفع'):'';
            htmlHeaders(res);
            res.end(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>طلبك</title><h1>طلب ${escape(order.number)}</h1><p>حالة الطلب: ${escape(order.status)}</p><p>حالة الدفع: ${escape(order.paymentStatus)}</p><p>الإجمالي: ${escape((order.totalMinor/100).toFixed(2))} SAR</p>${checkout.quote.demo?'<p>هذا طلب تجريبي.</p>':''}${pay}${refresh}<p>لا يعتبر الدفع مكتملًا إلا بعد التحقق لدى مزود الدفع.</p></html>`);return;
          }
          const providers=(await core.payments(checkout.tenantId)).providers.filter(row=>['stripe','moyasar','tap','paytabs','geidea','myfatoorah'].includes(row.id));
          const providerOptions=providers.map(row=>`<option value="${escape(row.id)}">${escape(row.name)}${row.mode==='test'?' (اختبار)':''}</option>`).join('');
          htmlHeaders(res);
          const delivery=checkout.cart.mode==='delivery'?'<fieldset><legend>عنوان التوصيل</legend><label>العنوان التفصيلي <textarea name="addressLine" maxlength="500"></textarea></label><label>العنوان الوطني أو المختصر <input name="nationalAddress" maxlength="300"></label></fieldset>':'';
          res.end(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>تأكيد الطلب</title><h1>راجع الطلب ثم أكّد</h1><ul>${items}</ul><p>الإجمالي: ${escape((checkout.totalMinor/100).toFixed(2))} SAR، شامل الرسوم والضريبة المعروضة.</p><form method="post" action="/checkout/${checkoutId}/confirm"><input type="hidden" name="csrf" value="${escape(csrf)}"><label>الاسم <input name="customerName" required maxlength="100" autocomplete="name"></label><label>الهاتف <input name="phone" type="tel" maxlength="40" autocomplete="tel"></label>${delivery}<label>طريقة الدفع <select name="paymentMethod">${methods}</select></label><label>مزود الدفع الإلكتروني <select name="paymentProvider"><option value="">اختر المزود عند الدفع الإلكتروني</option>${providerOptions}</select></label><label>ملاحظات <textarea name="notes" maxlength="1000"></textarea></label><button type="submit">تأكيد وإنشاء الطلب</button></form><p>هذه الخطوة تنشئ الطلب فقط، ولا تثبت سدادًا إلكترونيًا.</p></html>`);return;
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
      if(management&&orderClient){
        if(req.method==='GET'&&!await auth.authenticate(req,{cookieOnly:true}))return redirect(res,'/auth/login?returnTo='+encodeURIComponent(url.pathname));
        const who=await browser(req),[,tenantId,number,action]=management;
        if(url.search)throw problem(400,'invalid_request');
        if(req.method==='GET'&&!action){
          let html;
          if(!tenantId)html=staffHome(who);
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
        const channelRoute=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/staff\/channels(?:\/(web|chatgpt|whatsapp_qr|whatsapp_cloud))?$/.exec(url.pathname);
        if(channelRoute&&orderClient){
          if(url.search)throw problem(400,'invalid_request');
          const [,tenantId,channel]=channelRoute;
          await directory.authorize(who.id,tenantId,'channels:manage');
          if(req.method==='GET'&&!channel)return json(res,200,await orderClient.channels(tenantId,who.id));
          if(req.method==='POST'&&channel)return json(res,200,await orderClient.setChannel(tenantId,who.id,channel,await body(req)));
        }
        const staffRoute=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/staff\/orders(?:\/(R[0-9]{8,20})(?:\/(status|cash))?)?$/.exec(url.pathname);
        if(staffRoute&&orderClient){
          if(url.search)throw problem(400,'invalid_request');
          const [,tenantId,number,action]=staffRoute;
          if(req.method==='GET'&&!action){
            await directory.authorize(who.id,tenantId,'orders:read');
            return json(res,200,number?await orderClient.staffOrder(tenantId,who.id,number):await orderClient.staffOrders(tenantId,who.id));
          }
          if(req.method==='POST'&&number){
            await directory.authorize(who.id,tenantId,action==='status'?'orders:update':'payments:collect');
            return json(res,200,await orderClient.staffChange(tenantId,who.id,number,action,await body(req)));
          }
        }
        if (req.method === 'POST' && url.pathname === '/api/platform/restaurants') return json(res, 201, await directory.createTenant(who.id, await body(req)));
        let match = /^\/api\/platform\/restaurants\/([a-z0-9-]{1,64})\/status$/.exec(url.pathname);
        if (match && req.method === 'PATCH') return json(res, 200, await directory.setTenantStatus(who.id, match[1], await body(req)));
        match = /^\/api\/restaurants\/([a-z0-9-]{1,64})\/members(?:\/([a-f0-9-]{36}))?$/.exec(url.pathname);
        if (match && req.method === 'GET' && !match[2]) return json(res, 200, { members: await directory.members(who.id, match[1]) });
        if (match && req.method === 'PUT' && match[2]) return json(res, 200, await directory.setMembership(who.id, match[1], match[2], await body(req)));
      }
      throw problem(404, 'not_found');
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const status = [400,401,403,404,409,413,415,429,503].includes(error.status) ? error.status : 500;
      const code = status === 500 || !/^[a-z_]{1,80}$/.test(error.code ?? '') ? 'request_failed' : error.code;
      json(res, status, { error: code });
    }
  }
  return { handle, auth, directory, login, core: publicCore, checkouts,events,eventWorker,
    startWorkers(){if(eventWorker&&!timer){timer=setInterval(()=>eventWorker.tick(),1000);timer.unref();}},
    async stopWorkers(){clearInterval(timer);timer=undefined;await eventWorker?.settle();},
  };
}
