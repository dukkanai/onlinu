import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createAuth, FIXTURES, problem, requireScope } from './auth.mjs';
import { createStore, validateCart } from './store.mjs';
import { createMcpHandler } from './mcp.mjs';
import { createEvents } from './events.mjs';
import { createMoyasarTestGateway } from './moyasar.mjs';
import { createOidcLogin } from './oidc.mjs';
import { createChannels } from './channels.mjs';

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const htmlEscape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function configuredValue(env,name) {
  if(env[name] && env[`${name}_FILE`])throw new Error(`ambiguous ${name} configuration`);
  if(!env[`${name}_FILE`])return env[name];
  const path=env[`${name}_FILE`];
  if(statSync(path).size>16384)throw new Error(`oversized ${name} configuration`);
  return readFileSync(path,'utf8').trim();
}
export function configuration(env = process.env) {
  env={...env};
  for(const name of ['DATABASE_URL','EVENTS_ENCRYPTION_KEY','TENANT_A_TOKEN','TENANT_B_TOKEN','OIDC_CLIENT_SECRET','SESSION_CSRF_KEY','OIDC_IDENTITY_MAP']) {
    const value=configuredValue(env,name);
    if(value!==undefined)env[name]=value;
  }
  if (env.PROTOTYPE_SYNTHETIC_ONLY !== '1') throw new Error('PROTOTYPE_SYNTHETIC_ONLY=1 required; production is unsupported');
  const base = new URL(env.PUBLIC_BASE_URL ?? 'http://127.0.0.1:18787');
  if (base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw new Error('invalid PUBLIC_BASE_URL');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
  const authMode=env.AUTH_MODE ?? 'synthetic';
  if(!['synthetic','oidc'].includes(authMode))throw new Error('unsupported authentication mode');
  if(!loopback && authMode!=='oidc')throw new Error('Remote exposure requires verified OIDC tester login');
  if ((!loopback || base.protocol !== 'http:') && !(env.PROTOTYPE_ALLOW_REMOTE === '1' && base.protocol === 'https:')) {
    throw new Error('Remote synthetic demo disabled; use loopback. Real accounts/production unsupported.');
  }
  const tenants = [
    {id:'demo-a',name:'مطبخ النخيل التجريبي',cuisine:'سعودي',template:'classic',url:env.TENANT_A_URL,token:env.TENANT_A_TOKEN},
    {id:'demo-b',name:'ركن الشواء التجريبي',cuisine:'مشويات',template:'bistro',url:env.TENANT_B_URL,token:env.TENANT_B_TOKEN},
  ];
  if (!env.DATABASE_URL || !env.EVENTS_ENCRYPTION_KEY) throw new Error('prototype database and event key required');
  for (const tenant of tenants) {
    if (!tenant.url || !tenant.token || tenant.token.length < 32) throw new Error('tenant connection configuration required');
    const url = new URL(tenant.url);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('invalid internal tenant URL');
    tenant.url = url.origin;
  }
  if (tenants[0].token === tenants[1].token || tenants[0].url === tenants[1].url) throw new Error('tenants require distinct endpoints and credentials');
  const paymentMode = env.PAYMENT_MODE ?? 'local-simulator';
  if (!['local-simulator','moyasar-test'].includes(paymentMode)) throw new Error('production payment disabled');
  if (paymentMode === 'moyasar-test' && !env.MOYASAR_TEST_KEY) throw new Error('sandbox key required');
  let oidc;
  if(authMode==='oidc') {
    if(base.protocol!=='https:' || !env.OIDC_CLIENT_SECRET || env.OIDC_CLIENT_SECRET.length<32
      || !env.SESSION_CSRF_KEY || Buffer.from(env.SESSION_CSRF_KEY,'base64').length!==32)throw new Error('secure OIDC configuration required');
    const issuer=new URL(env.OIDC_ISSUER);
    if(issuer.protocol!=='https:' || issuer.origin!==base.origin || issuer.pathname!=='/identity'
      || issuer.search || issuer.hash || issuer.username || issuer.password)throw new Error('invalid trusted issuer');
    const identityMap=JSON.parse(env.OIDC_IDENTITY_MAP ?? '{}');
    if(!identityMap || Array.isArray(identityMap) || !Object.keys(identityMap).length
      || Object.entries(identityMap).some(([email,id])=>!email.endsWith('@staging.invalid') || !Object.hasOwn(FIXTURES,id)))throw new Error('tester allowlist required');
    if(env.TENANT_A_TOKEN.startsWith('demo-')
      || env.TENANT_B_TOKEN.startsWith('demo-') || /^A+=?$/.test(env.EVENTS_ENCRYPTION_KEY))throw new Error('public fixture credentials are forbidden in staging');
    oidc={issuer:issuer.href,clientId:env.OIDC_CLIENT_ID,clientSecret:env.OIDC_CLIENT_SECRET,identityMap};
    if(!oidc.clientId)throw new Error('OIDC client required');
  }
  return { baseUrl:base.origin, tenants, databaseUrl:env.DATABASE_URL, encryptionKey:env.EVENTS_ENCRYPTION_KEY,
    port:Number(env.PORT ?? 3000), bind:env.BIND_ADDRESS ?? '0.0.0.0', paymentMode,authMode,oidc,csrfKey:env.SESSION_CSRF_KEY,
    moyasarKey:env.MOYASAR_TEST_KEY, redirects:(env.OAUTH_REDIRECT_URIS ?? (authMode==='oidc'?'https://chatgpt.com/connector_platform_oauth_redirect':`${base.origin}/dev/oauth-callback`)).split(',') };
}

export function publicOrder(order) {
  const { id, tenantId, currency, totalMinor, status, paymentStatus, version, items } = order;
  return { id, tenantId, currency, totalMinor, status, paymentStatus, version, items };
}
async function body(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 32768) throw problem(413, 'body_too_large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
    const entries = [...new URLSearchParams(raw)];
    if (new Set(entries.map(([key]) => key)).size !== entries.length) throw problem(400,'duplicate_parameter');
    return Object.fromEntries(entries);
  }
  if (!req.headers['content-type']?.startsWith('application/json')) throw problem(415,'json_required');
  try {
    const result = JSON.parse(raw);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw problem(400,'invalid_json'); }
}
const only = (input, keys) => {
  if (Object.keys(input).some(key => !keys.includes(key))) throw problem(400,'unknown_field');
  return input;
};
function json(res, status, value) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(value));
}

