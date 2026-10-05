import 'package:flutter/material.dart';
import 'controller.dart';
import 'brand_models.dart';

class BrandPane extends StatelessWidget {
  const BrandPane({super.key, required this.controller});
  final CoreController controller;
  @override
  Widget build(BuildContext context) {
    final c = controller, state = c.appearance;
    if (state == null) return const Text('لم تُحمّل إعدادات المظهر.');
    Future<void> edit(String action) async {
      final changes = await showDialog<Map<String, dynamic>>(
          context: context,
          builder: (_) =>
              BrandEditor(controller: c, state: state, action: action));
      if (changes != null) await c.changeAppearance(state, action, changes);
    }

    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const SizedBox(height: 20),
      const Text('مظهر واجهة العملاء',
          style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
      Text(
          'المنشور: ${state.live.label('storefrontTemplate')} • إصدار المظهر ${state.version} • إصدار المتجر ${state.catalogVersion}'),
      Text(state.draft == null
          ? 'لا توجد مسودة محفوظة.'
          : 'مسودة خاصة: ${state.draft!.label('storefrontTemplate')}؛ لم تظهر للعملاء بعد.'),
      const Text(
          'تعديل القالب والخطوط والنصوص لا يغير الأسعار أو الطلبات أو الدفع. الألوان والصور تُحفظ كما هي؛ تعديلها متاح في المحرر الأصلي.'),
      for (final entry in brandLabels.entries)
        ListTile(
            title: Text(entry.value),
            subtitle: Text((state.draft ?? state.live).label(entry.key))),
      if (c.membership?.can('settings:update') == true)
        Wrap(spacing: 8, children: [
          FilledButton(
              onPressed: c.writable ? () => edit('draft') : null,
              child: const Text('تعديل مسودة المظهر')),
          OutlinedButton(
              onPressed: c.writable && state.draft != null
                  ? () => edit('publish')
                  : null,
              child: const Text('مراجعة نشر المسودة')),
          OutlinedButton(
              onPressed:
                  c.writable && state.hasPrevious ? () => edit('revert') : null,
              child: const Text('مراجعة استعادة المظهر السابق')),
        ])
    ]);
  }
}

class BrandEditor extends StatefulWidget {
  const BrandEditor(
      {super.key,
      required this.controller,
      required this.state,
      required this.action});
  final CoreController controller;
  final CoreBrandState state;
  final String action;
  @override
  State<BrandEditor> createState() => _BrandEditorState();
}

class _BrandEditorState extends State<BrandEditor> {
  late Map<String, dynamic> values;
  late TextEditingController title, intro;
  bool reviewing = false, confirmed = false;
  String? error;
  @override
  void initState() {
    super.initState();
    values = {...(widget.state.draft ?? widget.state.live).values};
    title = TextEditingController(text: values['introTitle'] as String);
    intro = TextEditingController(text: values['introText'] as String);
  }

  @override
  void dispose() {
    title.dispose();
    intro.dispose();
    super.dispose();
  }

