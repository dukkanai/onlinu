import {createAuth,NATIVE_CLIENT_ID,NATIVE_SCOPE,problem} from './auth.mjs';

const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const page=(title,body)=>`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><h1>${escape(title)}</h1>${body}</html>`;
const roleLabel={owner:'مالك',manager:'مدير',supervisor:'مشرف',kitchen:'مطبخ',cashier:'كاشير',courier:'مندوب'};
const grantFields=['client_id','redirect_uri','response_type','resource','scope','state','code_challenge','code_challenge_method'];
function grantInput(entries){
 if(new Set(entries.map(([key])=>key)).size!==entries.length||entries.some(([key,value])=>!grantFields.includes(key)||typeof value!=='string'))throw problem(400,'invalid_authorization_request');
 return Object.fromEntries(entries);
}
export async function createNativeStaff({pool,baseUrl,csrfKey,directory,browserAuth,staffApi,body,json,htmlHeaders,redirect}){
 const issuer=baseUrl+'/native';
 const auth=createAuth({pool,baseUrl:issuer,profile:'native_staff',csrfKey,allowSyntheticAuthorization:false,
  principalResolver:async id=>{const who=await directory.resolve(id);return who?.memberships.length?who:null;}});
 await auth.init();
 async function browser(req){
  if(req.headers.authorization)throw problem(403,'browser_session_required');
  const who=await browserAuth.authenticate(req,{cookieOnly:true});if(!who)throw problem(401,'authentication_required');return who;
 }
 function consentHeaders(res,input){
  res.setHeader('content-security-policy',`default-src 'none'; form-action 'self' ${new URL(input.redirect_uri).origin}; frame-ancestors 'none'; base-uri 'none'`);
 }
 async function handle(req,res,url){
  const path=url.pathname;
  if(req.method==='GET'&&path==='/.well-known/oauth-authorization-server/native')return json(res,200,auth.metadata);
  if(req.method==='GET'&&['/native/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/native/api'].includes(path))return json(res,200,auth.resourceMetadata);
  if(path.startsWith('/native/api/')){
   if(req.headers.cookie||req.headers.origin)throw problem(403,'native_bearer_required');
   const who=await auth.authenticate(req,{bearerOnly:true});if(!who?.scopes.includes(NATIVE_SCOPE)){res.setHeader('www-authenticate',`Bearer realm="onlinu-native"${req.headers.authorization?', error="invalid_token"':''}`);throw problem(401,'authentication_required');}
   if(url.search)throw problem(400,'invalid_request');
   if(req.method==='GET'&&path==='/native/api/me')return json(res,200,{principal:who});
   const tenant=/^\/native\/api\/restaurants\/([a-z0-9-]{1,64})(?:\/|$)/.exec(path)?.[1];
   const member=who.memberships.find(row=>row.tenantId===tenant);
   // Native restaurant access cannot inherit platform-operator bypasses.
   if(!tenant||!member)throw problem(403,'forbidden');
   if(/^\/native\/api\/restaurants\/[^/]+\/members(?:\/|$)/.test(path)&&!member.permissions.includes('members:manage'))throw problem(403,'forbidden');
   const target=new URL('/api'+path.slice('/native/api'.length),baseUrl);
   return staffApi(req,res,who,target,{restaurantOnly:true});
  }
  if(req.method==='POST'&&['/native/oauth/token','/native/oauth/revoke'].includes(path)){
   if(req.headers.cookie||req.headers.authorization||req.headers.origin)throw problem(403,'native_client_required');
   if(url.search)throw problem(400,'invalid_request');
   const input=await body(req);if(input.client_id!==NATIVE_CLIENT_ID)throw problem(400,'invalid_client_metadata');
   if(path.endsWith('/token'))return json(res,200,await auth.exchange(input));
   await auth.revoke(input.token);return json(res,200,{});
  }
  if(path==='/native/oauth/authorize'&&req.method==='GET'){
   const input=grantInput([...url.searchParams]);await auth.validateAuthorization(input);
   if(req.headers.authorization)throw problem(403,'browser_session_required');
   const who=await browserAuth.authenticate(req,{cookieOnly:true});
   if(!who)return redirect(res,'/auth/login?returnTo='+encodeURIComponent(path+url.search));
   if(!await auth.principal(who.id)){htmlHeaders(res,403);res.end(page('عضوية الإدارة مطلوبة','<p>اطلب من مالك المطعم إضافة حسابك أولًا.</p><a href="/manage">عرض معرّف حسابك</a>'));return;}
   const hidden=Object.entries(input).map(([key,value])=>`<input type="hidden" name="${key}" value="${escape(value)}">`).join('');
   const memberships=who.memberships.map(row=>`<li>${escape(row.tenantId)}: ${escape(roleLabel[row.role]??row.role)}</li>`).join('');
   consentHeaders(res,input);htmlHeaders(res);
   res.end(page('ربط تطبيق إدارة Onlinu',`<p>وافق فقط إذا بدأت الدخول من نسختك الموثوقة من تطبيق Windows. سيعود المتصفح إلى التطبيق على جهازك.</p><p>يتيح الربط وظائف الإدارة وفق صلاحياتك الحالية في المطاعم أدناه، لمدة أقصاها 8 ساعات. لا يمنح صلاحيات إضافية؛ يمكنك إبطاله من صفحة جلسات التطبيق.</p><ul>${memberships}</ul><form method="post" action="/native/oauth/authorize">${hidden}<input type="hidden" name="csrf" value="${escape(browserAuth.csrfToken(req))}"><button name="approve" value="yes">ربط تطبيق الإدارة</button><button name="approve" value="no">إلغاء الربط</button></form>`));return;
  }
  if(path==='/native/oauth/authorize'&&req.method==='POST'){
   if(req.headers.origin!==baseUrl||url.search)throw problem(403,'origin_required');
   const who=await browser(req),input=await body(req);browserAuth.verifyCsrf(req,input.csrf);
   const {csrf,approve,...submitted}=input,grant=grantInput(Object.entries(submitted));await auth.validateAuthorization(grant);
   let destination;
   if(approve==='no'){
    const callback=new URL(grant.redirect_uri);callback.searchParams.set('error','access_denied');callback.searchParams.set('state',grant.state);callback.searchParams.set('iss',issuer);destination=callback.href;
   }else if(approve==='yes')destination=await auth.authorize(grant,who);
   else throw problem(400,'invalid_request');
   consentHeaders(res,grant);return redirect(res,destination,303);
  }
  const sessions=/^\/native\/sessions(?:\/(all|[A-Za-z0-9_-]{43}))?$/.exec(path);
  if(sessions){
   if(url.search)throw problem(400,'invalid_request');
   if(req.method==='GET'&&!sessions[1]){
    if(req.headers.authorization)throw problem(403,'browser_session_required');
    const who=await browserAuth.authenticate(req,{cookieOnly:true});if(!who)return redirect(res,'/auth/login?returnTo=%2Fnative%2Fsessions');
    const grants=await auth.nativeGrants(who.id),csrf=browserAuth.csrfToken(req);
    const revoke=(id,label)=>`<form method="post" action="/native/sessions/${id}"><input type="hidden" name="csrf" value="${escape(csrf)}"><button>${label}</button></form>`;
    htmlHeaders(res);res.end(page('جلسات تطبيق الإدارة',`<a href="/manage">الإدارة</a><p>أحدث 100 جلسة فعّالة. إبطال جميع الجلسات يشمل الأقدم أيضًا ولا يغيّر ربط ChatGPT أو جلسة هذا المتصفح.</p>${grants.map(row=>`<section><h2>جلسة ${escape(row.id.slice(0,8))}</h2><p>تنتهي (UTC): ${escape(row.expiresAt)}</p>${revoke(row.id,'إبطال هذه الجلسة')}</section>`).join('')}${revoke('all','إبطال جميع جلسات التطبيق')}`));return;
   }
   if(req.method==='POST'&&sessions[1]){
    if(req.headers.origin!==baseUrl)throw problem(403,'origin_required');
    const who=await browser(req),input=await body(req);browserAuth.verifyCsrf(req,input.csrf);
    if(Object.keys(input).some(key=>key!=='csrf'))throw problem(400,'invalid_request');
    await auth.revokeNativeGrant(who.id,sessions[1]);return redirect(res,'/native/sessions',303);
   }
  }
  throw problem(404,'not_found');
 }
 return{auth,handle};
}
