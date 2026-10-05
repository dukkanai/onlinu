const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const labels={new:'جديد',accepted:'مقبول',preparing:'قيد التحضير',ready:'جاهز',out_for_delivery:'خرج للتوصيل',completed:'مكتمل',cancelled:'ملغي',
  unpaid:'غير مدفوع',pending:'بانتظار التحقق',paid:'مدفوع',failed:'فشل الدفع',refunded:'مسترد',review:'يحتاج مراجعة'};
const label=value=>escape(labels[value]??value);
const page=(title,body)=>`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><h1>${escape(title)}</h1>${body}</html>`;

export function staffHome(principal){
  const memberships=principal.memberships.filter(member=>['orders:read','channels:manage','stock:read'].some(permission=>member.permissions.includes(permission)));
  return page('إدارة المطاعم',`<p>اختر المطعم. لا يظهر هنا إلا ما تسمح به عضويتك الحالية.</p><ul>${memberships.map(member=>`<li>${member.permissions.includes('orders:read')?`<a href="/manage/${escape(member.tenantId)}/orders">${escape(member.tenantId)}</a>`:escape(member.tenantId)} (${escape(member.role)}) ${member.permissions.includes('channels:manage')?`<a href="/manage/${escape(member.tenantId)}/channels">قنوات ${escape(member.tenantId)}</a>`:''} ${member.permissions.includes('stock:read')?`<a href="/manage/${escape(member.tenantId)}/stock">مخزون ${escape(member.tenantId)}</a>`:''}</li>`).join('')}</ul>${memberships.length?'':'<p>لا توجد عضوية تسمح بالإدارة.</p>'}<a href="/">الصفحة الرئيسية</a>`);
}

export function staffStockPage({tenantId,membership,items,catalog,csrf}){
  const names=new Map(catalog.items.map(item=>[item.id,item.name]));
  const sections=items.map(item=>{
    const name=names.get(item.itemId)??item.itemId;
    const state=item.tracked?`المتاح للبيع: ${escape(item.available)}. المحجوز: ${escape(item.held)}.`:'التتبع غير مفعّل؛ الصفر المعروض ليس قياسًا للمخزون الفعلي.';
    const form=membership.permissions.includes('stock:update')?`<form method="post" action="/manage/${escape(tenantId)}/stock/${escape(item.itemId)}"><fieldset><legend>تعديل مخزون ${escape(name)}</legend><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="version" value="${escape(item.version)}"><label>تتبع مخزون ${escape(name)} <select name="tracked"><option value="true" ${item.tracked?'selected':''}>مفعّل</option><option value="false" ${!item.tracked?'selected':''}>غير مفعّل</option></select></label><label>الكمية المتاحة للبيع من ${escape(name)} <input name="available" type="number" min="0" max="1000000" step="1" required value="${escape(item.available)}"></label><button>حفظ مخزون ${escape(name)}</button></fieldset></form>`:'';
    return `<section><h2>${escape(name)}</h2><p>${state}</p><p>الإصدار: ${escape(item.version)}</p>${form}</section>`;
  }).join('');
  return page('مخزون '+tenantId,`<a href="/manage">مطاعمي</a><p>الجرد يضبط المتاح للبيع فقط، خارج الكميات المحجوزة أو المباعة. لا يمسح الحجوزات القائمة. عند تعطيل التتبع يجب أن تكون الكمية صفرًا؛ وقد يُرفض التغيير حتى تسوية الطلبات الجارية.</p>${sections||'<p>لا توجد أصناف.</p>'}`);
}

