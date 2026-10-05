import 'package:flutter/material.dart';
import 'controller.dart';
import 'service_policy.dart';

class ServicePane extends StatelessWidget {
  const ServicePane({super.key, required this.controller});
  final CoreController controller;
  @override
  Widget build(BuildContext context) {
    final policy = controller.service;
    if (policy == null) return const Text('لم تُحمّل سياسة استقبال الطلبات.');
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const SizedBox(height: 20),
      const Text('استقبال الطلبات وطرق الخدمة',
          style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
      const Text(
          'الإيقاف يمنع الطلبات الجديدة فقط. تستمر متابعة الطلبات الموجودة وتسويتها. ساعات العمل المكتوبة لا تُغلق الطلبات تلقائيًا.'),
      for (final entry in serviceLabels.entries)
        ListTile(
            title: Text(entry.value),
            trailing:
                Text(policy.flags[entry.key] == true ? 'مفعّل' : 'متوقف')),
      if (controller.membership?.can('settings:update') == true)
        FilledButton(
            onPressed: controller.writable
                ? () async {
                    final changes = await showDialog<Map<String, bool>>(
                        context: context,
                        builder: (_) => ServiceEditor(
                            controller: controller, policy: policy));
                    if (changes != null)
                      await controller.patchService(policy, changes);
                  }
                : null,
            child: const Text('مراجعة طرق الخدمة'))
    ]);
  }
}

class ServiceEditor extends StatefulWidget {
  const ServiceEditor(
      {super.key, required this.controller, required this.policy});
  final CoreController controller;
  final CoreServicePolicy policy;
  @override
  State<ServiceEditor> createState() => _ServiceEditorState();
}

class _ServiceEditorState extends State<ServiceEditor> {
  late Map<String, bool> values;
  bool reviewed = false;
  String? error;
  @override
  void initState() {
    super.initState();
    values = {...widget.policy.flags};
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
      listenable: widget.controller,
      builder: (context, _) {
        final c = widget.controller,
            allowed = c.selectedTenant == widget.policy.tenantId &&
                c.membership?.can('settings:read') == true,
            editable = allowed &&
                c.writable &&
                c.membership?.can('settings:update') == true;
        return AlertDialog(
            title: const Text('مراجعة استقبال الطلبات'),
            content: SizedBox(
                width: 550,
                child: SingleChildScrollView(
                    child: !allowed
                        ? const Text('تغير المطعم أو صلاحياتك. أغلق النموذج.')
                        : Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                                Text('المطعم: ${widget.policy.tenantId}'),
                                const Text(
                                    'التغيير يسري على قبول الطلبات الجديدة في القنوات المرتبطة. الطلبات المسجلة والأسعار والضرائب وروابط الطاولات محفوظة.'),
                                for (final entry in serviceLabels.entries)
                                  SwitchListTile(
                                      title: Text(entry.value),
                                      value: values[entry.key]!,
                                      onChanged: editable
                                          ? (v) => setState(() {
                                                values[entry.key] = v;
                                                reviewed = false;
                                                error = null;
                                              })
                                          : null),
                                if (values['acceptingOrders'] == false)
                                  const Text(
                                      'المطعم لن يقبل طلبات جديدة حتى إعادة فتح الاستقبال.'),
                                for (final entry in serviceLabels.entries)
                                  if (values[entry.key] !=
                                      widget.policy.flags[entry.key])
                                    Text(
                                        '${entry.value}: ${widget.policy.flags[entry.key] == true ? 'مفعّل' : 'متوقف'} ← ${values[entry.key] == true ? 'مفعّل' : 'متوقف'}'),
                                if (error != null) Text(error!),
                                CheckboxListTile(
                                    value: reviewed,
                                    onChanged: editable
                                        ? (v) =>
                                            setState(() => reviewed = v == true)
                                        : null,
                                    title: const Text(
                                        'راجعت أثر التغيير على الطلبات الجديدة.'))
                              ]))),
            actions: [
              TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('إلغاء')),
              FilledButton(
                  onPressed: editable && reviewed
                      ? () {
                          final changes = {
                            for (final v in values.entries)
                              if (v.value != widget.policy.flags[v.key])
                                v.key: v.value
                          };
                          try {
                            widget.policy.validate(changes);
                            Navigator.pop(context, changes);
                          } catch (e) {
                            setState(() => error = errorMessage(e));
                          }
                        }
                      : null,
                  child: const Text('حفظ سياسة الاستقبال'))
            ]);
      });
}
