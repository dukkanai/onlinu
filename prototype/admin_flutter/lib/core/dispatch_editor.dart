import 'dart:async';
import 'package:flutter/material.dart';
import 'controller.dart';
import 'models.dart';

class DispatchEditor extends StatefulWidget {
  const DispatchEditor(
      {super.key, required this.controller, required this.order});
  final CoreController controller;
  final CoreOrder order;
  @override
  State<DispatchEditor> createState() => _DispatchEditorState();
}

class _DispatchEditorState extends State<DispatchEditor> {
  List<CoreCourier>? couriers;
  String? selected, error;
  bool review = false, loading = false;
  bool get allowed =>
      widget.controller.signedIn &&
      widget.controller.selectedTenant == widget.order.tenantId &&
      widget.controller.membership?.can('delivery:assign') == true;
  @override
  void initState() {
    super.initState();
    unawaited(load());
  }

  Future<void> load() async {
    setState(() {
      loading = true;
      error = null;
      couriers = null;
      selected = null;
      review = false;
    });
    try {
      final rows = await widget.controller.couriers(widget.order.tenantId);
      if (mounted && allowed) setState(() => couriers = rows);
    } catch (e) {
      if (mounted) setState(() => error = errorMessage(e));
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
      listenable: widget.controller,
      builder: (context, _) {
        final c = widget.controller,
            o = widget.order,
            rows = couriers ?? <CoreCourier>[];
        final stale = !c.orders
            .any((v) => v.number == o.number && v.version == o.version);
        final editable =
            allowed && c.writable && !stale && !loading && o.canAssign;
        final chosen = rows.where((v) => v.id == selected).firstOrNull;
        final ready = editable &&
            selected != null &&
            selected != o.courierId &&
            (selected == '' || chosen?.active == true);
        return AlertDialog(
            title: Text(
                review ? 'تأكيد إسناد المندوب' : 'إسناد الطلب ${o.number}'),
            content: SizedBox(
                width: 580,
                child: SingleChildScrollView(
                    child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                      if (!allowed)
                        const Text(
                            'تغيرت الجلسة أو صلاحية الإسناد. أغلق هذه النافذة.'),
                      if (allowed) ...[
                        Text('الطلب: ${o.number} • المطعم: ${o.tenantId}'),
                        Text(
                            'المندوب الحالي: ${o.courierId.isEmpty ? 'لم يُسند' : o.courierName}'),
                        if (stale)
                          const Text(
                              'تغير الطلب أثناء الاختيار. افتح نسخته الحالية.'),
                        if (loading) const LinearProgressIndicator(),
                        if (error != null) ...[
                          Text(error!),
                          TextButton(
                              onPressed: loading ? null : load,
                              child: const Text('إعادة تحميل المندوبين'))
                        ],
                        if (review) ...[
                          Text(selected == ''
                              ? 'سيُلغى إسناد المندوب الحالي.'
                              : 'المندوب الجديد: ${chosen?.name ?? ''}'),
                          if (chosen != null)
                            Text('الحالة الحالية: ${chosen.availabilityLabel}'),
                          if (chosen != null)
                            SelectableText(chosen.id,
                                textDirection: TextDirection.ltr),
                          const Text(
                              'إعادة الإسناد تنقل صلاحية متابعة هذا الطلب من المندوب السابق. هذا لا يسجل تحصيلًا أو تسليمًا.'),
                        ] else if (couriers != null) ...[
                          const Text(
                              'المندوبون المسجلون في النواة الحالية. لا تُنشأ حسابات أو كلمات مرور من هذه النافذة.'),
                          DropdownButtonFormField<String>(
                              initialValue: selected,
                              isExpanded: true,
                              decoration: const InputDecoration(
                                  labelText: 'المندوب المطلوب'),
                              items: [
                                const DropdownMenuItem(
                                    value: '', child: Text('إلغاء الإسناد')),
                                for (final courier
                                    in rows.where((v) => v.active))
                                  DropdownMenuItem(
                                      value: courier.id,
                                      child: Text(
                                          '${courier.name} • ${courier.availabilityLabel} • ${courier.id.substring(courier.id.length - 8)}',
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis))
                              ],
                              onChanged: editable
                                  ? (v) => setState(() => selected = v)
                                  : null),
                          if (rows.length == 500)
                            const Text(
                                'تُعرض أول 500 هوية مندوب من النواة الحالية.'),
                          if (rows.every((v) => !v.active))
                            const Text(
                                'لا يوجد مندوب مفعّل في القائمة الحالية.'),
                          if (chosen != null &&
                              chosen.availability != 'available')
                            const Text(
                                'المندوب ليس متاحًا الآن حسب آخر حالة. راجع ملاءمة إسناد الطلب قبل التأكيد.'),
                        ],
                      ]
                    ]))),
            actions: [
              TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('إلغاء')),
              if (review)
                TextButton(
                    onPressed:
                        allowed ? () => setState(() => review = false) : null,
                    child: const Text('رجوع للمراجعة')),
              FilledButton(
                  onPressed: ready
                      ? review
                          ? () => Navigator.pop(context, selected)
                          : () => setState(() => review = true)
                      : null,
                  child: Text(review ? 'تأكيد الإسناد' : 'مراجعة الإسناد'))
            ]);
      });
}
