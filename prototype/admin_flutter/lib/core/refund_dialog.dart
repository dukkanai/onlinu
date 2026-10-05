import 'dart:convert';
import 'package:flutter/material.dart';
import 'controller.dart';
import 'finance_models.dart';
import 'refund_models.dart';
import 'models.dart';

class RefundDialog extends StatefulWidget {
  const RefundDialog(
      {super.key,
      required this.controller,
      required this.number,
      required this.id});
  final CoreController controller;
  final String number, id;
  @override
  State<RefundDialog> createState() => _RefundDialogState();
}

class _RefundDialogState extends State<RefundDialog> {
  final reference = TextEditingController(), reason = TextEditingController();
  String? action, validation;
  CoreRefundDetail? reviewed;
  bool confirmed = false;
  @override
  void dispose() {
    reference.dispose();
    reason.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
      listenable: widget.controller,
      builder: (context, _) {
        final c = widget.controller, r = c.refund;
        final visible = c.canManageRefund &&
            r != null &&
            r.id == widget.id &&
            r.number == widget.number;
        final current = visible &&
            reviewed != null &&
            reviewed!.version == r.version &&
            reviewed!.tenantId == r.tenantId;
        return AlertDialog(
            title: const Text('مراجعة عملية الاسترداد'),
            content: SizedBox(
                width: 600,
                child: SingleChildScrollView(
                    child: !visible
                        ? Text(c.loadingRefund
                            ? 'جارٍ تحميل عملية الاسترداد…'
                            : c.message ?? 'لم تعد بيانات الاسترداد متاحة.')
                        : Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                                Text('المطعم: ${r.tenantId}'),
                                Text(r.number,
                                    textDirection: TextDirection.ltr),
                                SelectableText(r.id,
                                    textDirection: TextDirection.ltr),
                                Text(
                                    'المبلغ: ${money(r.amount)} • الضريبة ضمنه: ${money(r.tax)}'),
                                Text(
                                    'المزود: ${r.provider.isEmpty ? 'غير مرتبط' : r.provider} • الإصدار: ${r.version}'),
                                Text(r.demo
                                    ? 'طلب تجريبي؛ لا يمثل أموالًا حقيقية.'
                                    : 'طلب فعلي؛ التصريح قد يرسل أموالًا حقيقية.'),
                                Text('الحالة: ${refundStatusLabel(r.status)}'),
                                Text('سبب الطلب: ${r.reason}'),
                                if (r.providerReference.isNotEmpty)
                                  Text('مرجع المزود: ${r.providerReference}'),
                                if (r.manualReference.isNotEmpty)
                                  Text('المرجع اليدوي: ${r.manualReference}'),
                                if (r.resolutionReason.isNotEmpty)
                                  Text(
                                      'ملاحظة المعالجة: ${r.resolutionReason}'),
                                const Text(
                                    'الإبلاغ اليدوي لا يساوي تأكيد المزود. التحقق والتحديث لا ينشئان دفعة استرداد جديدة.'),
                                if (c.message != null) Text(c.message!),
                                if (action == null)
                                  Wrap(spacing: 8, children: [
                                    for (final value in [
                                      'authorize',
                                      'manual',
                                      'verify',
                                      'refresh'
                                    ])
                                      if (r.supports(value))
                                        OutlinedButton(
                                            onPressed: !c.writable
                                                ? null
                                                : () => setState(() {
                                                      action = value;
                                                      reviewed = null;
                                                      confirmed = false;
                                                    }),
                                            child:
                                                Text(refundActionLabel(value)))
                                  ])
                                else ...[
                                  const Divider(),
                                  Text(refundActionLabel(action!)),
                                  if (action == 'authorize')
                                    const Text(
                                        'هذا تصريح بتنفيذ المبلغ المذكور بواسطة عامل الاسترداد. إلغاء الطلب وحده لا يصرح بتحويل الأموال.'),
                                  if (action == 'manual')
                                    const Text(
                                        'سجّل فقط استردادًا نفذته سابقًا خارج التطبيق. هذا الزر لا ينفذ التحويل ولا يؤكد المزود.'),
                                  if (action == 'verify')
                                    const Text(
                                        'أدخل مرجع العملية الموجودة لدى المزود للتحقق منها دون إرسال استرداد جديد.'),
                                  if ({'manual', 'verify'}
                                      .contains(action)) ...[
                                    TextField(
                                        controller: reference,
                                        enabled: reviewed == null && !c.busy,
                                        maxLength: 200,
                                        decoration: const InputDecoration(
                                            labelText: 'مرجع الاسترداد')),
                                    TextField(
                                        controller: reason,
                                        enabled: reviewed == null && !c.busy,
                                        maxLength: 1000,
                                        decoration: const InputDecoration(
                                            labelText:
                                                'سبب الإجراء أو ملاحظة التحقق')),
                                  ],
                                  if (validation != null) Text(validation!),
                                  if (reviewed == null)
                                    FilledButton(
                                        onPressed: !c.writable
                                            ? null
                                            : () {
                                                if ({'manual', 'verify'}
                                                    .contains(action)) {
                                                  final refBytes = utf8
                                                          .encode(reference.text
                                                              .trim())
                                                          .length,
                                                      reasonBytes = utf8
                                                          .encode(reason.text
                                                              .trim())
                                                          .length;
                                                  if (refBytes < 3 ||
                                                      refBytes > 200 ||
                                                      reasonBytes < 3 ||
                                                      reasonBytes > 1000) {
                                                    setState(() => validation =
                                                        'أدخل مرجعًا وملاحظة صالحين. الحد 200 بايت للمرجع و1000 للملاحظة؛ الحروف العربية قد تشغل أكثر من بايت.');
                                                    return;
                                                  }
                                                }
                                                validation = null;
                                                FocusScope.of(context)
                                                    .unfocus();
                                                setState(() {
                                                  reviewed = r;
                                                  confirmed = false;
                                                });
                                              },
                                        child: const Text('مراجعة الإجراء'))
                                  else ...[
                                    Text(
                                        'تأكيد ${refundActionLabel(action!)} للمبلغ ${money(reviewed!.amount)}، المطعم ${reviewed!.tenantId}، الطلب ${reviewed!.number}، المزود ${reviewed!.provider.isEmpty ? "غير مرتبط" : reviewed!.provider}، ${reviewed!.demo ? "تجريبي" : "فعلي"}، الإصدار ${reviewed!.version}.'),
                                    if (!current)
                                      const Text(
                                          'تغيرت العملية. أعد المراجعة قبل أي إرسال.'),
                                    CheckboxListTile(
                                        value: confirmed,
                                        onChanged: current && !c.busy
                                            ? (v) => setState(
                                                () => confirmed = v == true)
                                            : null,
                                        title: const Text(
                                            'راجعت المبلغ والمزود ووضع التجربة وأؤكد هذا الإجراء')),
                                    FilledButton(
                                        onPressed: !current ||
                                                !confirmed ||
                                                !c.writable
                                            ? null
                                            : () async {
                                                final expected = reviewed!,
                                                    selected = action!;
                                                setState(
                                                    () => confirmed = false);
                                                await c.manageRefund(
                                                    expected, selected,
                                                    reference: {
                                                      'manual',
                                                      'verify'
                                                    }.contains(selected)
                                                        ? reference.text.trim()
                                                        : null,
                                                    reason: {'manual', 'verify'}
                                                            .contains(selected)
                                                        ? reason.text.trim()
                                                        : null);
                                                if (mounted)
                                                  setState(() {
                                                    action = null;
                                                    reviewed = null;
                                                    reference.clear();
                                                    reason.clear();
                                                  });
                                              },
                                        child: const Text(
                                            'تأكيد إجراء الاسترداد')),
                                  ],
                                  TextButton(
                                      onPressed: c.busy
                                          ? null
                                          : () => setState(() {
                                                action = null;
                                                reviewed = null;
                                                confirmed = false;
                                              }),
                                      child: const Text('إلغاء المراجعة')),
                                ],
                              ]))),
            actions: [
              TextButton(
                  onPressed: c.busy
                      ? null
                      : () {
                          setState(() {
                            action = null;
                            reviewed = null;
                            confirmed = false;
                          });
                          c.showRefund(widget.number, widget.id);
                        },
                  child: const Text('تحديث عملية الاسترداد')),
              TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('إغلاق عملية الاسترداد')),
            ]);
      });
}
