import test from 'node:test';
import assert from 'node:assert/strict';
import {checkoutSummary} from './checkout-pages.mjs';
test('checkout summary lists selected options and inclusive tax once with escaped text',()=>{
 const html=checkoutSummary({items:[{name:'<img src=x>',quantity:2,totalMinor:3000,options:[{name:'Extra & sauce',priceMinor:300}]}],
 subtotalMinor:3000,deliveryFeeMinor:500,totalMinor:3500,tax:{enabled:true,rateBps:1500,number:'<synthetic>',netMinor:3043,taxMinor:457,grossMinor:3500},demo:true});
 assert.match(html,/&lt;img src=x&gt;/);assert.doesNotMatch(html,/<img/);assert.match(html,/Extra &amp; sauce/);
 for(const amount of ['30.00','5.00','35.00','30.43','4.57','3.00'])assert.ok(html.includes(amount+' SAR'));
 assert.match(html,/الضريبة المشمولة \(15%\)/);assert.match(html,/هذا طلب تجريبي/);
 assert.doesNotMatch(html,/40\.00/);
});

test('review failures explain recovery without claiming a failed order was not created',async()=>{
 const {checkoutErrorPage}=await import('./checkout-pages.mjs');
 assert.match(checkoutErrorPage('quote_changed'),/عرض سعر/);
 assert.match(checkoutErrorPage('order_outcome_unknown'),/لا تنشئ طلبًا آخر/);
 assert.equal(checkoutErrorPage('<script>'),null);
});

test('customer support review escapes messages and uncertain outcomes block new forms',async()=>{
 const {checkoutSupportPage}=await import('./checkout-pages.mjs');
 const order={number:'R12345678',version:3,totalMinor:3500,status:'preparing',paymentStatus:'paid',demo:true,cancellation:null,complaints:[],cancellationHistory:[],historyTruncated:false};
 const args={checkoutId:'synthetic',tenantId:'a',order,csrf:'token',requestId:'request'};
 const initial=checkoutSupportPage(args);assert.match(initial,/مراجعة طلب إلغاء/);assert.match(initial,/مراجعة إرسال شكوى/);assert.doesNotMatch(initial,/\/execute/);
 const review=checkoutSupportPage({...args,review:{kind:'cancellation',requestId:'request',version:3,reason:'<script>private</script>'}});
 assert.doesNotMatch(review,/<script>/);assert.match(review,/&lt;script&gt;/);assert.match(review,/name="reviewed" value="yes" required/);assert.match(review,/لا يعني اكتمال الاسترداد/);
 const pending=checkoutSupportPage({...args,pending:{kind:'complaint',requestId:'unknown'}});assert.doesNotMatch(pending,/<form/);assert.match(pending,/نتيجة الإرسال لم تتأكد/);
 const retry=checkoutSupportPage({...args,pending:{kind:'complaint',requestId:'unknown',version:3}});assert.match(retry,/retry-review/);assert.doesNotMatch(retry,/retry-execute/);assert.match(retry,/أعد كتابة السبب الأصلي/);
 const retryReview=checkoutSupportPage({...args,review:{retry:true,kind:'complaint',requestId:'unknown',version:2,reason:'original'}});assert.match(retryReview,/retry-execute/);assert.match(retryReview,/نسخة المراجعة الأصلية: 2/);assert.match(retryReview,/name="reviewed" value="yes" required/);
 const terminal=checkoutSupportPage({...args,order:{...order,status:'cancelled'}});assert.doesNotMatch(terminal,/مراجعة طلب إلغاء/);assert.match(terminal,/مراجعة إرسال شكوى/);
});


test('customer machine states are readable Arabic without treating review as refunded',async()=>{
 const {checkoutOrderStatus,checkoutPaymentStatus,checkoutSupportPage}=await import('./checkout-pages.mjs');
 assert.equal(checkoutOrderStatus('cancelled'),'ملغي');assert.equal(checkoutPaymentStatus('review'),'قيد المراجعة المالية');
 const html=checkoutSupportPage({checkoutId:'id',tenantId:'a',csrf:'token',requestId:'key',order:{number:'R12345678',version:2,totalMinor:3500,status:'cancelled',paymentStatus:'review',complaints:[],cancellationHistory:[],cancellation:{status:'approved',reason:'Synthetic',decisionReason:'before_preparation',id:'key'}}});
 assert.match(html,/تم الإلغاء تلقائيًا قبل بدء التحضير/);assert.match(html,/قيد المراجعة المالية/);assert.doesNotMatch(html,/before_preparation|حالة الدفع: مسترد/);
});
