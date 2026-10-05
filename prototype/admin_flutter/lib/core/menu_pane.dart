import 'dart:async';
import 'package:flutter/material.dart';
import 'controller.dart';
import 'models.dart';

typedef MenuEdit = ({
  String name,
  String categoryId,
  int price,
  bool available
});

class MenuPane extends StatefulWidget {
  const MenuPane({super.key, required this.controller});
  final CoreController controller;
  @override
  State<MenuPane> createState() => _MenuPaneState();
}

class _MenuPaneState extends State<MenuPane> {
  String filter = '';
  String? category;
  int page = 0;
  Future<void> _edit(CoreMenu menu, CoreMenuItem item) async {
    final result = await showDialog<MenuEdit>(
        context: context, builder: (_) => _MenuDialog(menu: menu, item: item));
    if (!mounted ||
        result == null ||
        widget.controller.selectedTenant != menu.tenantId) return;
    await widget.controller.patchMenu(menu, item,
        name: result.name,
        categoryId: result.categoryId,
        price: result.price,
        available: result.available);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller, menu = c.menu;
    if (menu == null)
      return const Padding(
          padding: EdgeInsets.all(20),
          child: Text('لم تُحمّل قائمة الأصناف بعد.'));
    final selected =
        menu.categories.any((v) => v.id == category) ? category : null;
    final all = menu.items
        .where((v) =>
            (selected == null || v.categoryId == selected) &&
            (v.name.toLowerCase().contains(filter) ||
                v.id.toLowerCase().contains(filter)))
        .toList();
    final pages = (all.length / 50).ceil(),
        current = page.clamp(0, pages > 0 ? pages - 1 : 0);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const SizedBox(height: 20),
      Text('قائمة الأصناف • ${menu.name}',
          style: const TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
      const Text(
          'تُحفظ التعديلات في قائمة المطعم الأصلية. الطلبات السابقة تحتفظ بأسمائها وأسعارها وقت الطلب.'),
      const SizedBox(height: 12),
      TextField(
          decoration: const InputDecoration(
              labelText: 'بحث في الأصناف',
              prefixIcon: Icon(Icons.search),
              border: OutlineInputBorder()),
          onChanged: (v) => setState(() {
                filter = v.trim().toLowerCase();
                page = 0;
              })),
      const SizedBox(height: 12),
      DropdownButtonFormField<String>(
          key: ValueKey('category-$selected'),
          initialValue: selected ?? '',
          decoration: const InputDecoration(
              labelText: 'التصنيف', border: OutlineInputBorder()),
          items: [
            const DropdownMenuItem(value: '', child: Text('كل التصنيفات')),
            for (final row in menu.categories)
              DropdownMenuItem(value: row.id, child: Text(row.name))
          ],
          onChanged: (v) => setState(() {
                category = v == '' ? null : v;
                page = 0;
              })),
      const SizedBox(height: 12),
      Text('${all.length} صنفًا'),
      for (final item in all.skip(current * 50).take(50))
        Card(
            child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(item.name,
                          style: Theme.of(context).textTheme.titleMedium),
                      Text(money(item.priceMinor)),
                      Text(item.available ? 'متاح للطلب' : 'غير متاح للطلب'),
                      if (c.membership?.can('menu:update') == true)
                        OutlinedButton.icon(
                            onPressed: c.writable
                                ? () {
                                    unawaited(_edit(menu, item));
                                  }
                                : null,
                            icon: const Icon(Icons.edit_outlined),
                            label: const Text('تعديل الصنف')),
                    ]))),
      if (all.isEmpty)
        const Padding(
            padding: EdgeInsets.all(20), child: Text('لا توجد أصناف مطابقة.')),
      if (pages > 1)
        Wrap(
            spacing: 12,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              TextButton(
                  onPressed: current > 0
                      ? () => setState(() => page = current - 1)
                      : null,
                  child: const Text('السابق')),
              Text('${current + 1} / $pages'),
              TextButton(
                  onPressed: current + 1 < pages
                      ? () => setState(() => page = current + 1)
                      : null,
                  child: const Text('التالي'))
            ]),
    ]);
  }
}

class _MenuDialog extends StatefulWidget {
  const _MenuDialog({required this.menu, required this.item});
  final CoreMenu menu;
  final CoreMenuItem item;
  @override
  State<_MenuDialog> createState() => _MenuDialogState();
}

class _MenuDialogState extends State<_MenuDialog> {
  late final TextEditingController name, price;
  late String category;
  late bool available;
  String? error;
  @override
  void initState() {
    super.initState();
    name = TextEditingController(text: widget.item.name);
    price = TextEditingController(text: priceInput(widget.item.priceMinor));
    category = widget.item.categoryId;
    available = widget.item.available;
  }

  @override
  void dispose() {
    name.dispose();
    price.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('تعديل الصنف'),
        content: SizedBox(
            width: 460,
            child: SingleChildScrollView(
                child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                  Text('المطعم: ${widget.menu.name} • ${widget.menu.tenantId}'),
                  const SizedBox(height: 12),
                  TextField(
                      controller: name,
                      maxLength: 320,
                      decoration: const InputDecoration(
                          labelText: 'اسم الصنف',
                          border: OutlineInputBorder())),
                  const SizedBox(height: 12),
                  TextField(
                      controller: price,
                      keyboardType:
                          const TextInputType.numberWithOptions(decimal: true),
                      decoration: const InputDecoration(
                          labelText: 'السعر بالريال السعودي',
                          helperText: 'حتى منزلتين عشريتين، دون فواصل آلاف',
                          border: OutlineInputBorder())),
                  const SizedBox(height: 12),
                  DropdownButtonFormField<String>(
                      initialValue: category,
                      decoration: const InputDecoration(
                          labelText: 'تصنيف الصنف',
                          border: OutlineInputBorder()),
                      items: widget.menu.categories
                          .map((v) => DropdownMenuItem(
                              value: v.id, child: Text(v.name)))
                          .toList(),
                      onChanged: (v) {
                        if (v != null) setState(() => category = v);
                      }),
                  SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      title: const Text('متاح لاستقبال طلبات جديدة'),
                      value: available,
                      onChanged: (v) => setState(() => available = v)),
                  const Text(
                      'لن تتغير الصورة أو الوصف أو الإضافات أو إعدادات المطعم من هذا النموذج.'),
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
              onPressed: () {
                final amount = priceMinor(price.text), label = name.text.trim();
                if (amount == null || label.isEmpty || label.length > 320) {
                  setState(() => error = 'أدخل اسمًا وسعرًا صحيحين.');
                  return;
                }
                Navigator.pop(context, (
                  name: label,
                  categoryId: category,
                  price: amount,
                  available: available
                ));
              },
              child: const Text('حفظ التعديلات'))
        ],
      );
}
