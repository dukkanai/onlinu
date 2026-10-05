import 'models.dart';
import 'transport.dart';

const serviceLabels = {
  'acceptingOrders': 'استقبال الطلبات الجديدة',
  'deliveryEnabled': 'التوصيل',
  'pickupEnabled': 'الاستلام من المطعم',
  'tableEnabled': 'طلبات الطاولات'
};

class CoreServicePolicy {
  CoreServicePolicy(Map<String, dynamic> json, {required this.tenantId})
      : version = integer(json['version'], min: 1),
        flags = Map.unmodifiable({
          for (final key in serviceLabels.keys)
            key: json[key] is bool ? json[key] as bool : invalidResponse()
        }) {
    if (flags['acceptingOrders'] == true &&
        !['deliveryEnabled', 'pickupEnabled', 'tableEnabled']
            .any((k) => flags[k] == true)) invalidResponse();
  }
  final String tenantId;
  final int version;
  final Map<String, bool> flags;
  void validate(Map<String, bool> changes) {
    if (changes.isEmpty ||
        changes.keys.any((v) => !serviceLabels.containsKey(v)))
      throw const CoreException('invalid_request');
    final merged = {...flags, ...changes};
    if (merged['acceptingOrders'] == true &&
        !['deliveryEnabled', 'pickupEnabled', 'tableEnabled']
            .any((k) => merged[k] == true))
      throw const CoreException('invalid_service_modes');
  }
}
