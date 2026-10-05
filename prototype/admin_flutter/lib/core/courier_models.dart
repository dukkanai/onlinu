import 'models.dart';
import 'team_models.dart';

class CoreCourierLink {
  CoreCourierLink(Map<String, dynamic> json)
      : courier = CoreCourier(json),
        version = integer(json['version']),
        activeOrders = integer(json['activeOrders']),
        bound =
            json['bound'] is bool ? json['bound'] as bool : invalidResponse(),
        principalId = json['principalId'] == null
            ? null
            : principalKey(json['principalId']),
        principalName = textField(json['principalName'], max: 120),
        eligible = json['eligible'] is bool
            ? json['eligible'] as bool
            : invalidResponse() {
    if (!bound && principalId != null) invalidResponse();
  }
  final CoreCourier courier;
  final int version, activeOrders;
  final bool bound, eligible;
  final String? principalId;
  final String principalName;
}

class CoreCourierCandidate {
  CoreCourierCandidate(Map<String, dynamic> json)
      : id = principalKey(json['principalId']),
        name = textField(json['displayName'], max: 120);
  final String id, name;
}

class CoreCourierLinks {
  CoreCourierLinks(Map<String, dynamic> json, {required this.tenantId})
      : links = List.unmodifiable(array(json['links'], max: 500)
            .map((v) => CoreCourierLink(object(v)))),
        candidates = List.unmodifiable(array(json['candidates'], max: 5000)
            .map((v) => CoreCourierCandidate(object(v)))) {
    if (json['limit'] != 500 ||
        links.map((v) => v.courier.id).toSet().length != links.length ||
        candidates.map((v) => v.id).toSet().length != candidates.length)
      invalidResponse();
  }
  final String tenantId;
  final List<CoreCourierLink> links;
  final List<CoreCourierCandidate> candidates;
}

class CoreCourierWork {
  CoreCourierWork(Map<String, dynamic> json, {required this.tenantId})
      : courier = json['courier'] == null
            ? null
            : CoreCourier(object(json['courier'])),
        bindingVersion = integer(json['bindingVersion']),
        orders = List.unmodifiable(array(json['orders'], max: 100)
            .map((v) => CoreOrder(object(v), tenantId: tenantId))) {
    if (json['limit'] != 100 ||
        (courier == null
            ? (bindingVersion != 0 || orders.isNotEmpty)
            : (!courier!.active || bindingVersion < 1)) ||
        orders.map((v) => v.number).toSet().length != orders.length ||
        orders.any((v) =>
            v.mode != 'delivery' ||
            v.courierId != courier?.id ||
            {'completed', 'cancelled'}.contains(v.status) ||
            v.deliveryStatus == 'delivered')) invalidResponse();
  }
  final String tenantId;
  final CoreCourier? courier;
  final int bindingVersion;
  final List<CoreOrder> orders;
}

class CoreCourierDetail {
  CoreCourierDetail(Map<String, dynamic> json, {required String tenant})
      : order = CoreOrder(json, tenantId: tenant, detail: true),
        bindingVersion = integer(json['bindingVersion'], min: 1),
        customerName = textField(json['customerName']),
        phone = textField(json['phone']),
        address = Map.unmodifiable({
          for (final key in const [
            'addressLine',
            'nationalAddress',
            'city',
            'district',
            'street',
            'building',
            'postalCode',
            'additionalNumber'
          ])
            key: textField(object(json['address'])[key])
        }) {
    if (order.mode != 'delivery' || order.courierId.isEmpty) invalidResponse();
  }
  final CoreOrder order;
  final int bindingVersion;
  final String customerName, phone;
  final Map<String, String> address;
}

String? courierNextStage(CoreOrder order) =>
    !{'ready', 'out_for_delivery'}.contains(order.status)
        ? null
        : const {
            'assigned': 'picked_up',
            'picked_up': 'on_the_way',
            'on_the_way': 'nearby',
            'nearby': 'at_door',
            'at_door': 'delivered'
          }[order.deliveryStatus];
bool courierCanCollect(CoreOrder order) =>
    order.deliveryStatus == 'at_door' &&
    order.paymentMethod == 'cash_on_delivery' &&
    order.paymentStatus == 'unpaid' &&
    {'ready', 'out_for_delivery'}.contains(order.status);
