const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const labels={new:'جديد',accepted:'مقبول',preparing:'قيد التحضير',ready:'جاهز',out_for_delivery:'خرج للتوصيل',completed:'مكتمل',cancelled:'ملغي',
  unpaid:'غير مدفوع',pending:'بانتظار التحقق',paid:'مدفوع',failed:'فشل الدفع',refunded:'مسترد',review:'يحتاج مراجعة'};
const label=value=>escape(labels[value]??value);
const page=(title,body)=>`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><h1>${escape(title)}</h1>${body}</html>`;

export function staffHome(principal){
  const sections=[['orders:read','orders',''],['menu:read','menu','منيو '],['stock:read','stock','مخزون '],['channels:manage','channels','قنوات ']];
  const memberships=principal.memberships.filter(member=>sections.some(([permission])=>member.permissions.includes(permission)));
  const rows=memberships.map(member=>{
    const links=sections.filter(([permission])=>member.permissions.includes(permission)).map(([,path,prefix])=>`<a href="/manage/${escape(member.tenantId)}/${path}">${escape(prefix+member.tenantId)}</a>`).join(' · ');
    return `<li>${links} (${escape(member.role)})</li>`;
  }).join('');
  return page('إدارة المطاعم',`<p>اختر المطعم. لا يظهر هنا إلا ما تسمح به عضويتك الحالية.</p><ul>${rows}</ul>${memberships.length?'':'<p>لا توجد عضوية تسمح بالإدارة.</p>'}<a href="/">الصفحة الرئيسية</a>`);
}

export function menuPriceMinor(value){
  if(typeof value!=='string')return null;
  const normalized=value.trim().replace(/[٠-٩]/g,char=>String(char.charCodeAt(0)-0x660)).replace(/[۰-۹]/g,char=>String(char.charCodeAt(0)-0x6f0)).replace(/٫/g,'.');
  if(!/^\d{1,7}(?:\.\d{1,2})?$/.test(normalized))return null;
  const [whole,fraction='']=normalized.split('.');
  const minor=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  return minor<=100_000_000?minor:null;
}

export function staffMenuPage({tenantId,menu,membership,csrf,newItemId,newCategoryId}){
  const categories=new Map(menu.categories.map(category=>[category.id,category.name]));
  const items=menu.items.map(item=>`<li><a href="/manage/${escape(tenantId)}/menu/items/${escape(item.id)}">${escape(item.name)}</a> — ${escape(categories.get(item.categoryId)??item.categoryId)} — ${escape((item.priceMinor/100).toFixed(2))} SAR — ${item.available?'مفعّل في المنيو':'غير مفعّل'}</li>`).join('');
  const hidden=(id)=>`<input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="expectedVersion" value="${escape(menu.version)}"><input type="hidden" name="id" value="${escape(id)}">`;
  const create=membership?.permissions.includes('menu:update')?`<section><h2>إضافة قسم</h2><form method="post" action="/manage/${escape(tenantId)}/menu/new-category">${hidden(newCategoryId)}<label>اسم القسم الجديد <input name="name" required maxlength="120"></label><input type="hidden" name="sort" value="0"><button>إضافة القسم</button></form></section>${menu.categories.length?`<section><h2>إضافة صنف</h2><form method="post" action="/manage/${escape(tenantId)}/menu/new-item">${hidden(newItemId)}<label>اسم الصنف الجديد <input name="name" required maxlength="160"></label><label>القسم للصنف الجديد <select name="categoryId">${menu.categories.map(category=>`<option value="${escape(category.id)}">${escape(category.name)}</option>`).join('')}</select></label><label>سعر الصنف الجديد <input name="price" inputmode="decimal" required maxlength="16"></label><button>إضافة الصنف للمراجعة</button></form><p>يُضاف الصنف غير مفعّل حتى تراجع تفاصيله وتفعّله.</p></section>`:'<p>أضف قسمًا أولًا لإضافة الأصناف.</p>'}`:'';
  const categoryEditor=membership?.permissions.includes('menu:update')?`<h2>تعديل الأقسام</h2>${menu.categories.map(category=>`<form method="post" action="/manage/${escape(tenantId)}/menu/categories/${escape(category.id)}"><fieldset><legend>${escape(category.name)}</legend><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="expectedVersion" value="${escape(menu.version)}"><label>اسم القسم <input name="name" required maxlength="120" value="${escape(category.name)}"></label><label>ترتيب القسم <input name="sort" type="number" min="0" max="10000" step="1" required value="${escape(category.sort)}"></label><button>حفظ القسم</button></fieldset></form>`).join('')}`:'';
  return page('منيو '+menu.name,`<a href="/manage">مطاعمي</a><p>الإصدار: ${escape(menu.version)}. التغييرات الجديدة لا تعيد تسعير الطلبات السابقة.</p><ul>${items}</ul>${create}${categoryEditor}`);
}