export function staffChannelsPage({tenantId,channels,csrf}){
  const names={web:'الموقع',chatgpt:'ChatGPT',whatsapp_qr:'واتساب QR',whatsapp_cloud:'واتساب Cloud API'};
  const sections=channels.map(policy=>`<section><h2>${escape(names[policy.channel]??policy.channel)}</h2><p>استقبال الطلبات الجديدة: ${policy.newOrdersEnabled?'مسموح بالإعداد':'متوقف بالإعداد'}. الإصدار: ${escape(policy.version)}</p>${policy.adapterImplemented?`<form method="post" action="/manage/${escape(tenantId)}/channels/${escape(policy.channel)}"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="expectedVersion" value="${escape(policy.version)}"><label>استقبال طلبات ${escape(names[policy.channel])} <select name="newOrdersEnabled"><option value="true" ${policy.newOrdersEnabled?'selected':''}>مسموح</option><option value="false" ${!policy.newOrdersEnabled?'selected':''}>متوقف</option></select></label><button>حفظ إعداد القناة</button></form>`:'<p>محول الطلبات لهذه القناة غير مكتمل. هذا لا يغيّر اتصال واتساب أو المكالمات القائمة.</p>'}</section>`).join('');
  return page('قنوات '+tenantId,`<a href="/manage">مطاعمي</a><p>الإيقاف يمنع إنشاء طلبات جديدة فقط. تبقى الطلبات السابقة وحالاتها ومدفوعاتها قابلة للمتابعة. السماح لا يغني عن جاهزية الربط وفتح المطعم.</p>${sections}`);
}

export function staffOrdersPage({tenantId,membership,orders,csrf}){
  const next=order=>({new:['accepted','cancelled'],accepted:['preparing','cancelled'],preparing:['ready','cancelled'],
    ready:[order.mode==='delivery'?'out_for_delivery':'completed','cancelled'],out_for_delivery:['completed','cancelled']}[order.status]??[]);
  const form=(order,action,fields,button)=>`<form method="post" action="/manage/${escape(tenantId)}/orders/${escape(order.number)}/${action}"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="version" value="${escape(order.version)}">${fields}<button>${button}</button></form>`;
  const cards=orders.map(order=>{
    const statuses=next(order);
    const status=membership.permissions.includes('orders:update')&&statuses.length?form(order,'status',`<label>الحالة التالية للطلب ${escape(order.number)} <select name="status">${statuses.map(value=>`<option value="${value}">${label(value)}</option>`).join('')}</select></label>`,'تحديث الحالة'):'';
    const cash=membership.permissions.includes('payments:collect')&&['cash_on_delivery','cash_before','cash_after'].includes(order.paymentMethod)&&order.paymentStatus==='unpaid'&&order.status!=='cancelled'?form(order,'cash','<p>لا تسجّل التحصيل إلا بعد استلام المبلغ نقدًا.</p>','تأكيد استلام المبلغ النقدي'):'';
    const detail=Array.isArray(order.items)?`<h3>الأصناف</h3><ul>${order.items.map(item=>`<li>${escape(item.name)} × ${escape(item.quantity)} (${escape((item.totalMinor/100).toFixed(2))} SAR) ${(item.options??[]).map(option=>escape(option.name)).join('، ')}</li>`).join('')}</ul>${order.tableName?`<p>الطاولة: ${escape(order.tableName)}</p>`:''}${order.notes?`<h3>تعليمات الطلب</h3><p>${escape(order.notes)}</p>`:''}`:'';
    return `<article><h2><a href="/manage/${escape(tenantId)}/orders/${escape(order.number)}">${escape(order.number)}</a></h2><p>الحالة: ${label(order.status)}. الدفع: ${label(order.paymentStatus)}.</p><p>الإجمالي: ${escape((order.totalMinor/100).toFixed(2))} SAR. الإصدار: ${escape(order.version)}</p>${detail}${status}${cash}</article>`;
  }).join('');
  return page('طلبات '+tenantId,`<nav><a href="/manage">مطاعمي</a> · <a href="/manage/${escape(tenantId)}/orders">تحديث القائمة</a></nav>${membership.tenantStatus==='suspended'?'<p>المطعم موقوف عن العمل الجديد؛ متابعة وتسوية الطلبات القائمة متاحة وفق صلاحياتك.</p>':''}<p>${orders.some(order=>Array.isArray(order.items))?'تفاصيل الأصناف وتعليمات التنفيذ محفوظة كما كانت عند الطلب.':'أحدث 100 طلب.'} هذه واجهة تشغيل أولية؛ تبقى إدارة المطعم الأصلية متاحة للوظائف الأخرى.</p>${cards||'<p>لا توجد طلبات.</p>'}`);
}
