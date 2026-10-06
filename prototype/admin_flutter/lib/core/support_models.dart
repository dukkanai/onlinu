import 'models.dart';
import 'team_models.dart';
import 'transport.dart';

class CoreSupportRequest {
  CoreSupportRequest(Map<String, dynamic> json, {required this.cancellation})
      : id = principalKey(json['id']),
        status = textField(json['status'], max: 40),
        reason = textField(json['reason'], max: 4000),
        response = textField(
            json[cancellation ? 'decisionReason' : 'resolution'],
            max: 4000),
        requestedAt =
            DateTime.tryParse(textField(json['requestedAt'], max: 80)) ??
                invalidResponse(),
        beforePreparation = cancellation
            ? (json['requestedBeforePreparation'] is bool
                ? json['requestedBeforePreparation'] as bool
                : invalidResponse())
            : false {
    if (!(cancellation
            ? {'requested', 'approved', 'rejected'}
            : {'open', 'resolved'})
        .contains(status)) invalidResponse();
  }
  final String id, status, reason, response;
  final DateTime requestedAt;
  final bool cancellation, beforePreparation;
  bool get open => status == (cancellation ? 'requested' : 'open');
  String get label => switch (status) {
        'requested' => 'بانتظار قرار الإلغاء',
        'approved' => 'أُقر الإلغاء',
        'rejected' => 'رُفض الإلغاء',
        'open' => 'شكوى مفتوحة',
        _ => 'شكوى عولجت'
      };
}

class CoreSupportSummary {
  CoreSupportSummary(Map<String, dynamic> json, {required String tenantId})
      : order = CoreOrder(json, tenantId: tenantId),
        cancellationPending = json['cancellationPending'] is bool
            ? json['cancellationPending'] as bool
            : invalidResponse(),
        openComplaints = integer(json['openComplaints'], max: 10);
  final CoreOrder order;
  final bool cancellationPending;
  final int openComplaints;
}

class CoreSupportQueue {
  CoreSupportQueue(Map<String, dynamic> json, {required this.tenantId})
      : orders = List.unmodifiable(array(json['orders'], max: 100)
            .map((v) => CoreSupportSummary(object(v), tenantId: tenantId))),
        hasMore = json['hasMore'] is bool
            ? json['hasMore'] as bool
            : invalidResponse() {
    if (json['limit'] != 100 ||
        orders.map((v) => v.order.number).toSet().length != orders.length)
      invalidResponse();
  }
  final String tenantId;
  final List<CoreSupportSummary> orders;
  final bool hasMore;
}

class CoreSupportDetail extends CoreSupportSummary {
  CoreSupportDetail(Map<String, dynamic> json, {required String tenantId})
      : demo = json['demo'] is bool ? json['demo'] as bool : invalidResponse(),
        cancellation = json['cancellation'] == null
            ? null
            : CoreSupportRequest(object(json['cancellation']),
                cancellation: true),
        complaints = List.unmodifiable(array(json['complaints'], max: 10)
            .map((v) => CoreSupportRequest(object(v), cancellation: false))),
        history = List.unmodifiable(array(json['cancellationHistory'], max: 20)
            .map((v) => CoreSupportRequest(object(v), cancellation: true))),
        historyTruncated = json['historyTruncated'] is bool
            ? json['historyTruncated'] as bool
            : invalidResponse(),
        super(json, tenantId: tenantId) {
    if (json['historyLimit'] != 20 ||
        cancellationPending != (cancellation?.open == true) ||
        openComplaints != complaints.where((v) => v.open).length ||
        complaints.map((v) => v.id).toSet().length != complaints.length)
      invalidResponse();
  }
  final bool demo, historyTruncated;
  final CoreSupportRequest? cancellation;
  final List<CoreSupportRequest> complaints, history;
  void validate(String id, String action,
      {bool? approve, required String reason}) {
    if (reason.trim().isEmpty ||
        reason.length > 4000 ||
        !{'decide', 'resolve'}.contains(action))
      throw const CoreException('invalid_request');
    if (action == 'decide' &&
            (approve == null ||
                cancellation?.id != id ||
                cancellation?.open != true ||
                {'cancelled', 'completed'}.contains(order.status)) ||
        action == 'resolve' &&
            (approve != null || !complaints.any((v) => v.id == id && v.open)))
      throw const CoreException('invalid_status');
  }
}
