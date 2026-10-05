import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:restaurant_admin_prototype/core/controller.dart';
import 'package:restaurant_admin_prototype/core/models.dart';
import 'package:restaurant_admin_prototype/core/transport.dart';
import 'core_fakes.dart';

void main() {
  late FakeCoreGateway api;
  late CoreController c;
  setUp(() {
    api = FakeCoreGateway();
    c = CoreController(api, pollInterval: const Duration(hours: 1));
  });
  tearDown(() => c.dispose());
  test(
      'multiple restaurants require explicit selection and reject foreign order actions',
      () async {
    api.currentProfile = profileFixture(tenants: ['demo-a', 'demo-b']);
    await c.start(restore: false);
    expect(c.selectedTenant, isNull);
    expect(api.reads, 0);
    await c.selectTenant('demo-b');
    expect(c.orders.single.tenantId, 'demo-b');
    await c.change(orderFixture());
    expect(api.writes, 0);
    await c.change(c.orders.single);
    expect(api.writes, 1);
    expect(api.writeTenant, 'demo-b');
    expect(api.writeVersion, 1);
  });
  test('late reads cannot populate another restaurant or revive logout',
      () async {
    api.currentProfile = profileFixture(tenants: ['demo-a', 'demo-b']);
    await c.start(restore: false);
    await c.selectTenant('demo-a');
    final gate = Completer<List<CoreOrder>>();
    api.readGate = gate;
    final old = c.refresh();
    await Future<void>.delayed(Duration.zero);
    api.readGate = null;
    await c.selectTenant('demo-b');
    gate.complete([orderFixture()]);
    await old;
    expect(c.orders.single.tenantId, 'demo-b');
    api.readGate = Completer<List<CoreOrder>>();
    final late = c.refresh();
    await Future<void>.delayed(Duration.zero);
    await c.signOut();
    api.readGate!.complete([orderFixture(tenant: 'demo-b')]);
    await late;
    expect(c.orders, isEmpty);
    expect(c.signedIn, false);
  });
  test('late details are discarded on close, selection and signout', () async {
    await c.start(restore: false);
    api.detailGate = Completer<CoreOrder>();
    final old = c.showDetail('R1234567890');
    c.closeDetail();
    api.detailGate!.complete(orderFixture(detail: true));
    await old;
    expect(c.detail, isNull);
    expect(c.loadingDetail, false);
  });
  test('writes are serialized, versioned and never optimistically fabricated',
      () async {
    await c.start(restore: false);
    api.writeGate = Completer<CoreOrder>();
    final original = c.orders.single;
    final write = c.change(original);
    await c.change(original);
    expect(api.writes, 1);
    expect(c.writable, false);
    expect(c.orders.single.version, 1);
    api.currentOrder = orderFixture(status: 'preparing', version: 2);
    api.writeGate!.complete(api.currentOrder);
    await write;
    expect(c.orders.single.version, 2);
    await c.change(original);
    expect(api.writes, 1);
  });
  test('offline snapshot is read-only and permission removal clears it',
      () async {
    await c.start(restore: false);
    api.readError = const CoreException('offline');
    await c.refresh();
    expect(c.orders, isNotEmpty);
    expect(c.writable, false);
    await c.change(c.orders.single);
    expect(api.writes, 0);
    api.readError = null;
    api.currentProfile = profileFixture(permissions: []);
    await c.refresh();
    expect(c.orders, isEmpty);
    expect(c.writable, false);
  });
  test('ambiguous writes are not replayed and logout fences their late results',
      () async {
    await c.start(restore: false);
    api.writeError = const CoreException('offline', uncertain: true);
    await c.change(c.orders.single);
    expect(api.writes, 1);
    expect(c.message, contains('لم تتأكد'));
    expect(api.reads, 2);
    api.writeError = null;
    api.writeGate = Completer<CoreOrder>();
    final pending = c.change(c.orders.single);
    await c.signOut();
    api.writeGate!.complete(orderFixture(version: 2));
    await pending;
    expect(c.profile, isNull);
    expect(c.orders, isEmpty);
    expect(api.writes, 2);
  });
  test(
      '401/403 remove private cache, background and stale snapshots block mutations',
      () async {
    await c.start(restore: false);
    c.setSuspended(true);
    await c.change(c.orders.single);
    expect(api.writes, 0);
    c.setSuspended(false);
    await Future<void>.delayed(Duration.zero);
    api.readError = const CoreException('forbidden', status: 403);
    await c.refresh();
    expect(c.profile, isNull);
    expect(c.orders, isEmpty);
  });
  test('cancelled login cannot create a visible session or restart polling',
      () async {
    api.session.loginGate = Completer<void>();
    final pending = c.start(restore: false);
    await c.signOut();
    api.session.loginGate!.complete();
    await pending;
    expect(c.signedIn, false);
    expect(c.orders, isEmpty);
    expect(api.profiles, 0);
  });
  test('membership removal resets the selected restaurant and purges its data',
      () async {
    await c.start(restore: false);
    api.currentProfile = profileFixture(tenants: []);
    await c.refresh();
    expect(c.selectedTenant, isNull);
    expect(c.orders, isEmpty);
    expect(c.detail, isNull);
  });
  test('stale data and suspended reads cannot authorize a mutation', () async {
    var now = DateTime.utc(2026, 10, 5);
    final controller = CoreController(api,
        pollInterval: const Duration(hours: 1), now: () => now);
    addTearDown(controller.dispose);
    await controller.start(restore: false);
    now = now.add(const Duration(seconds: 26));
    await controller.change(controller.orders.single);
    expect(api.writes, 0);
    await controller.refresh();
    expect(controller.writable, true);
    controller.setSuspended(true);
    expect(controller.writable, false);
  });
  test('cash/payment progression matches original core and money uses integers',
      () {
    expect(orderFixture(payment: 'unpaid').nextStatus, isNull);
    expect(
        orderFixture(status: 'new', payment: 'unpaid').nextStatus, 'accepted');
    expect(
        orderFixture(mode: 'table', method: 'cash_after', payment: 'unpaid')
            .nextStatus,
        'preparing');
    expect(
        orderFixture(
                mode: 'delivery',
                method: 'cash_on_delivery',
                payment: 'unpaid',
                status: 'ready')
            .nextStatus,
        'out_for_delivery');
    expect(
        orderFixture(
                mode: 'delivery',
                method: 'cash_on_delivery',
                payment: 'unpaid',
                status: 'out_for_delivery')
            .nextStatus,
        isNull);
    expect(
        orderFixture(mode: 'table', method: 'cash_before', payment: 'unpaid')
            .canCollect,
        true);
    expect(orderFixture(method: 'cash_before', payment: 'unpaid').canCollect,
        false);
    expect(orderFixture(status: 'completed').nextStatus, isNull);
    expect(money(12345), '123.45 ر.س');
  });
}
