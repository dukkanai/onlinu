import 'dart:async';
import 'package:flutter/material.dart';
import 'controller.dart';
import 'models.dart';
import 'support_models.dart';
import 'finance_models.dart';
import 'finance_dialog.dart';

class SupportPane extends StatefulWidget {
  const SupportPane({super.key, required this.controller});
  final CoreController controller;
  @override
  State<SupportPane> createState() => _SupportPaneState();
}

class _SupportPaneState extends State<SupportPane> {
  final lookup = TextEditingController();
  String? error;
  @override
  void dispose() {
    lookup.dispose();
    super.dispose();
  }

  Future<void> open(String number) async {
    if (!RegExp(r'^R[0-9]{8,20}$').hasMatch(number)) {
      setState(() => error = 'أدخل رقم طلب صالحًا يبدأ بحرف R.');
      return;
    }
    setState(() => error = null);
    final c = widget.controller;
    unawaited(c.showSupport(number));
    await showDialog<void>(
        context: context,
        builder: (_) => SupportDialog(controller: c, number: number));
    c.closeSupport();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller, queue = c.support;
    if (queue == null) return const Text('لم تُحمّل قائمة الإلغاء والشكاوى.');
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const SizedBox(height: 20),
      const Text('الإلغاء والشكاوى',
          style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
      const Text(
          'طلبات بها إلغاء معلق أو شكاوى مفتوحة، مرتبة من أقدم طلب. المعالجة تحتاج صلاحية إدارة الإلغاء والشكاوى.'),
      if (queue.hasMore)
        const Text(
            'يوجد أكثر من 100 طلب معلق. معالجة الأقدم تُظهر البقية؛ يمكنك فتح طلب معروف برقمه.'),
      TextField(
          controller: lookup,
          maxLength: 21,
          textDirection: TextDirection.ltr,
          decoration: const InputDecoration(labelText: 'رقم الطلب للدعم')),
      if (error != null) Text(error!),
      TextButton(
          onPressed:
              c.busy ? null : () => open(lookup.text.trim().toUpperCase()),
          child: const Text('فتح طلب الدعم')),
      if (queue.orders.isEmpty) const Text('لا توجد طلبات دعم معلقة حاليًا.'),
      for (final entry in queue.orders)
        Card(
            child: ListTile(
                title:
                    Text(entry.order.number, textDirection: TextDirection.ltr),
                subtitle: Text(
                    '${coreStatusLabel(entry.order.status)} • ${entry.cancellationPending ? 'إلغاء معلق • ' : ''}${entry.openComplaints} شكاوى مفتوحة'),
                trailing: TextButton(
                    onPressed: c.busy ? null : () => open(entry.order.number),
                    child: const Text('مراجعة الدعم')))),
    ]);
  }
}

class SupportDialog extends StatefulWidget {
  const SupportDialog(
      {super.key, required this.controller, required this.number});
  final CoreController controller;
  final String number;
  @override
  State<SupportDialog> createState() => _SupportDialogState();
}

class _SupportDialogState extends State<SupportDialog> {
  final reason = TextEditingController();
  CoreSupportDetail? snapshot;
  CoreSupportRequest? selected;
  String? action, error;
  bool? approve;
  bool reviewing = false, confirmed = false;
  @override
  void dispose() {
    reason.dispose();
    super.dispose();
  }

  void choose(CoreSupportDetail data, CoreSupportRequest request, String kind,
      bool? approval) {
    setState(() {
      snapshot = data;
      selected = request;
      action = kind;
      approve = approval;
      reviewing = false;
      confirmed = false;
      error = null;
      reason.clear();
    });
  }