export async function createPlatform(config, { pool = new pg.Pool({connectionString:config.databaseUrl,max:8}), webhookFetch } = {}) {
  const listRestaurants = (args = {}) => {
    const query = typeof args.query === 'string' ? args.query.trim().slice(0,100) : '';
    return config.tenants.filter(tenant => (!query || `${tenant.name} ${tenant.cuisine}`.includes(query))
      && (!args.cuisine || tenant.cuisine === args.cuisine)).map(({id,name,cuisine,template}) => ({id,name,cuisine,template}));
  };
  function tenantConfig(id) {
    const tenant = config.tenants.find(item => item.id === id);
    if (!tenant) throw problem(404,'not_found');
    return tenant;
  }
  async function tenantRequest(id, path, {method='GET',body:input,principal} = {}) {
    const tenant = tenantConfig(id);
    const headers = {Authorization:`Bearer ${tenant.token}`};
    if (principal) { headers['X-Actor-ID'] = principal.id; headers['X-Actor-Role'] = principal.role; }
    if (input !== undefined) headers['Content-Type']='application/json';
    let response;
    try {
      response = await fetch(`${tenant.url}${path}`, {method, headers, body:input === undefined ? undefined : JSON.stringify(input),
        redirect:'error', signal:AbortSignal.timeout(5000)});
    } catch { throw problem(503,'restaurant_unavailable'); }
    let result;
    try { result = await response.json(); } catch { throw problem(502,'invalid_restaurant_response'); }
    if (!response.ok) throw problem([400,401,403,404,409,413].includes(response.status)?response.status:503,
      typeof result.error === 'string' && /^[a-z_]{1,64}$/.test(result.error) ? result.error : 'restaurant_unavailable');
    if (result.tenantId !== undefined && result.tenantId !== id) throw problem(502,'restaurant_identity_mismatch');
    return result;
  }
  const protectedStage=config.authMode==='oidc';
  const cookieName=protectedStage?'__Host-restaurant_session':'prototype_session';
  const auth = createAuth({pool,baseUrl:config.baseUrl,redirectAllowlist:config.redirects,cookieName,
    allowSyntheticAuthorization:!protectedStage,csrfKey:config.csrfKey,
    onRegistrationRejected:protectedStage?result=>console.info(JSON.stringify({event:'oauth_registration_rejected',...result})):undefined,
    onGrantRevoked:(principalId,transaction)=>events.revokeAll(principalId,transaction)});
  const login=protectedStage?createOidcLogin({pool,baseUrl:config.baseUrl,...config.oidc}):null;
  const channels=createChannels({pool,tenants:config.tenants.map(tenant=>tenant.id)});
  const store = createStore({pool,baseUrl:config.baseUrl,tenantRequest,listRestaurants});
  const service = {id:'platform-service',role:'service'};
  const loadOwnedOrder = async (principal, {tenantId,orderId}) => {
    const live = principal && await auth.principal(principal.id);
    if (!live || live.role !== 'customer' || principal.role !== 'customer' || !ID.test(orderId ?? '')) throw problem(403,'customer_required');
    return publicOrder(await tenantRequest(tenantId,`/orders/${orderId}`,{principal:live}));
  };
  const getOrderStatus = async (principal, args) => {
    requireScope(principal,'orders:read');
    return loadOwnedOrder(principal,args);
  };
  const events = createEvents({pool,encryptionKey:config.encryptionKey,authorizeOrder:loadOwnedOrder,webhookFetch});
  await auth.init(); await store.init(); await events.init();await channels.init();if(login)await login.init();
  const gateway = config.paymentMode === 'moyasar-test' ? createMoyasarTestGateway({secretKey:config.moyasarKey}) : null;
  const uiHtml = await readFile(new URL('./public/widget.html',import.meta.url),'utf8');
  const getMenu = async args => tenantRequest(args.tenantId,'/menu');
  const quoteCart = async (principal, args) => tenantRequest(args.tenantId,'/quote',{
    method:'POST',body:{items:validateCart({items:args.items})}});
  const mcp = createMcpHandler({baseUrl:config.baseUrl,authenticate:req=>auth.authenticate(req,{bearerOnly:true}),
    listRestaurants:args=>({restaurants:listRestaurants(args)}),getMenu,quoteCart,
    prepareCheckout:(principal,args)=>store.prepare(principal,args),getOrderStatus,events,uiHtml,requireCatalogAuth:protectedStage,
    onProtocolExchange:protectedStage ? result=>console.info(JSON.stringify({event:'mcp_exchange',...result})) : undefined});
  async function startSandboxPayment(order) {
    const row = await pool.query('INSERT INTO demo_payment_attempts(tenant_id,order_id,state) VALUES($1,$2,\'creating\') ON CONFLICT DO NOTHING RETURNING *',
      [order.tenantId,order.id]);
    if (row.rowCount) {
      try {
        const invoice = await gateway.createInvoice({order,
          callbackUrl:`${config.baseUrl}/webhooks/moyasar/${order.tenantId}/${order.id}`,
          returnUrl:`${config.baseUrl}/payment-return/${order.tenantId}/${order.id}`});
        await pool.query('UPDATE demo_payment_attempts SET state=\'created\',invoice_id=$3,invoice_url=$4 WHERE tenant_id=$1 AND order_id=$2',
          [order.tenantId,order.id,invoice.id,invoice.url]);
        return {paymentMode:'moyasar-test',paymentUrl:invoice.url};
      } catch (error) {
        await pool.query('UPDATE demo_payment_attempts SET state=\'review\',error_code=$3 WHERE tenant_id=$1 AND order_id=$2',
          [order.tenantId,order.id,error.code ?? 'moyasar_outcome_unknown']);
        throw problem(409,'sandbox_payment_requires_review');
      }
    }
    const {rows} = await pool.query('SELECT * FROM demo_payment_attempts WHERE tenant_id=$1 AND order_id=$2',[order.tenantId,order.id]);
    if (rows[0]?.state !== 'created') throw problem(409,'sandbox_payment_requires_review');
    return {paymentMode:'moyasar-test',paymentUrl:rows[0].invoice_url};
  }
  async function inspectSandboxPayment(tenantId,orderId,principal) {
    if (!gateway) throw problem(409,'moyasar_test_not_configured');
    // Always fetch order as its owner. Public webhook resolves owner only from our checkout.
    let owner = principal;
    if (!owner) {
      const {rows} = await pool.query('SELECT principal_id FROM demo_checkouts WHERE tenant_id=$1 AND order_id=$2',[tenantId,orderId]);
      owner = rows[0] && await auth.principal(rows[0].principal_id);
    }
    if (!owner) throw problem(404,'not_found');
    const order = await tenantRequest(tenantId,`/orders/${orderId}`,{principal:owner});
    const {rows} = await pool.query('SELECT invoice_id FROM demo_payment_attempts WHERE tenant_id=$1 AND order_id=$2 AND state=\'created\'',[tenantId,orderId]);
    if (!rows[0]?.invoice_id) throw problem(404,'not_found');
    const result = await gateway.inspectInvoice({invoiceId:rows[0].invoice_id,order});
    if (result.status === 'paid') return tenantRequest(tenantId,`/orders/${orderId}/confirm-test-payment`,{
      principal:service,method:'POST',body:{provider:'moyasar-test',reference:result.invoiceId,amountMinor:result.amountMinor,currency:result.currency}});
    return order;
  }
  const rateWindows = new Map();
  function rate(req, sensitive=false) {
    const now = Date.now();
    if (rateWindows.size > 1000) for (const [key,value] of rateWindows) if(value.until<now) rateWindows.delete(key);
    const key = `${req.socket.remoteAddress}:${sensitive?'sensitive':'api'}`;
    let row=rateWindows.get(key);
    if(!row || row.until<now) { row={until:now+60_000,count:0};rateWindows.set(key,row); }
    if(++row.count > (sensitive?120:1200)) throw problem(429,'rate_limited');
  }
  const assets = {
    '/': [protectedStage?'staging.html':'index.html','text/html; charset=utf-8'],
    ...(protectedStage?{'/staging.js':['staging.js','text/javascript; charset=utf-8'],'/staging.css':['staging.css','text/css; charset=utf-8']}:{'/app.js':['app.js','text/javascript; charset=utf-8']}),
    '/style.css':['style.css','text/css; charset=utf-8'],
  };
  const sessionCookie=(token,age=1800)=>`${cookieName}=${token}; HttpOnly; SameSite=${protectedStage?'Lax':'Strict'}; Path=/; Max-Age=${age}${protectedStage?'; Secure':''}`;
  const redirect=(res,target)=>{res.writeHead(302,{Location:target});res.end();};
  function parameters(searchParams) {
    const entries=[...searchParams];
    if(new Set(entries.map(([key])=>key)).size!==entries.length)throw problem(400,'duplicate_parameter');
    return Object.fromEntries(entries);
  }
  async function handle(req,res) {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    try {
      const url = new URL(req.url,config.baseUrl);
      if(protectedStage && ['/.well-known/oauth-protected-resource','/.well-known/oauth-authorization-server','/oauth/register'].includes(url.pathname)) {
        const route=url.pathname;
        const method=['GET','POST','HEAD'].includes(req.method)?req.method:'other';
        res.once('finish',()=>console.info(JSON.stringify({event:'oauth_discovery',route,method,status:res.statusCode})));
      }
      if(req.method==='GET' && url.pathname==='/health') return json(res,200,{status:'ok',mode:'synthetic',authMode:config.authMode ?? 'synthetic',paymentMode:config.paymentMode});
      if(req.headers.host !== new URL(config.baseUrl).host) throw problem(421,'unexpected_host');
      if(req.headers.origin && req.headers.origin!==config.baseUrl) throw problem(403,'origin_rejected');
      if(url.searchParams.has('access_token')) throw problem(400,'token_in_url_forbidden');
      rate(req, url.pathname.startsWith('/dev/') || url.pathname.startsWith('/auth/') || url.pathname.startsWith('/oauth/') || url.pathname.startsWith('/webhooks/'));
      if(protectedStage && url.pathname.startsWith('/dev/'))throw problem(404,'not_found');
      if(url.pathname==='/mcp') return await mcp(req,res);
      if(req.method==='GET' && url.pathname==='/.well-known/oauth-protected-resource') return json(res,200,auth.resourceMetadata);
      if(req.method==='GET' && url.pathname==='/.well-known/oauth-authorization-server') return json(res,200,auth.metadata);
      const oauthBackchannel = ['/oauth/token','/oauth/register','/oauth/revoke'].includes(url.pathname);
      const webhook = /^\/webhooks\/moyasar\/(demo-[ab])\/([a-zA-Z0-9_-]{1,128})$/.exec(url.pathname);
      if(req.method==='POST' && !oauthBackchannel && !webhook && req.headers.origin!==config.baseUrl && !req.headers.authorization) throw problem(403,'origin_required');
      if(protectedStage && req.method==='POST' && !oauthBackchannel && !webhook && url.pathname!=='/oauth/authorize' && !req.headers.authorization)auth.verifyCsrf(req);
      if(protectedStage && req.method==='GET' && url.pathname==='/auth/login') {
        const input=only(parameters(url.searchParams),['returnTo']);
        const flow=await login.begin(input.returnTo ?? '/');
        res.setHeader('Set-Cookie',`__Host-oidc_binding=${flow.bindingCookie}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
        return redirect(res,flow.authorizationUrl);
      }
      if(protectedStage && req.method==='GET' && url.pathname==='/auth/callback') {
        const cookies=(req.headers.cookie??'').split(';').map(value=>value.trim()).filter(value=>value.startsWith('__Host-oidc_binding='));
        const binding=cookies.length===1?cookies[0].slice('__Host-oidc_binding='.length):'';
        res.setHeader('Set-Cookie','__Host-oidc_binding=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
        const result=await login.complete(url.href,binding);
        await auth.revoke(auth.browserToken(req));
        const session=await auth.issue(result.principalId,undefined,{kind:'browser'});
        res.setHeader('Set-Cookie',[sessionCookie(session.accessToken),'__Host-oidc_binding=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0']);
        return redirect(res,result.returnTo);
      }
      if(protectedStage && req.method==='GET' && url.pathname==='/api/session') {
        const principal=await auth.authenticate(req,{cookieOnly:true});
        if(!principal)throw problem(401,'authentication_required');
        return json(res,200,{principal,authMode:'oidc',csrfToken:auth.csrfToken(req)});
      }
      if(protectedStage && req.method==='POST' && url.pathname==='/auth/logout') {
        if(req.headers.origin!==config.baseUrl)throw problem(403,'origin_required');
        auth.verifyCsrf(req);only(await body(req),[]);
        await auth.revoke(auth.browserToken(req));res.setHeader('Set-Cookie',sessionCookie('',0));
        return json(res,200,{loggedOut:true});
      }
      if(req.method==='POST' && url.pathname==='/dev/session') {
        if(req.headers.origin!==config.baseUrl) throw problem(403,'origin_required');
        const input=only(await body(req),['identity']);
        if(!FIXTURES[input.identity]) throw problem(400,'unknown_identity');
        const session=await auth.issue(input.identity,undefined,{kind:'browser'});
        res.setHeader('Set-Cookie',sessionCookie(session.accessToken));
        return json(res,200,session);
      }
      if(req.method==='POST' && url.pathname==='/oauth/register') return json(res,201,await auth.register(await body(req)));
      if(req.method==='POST' && url.pathname==='/oauth/token') return json(res,200,await auth.exchange(await body(req)));
      if(req.method==='POST' && url.pathname==='/oauth/revoke') {
        const input=await body(req);
        const owner=await auth.authenticate({headers:{authorization:`Bearer ${input.token}`}}, {bearerOnly:true});
        // Synthetic policy: explicit disconnect revokes every event subscription owned by this identity.
        const revokedOwner=await auth.revoke(input.token);
        if(owner && owner.id!==revokedOwner) await events.revokeAll(owner.id);
        return json(res,200,{});
      }
      if(req.method==='GET' && url.pathname==='/oauth/authorize') {
        const input=parameters(url.searchParams);
        await auth.validateAuthorization(input);
        if(protectedStage) {
          if(input.identity!==undefined)throw problem(400,'identity_parameter_forbidden');
          const principal=await auth.authenticate(req,{cookieOnly:true});
          if(!principal)return redirect(res,`/auth/login?returnTo=${encodeURIComponent(url.pathname+url.search)}`);
          if(principal.role!=='customer')throw problem(403,'customer_required');
          const fields=Object.entries(input).map(([key,value])=>`<input type="hidden" name="${htmlEscape(key)}" value="${htmlEscape(value)}">`).join('');
          // Browsers also enforce form-action on the post-consent redirect.
          // Permit only the exact validated callback, not arbitrary HTTPS sites.
          res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self' ${input.redirect_uri}; base-uri 'none'`);
          // Native form POST under no-referrer sends Origin:null. Preserve
          // exact-origin checking; no referrer is sent to external callbacks.
          res.setHeader('Referrer-Policy','same-origin');
          res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
          return res.end(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="referrer" content="same-origin"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><main><h1>السماح للإضافة بالوصول</h1><p>حساب اختبار موثق: ${htmlEscape(principal.id)}. بيانات المطاعم والطلبات وهمية، ولا توجد مدفوعات حقيقية.</p><p>الصلاحيات المطلوبة:</p><pre>${htmlEscape(input.scope)}</pre><form method="post" action="/oauth/authorize">${fields}<input type="hidden" name="_csrf" value="${htmlEscape(auth.csrfToken(req))}"><button name="decision" value="allow">السماح</button><button name="decision" value="deny">رفض</button></form></main></html>`);
        }
        const fields=Object.entries(input).map(([key,value])=>`<input type="hidden" name="${htmlEscape(key)}" value="${htmlEscape(value)}">`).join('');
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
        return res.end(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><main><h1>تفويض تجريبي فقط</h1><p>هذا ليس تسجيل دخول حقيقيًا. اختر هوية وهمية ولا تدخل معلومات شخصية.</p><form method="post" action="/oauth/authorize">${fields}<select name="identity"><option>customer-alice</option><option>customer-bob</option></select><button>الموافقة على الصلاحيات التجريبية</button></form><pre>${htmlEscape(input.scope)}</pre></main></html>`);
      }
      if(req.method==='POST' && url.pathname==='/oauth/authorize') {
        if(req.headers.origin!==config.baseUrl) throw problem(403,'origin_required');
        let input=await body(req),verified;
        if(protectedStage) {
          verified=await auth.authenticate(req,{cookieOnly:true});if(!verified)throw problem(401,'authentication_required');
          auth.verifyCsrf(req,input._csrf);
          const {_csrf,decision,...request}=input;input=request;
          await auth.validateAuthorization(input);
          if(input.identity!==undefined)throw problem(400,'identity_parameter_forbidden');
          // Preserve the same narrow permission on the redirect response too;
          // Chromium may apply its CSP when following the submitted form.
          res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self' ${input.redirect_uri}; base-uri 'none'`);
          if(decision==='deny') {
            const target=new URL(input.redirect_uri);target.searchParams.set('error','access_denied');target.searchParams.set('state',input.state);target.searchParams.set('iss',config.baseUrl);
            return redirect(res,target.href);
          }
          if(decision!=='allow')throw problem(400,'consent_required');
        }
        const target=await auth.authorize(input,verified);
        res.writeHead(302,{Location:target});return res.end();
      }
      if(req.method==='GET' && url.pathname==='/dev/oauth-callback') return json(res,200,{mode:'synthetic',message:'OAuth callback reached; automated test exchanges code. No token displayed.'});
      if(webhook && req.method==='POST') {
        await body(req); // Never trust webhook content as evidence of money.
        await inspectSandboxPayment(webhook[1],webhook[2]);return json(res,200,{received:true});
      }
      if(protectedStage && url.pathname.startsWith('/api/')) {
        const viewer=await auth.authenticate(req);if(!viewer)throw problem(401,'authentication_required');
        if(url.pathname.startsWith('/api/restaurants/'))requireScope(viewer,req.method==='POST' && !url.pathname.endsWith('/quote')?'orders:write':'orders:read');
        if(url.pathname==='/api/restaurants')requireScope(viewer,'orders:read');
      }
      if(req.method==='GET' && url.pathname==='/api/restaurants') return json(res,200,{restaurants:listRestaurants({query:url.searchParams.get('query') ?? ''})});
      let match=/^\/api\/restaurants\/(demo-[ab])\/(menu|quote|checkouts)$/.exec(url.pathname);
      if(match) {
        if(req.method==='GET' && match[2]==='menu') return json(res,200,await getMenu({tenantId:match[1]}));
        if(req.method==='POST' && match[2]==='quote') {
          const input=only(await body(req),['items']);return json(res,200,await quoteCart(null,{tenantId:match[1],...input}));
        }
        if(req.method==='POST' && match[2]==='checkouts') {
          const principal=await auth.authenticate(req);if(!principal)throw problem(401,'authentication_required');
          requireScope(principal,'orders:write');
          const input=only(await body(req),['items','expectedTotalMinor','idempotencyKey']);
          return json(res,201,await store.prepare(principal,{tenantId:match[1],...input}));
        }
      }
      if(req.method==='GET' && (assets[url.pathname] || /^\/checkout\/[a-f0-9-]{36}$/.test(url.pathname) || /^\/payment-return\/demo-[ab]\/[a-zA-Z0-9_-]{1,128}$/.test(url.pathname))) {
        const [file,type]=assets[url.pathname] ?? assets['/'];
        res.writeHead(200,{'Content-Type':type});return res.end(await readFile(new URL(`./public/${file}`,import.meta.url)));
      }
      const principal=await auth.authenticate(req);
      if(!principal) throw problem(401,'authentication_required');
      match=/^\/api\/checkouts\/([a-f0-9-]{36})(?:\/(confirm))?$/.exec(url.pathname);
      if(match) {
        if(req.method==='GET' && !match[2]) {
          requireScope(principal,'orders:read');
          const row=await store.checkout(principal,match[1]);
          return json(res,200,{checkoutId:row.id,tenantId:row.tenant_id,items:row.items,totalMinor:Number(row.total_minor),currency:row.currency,orderId:row.order_id,paymentMode:config.paymentMode,expiresAt:row.expires_at});
        }
        if(req.method==='POST' && match[2]==='confirm') {
          requireScope(principal,'orders:write');
          only(await body(req),[]);
          const order=await store.confirm(principal,match[1]);
          const payment=gateway ? await startSandboxPayment(order) : {paymentMode:'local-simulator',simulationUrl:`/api/restaurants/${order.tenantId}/orders/${order.id}/simulate-payment`};
          return json(res,200,{order:publicOrder(order),...payment});
        }
      }
      match=/^\/api\/restaurants\/(demo-[ab])\/orders\/([a-zA-Z0-9_-]{1,128})(?:\/(simulate-payment|payment-status))?$/.exec(url.pathname);
      if(match) {
        if(req.method==='GET' && !match[3]) return json(res,200,await getOrderStatus(principal,{tenantId:match[1],orderId:match[2]}));
        if(req.method==='POST' && match[3]) {
          only(await body(req),[]);
          requireScope(principal,'orders:write');
          if(match[3]==='simulate-payment') {
            if(config.paymentMode!=='local-simulator')throw problem(409,'simulation_disabled');
            return json(res,200,publicOrder(await tenantRequest(match[1],`/orders/${match[2]}/simulate-payment`,{principal,method:'POST',body:{}})));
          }
          return json(res,200,publicOrder(await inspectSandboxPayment(match[1],match[2],principal)));
        }
      }
      if(url.pathname.startsWith('/api/merchant/')) {
        if(principal.role!=='merchant')throw problem(403,'merchant_required');
        if(url.pathname==='/api/merchant/restaurants' && req.method==='GET')return json(res,200,{restaurants:listRestaurants().filter(r=>principal.tenantIds.includes(r.id))});
        const channelMatch=/^\/api\/merchant\/restaurants\/(demo-[ab])\/channels$/.exec(url.pathname);
        if(channelMatch) {
          if(req.method==='GET')return json(res,200,await channels.get(principal,channelMatch[1]));
          if(req.method==='POST')return json(res,200,await channels.update(principal,channelMatch[1],await body(req)));
        }
        match=/^\/api\/merchant\/restaurants\/(demo-[ab])\/orders(?:\/([a-zA-Z0-9_-]{1,128})\/status)?$/.exec(url.pathname);
        if(match) {
          if(!principal.tenantIds.includes(match[1]))throw problem(403,'tenant_forbidden');
          if(req.method==='GET' && !match[2]) {
            const result=await tenantRequest(match[1],'/orders',{principal});return json(res,200,{orders:result.orders.map(publicOrder)});
          }
          if(req.method==='POST' && match[2]) {
            const input=only(await body(req),['status','expectedVersion']);
            return json(res,200,publicOrder(await tenantRequest(match[1],`/orders/${match[2]}/status`,{principal,method:'POST',body:input})));
          }
        }
      }
      throw problem(404,'not_found');
    } catch(error) {
      if(res.headersSent) { res.end();return; }
      if(error.status===401)res.setHeader('WWW-Authenticate',`Bearer resource_metadata="${config.baseUrl}/.well-known/oauth-protected-resource"`);
      const status=Number.isInteger(error.status)&&error.status>=400&&error.status<600?error.status:500;
      json(res,status,{error:status===500?'internal_error':error.code ?? 'request_failed',...(req.url?.startsWith('/oauth/authorize')?{iss:config.baseUrl}:{})});
    }
  }
  let timer, working=false;
  const workerHealth={lastSuccessAt:null,consecutiveFailures:0};
  async function tick() {
    if(working)return;working=true;
    try {
      for(const tenant of config.tenants) {
        await pool.query('INSERT INTO demo_outbox_cursors(tenant_id) VALUES($1) ON CONFLICT DO NOTHING',[tenant.id]);
        const {rows}=await pool.query('SELECT sequence FROM demo_outbox_cursors WHERE tenant_id=$1',[tenant.id]);
        const result=await tenantRequest(tenant.id,`/events?after=${Number(rows[0].sequence)}&limit=100`,{principal:service});
        for(const event of result.events) {
          if(event.tenantId!==tenant.id)throw problem(502,'restaurant_identity_mismatch');
          await events.enqueue(event);
          await pool.query('UPDATE demo_outbox_cursors SET sequence=GREATEST(sequence,$2) WHERE tenant_id=$1',[tenant.id,event.sequence]);
        }
      }
      for(let index=0;index<10;index++) {
        const result=await events.dispatchOnce();if(!result.attempted)break;
      }
      workerHealth.lastSuccessAt=new Date().toISOString();workerHealth.consecutiveFailures=0;
    } catch {
      workerHealth.consecutiveFailures++;
      // Fixed diagnostic only: never log payloads, callback URLs, identities or credentials.
      if(workerHealth.consecutiveFailures===1 || workerHealth.consecutiveFailures%60===0)process.stderr.write('Synthetic event worker retry pending\n');
    }
    finally { working=false; }
  }
  return {handle,pool,auth,store,events,channels,tenantRequest,tick,workerHealth,
    startWorker(){timer=setInterval(tick,1000);timer.unref();},
    async close(){clearInterval(timer);while(working)await new Promise(resolve=>setTimeout(resolve,20));await pool.end();},
  };
}

if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
  const config=configuration();
  const app=await createPlatform(config);
  const server=http.createServer(app.handle);
  server.requestTimeout=15_000;server.headersTimeout=10_000;
  server.listen(config.port,config.bind,()=>{
    process.stdout.write(`Synthetic prototype listening on port ${config.port}; payment=${config.paymentMode}; no production data\n`);
    app.startWorker();
  });
  const stop=()=>server.close(async()=>{await app.close();process.exit(0);});
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
