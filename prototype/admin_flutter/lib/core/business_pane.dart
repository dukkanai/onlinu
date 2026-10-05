import 'package:flutter/material.dart';
import 'controller.dart';
import 'business_profile.dart';

class BusinessPane extends StatelessWidget {
  const BusinessPane({super.key, required this.controller});
  final CoreController controller;
  Future<void> edit(BuildContext context, CoreBusinessProfile profile) async {
    final changes = await showDialog<Map<String, String>>(
        context: context,
        builder: (_) =>
            BusinessEditor(controller: controller, profile: profile));
    if (changes != null) await controller.patchBusiness(profile, changes);
  }

  @override
  Widget build(BuildContext context) {
    final profile = controller.business;
    if (profile == null) return const Text('لم تُحمّل بيانات المطعم بعد.');
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const Text('بيانات المطعم العامة', style: TextStyle(fontSize: 22)),
      const Text('ساعات العمل نص معلوماتي؛ لا تُغلق الطلبات تلقائيًا.'),
      for (final entry in profileLabels.entries)
        ListTile(
            title: Text(entry.value),
            subtitle: Text(profile.fields[entry.key]!.isEmpty
                ? 'غير محدد'
                : profile.fields[entry.key]!)),
      if (controller.membership?.can('settings:update') == true)
        FilledButton(
            onPressed:
                controller.writable ? () => edit(context, profile) : null,
            child: const Text('تعديل البيانات العامة')),
    ]);
  }
}

class BusinessEditor extends StatefulWidget {
  const BusinessEditor(
      {super.key, required this.controller, required this.profile});
  final CoreController controller;
  final CoreBusinessProfile profile;
  @override
  State<BusinessEditor> createState() => _BusinessEditorState();
}

class _BusinessEditorState extends State<BusinessEditor> {
  late final Map<String, TextEditingController> fields;
  bool reviewed = false;
  String? error;
  @override
  void initState() {
    super.initState();
    fields = {
      for (final key in profileLabels.keys)
        key: TextEditingController(text: widget.profile.fields[key])
    };
  }

  @override
  void dispose() {
    for (final field in fields.values) {
      field.dispose();
    }
    super.dispose();
  }

  void save() {
    try {
      final changes = {
        for (final entry in fields.entries)
          if (entry.value.text.trim() != widget.profile.fields[entry.key])
            entry.key: entry.value.text.trim()
      };
      if (changes.isEmpty) {
        setState(() => error = 'لا توجد تغييرات لحفظها.');
        return;
      }
      Navigator.pop(context, validatedProfileChanges(changes));
    } catch (_) {
      setState(() => error = 'تحقق من الاسم وطول الحقول والمحتوى.');
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
      listenable: widget.controller,
      builder: (context, _) {
        final c = widget.controller,
            allowed = c.signedIn &&
                c.selectedTenant == widget.profile.tenantId &&
                c.membership?.can('settings:read') == true;
        final stale =
            c.business != null && c.business!.version != widget.profile.version;
        final editable = allowed &&
            c.writable &&
            !stale &&
            c.membership?.can('settings:update') == true;
        return AlertDialog(
            title: const Text('تعديل بيانات المطعم العامة'),
            content: SizedBox(
                width: 620,
                child: SingleChildScrollView(
                    child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                      if (!allowed)
                        const Text(
                            'تغيرت الجلسة أو الصلاحيات. أغلق هذه النافذة.'),
                      if (allowed) ...[
                        if (stale)
                          const Text(
                              'تغيرت البيانات. أغلق النافذة وافتح النسخة الحالية.'),
                        const Text(
                            'ستظهر هذه البيانات للعملاء. ساعات العمل وصف فقط؛ ولا يتغير القالب أو الضرائب أو الأسعار أو وسائل الدفع.'),
                        for (final entry in profileLabels.entries)
                          Padding(
                              padding: const EdgeInsets.only(top: 16),
                              child: TextField(
                                  controller: fields[entry.key],
                                  readOnly: !editable,
                                  maxLength: profileLimits[entry.key],
                                  maxLines: entry.key == 'name' ||
                                          entry.key == 'phone'
                                      ? 1
                                      : 3,
                                  decoration: InputDecoration(
                                      labelText: entry.value,
                                      border: const OutlineInputBorder()))),
                        CheckboxListTile(
                            title: const Text(
                                'راجعت المعلومات العامة التي ستُنشر'),
                            value: reviewed,
                            onChanged: editable
                                ? (v) => setState(() => reviewed = v == true)
                                : null),
                        if (error != null) Text(error!),
                      ]
                    ]))),
            actions: [
              TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('إلغاء')),
              FilledButton(
                  onPressed: editable && reviewed ? save : null,
                  child: const Text('حفظ البيانات العامة'))
            ]);
      });
}
