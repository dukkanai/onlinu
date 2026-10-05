import 'dart:async';

import 'package:restaurant_admin_prototype/api.dart';
import 'package:restaurant_admin_prototype/models.dart';

RestaurantOrder fixtureOrder({
  String tenant = 'demo-a',
  String status = 'accepted',
  String payment = 'paid',
  int version = 1,
}) =>
    RestaurantOrder(
      id: 'order-1',
      tenantId: tenant,
      status: status,
      paymentStatus: payment,
      version: version,
      totalMinor: 4200,
      currency: 'SAR',
      items: const [OrderLine(name: 'طبق تجريبي', quantity: 2)],
    );

class FakeAdminApi implements AdminApi {
  String? identity;
  int writes = 0;
  int reads = 0;
  bool closed = false;
  Object? readFailure;
  Object? writeFailure;
  Completer<List<RestaurantOrder>>? pendingRead;
  Completer<RestaurantOrder>? pendingWrite;
  int? receivedVersion;
  String? receivedStatus;
  RestaurantOrder currentOrder = fixtureOrder();

  String get tenant => identity == 'merchant-b' ? 'demo-b' : 'demo-a';

  @override
  Future<void> signIn(String selected) async {
    identity = selected;
    currentOrder = fixtureOrder(tenant: tenant);
  }

  @override
  Future<List<Restaurant>> restaurants() async => [
        Restaurant(
            id: tenant,
            name: tenant == 'demo-a' ? 'مطعم أ التجريبي' : 'مطعم ب التجريبي'),
      ];

  @override
  Future<List<RestaurantOrder>> orders(String tenantId) async {
    reads++;
    if (readFailure != null) throw readFailure!;
    if (pendingRead != null) return pendingRead!.future;
    return [currentOrder];
  }

  @override
  Future<RestaurantOrder> updateStatus(
      String tenantId, RestaurantOrder order, String nextStatus) async {
    writes++;
    receivedVersion = order.version;
    receivedStatus = nextStatus;
    if (writeFailure != null) throw writeFailure!;
    if (pendingWrite != null) return pendingWrite!.future;
    currentOrder = fixtureOrder(
        tenant: tenantId, status: nextStatus, version: order.version + 1);
    return currentOrder;
  }

  @override
  void clearSession() => identity = null;

  @override
  void close() => closed = true;
}
