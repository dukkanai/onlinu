import 'models.dart';
import 'transport.dart';

const paymentModeLabels = {
  'delivery': 'التوصيل',
  'pickup': 'الاستلام',
  'table': 'الطاولات'
};
const paymentMethodLabels = {
  'cash_on_delivery': 'الدفع النقدي عند التوصيل',
  'cash_before': 'الدفع النقدي قبل الخدمة',
  'cash_after': 'الدفع النقدي بعد الخدمة',
  'card': 'الدفع الإلكتروني'
};
const paymentChoices = {
  'delivery': ['cash_on_delivery', 'card'],
  'pickup': ['card'],
  'table': ['cash_before', 'cash_after', 'card']
};
const paymentAvailabilityWarning =
    'هذه خيارات مهيأة وليست دليلًا على اتصال مزود دفع. تعطيل النقد مع عدم توفر مزود إلكتروني مؤهل قد يمنع الطلبات الجديدة. لا يغيّر الحفظ الطلبات السابقة ولا يحصّل أموالًا.';

class CorePaymentMode {
  CorePaymentMode(Map<String, dynamic> json)
      : mode = textField(json['mode'], max: 16),
        enabled = json['enabled'] is bool
            ? json['enabled'] as bool
            : invalidResponse(),
        methods = List.unmodifiable(
            array(json['methods'], max: 3).map((v) => textField(v, max: 24))) {
    if (!paymentChoices.containsKey(mode) ||
        methods.toSet().length != methods.length ||
        methods.any((v) => !paymentChoices[mode]!.contains(v)) ||
        enabled && methods.isEmpty) invalidResponse();
  }
  final String mode;
  final bool enabled;
  final List<String> methods;
}

class CorePaymentMethods {
  CorePaymentMethods(Map<String, dynamic> json, {required this.tenantId})
      : version = integer(json['version'], min: 1),
        currency = textField(json['currency'], max: 3),
        demo = json['demo'] is bool ? json['demo'] as bool : invalidResponse(),
        modes = List.unmodifiable(array(json['modes'], max: 3)
            .map((v) => CorePaymentMode(object(v)))) {
    tenantKey(tenantId);
    if (currency != 'SAR' ||
        modes.length != 3 ||
        modes.map((v) => v.mode).toSet().length != 3) invalidResponse();
  }
  final String tenantId, currency;
  final int version;
  final bool demo;
  final List<CorePaymentMode> modes;
  CorePaymentMode mode(String key) => modes.firstWhere((v) => v.mode == key);
  void validate(String key, List<String> methods) {
    if (!paymentChoices.containsKey(key) ||
        methods.toSet().length != methods.length ||
        methods.any((v) => !paymentChoices[key]!.contains(v)) ||
        mode(key).enabled && methods.isEmpty) {
      throw const CoreException('invalid_request');
    }
  }
}
