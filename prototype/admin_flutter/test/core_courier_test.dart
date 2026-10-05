import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:restaurant_admin_prototype/core/api.dart';
import 'package:restaurant_admin_prototype/core/app.dart';
import 'package:restaurant_admin_prototype/core/controller.dart';
import 'package:restaurant_admin_prototype/core/courier_models.dart';
import 'package:restaurant_admin_prototype/core/models.dart';
import 'package:restaurant_admin_prototype/core/transport.dart';
import 'core_fakes.dart';

const ownedDriver = '12345678123442348234123456789def';
Map<String, dynamic> courierJson() => {
      'id': ownedDriver,
      'name': 'مندوب تجريبي',
      'active': true,
      'availability': 'offline'
    };
Map<String, dynamic> ownOrder(
        {String stage = 'assigned',
        String payment = 'unpaid',
        int version = 1}) =>
    orderJson(
        mode: 'delivery',
        status: 'ready',
        method: 'cash_on_delivery',
        payment: payment,
        courierId: ownedDriver,
        courierName: 'مندوب تجريبي',
        deliveryStatus: stage,
        version: version);
Map<String, dynamic> ownWorkJson(
        {String stage = 'assigned', int binding = 1}) =>
    {
      'tenantId': 'demo-a',
      'courier': courierJson(),
      'bindingVersion': binding,
      'limit': 100,
      'orders': [ownOrder(stage: stage)]
    };
CoreCourierWork ownWork({String stage = 'assigned', int binding = 1}) =>
    CoreCourierWork(ownWorkJson(stage: stage, binding: binding),
        tenantId: 'demo-a');
Map<String, dynamic> linksJson() => {
      'tenantId': 'demo-a',
      'limit': 500,
      'links': [
        {
          ...courierJson(),
          'version': 0,
          'activeOrders': 0,
          'bound': false,
          'principalId': null,
          'principalName': '',
          'eligible': false
        }
      ],
      'candidates': [
        {'principalId': principalId, 'displayName': 'هوية تجريبية'}
      ]
    };
