const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const money=value=>escape((value/100).toFixed(2))+' SAR';
// Label only known machine states; unknown text is still escaped by the caller.
export const checkoutOrderStatus=value=>({new:'جديد',accepted:'مقبول',preparing:'قيد التحضير',ready:'جاهز',out_for_delivery:'في الطريق',completed:'مكتمل',cancelled:'ملغي'}[value]??value);
export const checkoutPaymentStatus=value=>({unpaid:'غير مدفوع',pending:'بانتظار تأكيد الدفع',paid:'مدفوع',review:'قيد المراجعة المالية',refunded:'مسترد',failed:'تعذر الدفع',cancelled:'ملغي'}[value]??value);
const supportResponse=value=>value==='before_preparation'?'تم الإلغاء تلقائيًا قبل بدء التحضير':value;
// Both preview and confirmed receipt use the core's gross-inclusive tax snapshot.
// This is an order summary, not a certified electronic tax invoice.
export function checkoutSummary(value){
  const lines=value.items.map(item=>`<li>${escape(item.name)} × ${escape(item.quantity)}: ${money(item.totalMinor)}${item.options?.length?`<ul>${item.options.map(option=>`<li>${escape(option.name)} (${money(option.priceMinor)} لكل قطعة)</li>`).join('')}</ul>`:''}</li>`).join('');
  const tax=value.tax;
  return `<section aria-label="ملخص الطلب"><ul>${lines}</ul><dl><dt>مجموع الأصناف</dt><dd>${money(value.subtotalMinor)}</dd><dt>رسوم التوصيل</dt><dd>${money(value.deliveryFeeMinor)}</dd>${tax.enabled?`<dt>الصافي قبل الضريبة</dt><dd>${money(tax.netMinor)}</dd><dt>الضريبة المشمولة (${escape(tax.rateBps/100)}%)</dt><dd>${money(tax.taxMinor)}</dd>`:''}<dt>الإجمالي</dt><dd>${money(value.totalMinor)}</dd></dl>${tax.enabled&&tax.number?`<p>الرقم الضريبي للمطعم: ${escape(tax.number)}</p>`:''}${value.tableName?`<p>الطاولة: ${escape(value.tableName)}</p>`:''}${value.demo?'<p>هذا طلب تجريبي.</p>':''}</section>`;
}

