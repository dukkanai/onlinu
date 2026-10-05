const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const money=value=>escape((value/100).toFixed(2))+' SAR';
// Both preview and confirmed receipt use the core's gross-inclusive tax snapshot.
// This is an order summary, not a certified electronic tax invoice.
export function checkoutSummary(value){
  const lines=value.items.map(item=>`<li>${escape(item.name)} × ${escape(item.quantity)}: ${money(item.totalMinor)}${item.options?.length?`<ul>${item.options.map(option=>`<li>${escape(option.name)} (${money(option.priceMinor)} لكل قطعة)</li>`).join('')}</ul>`:''}</li>`).join('');
  const tax=value.tax;
  return `<section aria-label="ملخص الطلب"><ul>${lines}</ul><dl><dt>مجموع الأصناف</dt><dd>${money(value.subtotalMinor)}</dd><dt>رسوم التوصيل</dt><dd>${money(value.deliveryFeeMinor)}</dd>${tax.enabled?`<dt>الصافي قبل الضريبة</dt><dd>${money(tax.netMinor)}</dd><dt>الضريبة المشمولة (${escape(tax.rateBps/100)}%)</dt><dd>${money(tax.taxMinor)}</dd>`:''}<dt>الإجمالي</dt><dd>${money(value.totalMinor)}</dd></dl>${tax.enabled&&tax.number?`<p>الرقم الضريبي للمطعم: ${escape(tax.number)}</p>`:''}${value.tableName?`<p>الطاولة: ${escape(value.tableName)}</p>`:''}${value.demo?'<p>هذا طلب تجريبي.</p>':''}</section>`;
}

export function checkoutErrorPage(code){
  const messages={
    quote_changed:'تغيّرت تفاصيل الطلب أو الضريبة بعد مراجعتك. ارجع إلى المحادثة واطلب عرض سعر ورابط تأكيد جديدين قبل المتابعة.',
    price_changed:'تغيّر سعر الطلب. ارجع إلى المحادثة واطلب عرض سعر ورابط تأكيد جديدين.',
    checkout_expired:'انتهت صلاحية رابط التأكيد. اطلب رابطًا جديدًا من المحادثة.',
    order_outcome_unknown:'لم يصل تأكيد نتيجة الطلب. لا تنشئ طلبًا آخر الآن. ارجع إلى رابط الطلب نفسه للتحقق من نتيجته.',
  };
  if(!messages[code])return null;
  return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>مراجعة الطلب</title><h1>يلزم التحقق قبل المتابعة</h1><p>${messages[code]}</p></html>`;
}