void main() {
  testWidgets('revoked linking permission masks visible identity choices',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile = profileFixture(permissions: ['couriers:link'])
      ..linksValue = CoreCourierLinks(linksJson(), tenantId: 'demo-a');
    api.session.restoreAvailable = true;
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    await tester.pumpWidget(CoreApp(controller: c));
    await tester.pumpAndSettle();
    final edit = find.text('مراجعة الربط');
    await tester.ensureVisible(edit);
    await tester.tap(edit);
    await tester.pumpAndSettle();

    expect(find.textContaining('هوية تجريبية'), findsWidgets);
    api.currentProfile = profileFixture(permissions: []);
    await c.refresh();
    await tester.pumpAndSettle();
    expect(find.textContaining('هوية تجريبية'), findsNothing);
    expect(find.text('تغير المطعم أو صلاحياتك. أغلق نموذج الربط.'),
        findsOneWidget);
    expect(api.courierWrites, isEmpty);
  });
  testWidgets(
      'suspended tenant can review unlink without choosing a new identity',
      (tester) async {
    final raw = linksJson();
    raw['candidates'] = <Map<String, dynamic>>[];
    raw['links'] = [
      {
        ...object((raw['links'] as List).single),
        'version': 1,
        'bound': true,
        'principalId': principalId,
        'principalName': 'هوية تجريبية',
        'eligible': false
      }
    ];
    final api = FakeCoreGateway()
      ..currentProfile = CoreProfile({
        'id': principalId,
        'memberships': [
          memberJson('demo-a',
              permissions: ['couriers:link'], status: 'suspended')
        ]
      })
      ..linksValue = CoreCourierLinks(raw, tenantId: 'demo-a');
    api.session.restoreAvailable = true;
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    await tester.pumpWidget(CoreApp(controller: c));
    await tester.pumpAndSettle();
    final edit = find.text('مراجعة الربط');
    await tester.ensureVisible(edit);
    await tester.tap(edit);
    await tester.pumpAndSettle();

    await tester.tap(find.text('فك الربط الحالي').last);
    await tester.pumpAndSettle();
    final review = find.byType(CheckboxListTile);
    await tester.ensureVisible(review);
    await tester.pumpAndSettle();
    await tester.tap(review);
    await tester.pumpAndSettle();
    await tester.tap(find.text('تأكيد تغيير الربط'));
    await tester.pumpAndSettle();
    expect(api.courierWrites, ['link:']);
  });

  test('suspended restaurant retains explicit binding revocation access', () {
    final member = CoreMembership(memberJson('demo-a',
        permissions: ['couriers:link'], status: 'suspended'));
    expect(member.can('couriers:link'), true);
    expect(member.can('settings:update'), false);
  });
  test(
      'courier list rejects other drivers, completed tasks and inconsistent binding',
      () {
    expect(ownWork().orders.length, 1);
    for (final json in [
      {...ownWorkJson(), 'courier': null},
      {...ownWorkJson(), 'bindingVersion': 0},
      {
        ...ownWorkJson(),
        'orders': [
          {...ownOrder(), 'courierId': 'b' * 32}
        ]
      },
      {
        ...ownWorkJson(),
        'orders': [
          {...ownOrder(), 'status': 'completed'}
        ]
      }
    ])
      expect(() => CoreCourierWork(json, tenantId: 'demo-a'),
          throwsA(isA<CoreException>()));
    expect(courierCanCollect(ownWork(stage: 'at_door').orders.single), true);
    expect(courierCanCollect(ownWork(stage: 'nearby').orders.single), false);
  });
  test('courier status and cash requests pin order and binding versions',
      () async {
    final session = FakeCoreSession()..hasSession = true,
        api = CoreApi(session),
        work = ownWork();
    session.transport.handler = (_, __, ___) async => CoreReply(200,
        {'tenantId': 'demo-a', ...ownOrder(stage: 'picked_up', version: 2)});
    await api.courierChange(work, work.orders.single);
    expect(session.transport.calls.single['body'],
        {'version': 1, 'bindingVersion': 1, 'status': 'picked_up'});
    await expectLater(api.courierChange(work, work.orders.single, cash: true),
        throwsA(isA<CoreException>()));
    expect(session.transport.calls.length, 1);
    final cash = ownWork(stage: 'at_door');
    session.transport.handler = (_, __, ___) async => CoreReply(200, {
          'tenantId': 'demo-a',
          ...ownOrder(stage: 'at_door', version: 2, payment: 'paid')
        });
    await api.courierChange(cash, cash.orders.single, cash: true);
    expect(session.transport.calls.last['body'],
        {'version': 1, 'bindingVersion': 1});
    session.transport.handler = (_, __, ___) async => CoreReply(200, {
          'tenantId': 'demo-a',
          ...ownOrder(stage: 'at_door', version: 2, payment: 'paid'),
          'totalMinor': 1
        });
    await expectLater(
        api.courierChange(cash, cash.orders.single, cash: true),
        throwsA(isA<CoreException>()
            .having((e) => e.uncertain, 'uncertain', true)));
  });
  test(
      'binding API requires explicit eligible identity and supports only reviewed empty unlink',
      () async {
    final session = FakeCoreSession()..hasSession = true,
        api = CoreApi(session),
        links = CoreCourierLinks(linksJson(), tenantId: 'demo-a');
    session.transport.handler = (_, __, ___) async => CoreReply(200, {
          'tenantId': 'demo-a',
          'link': {
            ...object((linksJson()['links'] as List).single),
            'version': 1,
            'bound': true,
            'principalId': principalId,
            'principalName': 'هوية تجريبية',
            'eligible': true
          }
        });
    await api.setCourierLink(links, links.links.single, principalId);
    expect(session.transport.calls.single['body'],
        {'expectedVersion': 0, 'principalId': principalId});
    await expectLater(
        api.setCourierLink(
            links, links.links.single, '00000000-0000-4000-8000-000000000000'),
        throwsA(isA<CoreException>()));
    await expectLater(api.setCourierLink(links, links.links.single, ''),
        throwsA(isA<CoreException>()));
    expect(session.transport.calls.length, 1);
  });
  test(
      'courier controller selects owned section and fences stale binding, permissions and offline writes',
      () async {
    final api = FakeCoreGateway()
      ..currentProfile = profileFixture(
          permissions: ['courier:read', 'courier:update', 'courier:collect'])
      ..workValue = ownWork();
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    expect(c.section, CoreSection.courier);
    expect(c.orders, isEmpty);
    final old = c.courierWork!;
    await c.changeCourier(old, old.orders.single);
    expect(api.courierWrites, ['status']);
    api.workValue = ownWork(binding: 2);
    await c.refresh();
    await c.changeCourier(old, old.orders.single);
    expect(api.courierWrites.length, 1);
    final current = c.courierWork!;
    c.setSuspended(true);
    await c.setCourierAvailability(current, 'available');
    expect(api.courierWrites.length, 1);
    c.setSuspended(false);
    api.currentProfile = profileFixture(permissions: ['courier:read']);
    await c.refresh();
    await c.changeCourier(current, current.orders.single);
    expect(api.courierWrites.length, 1);
  });
  testWidgets(
      'courier workflow requires review and does not expose all restaurant orders',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile = profileFixture(
          permissions: ['courier:read', 'courier:update', 'courier:collect'])
      ..workValue = ownWork(stage: 'at_door');
    api.session.restoreAvailable = true;
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    await tester.pumpWidget(CoreApp(controller: c));
    await tester.pumpAndSettle();
    expect(find.text('آخر 100 طلب'), findsNothing);
    final button = find.text('استلمت نقد هذا الطلب');
    await tester.ensureVisible(button);
    await tester.tap(button);
    await tester.pumpAndSettle();
    expect(api.courierWrites, isEmpty);
    expect(find.textContaining('هل استلمت فعليًا'), findsOneWidget);
    await tester.tap(find.text('رجوع'));
    await tester.pumpAndSettle();
    expect(api.courierWrites, isEmpty);
    await tester.ensureVisible(button);
    await tester.tap(button);
    await tester.pumpAndSettle();
    await tester.tap(find.text('تأكيد'));
    await tester.pumpAndSettle();
    expect(api.courierWrites, ['cash']);
  });
  testWidgets('binding UI requires an explicit target and review checkbox',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile = profileFixture(permissions: ['couriers:link'])
      ..linksValue = CoreCourierLinks(linksJson(), tenantId: 'demo-a');
    api.session.restoreAvailable = true;
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    await tester.pumpWidget(CoreApp(controller: c));
    await tester.pumpAndSettle();
    final edit = find.text('مراجعة الربط');
    await tester.ensureVisible(edit);
    await tester.tap(edit);
    await tester.pumpAndSettle();
    expect(
        tester
            .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'تأكيد تغيير الربط'))
            .onPressed,
        isNull);

    await tester.tap(find.textContaining('هوية تجريبية').last);
    await tester.pumpAndSettle();
    expect(
        tester
            .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'تأكيد تغيير الربط'))
            .onPressed,
        isNull);
    final review = find.byType(CheckboxListTile);
    await tester.ensureVisible(review);
    await tester.tap(review);
    await tester.pumpAndSettle();
    await tester.tap(find.text('تأكيد تغيير الربط'));
    await tester.pumpAndSettle();
    expect(api.courierWrites, ['link:$principalId']);
  });
}
