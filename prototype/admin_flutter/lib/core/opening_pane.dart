import 'package:flutter/material.dart';
import 'controller.dart';
import 'opening_schedule.dart';

class OpeningPane extends StatelessWidget {
  const OpeningPane({super.key, required this.controller});
  final CoreController controller;
  @override
  Widget build(BuildContext context) {
    final policy = controller.opening;
    if (policy == null) return const Text('لم تُحمّل مواعيد العمل.');
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Text('مواعيد عمل المطعم',
          style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
      Text(policy.enabled
          ? 'المواعيد الآلية مفعلة — توقيت السعودية'
          : 'المواعيد الآلية معطلة؛ تتبع الطلبات سياسة الاستقبال اليدوية.'),
      for (var i = 0; i < 7; i++)
        ListTile(
            title: Text(openingDays[i]),
            subtitle: Text(
                policy.dayText(i).isEmpty ? 'مغلق' : policy.dayText(i),
                textDirection: TextDirection.ltr)),
      if (policy.exceptions.isNotEmpty)
        Text(policy.exceptionsText, textDirection: TextDirection.ltr),
      if (controller.membership?.can('settings:update') == true)
        FilledButton(
            onPressed: controller.writable
                ? () async {
                    final result = await showDialog<CoreOpeningSchedule>(
                        context: context,
                        builder: (_) => OpeningEditor(
                            controller: controller, policy: policy));
                    if (result != null)
                      await controller.patchOpeningSchedule(policy, result);
                  }
                : null,
            child: const Text('تعديل مواعيد العمل'))
    ]);
  }
}

class OpeningEditor extends StatefulWidget {
  const OpeningEditor(
      {super.key, required this.controller, required this.policy});
  final CoreController controller;
  final CoreOpeningSchedule policy;
  @override
  State<OpeningEditor> createState() => _OpeningEditorState();
}

class _OpeningEditorState extends State<OpeningEditor> {
  late List<TextEditingController> days;
  late TextEditingController dates;
  late bool enabled;
  CoreOpeningSchedule? review;
  bool confirmed = false;
  String? error;
  @override
  void initState() {
    super.initState();
    enabled = widget.policy.enabled;
    days = List.generate(
        7, (i) => TextEditingController(text: widget.policy.dayText(i)));
    dates = TextEditingController(text: widget.policy.exceptionsText);
  }

  @override
  void dispose() {
    for (final field in days) {
      field.dispose();
    }
    dates.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
      listenable: widget.controller,
      builder: (context, _) {
        final c = widget.controller,
            allowed = c.selectedTenant == widget.policy.tenantId &&
                c.membership?.can('settings:read') == true;
        final editable = allowed &&
            c.writable &&
            c.membership?.can('settings:update') == true &&
            c.opening?.version == widget.policy.version;
        return AlertDialog(
            title:
                Text(review == null ? 'تعديل المواعيد' : 'مراجعة مواعيد العمل'),
            content: SizedBox(
                width: 560,
                child: SingleChildScrollView(
                    child: !allowed
                        ? const Text('تغير المطعم أو صلاحياتك. أغلق النموذج.')
                        : Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                                const Text(
                                    'توقيت السعودية Asia/Riyadh. اليوم الفارغ مغلق. قسّم الدوام بعد منتصف الليل على يومين. المواعيد لا تفتح مطعمًا أُغلق يدويًا ولا تلغي طلباته المقبولة.'),
                                if (!editable)
                                  const Text(
                                      'حدّث البيانات وأعد المراجعة؛ النسخة أو الصلاحية أو الاتصال تغيّرت.'),
                                if (review == null) ...[
                                  SwitchListTile(
                                      title:
                                          const Text('تفعيل المواعيد الآلية'),
                                      value: enabled,
                                      onChanged: editable
                                          ? (v) => setState(() => enabled = v)
                                          : null),
                                  const Text(
                                      'مثال للفترات: 09:00-14:00, 17:00-24:00'),
                                  for (var i = 0; i < 7; i++)
                                    TextField(
                                        controller: days[i],
                                        enabled: editable,
                                        textDirection: TextDirection.ltr,
                                        maxLength: 160,
                                        decoration: InputDecoration(
                                            labelText: openingDays[i])),
                                  TextField(
                                      controller: dates,
                                      enabled: editable,
                                      textDirection: TextDirection.ltr,
                                      minLines: 3,
                                      maxLines: 6,
                                      maxLength: 12000,
                                      decoration: const InputDecoration(
                                          labelText: 'استثناءات التواريخ',
                                          helperText:
                                              '2026-12-01 = 10:00-16:00\nاترك ما بعد = فارغًا لإغلاق التاريخ')),
                                ] else ...[
                                  Text(review!.enabled
                                      ? 'سيُمنع الطلب خارج المواعيد التالية.'
                                      : 'ستُعطل المواعيد الآلية.'),
                                  for (var i = 0; i < 7; i++)
                                    Text(
                                        '${openingDays[i]}: ${review!.dayText(i).isEmpty ? 'مغلق' : review!.dayText(i)}'),
                                  Text(
                                      review!.exceptionsText.isEmpty
                                          ? 'لا توجد استثناءات'
                                          : review!.exceptionsText,
                                      textDirection: TextDirection.ltr),
                                  CheckboxListTile(
                                      title: const Text(
                                          'راجعت الأيام والاستثناءات وأثر التغيير'),
                                      value: confirmed,
                                      onChanged: editable
                                          ? (v) => setState(
                                              () => confirmed = v == true)
                                          : null),
                                ],
                                if (error != null) Text(error!),
                              ]))),
            actions: [
              TextButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: const Text('إلغاء')),
              if (review != null)
                TextButton(
                    onPressed: editable
                        ? () => setState(() {
                              review = null;
                              confirmed = false;
                            })
                        : null,
                    child: const Text('رجوع للتعديل')),
              FilledButton(
                  onPressed: !editable
                      ? null
                      : review == null
                          ? () {
                              try {
                                final value = widget.policy.edited(
                                    enabled: enabled,
                                    days: days.map((v) => v.text).toList(),
                                    dates: dates.text);
                                setState(() {
                                  review = value;
                                  confirmed = false;
                                  error = null;
                                });
                              } catch (_) {
                                setState(() => error =
                                    'تحقق من الفترات والتواريخ وعدم تداخلها.');
                              }
                            }
                          : confirmed
                              ? () => Navigator.of(context).pop(review)
                              : null,
                  child: Text(
                      review == null ? 'مراجعة المواعيد' : 'تطبيق المواعيد')),
            ]);
      });
}
