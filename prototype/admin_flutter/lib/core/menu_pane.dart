import 'dart:async';
import 'package:flutter/material.dart';
import 'controller.dart';
import 'models.dart';
import 'category_editor.dart';
import 'menu_details_editor.dart';

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

  Future<void> _create(CoreMenu menu, bool category) async {
    final result = await showDialog<MenuCreation>(
        context: context,
        builder: (_) => _CreateMenuDialog(menu: menu, category: category));
    if (!mounted ||
        result == null ||
        widget.controller.selectedTenant != menu.tenantId) return;
    await widget.controller.createMenuEntry(menu,
        id: result.id,
        name: result.name,
        sort: result.sort,
        categoryId: result.categoryId,
        price: result.price);
  }

  Future<void> _category(CoreMenu menu) async {
    final result = await showDialog<CategoryEdit>(
        context: context, builder: (_) => CategoryEditor(menu: menu));
    if (!mounted ||
        result == null ||
        widget.controller.selectedTenant != menu.tenantId) return;
    await widget.controller.patchCategory(menu, result.category,
        name: result.name, sort: result.sort);
  }

  Future<void> _details(CoreMenu menu, CoreMenuItem item) async {
    final result = await showDialog<MenuDetailsEdit>(
        context: context,
        builder: (_) => MenuDetailsEditor(
            controller: widget.controller, tenant: menu.tenantId, id: item.id));
    if (!mounted ||
        result == null ||
        widget.controller.selectedTenant != menu.tenantId) return;
    await widget.controller.patchMenuDetails(result.details,
        description: result.description, options: result.options);
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
        .toList()
      ..sort((a, b) {
        final order = a.sort.compareTo(b.sort);
        return order != 0 ? order : a.id.compareTo(b.id);
      });
    final pages = (all.length / 50).ceil(),
        current = page.clamp(0, pages > 0 ? pages - 1 : 0);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const SizedBox(height: 20),
      Text('قائمة الأصناف • ${menu.name}',
          style: const TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
      const Text(
          'تُحفظ التعديلات في قائمة المطعم الأصلية. الطلبات السابقة تحتفظ بأسمائها وأسعارها وقت الطلب.'),
      if (c.membership?.can('menu:update') == true)
        Wrap(spacing: 12, runSpacing: 8, children: [
          OutlinedButton.icon(
              onPressed: c.writable && menu.categories.length < 1000
                  ? () {
                      unawaited(_create(menu, true));
                    }
                  : null,
              icon: const Icon(Icons.create_new_folder_outlined),
              label: const Text('إضافة تصنيف')),
          OutlinedButton.icon(
              onPressed: c.writable && menu.categories.isNotEmpty
                  ? () {
                      unawaited(_category(menu));
                    }
                  : null,
              icon: const Icon(Icons.edit_note),
              label: const Text('تعديل تصنيف')),
          FilledButton.icon(
              onPressed: c.writable &&
                      menu.categories.isNotEmpty &&
                      menu.items.length < 5000
                  ? () {
                      unawaited(_create(menu, false));
                    }
                  : null,
              icon: const Icon(Icons.add),
              label: const Text('إضافة صنف')),
        ]),
      if (menu.categories.isEmpty)
        const Text('أضف تصنيفًا أولًا قبل إنشاء الأصناف.'),
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
                      Text(item.id,
                          textDirection: TextDirection.ltr,
                          style: Theme.of(context).textTheme.labelSmall),
                      Text(money(item.priceMinor)),
                      Text(item.available ? 'متاح للطلب' : 'غير متاح للطلب'),
                      OutlinedButton(
                          onPressed: () {
                            unawaited(_details(menu, item));
                          },
                          child: const Text('الوصف والإضافات')),
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

typedef MenuCreation = ({
  String id,
  String name,
  int sort,
  String? categoryId,
  int? price
});

class _CreateMenuDialog extends StatefulWidget {
  const _CreateMenuDialog({required this.menu, required this.category});
  final CoreMenu menu;
  final bool category;
  @override
  State<_CreateMenuDialog> createState() => _CreateMenuDialogState();
}

class _CreateMenuDialogState extends State<_CreateMenuDialog> {
  final name = TextEditingController(),
      price = TextEditingController(),
      sort = TextEditingController(text: '0');
  late final String id;
  String? categoryId, error;
  @override
  void initState() {
    super.initState();
    id = newMenuId(widget.category);
    categoryId = widget.category ? null : widget.menu.categories.first.id;
  }

  @override
  void dispose() {
    name.dispose();
    price.dispose();
    sort.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
          title: Text(widget.category ? 'إضافة تصنيف' : 'إضافة صنف'),
          content: SizedBox(
              width: 460,
              child: SingleChildScrollView(
                  child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                    Text(
                        'المطعم: ${widget.menu.name} • ${widget.menu.tenantId}'),
                    const SizedBox(height: 12),
                    TextField(
                        controller: name,
                        maxLength: widget.category ? 240 : 320,
                        decoration: InputDecoration(
                            labelText: widget.category
                                ? 'اسم التصنيف الجديد'
                                : 'اسم الصنف الجديد',
                            border: const OutlineInputBorder())),
                    const SizedBox(height: 12),
                    if (!widget.category) ...[
                      DropdownButtonFormField<String>(
                          initialValue: categoryId,
                          decoration: const InputDecoration(
                              labelText: 'تصنيف الصنف',
                              border: OutlineInputBorder()),
                          items: widget.menu.categories
                              .map((v) => DropdownMenuItem(
                                  value: v.id, child: Text(v.name)))
                              .toList(),
                          onChanged: (v) => setState(() => categoryId = v)),
                      const SizedBox(height: 12),
                      TextField(
                          controller: price,
                          keyboardType: const TextInputType.numberWithOptions(
                              decimal: true),
                          decoration: const InputDecoration(
                              labelText: 'السعر بالريال السعودي',
                              helperText: 'حتى منزلتين عشريتين',
                              border: OutlineInputBorder())),
                      const SizedBox(height: 12),
                      const Text(
                          'يُنشأ الصنف غير متاح للطلب، دون صورة أو إضافات. راجعه ثم فعّله من التعديل.'),
                    ],
                    TextField(
                        controller: sort,
                        keyboardType: TextInputType.number,
                        decoration: const InputDecoration(
                            labelText: 'ترتيب العرض',
                            helperText: 'عدد صحيح من 0 إلى 10,000',
                            border: OutlineInputBorder())),
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
                  final label = name.text.trim(),
                      position = stockQuantity(sort.text),
                      amount = widget.category ? null : priceMinor(price.text);
                  if (label.isEmpty ||
                      label.length > (widget.category ? 240 : 320) ||
                      position == null ||
                      position > 10000 ||
                      (!widget.category &&
                          (amount == null || categoryId == null))) {
                    setState(() => error = 'راجع الاسم والسعر وترتيب العرض.');
                    return;
                  }
                  Navigator.pop(context, (
                    id: id,
                    name: label,
                    sort: position,
                    categoryId: widget.category ? null : categoryId,
                    price: amount
                  ));
                },
                child: const Text('إنشاء'))
          ]);
}
