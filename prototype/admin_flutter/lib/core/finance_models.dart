import 'models.dart';
import 'team_models.dart';

class CoreRefundSummary {
  CoreRefundSummary(Map<String, dynamic> json)
      : id = principalKey(json['id']),
        version = integer(json['version'], min: 1),
        status = textField(json['status'], max: 40),
        provider = textField(json['provider'], max: 40),
        amount = integer(json['amountMinor'], min: 1, max: 100000000),
        tax = integer(json['taxMinor'], max: 100000000),
        confirmation = textField(json['confirmation'], max: 40),
        authorized = json['authorized'] is bool
            ? json['authorized'] as bool
            : invalidResponse(),
        submitted = json['submitted'] is bool
            ? json['submitted'] as bool
            : invalidResponse(),
        updatedAt = DateTime.tryParse(textField(json['updatedAt'], max: 80)) ??
            invalidResponse() {
    if (json['currency'] != 'SAR' ||
        tax > amount ||
        !{
          'requested',
          'processing',
          'succeeded',
          'failed',
          'review',
          'manual_reported'
        }.contains(status)) invalidResponse();
  }
  final String id, status, provider, confirmation;
  final int version, amount, tax;
  final bool authorized, submitted;
  final DateTime updatedAt;
}

class CoreFinance {
  CoreFinance(Map<String, dynamic> json, {required this.tenantId})
      : number = orderKey(json['number']),
        version = integer(json['orderVersion'], min: 1),
        total = integer(json['totalMinor'], max: 100000000),
        captured = integer(json['capturedMinor'], max: 100000000),
        reserved = integer(json['reservedMinor'], max: 100000000),
        refunded = integer(json['refundedMinor'], max: 100000000),
        available = integer(json['availableMinor'], max: 100000000),
        method = textField(json['paymentMethod'], max: 40),
        status = textField(json['paymentStatus'], max: 40),
        provider = textField(json['provider'], max: 40),
        demo = json['demo'] is bool ? json['demo'] as bool : invalidResponse(),
        refunds = List.unmodifiable(array(json['refunds'], max: 100)
            .map((v) => CoreRefundSummary(object(v)))) {
    if (json['currency'] != 'SAR' ||
        json['limit'] != 100 ||
        refunded > reserved ||
        available > captured ||
        refunds.map((v) => v.id).toSet().length != refunds.length)
      invalidResponse();
  }
  final String tenantId, number, method, status, provider;
  final int version, total, captured, reserved, refunded, available;
  final bool demo;
  final List<CoreRefundSummary> refunds;
}

String refundStatusLabel(String value) => switch (value) {
      'requested' => 'طلب استرداد مسجل',
      'processing' => 'قيد المعالجة',
      'succeeded' => 'استرداد مؤكد',
      'failed' => 'فشل الاسترداد',
      'manual_reported' => 'إبلاغ يدوي غير مؤكد من المزود',
      _ => 'يحتاج مراجعة'
    };

String financeStatusLabel(String value) => switch (value) {
      'paid' => 'مدفوع',
      'unpaid' => 'غير مدفوع',
      'pending' => 'بانتظار التحقق',
      'refunded' => 'مسترد',
      'failed' => 'فشل الدفع',
      'review' => 'يحتاج مراجعة',
      _ => 'حالة غير مدعومة'
    };
String financeMethodLabel(String value) => switch (value) {
      'card' => 'إلكتروني',
      'cash_on_delivery' => 'نقد عند التوصيل',
      'cash_before' => 'نقد قبل الخدمة',
      'cash_after' => 'نقد بعد الخدمة',
      _ => 'طريقة غير مدعومة'
    };
