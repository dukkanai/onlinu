import 'dart:async';
import 'dart:typed_data';
import 'dart:ui' as ui;
import 'transport.dart';
import 'package:flutter/material.dart';
import 'controller.dart';
import 'models.dart';
import 'menu_image_io.dart';

class MenuImageEditor extends StatefulWidget {
  const MenuImageEditor(
      {super.key,
      required this.controller,
      required this.tenant,
      required this.id,
      this.picker = pickMenuImage});
  final CoreController controller;
  final String tenant, id;
  final MenuImagePicker picker;
  @override
  State<MenuImageEditor> createState() => _MenuImageEditorState();
}

class _MenuImageEditorState extends State<MenuImageEditor> {
  CoreMenuDetails? details;
  SelectedMenuImage? selected;
  Uint8List? preview;
  String? error;
  bool working = false;
  bool get allowed =>
      widget.controller.signedIn &&
      widget.controller.selectedTenant == widget.tenant &&
      widget.controller.membership?.can('menu:read') == true;
  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    setState(() {
      working = true;
      error = null;
      selected = null;
      preview = null;
      details = null;
    });
    try {
      final d = await widget.controller.menuDetails(widget.id);
      if (!mounted || !allowed) return;
      setState(() => details = d);
      if (d.imageUrl.isNotEmpty) {
        final bytes = await widget.controller.menuImage(d);
        final buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
        try {
          final descriptor = await ui.ImageDescriptor.encoded(buffer);
          try {
            if (descriptor.width > 4096 ||
                descriptor.height > 4096 ||
                descriptor.width * descriptor.height > 16000000)
              throw const CoreException('image_invalid');
          } finally {
            descriptor.dispose();
          }
        } finally {
          buffer.dispose();
        }
        if (mounted && allowed) setState(() => preview = bytes);
      }
    } catch (e) {
      if (mounted) setState(() => error = errorMessage(e));
    } finally {
      if (mounted) setState(() => working = false);
    }
  }

  Future<void> _pick() async {
    setState(() {
      working = true;
      selected = null;
      error = null;
    });
    try {
      final image = await widget.picker();
      if (image != null) validateMenuImage(image.bytes);
      if (mounted && allowed) setState(() => selected = image);
    } catch (e) {
      if (mounted) setState(() => error = errorMessage(e));
    } finally {
      if (mounted) setState(() => working = false);
    }
  }

  Future<void> _save() async {
    final d = details, image = selected;
    if (d == null || image == null || !allowed) return;
    setState(() {
      working = true;
      error = null;
    });
    final result = await widget.controller.uploadMenuImage(d, image.bytes);
    if (!mounted) return;
    setState(() {
      working = false;
      selected = null;
    });
    if (result != null && allowed) {
      await _load();
    } else {
      setState(() => error = widget.controller.message ??
          'لم يُؤكد حفظ الصورة. حدّث الصنف قبل المحاولة مجددًا.');
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
      listenable: widget.controller,
      builder: (context, _) {
        final c = widget.controller, d = details;
        final stale =
            d != null && c.menu != null && d.version < c.menu!.version;
        final editable = allowed &&
            d != null &&
            !stale &&
            !working &&
            c.writable &&
            c.membership?.can('menu:update') == true;
        return AlertDialog(
            title: Text(
                allowed && d != null ? 'صورة ${d.item.name}' : 'صورة الصنف'),
            content: SizedBox(
                width: 520,
                child: SingleChildScrollView(
                    child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                      if (!allowed)
                        const Text(
                            'تغيرت الجلسة أو الصلاحيات. أغلق هذه النافذة.'),
                      if (allowed) ...[
                        if (working) const LinearProgressIndicator(),
                        if (preview != null)
                          Image.memory(preview!,
                              height: 220,
                              fit: BoxFit.contain,
                              cacheWidth: 512,
                              semanticLabel: 'الصورة الحالية للصنف',
                              errorBuilder: (_, __, ___) =>
                                  const Text('تعذر عرض الصورة الحالية.')),
                        if (d != null && d.imageUrl.isEmpty)
                          const Text('لا توجد صورة حالية.'),
                        const SizedBox(height: 12),
                        const Text(
                            'PNG أو JPEG، حتى 5 ميغابايت. ستُنشر الصورة في قائمة المطعم العامة بعد الرفع. اختيار الملف وحده لا يرفعه.'),
                        if (stale)
                          const Text(
                              'تغيرت القائمة. حدّث الصنف وأعد اختيار الصورة.'),
                        if (selected != null)
                          Text(
                              'الملف: ${selected!.name} (${(selected!.bytes.length / 1024).ceil()} كيلوبايت)'),
                        if (error != null) Text(error!, semanticsLabel: error),
                        const SizedBox(height: 12),
                        OutlinedButton(
                            onPressed: editable ? _pick : null,
                            child: const Text('اختيار صورة')),
                        FilledButton(
                            onPressed:
                                editable && selected != null ? _save : null,
                            child: const Text('رفع الصورة للصنف')),
                      ]
                    ]))),
            actions: [
              TextButton(
                  onPressed: allowed && !working ? _load : null,
                  child: const Text('تحديث الصنف')),
              TextButton(
                  onPressed: working ? null : () => Navigator.pop(context),
                  child: const Text('إغلاق')),
            ]);
      });
}