  String get actionLabel => action == 'resolve'
      ? 'حفظ معالجة الشكوى'
      : approve == true
          ? 'الموافقة على الإلغاء'
          : 'رفض الإلغاء';
  Widget requestView(CoreSupportRequest request) =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(request.label),
        SelectableText(request.id, textDirection: TextDirection.ltr),
        Text('السبب: ${request.reason}'),
        Text('وقت الطلب: ${localTimestamp(request.requestedAt)}'),
        if (request.response.isNotEmpty)
          Text('الرد المسجل: ${request.response}')
      ]);
  @override
  Widget build(BuildContext context) => ListenableBuilder(
      listenable: widget.controller,
      builder: (context, _) {
        final c = widget.controller,
            data = c.supportDetail,
            visible = c.canReadSupport &&
                data != null &&
                data.order.number == widget.number,
            current = visible &&
                snapshot != null &&
                snapshot!.order.version == data.order.version &&
                snapshot!.order.tenantId == data.order.tenantId;
        return AlertDialog(
            title: const Text('تفاصيل الإلغاء والشكاوى'),
            content: SizedBox(
                width: 620,
                child: SingleChildScrollView(
                    child: !visible
                        ? Text(c.loadingSupport
                            ? 'جارٍ تحميل الدعم…'
                            : c.message ?? 'لم تعد بيانات الدعم متاحة.')
                        : Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                                Text('المطعم: ${data.order.tenantId}'),
                                Text(data.order.number,
                                    textDirection: TextDirection.ltr),
                                Text(
                                    'الإصدار: ${data.order.version} • ${coreStatusLabel(data.order.status)}'),
                                Text(
                                    'إجمالي الطلب: ${money(data.order.totalMinor)} • الدفع: ${financeStatusLabel(data.order.paymentStatus)}'),
                                Text(data.demo
                                    ? 'طلب تجريبي.'
                                    : 'طلب فعلي؛ راجع القرار بعناية.'),
                                const Text(
                                    'الموافقة تلغي الطلب وفق قواعد التحضير والمخزون الأصلية. قد ينشأ طلب استرداد غير مصرح؛ لا يُرسل المال تلقائيًا. معالجة الشكوى لا تغير مبلغ الطلب.'),
                                if (c.message != null) Text(c.message!),
                                if (data.cancellation != null)
                                  Card(
                                      child: Padding(
                                          padding: const EdgeInsets.all(8),
                                          child: Column(
                                              crossAxisAlignment:
                                                  CrossAxisAlignment.start,
                                              children: [
                                                requestView(data.cancellation!),
                                                if (data.cancellation!.open &&
                                                    !{
                                                      'cancelled',
                                                      'completed'
                                                    }.contains(
                                                        data.order.status) &&
                                                    c.canManageSupport &&
                                                    action == null)
                                                  Wrap(spacing: 8, children: [
                                                    OutlinedButton(
                                                        onPressed: c.writable
                                                            ? () => choose(
                                                                data,
                                                                data
                                                                    .cancellation!,
                                                                'decide',
                                                                true)
                                                            : null,
                                                        child: const Text(
                                                            'مراجعة الموافقة على الإلغاء')),
                                                    OutlinedButton(
                                                        onPressed: c.writable
                                                            ? () => choose(
                                                                data,
                                                                data
                                                                    .cancellation!,
                                                                'decide',
                                                                false)
                                                            : null,
                                                        child: const Text(
                                                            'مراجعة رفض الإلغاء')),
                                                  ])
                                              ]))),
                                for (final complaint in data.complaints)
                                  Card(
                                      child: Padding(
                                          padding: const EdgeInsets.all(8),
                                          child: Column(
                                              crossAxisAlignment:
                                                  CrossAxisAlignment.start,
                                              children: [
                                                requestView(complaint),
                                                if (complaint.open &&
                                                    c.canManageSupport &&
                                                    action == null)
                                                  OutlinedButton(
                                                      key: ValueKey(
                                                          'support-resolve-${complaint.id}'),
                                                      onPressed: c.writable
                                                          ? () => choose(
                                                              data,
                                                              complaint,
                                                              'resolve',
                                                              null)
                                                          : null,
                                                      child: const Text(
                                                          'مراجعة معالجة الشكوى'))
                                              ]))),
                                if (data.cancellation == null &&
                                    data.complaints.isEmpty)
                                  const Text(
                                      'لا توجد طلبات إلغاء أو شكاوى مسجلة لهذا الطلب.'),
                                if (action != null && c.canManageSupport) ...[
                                  const Divider(),
                                  Text(actionLabel),
                                  Text(
                                      'مرجع المراجعة: ${selected!.id} • الإصدار ${snapshot!.order.version}'),
                                  if (!current)
                                    const Text(
                                        'تغير الطلب. ألغِ المراجعة وحدّث البيانات قبل القرار.'),
                                  if (error != null) Text(error!),
                                  TextField(
                                      controller: reason,
                                      enabled: !reviewing && current && !c.busy,
                                      maxLength: 1000,
                                      maxLines: 3,
                                      decoration: const InputDecoration(
                                          labelText:
                                              'سبب القرار أو تفاصيل المعالجة')),
                                  if (!reviewing)
                                    FilledButton(
                                        onPressed: current && c.writable
                                            ? () {
                                                if (reason.text
                                                    .trim()
                                                    .isEmpty) {
                                                  setState(() => error =
                                                      'اكتب سبب القرار أو المعالجة.');
                                                  return;
                                                }
                                                FocusScope.of(context)
                                                    .unfocus();
                                                setState(() {
                                                  reviewing = true;
                                                  confirmed = false;
                                                  error = null;
                                                });
                                              }
                                            : null,
                                        child: const Text('مراجعة قرار الدعم'))
                                  else ...[
                                    Text(
                                        'تأكيد $actionLabel للطلب ${snapshot!.order.number} في المطعم ${snapshot!.order.tenantId}، إجمالي ${money(snapshot!.order.totalMinor)}، الإصدار ${snapshot!.order.version}.'),
                                    const Text(
                                        'الاسترداد المالي يحتاج مراجعة وتصريحًا منفصلين؛ هذا القرار لا يرسل المال.'),
                                    CheckboxListTile(
                                        value: confirmed,
                                        onChanged: current && !c.busy
                                            ? (v) => setState(
                                                () => confirmed = v == true)
                                            : null,
                                        title: const Text(
                                            'راجعت الطلب والسبب وأثر القرار وأؤكد التنفيذ')),
                                    FilledButton(
                                        onPressed: current &&
                                                confirmed &&
                                                c.writable
                                            ? () async {
                                                final expected = snapshot!,
                                                    request = selected!,
                                                    kind = action!,
                                                    approval = approve;
                                                setState(
                                                    () => confirmed = false);
                                                await c.changeSupport(
                                                    expected, request.id, kind,
                                                    approve: approval,
                                                    reason: reason.text.trim());
                                                if (mounted)
                                                  setState(() {
                                                    action = null;
                                                    snapshot = null;
                                                    selected = null;
                                                    reviewing = false;
                                                    reason.clear();
                                                  });
                                              }
                                            : null,
                                        child: const Text('تأكيد قرار الدعم')),
                                  ],
                                  TextButton(
                                      onPressed: c.busy
                                          ? null
                                          : () => setState(() {
                                                action = null;
                                                snapshot = null;
                                                selected = null;
                                                reviewing = false;
                                                confirmed = false;
                                              }),
                                      child: const Text('إلغاء مراجعة الدعم')),
                                ] else if (action != null)
                                  const Text(
                                      'لم تعد صلاحية اتخاذ القرار متاحة.'),
                                if (data.history.isNotEmpty) ...[
                                  const Divider(),
                                  const Text('سجل الإلغاءات السابق'),
                                  for (final item in data.history)
                                    Padding(
                                        padding: const EdgeInsets.all(8),
                                        child: requestView(item))
                                ],
                                if (data.historyTruncated)
                                  const Text(
                                      'يعرض آخر 20 إلغاء سابقًا. السجل الكامل محفوظ في الإدارة الأصلية.'),
                                if (c.membership?.can('payments:read') == true)
                                  TextButton(
                                      onPressed: c.busy
                                          ? null
                                          : () async {
                                              unawaited(
                                                  c.showFinance(widget.number));
                                              await showDialog<void>(
                                                  context: context,
                                                  builder: (_) => FinanceDialog(
                                                      controller: c,
                                                      number: widget.number));
                                              c.closeDetail();
                                            },
                                      child: const Text(
                                          'فتح السجل المالي لهذا الطلب')),
                              ]))),
            actions: [
              TextButton(
                  onPressed: c.busy
                      ? null
                      : () {
                          setState(() {
                            action = null;
                            snapshot = null;
                            selected = null;
                            reviewing = false;
                            confirmed = false;
                          });
                          unawaited(c.showSupport(widget.number));
                        },
                  child: const Text('تحديث بيانات الدعم')),
              TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('إغلاق الدعم')),
            ]);
      });
}
