import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:restaurant_admin_prototype/admin_controller.dart';
import 'package:restaurant_admin_prototype/api.dart';
import 'package:restaurant_admin_prototype/models.dart';

import 'fakes.dart';

void main() {
  late FakeAdminApi api;
  late AdminController controller;

  setUp(() {
    api = FakeAdminApi();
    controller = AdminController(api, pollInterval: const Duration(hours: 1));
  });
  tearDown(() => controller.dispose());

  test('version is preserved and UI only changes after server success',
      () async {
    await controller.signIn('merchant-a');
    api.pendingWrite = Completer<RestaurantOrder>();
    final future = controller.advance(controller.orders.single);
    expect(controller.orders.single.status, 'accepted');
    expect(controller.canWrite, isFalse);
    expect(api.receivedVersion, 1);
    expect(api.receivedStatus, 'preparing');
    api.pendingWrite!.complete(fixtureOrder(status: 'preparing', version: 2));
    await future;
    expect(controller.orders.single.status, 'preparing');
    expect(controller.orders.single.version, 2);
  });

  test('failed refresh blocks writes until a fresh read succeeds', () async {
    await controller.signIn('merchant-a');
    api.readFailure = const AdminApiException('offline');
    await controller.refresh();
    await controller.advance(controller.orders.single);
    expect(api.writes, 0);
    expect(controller.canWrite, isFalse);
    expect(controller.error, contains('أوقفت التعديلات'));
    api.readFailure = null;
    await controller.refresh();
    expect(controller.canWrite, isTrue);
    expect(controller.error, isNull);
  });

  test('409 and ambiguous write results are never retried automatically',
      () async {
    await controller.signIn('merchant-a');
    api.writeFailure = const AdminApiException('conflict', status: 409);
    await controller.advance(controller.orders.single);
    await controller.advance(controller.orders.single);
    expect(api.writes, 1);
    expect(controller.error, contains('تغير الطلب'));
    expect(controller.orders.single.version, 1);
    api.currentOrder = fixtureOrder(status: 'preparing', version: 2);
    await controller.refresh();
    expect(controller.orders.single.version, 2);
    expect(controller.canWrite, isTrue);
    expect(api.writes, 1);
  });

  test('unpaid and terminal orders have no transition', () async {
    expect(
        fixtureOrder(payment: 'pending', status: 'pending_payment').nextStatus,
        isNull);
    expect(fixtureOrder(status: 'completed').nextStatus, isNull);
    await controller.signIn('merchant-a');
    await controller.advance(fixtureOrder(tenant: 'demo-b'));
    expect(api.writes, 0);
  });

  test('identity switch clears previous restaurant and logout drops late read',
      () async {
    await controller.signIn('merchant-a');
    await controller.signIn('merchant-b');
    expect(controller.orders.single.tenantId, 'demo-b');
    api.pendingRead = Completer<List<RestaurantOrder>>();
    final request = controller.refresh();
    controller.signOut();
    api.pendingRead!.complete([fixtureOrder(tenant: 'demo-b')]);
    await request;
    expect(controller.orders, isEmpty);
    expect(controller.identity, isNull);
    expect(controller.connection, ConnectionState.signedOut);
  });

  test('401 clears in-memory session and exposes useful error', () async {
    await controller.signIn('merchant-a');
    api.readFailure = const AdminApiException('expired', status: 401);
    await controller.refresh();
    expect(controller.orders, isEmpty);
    expect(controller.identity, isNull);
    expect(api.identity, isNull);
    expect(controller.busy, isFalse);
    expect(controller.error, contains('انتهت جلسة'));
  });

  test('suspension disables mutations until foreground fresh read', () async {
    await controller.signIn('merchant-a');
    controller.setSuspended(true);
    expect(controller.canWrite, isFalse);
    api.pendingRead = Completer<List<RestaurantOrder>>();
    controller.setSuspended(false);
    expect(controller.canWrite, isFalse);
    api.pendingRead!.complete([fixtureOrder(version: 2)]);
    await Future<void>.delayed(Duration.zero);
    expect(controller.canWrite, isTrue);
    expect(controller.orders.single.version, 2);
  });

  test('poll timer is cancelled and API closed on dispose', () async {
    final pollingApi = FakeAdminApi();
    final polling = AdminController(pollingApi,
        pollInterval: const Duration(milliseconds: 5));
    await polling.signIn('merchant-a');
    await Future<void>.delayed(const Duration(milliseconds: 15));
    polling.dispose();
    final readsAtDispose = pollingApi.reads;
    await Future<void>.delayed(const Duration(milliseconds: 15));
    expect(readsAtDispose, greaterThan(1));
    expect(pollingApi.reads, readsAtDispose);
    expect(pollingApi.closed, isTrue);
  });
}
