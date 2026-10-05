import 'finance_models.dart';
import 'models.dart';

class CoreRefundDetail extends CoreRefundSummary {
  CoreRefundDetail(Map<String, dynamic> json, {required this.tenantId})
      : number = orderKey(json['number']),
        orderVersion = integer(json['orderVersion'], min: 1),
        total = integer(json['orderTotalMinor'], max: 100000000),
        captured = integer(json['capturedMinor'], max: 100000000),
        demo = json['demo'] is bool ? json['demo'] as bool : invalidResponse(),
        reason = textField(json['reason'], max: 4000),
        providerReference = textField(json['providerReference'], max: 4096),
        manualReference = textField(json['manualReference'], max: 4096),
        resolutionReason = textField(json['resolutionReason'], max: 4000),
        automatic = object(json['capability'])['automatic'] is bool
            ? object(json['capability'])['automatic'] as bool
            : invalidResponse(),
        super(json);
  final String tenantId,
      number,
      reason,
      providerReference,
      manualReference,
      resolutionReason;
  final int orderVersion, total, captured;
  final bool demo, automatic;
  bool get canAuthorize =>
      !authorized &&
      !submitted &&
      {'requested', 'review'}.contains(status) &&
      automatic &&
      captured == total;
  bool get canManual => status == 'review' && !submitted && captured >= amount;
  bool get canVerify =>
      status == 'review' && submitted && providerReference.isEmpty;
  bool get canRefresh =>
      providerReference.isNotEmpty &&
      !{'succeeded', 'failed', 'manual_reported'}.contains(status);
  bool supports(String action) => switch (action) {
        'authorize' => canAuthorize,
        'manual' => canManual,
        'verify' => canVerify,
        'refresh' => canRefresh,
        _ => false
      };
  Map<String, dynamic> review() => {
        'version': version,
        'reviewed': true,
        'amountMinor': amount,
        'currency': 'SAR',
        'provider': provider,
        'demo': demo
      };
}

String refundActionLabel(String action) => switch (action) {
      'authorize' => 'التصريح بتنفيذ الاسترداد',
      'manual' => 'تسجيل استرداد يدوي سابق',
      'verify' => 'التحقق من مرجع المزود',
      _ => 'مراجعة حالة المزود'
    };
