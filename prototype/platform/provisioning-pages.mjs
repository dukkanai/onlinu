import { problem } from './auth.mjs';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const states = { queued: 'بانتظار التنفيذ', claimed: 'محجوز لعامل', unknown: 'النتيجة غير مؤكدة', succeeded: 'سُجّل نجاح التجهيز', cancelled: 'أُلغي طلب التجهيز' };
export function provisioningQuery(params) {
  const entries = [...params];
  if (new Set(entries.map(([k])=>k)).size !== entries.length || entries.some(([k])=>!['state','tenantId','after','limit'].includes(k))) throw problem(400,'invalid_request');
  const value=Object.fromEntries(entries),result={};
  if (value.state) { if (!Object.hasOwn(states,value.state)) throw problem(400,'invalid_request'); result.state=value.state; }
  if (value.tenantId) { if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.tenantId)) throw problem(400,'invalid_request'); result.tenantId=value.tenantId; }
  if (value.after !== undefined) { if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.after)) throw problem(400,'invalid_request'); result.after=value.after; }
  if (value.limit !== undefined) { if (!/^(?:[1-9][0-9]?|100)$/.test(value.limit)) throw problem(400,'invalid_request'); result.limit=Number(value.limit); }
  return result;
}
export function provisioningQueuePage(page,query) {
  const next=page.nextCursor?'/operator/provisioning?'+new URLSearchParams({...query,after:page.nextCursor}):null;
  return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>سجل تجهيز المطاعم</title>
<h1>سجل تجهيز المطاعم</h1><p>عرض للمشغّل فقط. لا تنفّذ هذه الصفحة أو تعيد أو تلغي أي عملية. نجاح التجهيز لا يعني نشر المطعم أو تفعيله.</p>
<form method="get" action="/operator/provisioning"><label for="provision-tenant">المطعم</label> <input id="provision-tenant" name="tenantId" value="${escape(query.tenantId)}" maxlength="64">
<label for="provision-state">الحالة</label> <select id="provision-state" name="state"><option value="">كل الحالات</option>${Object.entries(states).map(([key,label])=>`<option value="${key}"${query.state===key?' selected':''}>${label}</option>`).join('')}</select>
<label for="provision-limit">عدد النتائج</label> <input id="provision-limit" name="limit" type="number" min="1" max="100" value="${escape(query.limit??25)}"><button>تصفية</button></form>
<p>ترتيب الأحدث أولًا. النتائج قد تتغير أثناء التصفح؛ حدّث القائمة لرؤية الطلبات الجديدة.</p>
${page.jobs.length?'':'<p>لا توجد طلبات مطابقة.</p>'}
${page.jobs.map(job=>`<article><h2>${escape(job.tenantId)}</h2><p>${escape(states[job.state]??'حالة غير معروفة')}${job.leaseExpired?' — انتهت مهلة العامل، وتحتاج مراجعة صريحة.':''}</p>
<dl><dt>رقم الطلب</dt><dd><code>${escape(job.id)}</code></dd><dt>الإصدار</dt><dd>${escape(job.version)}</dd><dt>وقت الإنشاء UTC</dt><dd>${escape(job.createdAt)}</dd><dt>آخر تعديل UTC</dt><dd>${escape(job.updatedAt)}</dd></dl>
<details><summary>مراجع التحقق</summary><p>الخطة: <code>${escape(job.planDigest)}</code></p><p>دليل التحقق: <code>${escape(job.evidenceDigest??'لم يسجل')}</code></p></details></article>`).join('')}
${next?`<a href="${escape(next)}">الصفحة التالية</a>`:''} <a href="/operator/provisioning">تحديث من البداية</a></html>`;
}