  Map<String, dynamic> get changes => widget.action == 'draft'
      ? {
          for (final entry in values.entries)
            if (entry.value !=
                (widget.state.draft ?? widget.state.live).values[entry.key])
              entry.key: entry.value
        }
      : {};
  @override
  Widget build(BuildContext context) => ListenableBuilder(
      listenable: widget.controller,
      builder: (context, _) {
        final c = widget.controller,
            allowed = c.signedIn &&
                !c.suspended &&
                c.selectedTenant == widget.state.tenantId &&
                c.section == CoreSection.appearance &&
                c.membership?.can('settings:read') == true &&
                c.membership?.can('settings:update') == true,
            current = c.appearance?.version == widget.state.version &&
                c.appearance?.catalogVersion == widget.state.catalogVersion;
        final actionLabel = widget.action == 'draft'
            ? 'حفظ مسودة خاصة'
            : widget.action == 'publish'
                ? 'نشر المسودة للعملاء'
                : 'استعادة المظهر السابق';
        return AlertDialog(
            title: Text(actionLabel),
            content: SizedBox(
                width: 620,
                child: SingleChildScrollView(
                    child: !allowed
                        ? const Text('لم تعد صلاحية مراجعة المظهر متاحة.')
                        : Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                                Text(
                                    'المطعم: ${widget.state.tenantId} • إصدار المظهر: ${widget.state.version} • إصدار المتجر: ${widget.state.catalogVersion}'),
                                if (!current)
                                  const Text(
                                      'تغير المظهر أو المتجر؛ أغلق هذه المراجعة ثم حدّث البيانات.'),
                                if (error != null) Text(error!),
                                if (widget.action == 'draft' && !reviewing) ...[
                                  for (final group in brandChoices.entries) ...[
                                    Padding(
                                        padding: const EdgeInsets.only(top: 12),
                                        child: Text(brandLabels[group.key]!)),
                                    Wrap(spacing: 6, children: [
                                      for (final choice in group.value.entries)
                                        ChoiceChip(
                                            key: ValueKey(
                                                'brand-${group.key}-${choice.key}'),
                                            label: Text(choice.value),
                                            selected:
                                                values[group.key] == choice.key,
                                            onSelected: current
                                                ? (selected) {
                                                    if (selected)
                                                      setState(() =>
                                                          values[group.key] =
                                                              choice.key);
                                                  }
                                                : null)
                                    ]),
                                  ],
                                  CheckboxListTile(
                                      title: const Text('إخفاء المقدمة'),
                                      value: values['hideHero'] as bool,
                                      onChanged: current
                                          ? (v) => setState(() =>
                                              values['hideHero'] = v == true)
                                          : null),
                                  TextField(
                                      controller: title,
                                      enabled: current,
                                      maxLength: 160,
                                      decoration: const InputDecoration(
                                          labelText: 'عنوان المقدمة'),
                                      onChanged: (v) =>
                                          values['introTitle'] = v),
                                  TextField(
                                      controller: intro,
                                      enabled: current,
                                      maxLength: 2000,
                                      maxLines: 3,
                                      decoration: const InputDecoration(
                                          labelText: 'نص المقدمة'),
                                      onChanged: (v) =>
                                          values['introText'] = v),
                                ] else ...[
                                  Text(widget.action == 'draft'
                                      ? 'ستبقى هذه التغييرات مسودة خاصة ولن تظهر للعملاء.'
                                      : widget.action == 'publish'
                                          ? 'سيُنشر كامل محتوى المسودة الحالية، بما فيها الألوان والصور المحفوظة في المحرر الأصلي.'
                                          : 'سيُستعاد آخر مظهر منشور محفوظ؛ تبقى أي مسودة قيد العمل دون حذف.'),
                                  if (widget.action == 'draft')
                                    for (final entry in changes.entries)
                                      Text(
                                          '${brandLabels[entry.key]}: ${entry.key == 'hideHero' ? (entry.value == true ? 'نعم' : 'لا') : brandChoices[entry.key]?[entry.value] ?? entry.value}'),
                                  if (widget.action == 'publish' &&
                                      widget.state.draft != null)
                                    for (final key in brandLabels.keys)
                                      Text(
                                          '${brandLabels[key]}: ${widget.state.draft!.label(key)}'),
                                  CheckboxListTile(
                                      value: confirmed,
                                      onChanged: current
                                          ? (v) => setState(
                                              () => confirmed = v == true)
                                          : null,
                                      title: Text(
                                          'راجعت المطعم والإصدارات وأؤكد $actionLabel')),
                                ]
                              ]))),
            actions: [
              TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('إلغاء تعديل المظهر')),
              if (allowed && widget.action == 'draft' && !reviewing)
                FilledButton(
                    onPressed: current && c.writable
                        ? () {
                            if (changes.isEmpty) {
                              setState(() =>
                                  error = 'غيّر خيارًا واحدًا على الأقل.');
                              return;
                            }
                            try {
                              widget.state.validate(widget.action, changes);
                              FocusScope.of(context).unfocus();
                              setState(() {
                                reviewing = true;
                                confirmed = false;
                                error = null;
                              });
                            } catch (_) {
                              setState(() =>
                                  error = 'تحقق من القالب والخطوط والنصوص.');
                            }
                          }
                        : null,
                    child: const Text('مراجعة تغييرات المظهر'))
              else if (allowed)
                FilledButton(
                    onPressed: current && confirmed && c.writable
                        ? () => Navigator.pop(context, changes)
                        : null,
                    child: Text('تأكيد $actionLabel')),
            ]);
      });
}
