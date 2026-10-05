const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const labels={new:'جديد',accepted:'مقبول',preparing:'قيد التحضير',ready:'جاهز',out_for_delivery:'خرج للتوصيل',completed:'مكتمل',cancelled:'ملغي',
  unpaid:'غير مدفوع',pending:'بانتظار التحقق',paid:'مدفوع',failed:'فشل الدفع',refunded:'مسترد',review:'يحتاج مراجعة'};
const label=value=>escape(labels[value]??value);
const page=(title,body)=>`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><h1>${escape(title)}</h1>${body}</html>`;

export function staffHome(principal){
  const memberships=principal.memberships.filter(member=>member.permissions.includes('orders:read'));
  return page('إدارة المطاعم',`<p>اختر المطعم لإدارة الطلبات. لا يظهر هنا إلا ما تسمح به عضويتك الحالية.</p><ul>${memberships.map(member=>`<li><a href="/manage/${escape(member.tenantId)}/orders">${escape(member.tenantId)}</a> (${escape(member.role)})</li>`).join('')}</ul>${memberships.length?'':'<p>لا توجد عضوية تسمح بعرض الطلبات.</p>'}<a href="/">الصفحة الرئيسية</a>`);
}

export function staffOrdersPage({tenantId,membership,orders,csrf}){
  const next=order=>({new:['accepted','cancelled'],accepted:['preparing','cancelled'],preparing:['ready','cancelled'],
    ready:[order.mode==='delivery'?'out_for_delivery':'completed','cancelled'],out_for_delivery:['completed','cancelled']}[order.status]??[]);
  const form=(order,action,fields,button)=>`<form method="post" action="/manage/${escape(tenantId)}/orders/${escape(order.number)}/${action}"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="version" value="${escape(order.version)}">${fields}<button>${button}</button></form>`;
  const cards=orders.map(order=>{
    const statuses=next(order);
    const status=membership.permissions.includes('orders:update')&&statuses.length?form(order,'status',`<label>الحالة التالية للطلب ${escape(order.number)} <select name="status">${statuses.map(value=>`<option value="${value}">${label(value)}</option>`).join('')}</select></label>`,'تحديث الحالة'):'';
    const cash=membership.permissions.includes('payments:collect')&&['cash_on_delivery','cash_before','cash_after'].includes(order.paymentMethod)&&order.paymentStatus==='unpaid'&&order.status!=='cancelled'?form(order,'cash','<p>لا تسجّل التحصيل إلا بعد استلام المبلغ نقدًا.</p>','تأكيد استلام المبلغ النقدي'):'';
    return `<article><h2>${escape(order.number)}</h2><p>الحالة: ${label(order.status)}. الدفع: ${label(order.paymentStatus)}.</p><p>الإجمالي: ${escape((order.totalMinor/100).toFixed(2))} SAR. الإصدار: ${escape(order.version)}</p>${status}${cash}</article>`;
  }).join('');
  return page('طلبات '+tenantId,`<nav><a href="/manage">مطاعمي</a> · <a href="/manage/${escape(tenantId)}/orders">تحديث القائمة</a></nav>${membership.tenantStatus==='suspended'?'<p>المطعم موقوف عن العمل الجديد؛ متابعة وتسوية الطلبات القائمة متاحة وفق صلاحياتك.</p>':''}<p>أحدث 100 طلب. هذه واجهة تشغيل أولية؛ تبقى إدارة المطعم الأصلية متاحة للوظائف الأخرى.</p>${cards||'<p>لا توجد طلبات.</p>'}`);
}
