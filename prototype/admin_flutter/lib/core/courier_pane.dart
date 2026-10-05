import 'dart:async';
import 'package:flutter/material.dart';
import 'controller.dart';
import 'courier_models.dart';
import 'models.dart';

class CourierPane extends StatelessWidget {
  const CourierPane({super.key, required this.controller});
  final CoreController controller;
  Future<bool> confirm(BuildContext context, String title, String text) async =>
      await showDialog<bool>(
          context: context,
          builder: (context) =>
              AlertDialog(title: Text(title), content: Text(text), actions: [
                TextButton(
                    onPressed: () => Navigator.pop(context, false),
                    child: const Text('رجوع')),
                FilledButton(
                    onPressed: () => Navigator.pop(context, true),
                    child: const Text('تأكيد'))
              ])) ==
      true;
  Future<void> change(
      BuildContext context, CoreCourierWork work, CoreOrder order,
      {bool cash = false}) async {
    final accepted = await confirm(
        context,
        cash ? 'تأكيد استلام نقد التوصيل' : 'تأكيد مرحلة التوصيل',
        cash
            ? 'المطعم ${work.tenantId}، الطلب ${order.number}: هل استلمت فعليًا ${money(order.totalMinor)} من العميل؟ هذا يسجل تحصيلًا ماليًا.'
            : 'المطعم ${work.tenantId}، الطلب ${order.number}: ${deliveryStatusLabel(order.deliveryStatus)} ← ${deliveryStatusLabel(courierNextStage(order) ?? '')}؟');
    if (context.mounted && accepted)
      await controller.changeCourier(work, order, cash: cash);
  }

  Future<void> details(BuildContext context, CoreOrder order) async {
    unawaited(controller.showCourierDetail(order));
    await showDialog<void>(
        context: context,
        builder: (dialogContext) => ListenableBuilder(
            listenable: controller,
            builder: (context, _) {
              final detail = controller.courierDetail;
              return AlertDialog(
                  title: const Text('تفاصيل مهمتي'),
                  content: SizedBox(
                      width: 520,
                      child: SingleChildScrollView(
                          child: detail == null
                              ? Text(controller.loadingDetail
                                  ? 'جارٍ تحميل تفاصيل المهمة…'
                                  : controller.message ??
                                      'لم تعد تفاصيل المهمة متاحة.')
                              : Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                      Text(detail.order.number,
                                          textDirection: TextDirection.ltr),
                                      Text('العميل: ${detail.customerName}'),
                                      SelectableText(detail.phone,
                                          textDirection: TextDirection.ltr),
                                      for (final entry in detail.address.entries
                                          .where((v) => v.value.isNotEmpty))
                                        Text('${const {
                                          'addressLine': 'العنوان',
                                          'nationalAddress': 'العنوان الوطني',
                                          'city': 'المدينة',
                                          'district': 'الحي',
                                          'street': 'الشارع',
                                          'building': 'المبنى',
                                          'postalCode': 'الرمز البريدي',
                                          'additionalNumber': 'الرقم الإضافي'
                                        }[entry.key]}: ${entry.value}'),
                                      for (final item in detail.order.items)
                                        Text(
                                            '${item.quantity} × ${item.name}${item.options.isEmpty ? '' : ' • ${item.options.join('، ')}'}'),
                                      if (detail.order.notes.isNotEmpty)
                                        Text('ملاحظات: ${detail.order.notes}')
                                    ]))),
                  actions: [
                    TextButton(
                        onPressed: () => Navigator.pop(dialogContext),
                        child: const Text('إغلاق المهمة'))
                  ]);
            }));
    controller.closeDetail();
  }

  @override
  Widget build(BuildContext context) {
    final c = controller, work = c.courierWork, member = c.membership;
    if (work == null)
      return const Padding(
          padding: EdgeInsets.all(20), child: Text('جارٍ تحميل مهام المندوب…'));
    final courier = work.courier;
    if (courier == null)
      return const Padding(
          padding: EdgeInsets.all(20),
          child: Text(
              'لم تُربط هويتك بمندوب مفعّل في هذا المطعم. اطلب من مسؤول الربط مراجعة حسابك.'));
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const SizedBox(height: 20),
      const Text('مهامي كمندوب',
          style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
      Text('${courier.name} • ${courier.availabilityLabel}'),
      const Text(
          'تظهر هنا مهامك المسندة وغير المنتهية فقط، حتى 100 مهمة. لا يجمع هذا القسم موقع جهازك.'),
      Wrap(spacing: 10, children: [
        for (final value in const {
          'available': 'متاح',
          'busy': 'مشغول',
          'offline': 'غير متصل'
        }.entries)
          OutlinedButton(
              onPressed: !c.writable ||
                      member?.can('courier:update') != true ||
                      value.key == courier.availability
                  ? null
                  : () async {
                      if (await confirm(context, 'تغيير حالة التوفر',
                              'المطعم ${work.tenantId}: تغيير حالتك إلى ${value.value}؟') &&
                          context.mounted)
                        await c.setCourierAvailability(work, value.key);
                    },
              child: Text('حالتي: ${value.value}'))
      ]),
      if (work.orders.isEmpty)
        const Padding(
            padding: EdgeInsets.all(20),
            child: Text('لا توجد مهام مسندة إليك حاليًا.')),
      for (final order in work.orders)
        Card(
            child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(order.number,
                          textDirection: TextDirection.ltr,
                          style: const TextStyle(fontWeight: FontWeight.bold)),
                      Text(
                          '${deliveryStatusLabel(order.deliveryStatus)} • ${money(order.totalMinor)}'),
                      Text(
                          'الدفع: ${order.paymentMethod == 'cash_on_delivery' ? 'نقد عند التسليم' : 'إلكتروني'} • ${order.paymentStatus == 'paid' ? 'مدفوع' : 'غير مسدد أو قيد المراجعة'}'),
                      Wrap(spacing: 12, children: [
                        OutlinedButton(
                            onPressed: c.online && !c.busy
                                ? () => details(context, order)
                                : null,
                            child: const Text('تفاصيل مهمتي')),
                        if (courierNextStage(order) != null &&
                            member?.can('courier:update') == true)
                          FilledButton(
                              onPressed: c.writable &&
                                      (courierNextStage(order) != 'delivered' ||
                                          order.paymentStatus == 'paid')
                                  ? () => change(context, work, order)
                                  : null,
                              child: Text(deliveryStatusLabel(
                                  courierNextStage(order)!))),
                        if (courierCanCollect(order) &&
                            member?.can('courier:collect') == true)
                          FilledButton(
                              onPressed: c.writable
                                  ? () =>
                                      change(context, work, order, cash: true)
                                  : null,
                              child: const Text('استلمت نقد هذا الطلب'))
                      ])
                    ])))
    ]);
  }
}

