import 'dart:async';
import 'package:flutter/material.dart';
import 'controller.dart';
import 'models.dart';

class StockPane extends StatefulWidget {
  const StockPane({super.key, required this.controller});
  final CoreController controller;
  @override
  State<StockPane> createState() => _StockPaneState();
}

class _StockPaneState extends State<StockPane> {
  String filter = '';
  int page = 0;
  Future<void> _edit(CoreStockItem item) async {
    final tenant = widget.controller.selectedTenant;
    final result = await showDialog<({bool tracked, int available})>(
        context: context, builder: (_) => _RecountDialog(item: item));
    if (!mounted ||
        result == null ||
        widget.controller.selectedTenant != tenant) return;
    await widget.controller
        .recount(item, tracked: result.tracked, available: result.available);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller,
        all = c.stock
            .where((v) =>
                v.name.toLowerCase().contains(filter) ||
                v.itemId.toLowerCase().contains(filter))
            .toList();
    final pages = (all.length / 50).ceil(),
        current = page.clamp(0, pages > 0 ? pages - 1 : 0),
        rows = all.skip(current * 50).take(50);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const SizedBox(height: 20),
      const Text('المخزون',
          style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
      const Text(
          'المتاح للبيع لا يشمل الكميات المحجوزة للطلبات. الصنف غير المتتبّع لا يعني أن مخزونه صفر.'),
      const SizedBox(height: 12),
      TextField(
          decoration: const InputDecoration(
              labelText: 'بحث بالاسم أو رمز الصنف',
              prefixIcon: Icon(Icons.search),
              border: OutlineInputBorder()),
          onChanged: (v) => setState(() {
                filter = v.trim().toLowerCase();
                page = 0;
              })),
      const SizedBox(height: 12),
      Text('${all.length} صنفًا'),
      for (final item in rows)
        Card(
            child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(item.name,
                          style: Theme.of(context).textTheme.titleMedium),
                      Text(item.itemId, textDirection: TextDirection.ltr),
                      const SizedBox(height: 8),
                      Text(item.tracked
                          ? 'المتاح للبيع: ${item.available}'
                          : 'تتبع المخزون غير مفعّل'),
                      Text('محجوز للطلبات: ${item.held}'),
                      if (item.version == 0)
                        const Text('لم يُضبط جرد هذا الصنف بعد.'),
                      if (c.membership?.can('stock:update') == true)
                        OutlinedButton.icon(
                            onPressed: c.writable
                                ? () {
                                    unawaited(_edit(item));
                                  }
                                : null,
                            icon: const Icon(Icons.inventory_2_outlined),
                            label: const Text('تعديل الجرد')),
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
                  child: const Text('التالي')),
            ]),
    ]);
  }
}

class _RecountDialog extends StatefulWidget {
  const _RecountDialog({required this.item});
  final CoreStockItem item;
  @override
  State<_RecountDialog> createState() => _RecountDialogState();
}

class _RecountDialogState extends State<_RecountDialog> {
  late final TextEditingController quantity;
  late bool tracked;
  String? error;
  @override
  void initState() {
    super.initState();
    tracked = widget.item.tracked;
    quantity = TextEditingController(text: '${widget.item.available}');
  }

  @override
  void dispose() {
    quantity.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: Text('جرد ${widget.item.name}'),
        content: SizedBox(
            width: 440,
            child: SingleChildScrollView(
                child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                  Text('المطعم: ${widget.item.tenantId}'),
                  Text(
                      'المحجوز حاليًا: ${widget.item.held}. هذا الجرد لا يغيّر الحجوزات.'),
                  SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      title: const Text('تفعيل تتبع المخزون'),
                      value: tracked,
                      onChanged: (v) => setState(() => tracked = v)),
                  if (tracked)
                    TextField(
                        controller: quantity,
                        keyboardType: TextInputType.number,
                        decoration: InputDecoration(
                            labelText: 'الكمية المتاحة للبيع خارج الحجوزات',
                            helperText: 'عدد صحيح من 0 إلى 1,000,000',
                            errorText: error,
                            border: const OutlineInputBorder())),
                  if (!tracked)
                    const Text(
                        'سيصبح الصنف غير خاضع لعدّ الكمية المتاحة. قد يرفض الخادم التغيير إذا وجدت طلبات غير محسومة.'),
                ]))),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('إلغاء')),
          FilledButton(
              onPressed: () {
                final value = tracked ? stockQuantity(quantity.text) : 0;
                if (value == null) {
                  setState(() => error = 'أدخل عددًا صحيحًا ضمن الحد.');
                  return;
                }
                Navigator.pop(context, (tracked: tracked, available: value));
              },
              child: const Text('تأكيد الجرد'))
        ],
      );
}