export function staffMenuItemPage({tenantId,membership,menu,csrf,newOptionId}){
  const item=menu.item;
  const options=(item.options??[]).map(option=>`<li>${escape(option.name)}: ${escape((option.priceMinor/100).toFixed(2))} SAR (${option.available?'مفعّل':'غير مفعّل'})</li>`).join('');
  const form=membership.permissions.includes('menu:update')?`<form method="post" action="/manage/${escape(tenantId)}/menu/items/${escape(item.id)}"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="expectedVersion" value="${escape(menu.version)}"><label>اسم الصنف <input name="name" required maxlength="320" value="${escape(item.name)}"></label><label>الوصف <textarea name="description" maxlength="4000">${escape(item.description)}</textarea></label><label>السعر بالريال السعودي <input name="price" inputmode="decimal" required maxlength="16" value="${escape((item.priceMinor/100).toFixed(2))}"></label><label>القسم <select name="categoryId">${menu.categories.map(category=>`<option value="${escape(category.id)}" ${item.categoryId===category.id?'selected':''}>${escape(category.name)}</option>`).join('')}</select></label><label>التوفر اليدوي <select name="available"><option value="true" ${item.available?'selected':''}>مفعّل</option><option value="false" ${!item.available?'selected':''}>غير مفعّل</option></select></label><label>الترتيب <input type="number" name="sort" min="0" max="10000" step="1" required value="${escape(item.sort)}"></label><button>حفظ الصنف</button></form>`:'';
  const imageName=/^\/restaurant-media\/([a-f0-9]{64}\.(?:png|jpg))$/.exec(item.imageUrl??'')?.[1];
  const preview=imageName?`<img src="/restaurant-media/${escape(tenantId)}/${imageName}" alt="صورة ${escape(item.name)}" width="320">`:item.imageUrl?'<p>توجد صورة خارجية محفوظة للصنف؛ لا تُحمّل تلقائيًا هنا.</p>':'';
  const imageForm=membership.permissions.includes('menu:update')?`<h2>صورة الصنف</h2>${preview}<form method="post" enctype="multipart/form-data" action="/manage/${escape(tenantId)}/menu/items/${escape(item.id)}/image"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="expectedVersion" value="${escape(menu.version)}"><label>صورة PNG أو JPEG <input type="file" name="image" accept="image/png,image/jpeg" required></label><button>رفع وحفظ الصورة</button></form><p>حتى 5 ميغابايت و4096 بكسل لكل بُعد. تُزال بيانات الصورة الوصفية؛ تظهر الصورة للزبائن بعد الحفظ. الصورة السابقة لا تُحذف.</p>`:preview;
  const optionForm=(option,isNew=false)=>`<form method="post" action="/manage/${escape(tenantId)}/menu/items/${escape(item.id)}/options${isNew?'':'/'+escape(option.id)}"><fieldset><legend>${isNew?'إضافة خيار جديد':escape(option.name)}</legend><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="expectedVersion" value="${escape(menu.version)}">${isNew?`<input type="hidden" name="id" value="${escape(newOptionId)}">`:''}<label>اسم الإضافة <input name="name" required maxlength="120" value="${escape(option.name)}"></label><label>سعر الإضافة <input name="price" inputmode="decimal" required maxlength="16" value="${escape((option.priceMinor/100).toFixed(2))}"></label><label>تفعيل الإضافة <select name="available" aria-label="تفعيل الإضافة"><option value="true" ${option.available?'selected':''}>مفعّلة</option><option value="false" ${!option.available?'selected':''}>غير مفعّلة</option></select></label><button>${isNew?'إضافة الخيار':'حفظ الإضافة'}</button></fieldset></form>`;
  const optionEditor=membership.permissions.includes('menu:update')?`<h2>تعديل الإضافات</h2>${(item.options??[]).map(option=>optionForm(option)).join('')}${(item.options??[]).length<50?optionForm({name:'',priceMinor:0,available:false},true):'<p>بلغ الصنف الحد الأقصى: 50 إضافة.</p>'}<p>يمكن تعطيل الإضافة دون تغيير الطلبات السابقة. كل حفظ يتطلب أحدث إصدار من المنيو.</p>`:'';
  return page(item.name,`<a href="/manage/${escape(tenantId)}/menu">المنيو</a><p>السعر: ${escape((item.priceMinor/100).toFixed(2))} SAR. الإصدار: ${escape(menu.version)}</p><p>تظل قواعد المخزون وفتح المطعم سارية. هذا النموذج يحافظ على الصورة والإضافات وإعدادات المطعم والطاولات.</p>${form}<h2>الإضافات الحالية</h2><ul>${options}</ul>${optionEditor}${imageForm}`);
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