class CourierLinksPane extends StatelessWidget {
  const CourierLinksPane({super.key, required this.controller});
  final CoreController controller;
  Future<void> edit(
      BuildContext context, CoreCourierLinks data, CoreCourierLink link) async {
    final target = await showDialog<String>(
        context: context, builder: (_) => _LinkEditor(data: data, link: link));
    if (context.mounted && target != null)
      await controller.setCourierLink(data, link, target);
  }

  @override
  Widget build(BuildContext context) {
    final c = controller, data = c.courierLinks;
    if (data == null) return const Text('جارٍ تحميل روابط المندوبين…');
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const SizedBox(height: 20),
      const Text('ربط هويات المندوبين',
          style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
      const Text(
          'اختر هوية موظف موثّقة صراحةً. الربط يتيح بيانات العميل ومهام المندوب حسب الصلاحيات. لا تُطابق الأسماء تلقائيًا. فك الربط يوقف وصول هذه الهوية عبر التطبيق، ولا يلغي دخول المندوب القديم بكلمة المرور.'),
      if (data.links.isEmpty) const Text('لا توجد حسابات مندوبين في المطعم.'),
      for (final link in data.links)
        Card(
            child: ListTile(
                title: Text(link.courier.name),
                subtitle: Text(
                    '${link.bound ? (link.principalName.isEmpty ? 'هوية مرتبطة غير متاحة' : link.principalName) : 'غير مربوط'} • ${link.activeOrders} مهام نشطة${link.bound && !link.eligible ? ' • الهوية غير مؤهلة حاليًا' : ''}'),
                trailing: OutlinedButton(
                    onPressed:
                        c.writable ? () => edit(context, data, link) : null,
                    child: const Text('مراجعة الربط'))))
    ]);
  }
}

class _LinkEditor extends StatefulWidget {
  const _LinkEditor({required this.data, required this.link});
  final CoreCourierLinks data;
  final CoreCourierLink link;
  @override
  State<_LinkEditor> createState() => _LinkEditorState();
}

class _LinkEditorState extends State<_LinkEditor> {
  String? target;
  bool reviewed = false;
  @override
  Widget build(BuildContext context) {
    final link = widget.link;
    final candidates =
        widget.data.candidates.where((v) => v.id != link.principalId).toList();
    return AlertDialog(
        title: const Text('مراجعة ربط هوية المندوب'),
        content: SizedBox(
            width: 560,
            child: SingleChildScrollView(
                child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                  Text(
                      'المطعم: ${widget.data.tenantId}\nالمندوب: ${link.courier.name}'),
                  SelectableText(link.courier.id,
                      textDirection: TextDirection.ltr),
                  if (link.principalId != null)
                    SelectableText('الهوية الحالية: ${link.principalId}'),
                  if (link.activeOrders > 0)
                    const Text(
                        'توجد مهام نشطة: يمكن فك الربط فقط. أعد إسناد المهام قبل ربط هوية جديدة.'),
                  DropdownButtonFormField<String>(
                      initialValue: target,
                      isExpanded: true,
                      decoration: const InputDecoration(
                          labelText: 'الهوية الجديدة أو فك الربط'),
                      items: [
                        if (link.bound)
                          const DropdownMenuItem(
                              value: '', child: Text('فك الربط الحالي')),
                        if (link.activeOrders == 0 && link.courier.active)
                          for (final v in candidates)
                            DropdownMenuItem(
                                value: v.id,
                                child: Text(
                                    '${v.name.isEmpty ? 'موظف' : v.name} • ${v.id}',
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis))
                      ],
                      onChanged: (v) => setState(() {
                            target = v;
                            reviewed = false;
                          })),
                  if (target != null && target!.isNotEmpty)
                    SelectableText(target!, textDirection: TextDirection.ltr),
                  CheckboxListTile(
                      value: reviewed,
                      onChanged: target == null
                          ? null
                          : (v) => setState(() => reviewed = v == true),
                      controlAffinity: ListTileControlAffinity.leading,
                      title: const Text(
                          'راجعت هوية الموظف والمندوب والمطعم وأثر تغيير الوصول إلى مهام التوصيل.'))
                ]))),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('إلغاء')),
          FilledButton(
              onPressed: target != null && reviewed
                  ? () => Navigator.pop(context, target)
                  : null,
              child: const Text('تأكيد تغيير الربط'))
        ]);
  }
}
