import 'dart:async';
import 'package:flutter/material.dart';
import 'controller.dart';
import 'finance_models.dart';
import 'models.dart';
import 'refund_dialog.dart';

class FinanceDialog extends StatelessWidget {
  const FinanceDialog(
      {super.key, required this.controller, required this.number});
  final CoreController controller;
  final String number;
  Widget content(BuildContext context, CoreFinance data) => Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('المطعم: ${data.tenantId}'),
            Text(data.number, textDirection: TextDirection.ltr),
            if (data.demo) const Text('طلب تجريبي؛ ليس حركة أموال حقيقية.'),
            Text(
                'طريقة الدفع: ${financeMethodLabel(data.method)} • المزود: ${data.provider.isEmpty ? 'غير مرتبط' : data.provider}'),
            Text('حالة الدفع: ${financeStatusLabel(data.status)}'),
            for (final entry in {
              'إجمالي الطلب': data.total,
              'المبلغ المحصل المؤكد': data.captured,
              'المبلغ المحجوز للاسترداد': data.reserved,
              'المبلغ المسترد المؤكد': data.refunded,
              'المتاح لطلب استرداد': data.available
            }.entries)
              Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: Text('${entry.key}: ${money(entry.value)}')),
            const Text(
                'المحجوز يشمل الاستردادات المؤكدة والمعلقة غير الفاشلة؛ الإبلاغ اليدوي لا يساوي تأكيد المزود. هذه الشاشة للعرض ولا ترسل أموالًا.'),
            const Divider(),
            const Text('سجل الاستردادات • حتى 100 عملية'),
            if (data.refunds.isEmpty)
              const Text('لا توجد عمليات استرداد مسجلة.'),
            for (final refund in data.refunds)
              Card(
                  child: Padding(
                      padding: const EdgeInsets.all(10),
                      child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                                '${refundStatusLabel(refund.status)} • ${money(refund.amount)}'),
                            Text('الضريبة ضمن المبلغ: ${money(refund.tax)}'),
                            if (controller.canManageRefund)
                              TextButton(
                                  onPressed: controller.busy
                                      ? null
                                      : () async {
                                          unawaited(controller.showRefund(
                                              data.number, refund.id));
                                          await showDialog<void>(
                                              context: context,
                                              builder: (_) => RefundDialog(
                                                  controller: controller,
                                                  number: data.number,
                                                  id: refund.id));
                                          controller.closeRefund();
                                        },
                                  child: const Text('إدارة عملية الاسترداد')),
                            SelectableText(refund.id,
                                textDirection: TextDirection.ltr),
                            Text(
                                'آخر تحديث: ${localTimestamp(refund.updatedAt)}'),
                            Text(refund.submitted
                                ? 'سُجلت محاولة إرسال آلي للمزود'
                                : refund.authorized
                                    ? 'مصرّح في السجل؛ لا توجد محاولة إرسال آلي مسجلة'
                                    : 'لم يُصرّح بتنفيذه'),
                          ]))),
          ]);
  @override
  Widget build(BuildContext context) => ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final c = controller, data = c.finance;
        return AlertDialog(
            title: const Text('المدفوعات والاستردادات'),
            content: SizedBox(
                width: 600,
                child: SingleChildScrollView(
                    child: data == null
                        ? Text(c.loadingDetail
                            ? 'جارٍ تحميل السجل المالي…'
                            : c.message ??
                                'لم يعد السجل المالي متاحًا. حدّث البيانات.')
                        : content(context, data))),
            actions: [
              TextButton(
                  onPressed: c.busy || c.loadingDetail
                      ? null
                      : () => c.showFinance(number),
                  child: const Text('تحديث السجل المالي')),
              TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('إغلاق السجل المالي')),
            ]);
      });
}
