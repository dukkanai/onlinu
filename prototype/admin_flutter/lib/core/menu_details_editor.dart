import 'dart:async';
import 'package:flutter/material.dart';
import 'controller.dart';
import 'models.dart';

typedef MenuDetailsEdit = ({
  CoreMenuDetails details,
  String description,
  List<CoreOption> options
});

class MenuDetailsEditor extends StatefulWidget {
  const MenuDetailsEditor(
      {super.key,
      required this.controller,
      required this.tenant,
      required this.id});
  final CoreController controller;
  final String tenant, id;
  @override
  State<MenuDetailsEditor> createState() => _MenuDetailsEditorState();
}

class _MenuDetailsEditorState extends State<MenuDetailsEditor> {
  final description = TextEditingController();
  CoreMenuDetails? details;
  List<CoreOption> options = [];
  String? error;
  bool submitted = false;
  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final value = await widget.controller.menuDetails(widget.id);
      if (!mounted) return;
      setState(() {
        details = value;
        description.text = value.description;
        options = value.options.toList();
      });
    } catch (e) {
      if (mounted) setState(() => error = errorMessage(e));
    }
  }

  @override
  void dispose() {
    description.dispose();
    super.dispose();
  }

  Future<void> _option([int? index]) async {
    final option = index == null ? null : options[index];
    final result = await showDialog<CoreOption>(
        context: context, builder: (_) => _OptionEditor(option: option));
    if (!mounted || result == null) return;
    setState(() {
      if (index == null) {
        options.add(result);
      } else {
        options[index] = result;
      }
    });
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
      listenable: widget.controller,
      builder: (context, _) {
        final c = widget.controller,
            d = details,
            allowed = c.signedIn &&
                c.selectedTenant == widget.tenant &&
                c.membership?.can('menu:read') == true;
        final stale =
            d != null && c.menu != null && d.version < c.menu!.version;
        final editable = allowed &&
            c.membership?.can('menu:update') == true &&
            options.length <= 50 &&
            !stale;
        return AlertDialog(
            title: Text(allowed && d != null
                ? 'تفاصيل ${d.item.name}'
                : 'تفاصيل الصنف'),
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
                      if (allowed && d == null && error == null)
                        const LinearProgressIndicator(),
                      if (allowed && d != null) ...[
                        Text(
                            'المطعم: ${c.membership?.tenantName ?? widget.tenant} • ${widget.tenant}'),
                        Text('المعرّف: ${d.item.id}'),
                        const SizedBox(height: 12),
                        TextField(
                            controller: description,
                            readOnly: !editable,
                            maxLength: 4000,
                            maxLines: 3,
                            decoration: const InputDecoration(
                                labelText: 'وصف الصنف',
                                border: OutlineInputBorder())),
                        if (stale)
                          const Text(
                              'تغيرت القائمة أثناء التعديل. أغلق النافذة وافتح النسخة الحالية قبل الحفظ.'),
                        if (options.length > 50)
                          const Text(
                              'عدد الإضافات يتجاوز حد التحرير الحالي؛ تُعرض دون تغيير أو حذف.'),
                        const Text('الإضافات',
                            style: TextStyle(
                                fontSize: 20, fontWeight: FontWeight.bold)),
                        for (var i = 0; i < options.length; i++)
                          Card(
                              child: Padding(
                                  padding: const EdgeInsets.all(12),
                                  child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        Text(options[i].name),
                                        Text(money(options[i].priceMinor)),
                                        CheckboxListTile(
                                            contentPadding: EdgeInsets.zero,
                                            title: const Text('متاحة للاختيار'),
                                            value: options[i].available,
                                            onChanged: editable
                                                ? (v) {
                                                    if (v != null)
                                                      setState(() => options[
                                                              i] =
                                                          options[i]
                                                              .withAvailable(
                                                                  v));
                                                  }
                                                : null),
                                        if (editable)
                                          TextButton(
                                              onPressed: () {
                                                unawaited(_option(i));
                                              },
                                              child:
                                                  const Text('تعديل الإضافة')),
                                      ]))),
                        if (editable && options.length < 50)
                          OutlinedButton.icon(
                              onPressed: () {
                                unawaited(_option());
                              },
                              icon: const Icon(Icons.add),
                              label: const Text('إضافة خيار')),
                        const Text(
                            'تعطيل الإضافة يحفظ معرّفها. لا تتغير لقطات الطلبات السابقة أو صورة الصنف.'),
                      ],
                      if (allowed && error != null)
                        Text(error!,
                            style: TextStyle(
                                color: Theme.of(context).colorScheme.error)),
                    ]))),
            actions: [
              TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('إغلاق')),
              if (editable && d != null)
                FilledButton(
                    onPressed: !submitted && c.writable
                        ? () {
                            if (description.text.trim().length > 4000 ||
                                options.any((v) =>
                                    v.name.trim().isEmpty ||
                                    v.name.length > 240 ||
                                    v.priceMinor > 100000000)) {
                              setState(() => error =
                                  'راجع الوصف وأسماء الإضافات وأسعارها.');
                              return;
                            }
                            submitted = true;
                            Navigator.pop(context, (
                              details: d,
                              description: description.text.trim(),
                              options: List<CoreOption>.unmodifiable(options)
                            ));
                          }
                        : null,
                    child: const Text('حفظ الوصف والإضافات'))
            ]);
      });
}

class _OptionEditor extends StatefulWidget {
  const _OptionEditor({this.option});
  final CoreOption? option;
  @override
  State<_OptionEditor> createState() => _OptionEditorState();
}

class _OptionEditorState extends State<_OptionEditor> {
  late final String id;
  late final TextEditingController name, price;
  late bool available;
  bool submitted = false;
  String? error;
  @override
  void initState() {
    super.initState();
    id = widget.option?.id ?? newMenuId(false).replaceFirst('i_', 'o_');
    name = TextEditingController(text: widget.option?.name ?? '');
    price =
        TextEditingController(text: priceInput(widget.option?.priceMinor ?? 0));
    available = widget.option?.available ?? false;
  }

  @override
  void dispose() {
    name.dispose();
    price.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
          title: Text(widget.option == null ? 'إضافة خيار' : 'تعديل الإضافة'),
          content: SizedBox(
              width: 420,
              child: SingleChildScrollView(
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                TextField(
                    controller: name,
                    maxLength: 240,
                    decoration: const InputDecoration(
                        labelText: 'اسم الإضافة',
                        border: OutlineInputBorder())),
                const SizedBox(height: 12),
                TextField(
                    controller: price,
                    keyboardType:
                        const TextInputType.numberWithOptions(decimal: true),
                    decoration: const InputDecoration(
                        labelText: 'سعر الإضافة بالريال',
                        border: OutlineInputBorder())),
                SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('إتاحة الإضافة'),
                    value: available,
                    onChanged: (v) => setState(() => available = v)),
                if (error != null)
                  Text(error!,
                      style: TextStyle(
                          color: Theme.of(context).colorScheme.error)),
              ]))),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(context),
                child: const Text('إلغاء')),
            FilledButton(
                onPressed: submitted
                    ? null
                    : () {
                        final label = name.text.trim(),
                            amount = priceMinor(price.text);
                        if (label.isEmpty ||
                            label.length > 240 ||
                            amount == null) {
                          setState(() => error = 'أدخل اسمًا وسعرًا صحيحين.');
                          return;
                        }
                        submitted = true;
                        Navigator.pop(
                            context,
                            CoreOption({
                              'id': id,
                              'name': label,
                              'priceMinor': amount,
                              'available': available
                            }));
                      },
                child: const Text('اعتماد الإضافة'))
          ]);
}
