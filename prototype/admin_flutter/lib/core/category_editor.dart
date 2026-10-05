import 'package:flutter/material.dart';
import 'models.dart';

typedef CategoryEdit = ({CoreCategory category, String name, int sort});

class CategoryEditor extends StatefulWidget {
  const CategoryEditor({super.key, required this.menu});
  final CoreMenu menu;
  @override
  State<CategoryEditor> createState() => _CategoryEditorState();
}

class _CategoryEditorState extends State<CategoryEditor> {
  late CoreCategory category;
  late final TextEditingController name, sort;
  String? error;
  @override
  void initState() {
    super.initState();
    category = widget.menu.categories.first;
    name = TextEditingController(text: category.name);
    sort = TextEditingController(text: '${category.sort}');
  }

  @override
  void dispose() {
    name.dispose();
    sort.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
          title: const Text('تعديل تصنيف'),
          content: SizedBox(
              width: 440,
              child: SingleChildScrollView(
                  child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                    Text(
                        'المطعم: ${widget.menu.name} • ${widget.menu.tenantId}'),
                    const SizedBox(height: 12),
                    DropdownButtonFormField<String>(
                        initialValue: category.id,
                        decoration: const InputDecoration(
                            labelText: 'التصنيف المراد تعديله',
                            border: OutlineInputBorder()),
                        items: widget.menu.categories
                            .map((v) => DropdownMenuItem(
                                value: v.id, child: Text(v.name)))
                            .toList(),
                        onChanged: (v) {
                          if (v == null) return;
                          setState(() {
                            category = widget.menu.categories
                                .firstWhere((c) => c.id == v);
                            name.text = category.name;
                            sort.text = '${category.sort}';
                            error = null;
                          });
                        }),
                    const SizedBox(height: 12),
                    TextField(
                        controller: name,
                        maxLength: 240,
                        decoration: const InputDecoration(
                            labelText: 'اسم التصنيف',
                            border: OutlineInputBorder())),
                    const SizedBox(height: 12),
                    TextField(
                        controller: sort,
                        keyboardType: TextInputType.number,
                        decoration: const InputDecoration(
                            labelText: 'ترتيب العرض',
                            helperText: 'من 0 إلى 10,000',
                            border: OutlineInputBorder())),
                    const Text('يبقى معرّف التصنيف وربط الأصناف به كما هما.'),
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
                      position = stockQuantity(sort.text);
                  if (label.isEmpty ||
                      label.length > 240 ||
                      position == null ||
                      position > 10000) {
                    setState(() => error = 'راجع اسم التصنيف وترتيب العرض.');
                    return;
                  }
                  Navigator.pop(context,
                      (category: category, name: label, sort: position));
                },
                child: const Text('حفظ التصنيف'))
          ]);
}
