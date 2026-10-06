import 'dart:async';
import 'package:flutter/material.dart';
import 'controller.dart';
import 'models.dart';
import 'delivery_models.dart';
import 'delivery_location_editor.dart';

sealed class DeliveryEdit {}

class PricingEdit extends DeliveryEdit {
  PricingEdit(this.mode, this.fee, this.minimum);
  final String mode;
  final int fee, minimum;
}

class ZoneEdit extends DeliveryEdit {
  ZoneEdit(this.id, this.enabled, this.fee);
  final String id;
  final bool enabled;
  final int? fee;
}

class DeliveryPane extends StatefulWidget {
  const DeliveryPane({super.key, required this.controller});
  final CoreController controller;
  @override
  State<DeliveryPane> createState() => _DeliveryPaneState();
}

class _DeliveryPaneState extends State<DeliveryPane> {
  String filter = '';
  int page = 0;
  Future<void> edit(CoreDelivery value,
      {bool pricing = false, CoreDeliveryZone? zone}) async {
    final result = await showDialog<DeliveryEdit>(
        context: context,
        builder: (_) => DeliveryEditor(
            controller: widget.controller,
            expected: value,
            pricing: pricing,
            zone: zone));
    if (!mounted || result == null) return;
    final c = widget.controller;
    if (result is PricingEdit) {
      await c.deliveryPricing(value,
          mode: result.mode, fee: result.fee, minimum: result.minimum);
    }
    if (result is ZoneEdit) {
      await c.deliveryZone(value,
          district: result.id, enabled: result.enabled, fee: result.fee);
    }
  }