export function checkoutErrorPage(code){
  const messages={
    support_request_pending:'توجد نتيجة إرسال غير مؤكدة لهذا الطلب. ارجع إلى صفحة متابعة الإلغاء والشكاوى للتحقق قبل إرسال طلب جديد.',
    support_request_rejected:'لم يُقبل هذا الإرسال. افتح صفحة الطلب وحدّث بياناته ثم راجع طلب دعم جديدًا.',
    quote_changed:'تغيّرت تفاصيل الطلب أو الضريبة بعد مراجعتك. ارجع إلى المحادثة واطلب عرض سعر ورابط تأكيد جديدين قبل المتابعة.',
    price_changed:'تغيّر سعر الطلب. ارجع إلى المحادثة واطلب عرض سعر ورابط تأكيد جديدين.',
    checkout_expired:'انتهت صلاحية رابط التأكيد. اطلب رابطًا جديدًا من المحادثة.',
    order_outcome_unknown:'لم يصل تأكيد نتيجة الطلب. لا تنشئ طلبًا آخر الآن. ارجع إلى رابط الطلب نفسه للتحقق من نتيجته.',
  };
  if(!messages[code])return null;
  return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>مراجعة الطلب</title><h1>يلزم التحقق قبل المتابعة</h1><p>${messages[code]}</p></html>`;
}


export function checkoutSupportPage({checkoutId,tenantId,order,pending,csrf,requestId,review}){
  const base='/checkout/'+escape(checkoutId),support=base+'/support';
  const hidden=(name,value)=>`<input type="hidden" name="${name}" value="${escape(value)}">`;
  const kindLabel=kind=>kind==='cancellation'?'طلب إلغاء':'إرسال شكوى';
  const state=value=>({requested:'بانتظار قرار المطعم',approved:'تمت الموافقة',rejected:'مرفوض',open:'مفتوحة',resolved:'تم الرد عليها'}[value]??value);
  const requestCard=(value,kind)=>`<article><h3>${kindLabel(kind)}: ${escape(state(value.status))}</h3><p>${escape(value.reason)}</p><p>رد المطعم: ${escape(supportResponse(value.decisionReason||value.resolution||'لم يصل رد بعد'))}</p><p>مرجع الطلب: ${escape(value.id)}</p></article>`;
  const warning='<p>طلب الإلغاء قبل بدء التحضير قد يُعتمد مباشرة. بعد بدء التحضير يحتاج قرار المطعم. اعتماد الإلغاء لا يعني اكتمال الاسترداد المالي؛ تتم مراجعته بشكل منفصل.</p>';
  const facts=`<p>المطعم: ${escape(tenantId)} · الطلب: ${escape(order.number)} · الإصدار: ${escape(order.version)}</p><p>الإجمالي: ${money(order.totalMinor)} · حالة الطلب: ${escape(checkoutOrderStatus(order.status))} · حالة الدفع: ${escape(checkoutPaymentStatus(order.paymentStatus))}</p>${order.demo?'<p>طلب تجريبي</p>':''}`;
  let controls='';
  if(pending&&!review)controls=`<p role="status">نتيجة الإرسال لم تتأكد بعد. لا ترسل طلبًا جديدًا. أعد فتح هذه الصفحة للتحقق من نفس المرجع؛ إذا استمرت الحالة فتواصل مع المطعم.</p><p>مرجع المتابعة: ${escape(pending.requestId)}</p><a href="${support}">التحقق من نفس الطلب</a>`;
  if(pending&&!review&&pending.version)controls+=`<p>يمكنك إعادة الإرسال بنفس المرجع والنسخة والسبب الأصلي فقط. لا يُعاد الإرسال تلقائيًا. إذا تغير الطلب فسيُرفض الطلب القديم بأمان.</p><form method="post" action="${support}/retry-review">${hidden('csrf',csrf)}${hidden('kind',pending.kind)}${hidden('requestId',pending.requestId)}${hidden('version',pending.version)}<label>أعد كتابة السبب الأصلي<textarea name="reason" maxlength="1000" required></textarea></label><button>مراجعة إعادة الإرسال بنفس المرجع</button></form>`;
  if(review)controls=`<section aria-label="مراجعة طلب الدعم"><h2>${review.retry?'راجع إعادة الإرسال بنفس المرجع':'راجع قبل الإرسال'}: ${kindLabel(review.kind)}</h2>${review.retry?`<p>نسخة المراجعة الأصلية: ${escape(review.version)}. لن يُنشأ طلب دعم ثانٍ لنفس المرجع، ولن يتم تجاوز تغيّر نسخة الطلب.</p>`:''}<p>${escape(review.reason)}</p>${warning}<form method="post" action="${support}/${review.retry?'retry-execute':'execute'}">${hidden('csrf',csrf)}${hidden('kind',review.kind)}${hidden('requestId',review.requestId)}${hidden('version',review.version)}${hidden('reason',review.reason)}<label><input type="checkbox" name="reviewed" value="yes" required>راجعت الطلب والسبب وأؤكد الإرسال</label><button>تأكيد إرسال طلب الدعم</button></form><a href="${support}">إلغاء المراجعة</a></section>`;
  else if(!pending) {
    const form=kind=>`<form method="post" action="${support}/review">${hidden('csrf',csrf)}${hidden('kind',kind)}${hidden('requestId',requestId)}${hidden('version',order.version)}<label>سبب ${kindLabel(kind)}<textarea name="reason" maxlength="1000" required></textarea></label><button>مراجعة ${kindLabel(kind)}</button></form>`;
    if(!['cancelled','completed'].includes(order.status)&&(!order.cancellation||order.cancellation.status==='rejected'))controls+=form('cancellation');
    if(order.complaints.length<10)controls+=form('complaint');
  }
  return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>متابعة الإلغاء والشكاوى</title><h1>متابعة الإلغاء والشكاوى</h1>${facts}${warning}${order.cancellation?requestCard(order.cancellation,'cancellation'):''}${order.complaints.map(value=>requestCard(value,'complaint')).join('')}${order.cancellationHistory.length?`<details><summary>طلبات الإلغاء السابقة${order.historyTruncated?' (آخر 20 فقط)':''}</summary>${order.cancellationHistory.map(value=>requestCard(value,'cancellation')).join('')}</details>`:''}${controls}<p><a href="${base}">العودة إلى الطلب</a></p></html>`;
}
