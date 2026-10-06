import 'package:flutter/material.dart';
import 'controller.dart';
import 'tax_models.dart';

class TaxPane extends StatelessWidget {
  const TaxPane({super.key, required this.controller});
  final CoreController controller;
  @override
  Widget build(BuildContext context) {
    final tax = controller.tax;
    if (tax == null) return const Text('لم تُحمّل إعدادات الضريبة.');
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const SizedBox(height: 20),
      const Text('إعدادات الضريبة',
          style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
      const Text(
          'تستخدم الأسعار المسجلة الشاملة للضريبة. تعديل الإعدادات لا يزيد أسعار الأصناف ولا يعيد حساب الطلبات السابقة. هذه الإعدادات ليست شهادة امتثال أو فاتورة إلكترونية معتمدة.'),
      Text(tax.enabled ? 'الضريبة مفعّلة' : 'الضريبة متوقفة'),
      Text('النسبة: ${tax.percent}%'),
      Text(
          'رقم التسجيل: ${tax.taxNumber.isEmpty ? 'غير محدد' : tax.taxNumber}'),
      if (controller.membership?.can('settings:update') == true)
        FilledButton(
            onPressed: controller.writable
                ? () async {
                    final result = await showDialog<Map<String, dynamic>>(
                        context: context,
                        builder: (_) =>
                            TaxEditor(controller: controller, tax: tax));
                    if (result != null)
                      await controller.patchTax(tax,
                          enabled: result['enabled'] as bool,
                          rateBps: result['rateBps'] as int,
                          taxNumber: result['taxNumber'] as String);
                  }
                : null,
            child: const Text('مراجعة إعدادات الضريبة'))
    ]);
  }
}

class TaxEditor extends StatefulWidget {
  const TaxEditor({super.key, required this.controller, required this.tax});
  final CoreController controller;
  final CoreTaxConfig tax;
  @override
  State<TaxEditor> createState() => _TaxEditorState();
}

class _TaxEditorState extends State<TaxEditor> {
  late final TextEditingController rate, number;
  late bool enabled;
  bool reviewed = false;
  String? error;
  @override
  void initState() {
    super.initState();
    rate = TextEditingController(text: widget.tax.percent);
    number = TextEditingController(text: widget.tax.taxNumber);
    enabled = widget.tax.enabled;
  }

  @override
  void dispose() {
    rate.dispose();
    number.dispose();
    super.dispose();
  }

  void changed() {
    setState(() {
      reviewed = false;
      error = null;
    });
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
      listenable: widget.controller,
      builder: (context, _) {
        final c = widget.controller,
            allowed = !c.suspended &&
                c.selectedTenant == widget.tax.tenantId &&
                c.section == CoreSection.tax &&
                c.membership?.can('settings:read') == true;
        final editable = allowed &&
            c.writable &&
            c.tax?.version == widget.tax.version &&
            c.membership?.can('settings:update') == true;
        return AlertDialog(
            title: const Text('مراجعة الضريبة للطلبات الجديدة'),
            content: SizedBox(
                width: 550,
                child: SingleChildScrollView(
                    child: !allowed
                        ? const Text('تغير المطعم أو صلاحياتك. أغلق النموذج.')
                        : Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                                Text(
                                    'المطعم: ${widget.tax.tenantId} · الإصدار: ${widget.tax.version}'),
                                const Text(
                                    'النسبة ورقم التسجيل يحددهما المسؤول المخوّل حسب وضع المنشأة. لا يغير هذا النموذج إجماليات الطلبات المسجلة أو يضيف مبلغًا فوق أسعار القائمة.'),
                                SwitchListTile(
                                    title: const Text('تفعيل حساب الضريبة'),
                                    value: enabled,
                                    onChanged: editable
                                        ? (value) {
                                            setState(() {
                                              enabled = value;
                                              reviewed = false;
                                              error = null;
                                            });
                                          }
                                        : null),
                                TextField(
                                    controller: rate,
                                    enabled: editable,
                                    keyboardType:
                                        const TextInputType.numberWithOptions(
                                            decimal: true),
                                    decoration: const InputDecoration(
                                        labelText: 'النسبة المئوية، مثل 15.00'),
                                    onChanged: (_) => changed()),
                                TextField(
                                    controller: number,
                                    enabled: editable,
                                    maxLength: 80,
                                    decoration: const InputDecoration(
                                        labelText: 'رقم التسجيل الضريبي'),
                                    onChanged: (_) => changed()),
                                const Text(
                                    'الأسعار شاملة للضريبة · العملة SAR. أي تأكيد طلب قديم لم يُنفذ بعد سيحتاج مراجعة جديدة إذا تغيّرت تفاصيل الضريبة.'),
                                if (!editable)
                                  const Text(
                                      'حدّث البيانات وأعد فتح المراجعة قبل الحفظ.'),
                                if (error != null) Text(error!),
                                CheckboxListTile(
                                    value: reviewed,
                                    onChanged: editable
                                        ? (value) => setState(
                                            () => reviewed = value == true)
                                        : null,
                                    title: const Text(
                                        'راجعت النسبة والتسجيل وأثرهما على الطلبات الجديدة.'))
                              ]))),
            actions: [
              TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('إلغاء')),
              FilledButton(
                  onPressed: editable && reviewed
                      ? () {
                          try {
                            final bps = taxRateFromPercent(rate.text);
                            widget.tax.validate(
                                enabled: enabled,
                                rateBps: bps,
                                taxNumber: number.text);
                            Navigator.pop(context, {
                              'enabled': enabled,
                              'rateBps': bps,
                              'taxNumber': number.text
                            });
                          } catch (e) {
                            setState(() => error = errorMessage(e));
                          }
                        }
                      : null,
                  child: const Text('حفظ إعدادات الضريبة'))
            ]);
      });
}
