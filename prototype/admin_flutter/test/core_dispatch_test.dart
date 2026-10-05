import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:restaurant_admin_prototype/core/api.dart';
import 'package:restaurant_admin_prototype/core/app.dart';
import 'package:restaurant_admin_prototype/core/controller.dart';
import 'package:restaurant_admin_prototype/core/models.dart';
import 'package:restaurant_admin_prototype/core/transport.dart';
import 'core_fakes.dart';

const driver = '12345678123442348234123456789def';
void main() {
  test('dispatch eligibility is limited to unfinished delivery orders', () {
    expect(orderFixture(mode: 'pickup').canAssign, false);
    expect(
        orderFixture(mode: 'delivery', status: 'completed').canAssign, false);
    expect(orderFixture(mode: 'delivery', status: 'accepted').canAssign, true);
    expect(
        CoreOrder(
                {...orderJson(mode: 'delivery'), 'deliveryStatus': 'delivered'},
                tenantId: 'demo-a')
            .canAssign,
        false);
  });
  test(
      'assignment API binds order, tenant, version, courier and unchanged money',
      () async {
    final session = FakeCoreSession()..hasSession = true,
        api = CoreApi(session),
        old = orderFixture(mode: 'delivery');
    session.transport.handler = (_, __, ___) async => CoreReply(200, {
          'tenantId': 'demo-a',
          ...orderJson(
              mode: 'delivery',
              version: 2,
              courierId: driver,
              courierName: 'مندوب',
              deliveryStatus: 'assigned')
        });
    final assigned = await api.assignCourier('demo-a', old, driver);
    expect(assigned.courierId, driver);
    expect(session.transport.calls.single['body'],
        {'version': 1, 'courierId': driver});
    await expectLater(api.assignCourier('demo-b', old, driver),
        throwsA(isA<CoreException>()));
    expect(session.transport.calls.length, 1);
    session.transport.handler = (_, __, ___) async => CoreReply(200, {
          'tenantId': 'demo-a',
          ...orderJson(
              mode: 'delivery',
              version: 2,
              courierId: driver,
              deliveryStatus: 'assigned'),
          'totalMinor': 1
        });
    await expectLater(
        api.assignCourier('demo-a', old, driver),
        throwsA(isA<CoreException>()
            .having((v) => v.uncertain, 'uncertain', true)));
  });
  test('controller refuses stale, duplicate and revoked courier assignments',
      () async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['orders:read', 'delivery:assign'])
      ..currentOrder = orderFixture(mode: 'delivery');
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    final old = c.orders.single;
    await c.assignCourier(old, driver);
    expect(api.assignments, 1);
    expect(c.orders.single.courierId, driver);
    await c.assignCourier(old, '');
    expect(api.assignments, 1);
    await c.assignCourier(c.orders.single, driver);
    expect(api.assignments, 1);
    api.currentProfile = profileFixture(permissions: ['orders:read']);
    await c.refresh();
    await c.assignCourier(c.orders.single, '');
    expect(api.assignments, 1);
  });
  test('late courier roster is rejected after dispatch permission is removed',
      () async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['orders:read', 'delivery:assign']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    final gate = Completer<List<CoreCourier>>();
    api.courierGate = gate;
    final pending = c.couriers('demo-a');
    final check = expectLater(pending, throwsA(isA<CoreException>()));
    api.currentProfile = profileFixture(permissions: ['orders:read']);
    await c.refresh();
    gate.complete(api.currentCouriers);
    await check;
    expect(c.orders, isEmpty);
  });
  testWidgets('assignment is reviewed before write and cancellation is inert',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['orders:read', 'delivery:assign'])
      ..currentOrder = orderFixture(mode: 'delivery');
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    await tester.pumpWidget(CoreApp(controller: c));
    await tester.pumpAndSettle();
    await tester.tap(find.text('الدخول عبر المتصفح'));
    await tester.pumpAndSettle();
    final assign = find.text('إسناد مندوب');
    await tester.ensureVisible(assign);
    await tester.pumpAndSettle();
    await tester.tap(assign);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(
        DropdownButtonFormField<String>, 'المندوب المطلوب'));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('مندوب تجريبي • متاح').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('مراجعة الإسناد'));
    await tester.pumpAndSettle();
    expect(api.assignments, 0);
    expect(find.text('تأكيد إسناد المندوب'), findsOneWidget);
    await tester.tap(find.text('إلغاء'));
    await tester.pumpAndSettle();
    expect(api.assignments, 0);
    await tester.ensureVisible(assign);
    await tester.pumpAndSettle();
    await tester.tap(assign);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(
        DropdownButtonFormField<String>, 'المندوب المطلوب'));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('مندوب تجريبي • متاح').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('مراجعة الإسناد'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('تأكيد الإسناد'));
    await tester.pumpAndSettle();
    expect(api.assignments, 1);
    expect(c.orders.single.courierId, driver);
    await tester.pumpWidget(const SizedBox());
  });
}
