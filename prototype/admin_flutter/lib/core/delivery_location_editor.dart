import 'package:flutter/material.dart';

import 'controller.dart';
import 'delivery_models.dart';

class DeliveryLocationEditor extends StatefulWidget {
  const DeliveryLocationEditor({
    super.key,
    required this.controller,
    required this.expected,
  });
  final CoreController controller;
  final CoreDelivery expected;
  @override
  State<DeliveryLocationEditor> createState() => _DeliveryLocationEditorState();
}

class _DeliveryLocationEditorState extends State<DeliveryLocationEditor> {
  late final TextEditingController latitude, longitude, radius;
  late bool requireLocation;
  DeliveryLocationChange? review;
  String? error;
  @override
  void initState() {
    super.initState();
    latitude = TextEditingController(
      text: widget.expected.latitude?.toString() ?? '',
    );
    longitude = TextEditingController(
      text: widget.expected.longitude?.toString() ?? '',
    );
    radius = TextEditingController(text: widget.expected.radius.toString());
    requireLocation = widget.expected.requireLocation;
  }

  @override
  void dispose() {
    latitude.dispose();
    longitude.dispose();
    radius.dispose();
    super.dispose();
  }

  void next() {
    final lat = deliveryDecimal(latitude.text, -90, 90);
    final lon = deliveryDecimal(longitude.text, -180, 180);
    final km = deliveryDecimal(radius.text, 0, 500);
    final clear = latitude.text.trim().isEmpty && longitude.text.trim().isEmpty;
    if (km == null ||
        !clear && (lat == null || lon == null) ||
        clear && km > 0) {
      setState(
        () => error = 'أدخل الإحداثيين الصحيحين ونطاقًا من صفر إلى 500 كم. لمسح الموقع اترك الإحداثيين فارغين واجعل النطاق صفرًا.',
      );
      return;
    }
    setState(() {
      error = null;
      review = DeliveryLocationChange(
        latitude: clear ? null : lat,
        longitude: clear ? null : lon,
        radius: km,
        requireLocation: requireLocation,
      );
    });
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final c = widget.controller;
      final allowed =
          c.signedIn &&
          c.selectedTenant == widget.expected.tenantId &&
          c.membership?.can('settings:read') == true;
      final stale =
          c.coverage == null || c.coverage!.version != widget.expected.version;
      final editable =
          allowed &&
          !stale &&
          c.writable &&
          widget.expected.locationKnown &&
          c.membership?.can('settings:update') == true;
      final selected = review;
      return AlertDialog(
        title: Text(
          selected == null
              ? 'موقع المطعم ونطاق التوصيل'
              : 'مراجعة موقع ونطاق التوصيل',
        ),
        content: SizedBox(
          width: 620,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (!allowed)
                  const Text('تغيرت الجلسة أو الصلاحيات. أغلق هذه النافذة.'),
                if (allowed) ...[
                  if (stale)
                    const Text('تغيرت إعدادات التوصيل. افتح النسخة الحالية.'),
                  if (!widget.expected.locationKnown)
                    const Text('إصدار النواة الحالي لا يدعم تعديل الموقع.'),
                  const Text(
                    'النطاق مسافة بخط مستقيم وليس مسافة الطريق. صفر يعطّل حد المسافة. النطاق الموجب يتطلب موقع العميل دائمًا. الرسوم والطلبات السابقة لا تتغير.',
                  ),
                  const SizedBox(height: 12),
                  if (selected == null) ...[
                    TextField(
                      controller: latitude,
                      readOnly: !editable,
                      textDirection: TextDirection.ltr,
                      maxLength: 64,
                      decoration: const InputDecoration(
                        labelText: 'خط عرض المطعم',
                      ),
                    ),
                    TextField(
                      controller: longitude,
                      readOnly: !editable,
                      textDirection: TextDirection.ltr,
                      maxLength: 64,
                      decoration: const InputDecoration(
                        labelText: 'خط طول المطعم',
                      ),
                    ),
                    TextField(
                      controller: radius,
                      readOnly: !editable,
                      textDirection: TextDirection.ltr,
                      maxLength: 64,
                      decoration: const InputDecoration(
                        labelText: 'نطاق التوصيل بالكيلومتر',
                      ),
                    ),
                    SwitchListTile(
                      title: const Text(
                        'اشتراط موقع العميل حتى عند تعطيل النطاق',
                      ),
                      value: requireLocation,
                      onChanged: editable
                          ? (value) => setState(() => requireLocation = value)
                          : null,
                    ),
                    const Text(
                      'لمسح موقع المطعم اترك الإحداثيين فارغين واجعل النطاق صفرًا.',
                    ),
                  ] else ...[
                    Text(
                      selected.latitude == null
                          ? 'سيُمسح موقع المطعم.'
                          : 'موقع المطعم: ${selected.latitude}, ${selected.longitude}',
                    ),
                    Text('النطاق: ${selected.radius} كم'),
                    Text(
                      'موقع العميل: ${selected.requireLocation || selected.radius > 0 ? 'مطلوب' : 'اختياري'}',
                    ),
                  ],
                  if (error != null) Text(error!),
                ],
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('إلغاء'),
          ),
          if (selected != null && allowed)
            TextButton(
              onPressed: editable ? () => setState(() => review = null) : null,
              child: const Text('رجوع للتعديل'),
            ),
          FilledButton(
            onPressed: !editable
                ? null
                : selected == null
                ? next
                : () => Navigator.of(context).pop(selected),
            child: Text(
              selected == null
                  ? 'مراجعة الموقع والنطاق'
                  : 'تأكيد حفظ الموقع والنطاق',
            ),
          ),
        ],
      );
    },
  );
}
