import 'package:flutter/material.dart';
import 'controller.dart';
import 'payment_methods.dart';

class PaymentMethodsPane extends StatelessWidget {
  const PaymentMethodsPane({super.key, required this.controller});
  final CoreController controller;
  @override
  Widget build(BuildContext context) {
    final data = controller.paymentMethods;
    if (data == null) return const Text('لم تُحمّل طرق الدفع.');
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const SizedBox(height: 20),
      const Text('طرق الدفع المهيأة', style: TextStyle(fontSize: 24)),
      Text('${data.currency} · ${data.demo ? 'وضع تجريبي' : 'وضع تشغيل'}'),
      const Text(paymentAvailabilityWarning),
      for (final mode in data.modes) ...[
        ListTile(
            title: Text(paymentModeLabels[mode.mode]!),
            subtitle: Text(
                '${mode.enabled ? 'مفعّلة' : 'متوقفة'} · ${mode.methods.map((v) => paymentMethodLabels[v]!).join('، ')}')),
        if (controller.membership?.can('settings:update') == true)
          FilledButton(
              onPressed: controller.writable
                  ? () async {
                      final methods = await showDialog<List<String>>(
                          context: context,
                          builder: (_) => PaymentMethodsEditor(
                              controller: controller,
                              expected: data,
                              mode: mode.mode));
                      if (methods != null)
                        await controller.patchPaymentMethods(
                            data, mode.mode, methods);
                    }
                  : null,
              child: Text('مراجعة دفع ${paymentModeLabels[mode.mode]}'))
      ]
    ]);
  }
}

class PaymentMethodsEditor extends StatefulWidget {
  const PaymentMethodsEditor(
      {super.key,
      required this.controller,
      required this.expected,
      required this.mode});
  final CoreController controller;
  final CorePaymentMethods expected;
  final String mode;
  @override
  State<PaymentMethodsEditor> createState() => _PaymentMethodsEditorState();
}

class _PaymentMethodsEditorState extends State<PaymentMethodsEditor> {
  late Set<String> selected;
  bool reviewed = false;
  @override
  void initState() {
    super.initState();
    selected = widget.expected.mode(widget.mode).methods.toSet();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
      listenable: widget.controller,
      builder: (context, _) {
        final c = widget.controller;
        final allowed = c.selectedTenant == widget.expected.tenantId &&
            c.section == CoreSection.paymentMethods &&
            c.membership?.can('settings:read') == true;
        final current = c.paymentMethods?.version == widget.expected.version;
        final editable = allowed &&
            current &&
            c.writable &&
            c.membership?.can('settings:update') == true;
        final valid =
            !widget.expected.mode(widget.mode).enabled || selected.isNotEmpty;
        final old = widget.expected.mode(widget.mode).methods.toSet();
        final changed =
            selected.length != old.length || !selected.containsAll(old);
        return AlertDialog(
            title: const Text('مراجعة طرق الدفع'),
            content: SizedBox(
                width: 560,
                child: SingleChildScrollView(
                    child: !allowed
                        ? const Text('تغير المطعم أو صلاحياتك. أغلق النموذج.')
                        : Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                                Text(
                                    'المطعم: ${widget.expected.tenantId} · ${paymentModeLabels[widget.mode]}'),
                                const Text(paymentAvailabilityWarning),
                                if (!current)
                                  const Text(
                                      'تغيرت البيانات. أغلق النموذج وحدّثها وأعد المراجعة.'),
                                Text(
                                    'قبل: ${old.map((v) => paymentMethodLabels[v]!).join('، ')}'),
                                for (final method
                                    in paymentChoices[widget.mode]!)
                                  CheckboxListTile(
                                      value: selected.contains(method),
                                      title: Text(paymentMethodLabels[method]!),
                                      onChanged: editable
                                          ? (v) => setState(() {
                                                if (v == true) {
                                                  selected.add(method);
                                                } else {
                                                  selected.remove(method);
                                                }
                                                reviewed = false;
                                              })
                                          : null),
                                if (!valid)
                                  const Text(
                                      'الخدمة المفعّلة تحتاج طريقة دفع واحدة على الأقل.'),
                                CheckboxListTile(
                                    key: const ValueKey('payment-review'),
                                    value: reviewed,
                                    title: const Text(
                                        'راجعت أثر طرق الدفع على الطلبات الجديدة.'),
                                    onChanged: editable
                                        ? (v) =>
                                            setState(() => reviewed = v == true)
                                        : null)
                              ]))),
            actions: [
              TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('إلغاء')),
              FilledButton(
                  onPressed: editable && valid && changed && reviewed
                      ? () {
                          final methods = paymentChoices[widget.mode]!
                              .where(selected.contains)
                              .toList();
                          widget.expected.validate(widget.mode, methods);
                          Navigator.pop(context, methods);
                        }
                      : null,
                  child: const Text('حفظ طرق الدفع'))
            ]);
      });
}