  Future<void> editLocation(CoreDelivery value) async {
    final change = await showDialog<DeliveryLocationChange>(
      context: context,
      builder: (_) => DeliveryLocationEditor(
        controller: widget.controller,
        expected: value,
      ),
    );
    if (!mounted || change == null) return;
    await widget.controller.deliveryLocation(value, change);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller, d = c.coverage;
    if (d == null) return const Text('لم تُحمّل إعدادات التوصيل بعد.');
    final rows = d.zones
            .where((v) =>
                filter.isEmpty ||
                '${v.label} ${v.city} ${v.id}'.toLowerCase().contains(filter))
            .toList(),
        pages = (rows.length / 50).ceil();
    final current = pages == 0 ? 0 : page.clamp(0, pages - 1),
        editable = c.writable && c.membership?.can('settings:update') == true;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const Text('مناطق ورسوم التوصيل', style: TextStyle(fontSize: 22)),
      Text(
          'التسعير: ${d.mode == 'flat' ? 'رسم موحّد' : 'حسب الحي'} • الحد الأدنى: ${money(d.minimum)}'),
      Text(
          'الرسم الموحّد: ${money(d.fee)}${d.mode == 'district' ? ' (غير مستخدم في وضع الأحياء)' : ''}'),
      Text(
          'خدمة التوصيل: ${d.enabled ? 'مفعّلة' : 'متوقفة'} • استقبال الطلبات العام: ${d.accepting ? 'مفعّل' : 'متوقف'}'),
      if (d.requireLocation || d.radius > 0)
        Text(
            'تطبق قيود الموقع الحالية أيضًا${d.radius > 0 ? '، بنطاق ${d.radius} كم' : ''}.'),
      const Text(
          'في وضع الأحياء، الحي غير المهيأ أو المعطّل لا يقبل التوصيل. الرسم صفر يعني توصيلًا مجانيًا. رسوم الطلبات السابقة لا تتغير.'),
      Wrap(spacing: 12, children: [
        if (d.locationKnown)
          OutlinedButton(
              onPressed: editable ? () => editLocation(d) : null,
              child: const Text('تعديل موقع ونطاق التوصيل')),
        OutlinedButton(
            onPressed: editable ? () => edit(d, pricing: true) : null,
            child: const Text('تعديل تسعير التوصيل')),
        OutlinedButton(
            onPressed: editable ? () => edit(d) : null,
            child: const Text('إعداد حي جديد'))
      ]),
      TextField(
          decoration:
              const InputDecoration(labelText: 'بحث في الأحياء المهيأة'),
          onChanged: (v) => setState(() {
                filter = v.trim().toLowerCase();
                page = 0;
              })),
      for (final z in rows.skip(current * 50).take(50))
        Card(
            child: Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(z.label,
                          style: Theme.of(context).textTheme.titleMedium),
                      Text('${z.region} • ${z.city}'),
                      SelectableText(z.id, textDirection: TextDirection.ltr),
                      Text(
                          '${z.enabled ? 'مفعّل' : 'معطّل'} • ${z.fee == null ? 'الرسم غير محدد' : z.fee == 0 ? 'توصيل مجاني' : money(z.fee!)}'),
                      if (!z.active)
                        const Text(
                            'الحي أو أحد والديه غير نشط في البيانات الحالية؛ لا يمكن تفعيله.'),
                      OutlinedButton(
                          onPressed: editable ? () => edit(d, zone: z) : null,
                          child: const Text('تعديل الحي')),
                    ]))),
      if (rows.isEmpty) const Text('لا توجد أحياء مهيأة مطابقة.'),
      if (pages > 1)
        Row(children: [
          TextButton(
              onPressed:
                  current > 0 ? () => setState(() => page = current - 1) : null,
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

class DeliveryEditor extends StatefulWidget {
  const DeliveryEditor(
      {super.key,
      required this.controller,
      required this.expected,
      this.pricing = false,
      this.zone});
  final CoreController controller;
  final CoreDelivery expected;
  final bool pricing;
  final CoreDeliveryZone? zone;
  @override
  State<DeliveryEditor> createState() => _DeliveryEditorState();
}

class _DeliveryEditorState extends State<DeliveryEditor> {
  late String mode;
  late bool enabled;
  late final TextEditingController fee, minimum;
  CoreGeography? regions, cities, districts;
  String? region, city, district, error;
  bool loading = false;
  DeliveryEdit? review;
  bool get allowed =>
      widget.controller.signedIn &&
      widget.controller.selectedTenant == widget.expected.tenantId &&
      widget.controller.membership?.can('settings:read') == true;
  @override
  void initState() {
    super.initState();
    mode = widget.expected.mode;
    enabled = widget.zone?.enabled ?? false;
    district = widget.zone?.id;
    fee = TextEditingController(
        text: widget.pricing
            ? priceInput(widget.expected.fee)
            : widget.zone?.fee == null
                ? ''
                : priceInput(widget.zone!.fee!));
    minimum = TextEditingController(text: priceInput(widget.expected.minimum));
    if (!widget.pricing && widget.zone == null) unawaited(load('regions'));
  }

  @override
  void dispose() {
    fee.dispose();
    minimum.dispose();
    super.dispose();
  }

  Future<void> load(String kind, {String? parent}) async {
    setState(() {
      loading = true;
      error = null;
    });
    try {
      final result = await widget.controller.geography(kind, parent: parent);
      if (!mounted || !allowed) return;
      setState(() {
        if (kind == 'regions')
          regions = result;
        else if (kind == 'cities')
          cities = result;
        else
          districts = result;
      });
    } catch (e) {
      if (mounted) setState(() => error = errorMessage(e));
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  void next() {
    final parsed = fee.text.trim().isEmpty ? null : priceMinor(fee.text),
        min = priceMinor(minimum.text);
    if (widget.pricing
        ? (parsed == null || min == null)
        : (district == null ||
            enabled && parsed == null ||
            fee.text.trim().isNotEmpty && parsed == null)) {
      setState(() => error =
          'اختر الحي وأدخل الرسوم الصحيحة. اكتب صفرًا صراحة للتوصيل المجاني.');
      return;
    }
    if (!widget.pricing && enabled && widget.zone?.active == false) {
      setState(() => error = 'لا يمكن تفعيل حي غير نشط.');
      return;
    }
    setState(() {
      error = null;
      review = widget.pricing
          ? PricingEdit(mode, parsed!, min!)
          : ZoneEdit(district!, enabled, parsed);
    });
  }

  Widget picker(String title, String? value, List<GeoPlace> places,
          void Function(String) select) =>
      DropdownButtonFormField<String>(
          key: ValueKey('$title-${places.map((v) => v.id).join(",")}'),
          initialValue: places.any((v) => v.id == value) ? value : null,
          isExpanded: true,
          decoration: InputDecoration(labelText: title),
          items: places
              .map((v) => DropdownMenuItem(value: v.id, child: Text(v.label)))
              .toList(),
          onChanged: loading
              ? null
              : (v) {
                  if (v != null) select(v);
                });
  @override
  Widget build(BuildContext context) => ListenableBuilder(
      listenable: widget.controller,
      builder: (context, _) {
        final c = widget.controller,
            stale = c.coverage == null ||
                c.coverage!.version != widget.expected.version;
        final editable = allowed &&
            !stale &&
            c.writable &&
            !loading &&
            c.membership?.can('settings:update') == true;
        final selected = review;
        return AlertDialog(
            title: Text(selected != null
                ? 'تأكيد تغيير التوصيل'
                : widget.pricing
                    ? 'تسعير التوصيل'
                    : 'إعداد حي التوصيل'),
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
                              'تغيرت إعدادات التوصيل. افتح النسخة الحالية.'),
                        if (loading) const LinearProgressIndicator(),
                        if (selected is PricingEdit) ...[
                          Text(
                              'التسعير الجديد: ${selected.mode == 'flat' ? 'رسم موحّد' : 'حسب الحي'}'),
                          Text('الرسم الموحّد: ${money(selected.fee)}'),
                          Text('الحد الأدنى: ${money(selected.minimum)}'),
                          if (selected.mode == 'district')
                            const Text(
                                'الأحياء غير المهيأة أو المعطّلة لن تقبل التوصيل، حتى لو كان الرسم الموحّد صفرًا.')
                        ],
                        if (selected is ZoneEdit) ...[
                          Text(
                              'الحي: ${widget.zone?.label ?? districts?.places.where((v) => v.id == selected.id).firstOrNull?.label ?? selected.id}'),
                          SelectableText(selected.id,
                              textDirection: TextDirection.ltr),
                          Text(
                              '${selected.enabled ? 'مفعّل' : 'معطّل'} • ${selected.fee == null ? 'الرسم غير محدد' : selected.fee == 0 ? 'توصيل مجاني' : money(selected.fee!)}')
                        ],
                        if (selected != null)
                          const Text(
                              'يؤثر التغيير على التسعير والطلبات الجديدة في جميع القنوات. رسوم الطلبات السابقة محفوظة، وقيود الموقع الحالية تبقى مطبّقة.'),
                        if (selected == null) ...[
                          if (widget.pricing) ...[
                            DropdownButtonFormField<String>(
                                initialValue: mode,
                                decoration: const InputDecoration(
                                    labelText: 'طريقة التسعير'),
                                items: const [
                                  DropdownMenuItem(
                                      value: 'flat', child: Text('رسم موحّد')),
                                  DropdownMenuItem(
                                      value: 'district',
                                      child: Text('حسب الحي'))
                                ],
                                onChanged: editable
                                    ? (v) => setState(() => mode = v!)
                                    : null),
                            TextField(
                                controller: minimum,
                                readOnly: !editable,
                                decoration: const InputDecoration(
                                    labelText: 'الحد الأدنى للطلب بالريال')),
                          ] else if (widget.zone != null) ...[
                            Text(widget.zone!.label),
                            Text(
                                '${widget.zone!.region} • ${widget.zone!.city}'),
                            SelectableText(widget.zone!.id,
                                textDirection: TextDirection.ltr)
                          ] else ...[
                            picker('المنطقة', region, regions?.places ?? [],
                                (v) {
                              setState(() {
                                region = v;
                                city = null;
                                district = null;
                                cities = null;
                                districts = null;
                              });
                              unawaited(load('cities', parent: v));
                            }),
                            picker('المدينة', city, cities?.places ?? [], (v) {
                              setState(() {
                                city = v;
                                district = null;
                                districts = null;
                              });
                              unawaited(load('districts', parent: v));
                            }),
                            picker('الحي', district, districts?.places ?? [],
                                (v) => setState(() => district = v)),
                            if (regions != null) ...[
                              Text(
                                  'المصدر: ${regions!.source} (${regions!.license})'),
                              const Text(
                                  'بيانات مجتمعية قد تكون ناقصة أو قديمة؛ ليست خدمة تحقق رسمية من العنوان.')
                            ],
                            if (error != null)
                              TextButton(
                                  onPressed: loading
                                      ? null
                                      : () => load(
                                          region == null
                                              ? 'regions'
                                              : city == null
                                                  ? 'cities'
                                                  : 'districts',
                                          parent: city ?? region),
                                  child: const Text('إعادة تحميل المناطق')),
                          ],
                          const SizedBox(height: 12),
                          TextField(
                              controller: fee,
                              readOnly: !editable,
                              keyboardType:
                                  const TextInputType.numberWithOptions(
                                      decimal: true),
                              decoration: InputDecoration(
                                  labelText: widget.pricing
                                      ? 'الرسم الموحّد بالريال'
                                      : 'رسم الحي بالريال',
                                  helperText:
                                      'الصفر مجاني؛ الحقل الفارغ ليس صفرًا')),
                          if (!widget.pricing)
                            SwitchListTile(
                                title: const Text('الحي مفعّل للتوصيل'),
                                value: enabled,
                                onChanged: editable &&
                                        ((widget.zone?.active ?? true) ||
                                            enabled)
                                    ? (v) => setState(() => enabled = v)
                                    : null),
                        ],
                        if (error != null) Text(error!),
                      ]
                    ]))),
            actions: [
              TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('إلغاء')),
              if (selected != null)
                TextButton(
                    onPressed:
                        allowed ? () => setState(() => review = null) : null,
                    child: const Text('رجوع للمراجعة')),
              FilledButton(
                  onPressed: editable
                      ? selected == null
                          ? next
                          : () => Navigator.pop(context, selected)
                      : null,
                  child: Text(selected == null
                      ? 'مراجعة التوصيل'
                      : 'تأكيد حفظ التوصيل'))
            ]);
      });
}
