import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:restaurant_admin_prototype/core/api.dart';
import 'package:restaurant_admin_prototype/core/app.dart';
import 'package:restaurant_admin_prototype/core/controller.dart';
import 'package:restaurant_admin_prototype/core/service_policy.dart';
import 'package:restaurant_admin_prototype/core/transport.dart';
import 'core_fakes.dart';

void main() {
  test(
      'service policy distinguishes omitted false values and prevents open without any mode',
      () {
    final fake = FakeCoreGateway(),
        policy = CoreServicePolicy(fake.serviceData, tenantId: 'demo-a');
    policy.validate({'acceptingOrders': false});
    expect(
        () =>
            policy.validate({'deliveryEnabled': false, 'pickupEnabled': false}),
        throwsA(isA<CoreException>()
            .having((e) => e.code, 'mode', 'invalid_service_modes')));
    expect(() => policy.validate({}), throwsA(isA<CoreException>()));
    expect(
        () => CoreServicePolicy({...fake.serviceData, 'pickupEnabled': 'false'},
            tenantId: 'demo-a'),
        throwsA(isA<CoreException>()));
    policy.validate({
      'acceptingOrders': false,
      'deliveryEnabled': false,
      'pickupEnabled': false
    });
  });
  test('service API sends only reviewed fields and verifies unchanged switches',
      () async {
    final session = FakeCoreSession()..hasSession = true,
        api = CoreApi(session),
        fake = FakeCoreGateway(),
        old = await fake.service('demo-a');
    session.transport.handler = (_, __, ___) async => CoreReply(200, {
          'tenantId': 'demo-a',
          ...fake.serviceData,
          'version': 2,
          'acceptingOrders': false
        });
    await api.patchService(old, {'acceptingOrders': false});
    expect(session.transport.calls.single['body'],
        {'expectedVersion': 1, 'acceptingOrders': false});
    session.transport.handler = (_, __, ___) async => CoreReply(200, {
          'tenantId': 'demo-a',
          ...fake.serviceData,
          'version': 2,
          'acceptingOrders': false,
          'deliveryEnabled': false
        });
    await expectLater(
        api.patchService(old, {'acceptingOrders': false}),
        throwsA(isA<CoreException>()
            .having((e) => e.uncertain, 'uncertain', true)));
  });
  test('service controller blocks stale, offline and revoked settings changes',
      () async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['settings:read', 'settings:update']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    await c.selectSection(CoreSection.service);
    final old = c.service!;
    await c.patchService(old, {'acceptingOrders': false});
    expect(api.serviceWrites, 1);
    expect(c.service!.flags['acceptingOrders'], false);
    await c.patchService(old, {'acceptingOrders': true});
    expect(api.serviceWrites, 1);
    c.setSuspended(true);
    await c.patchService(c.service!, {'acceptingOrders': true});
    expect(api.serviceWrites, 1);
  });
  testWidgets(
      'service switch requires explicit review and cancel does not write',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['settings:read', 'settings:update']);
    api.session.restoreAvailable = true;
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    await tester.pumpWidget(CoreApp(controller: c));
    await tester.pumpAndSettle();
    final tab = find.widgetWithText(ChoiceChip, 'استقبال الطلبات');
    await tester.ensureVisible(tab);
    await tester.tap(tab);
    await tester.pumpAndSettle();
    final edit = find.text('مراجعة طرق الخدمة');
    await tester.ensureVisible(edit);
    await tester.tap(edit);
    await tester.pumpAndSettle();
    await tester
        .tap(find.widgetWithText(SwitchListTile, 'استقبال الطلبات الجديدة'));
    await tester.pumpAndSettle();
    expect(
        tester
            .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'حفظ سياسة الاستقبال'))
            .onPressed,
        isNull);
    await tester.tap(find.text('إلغاء'));
    await tester.pumpAndSettle();
    expect(api.serviceWrites, 0);
    await tester.ensureVisible(edit);
    await tester.tap(edit);
    await tester.pumpAndSettle();
    await tester
        .tap(find.widgetWithText(SwitchListTile, 'استقبال الطلبات الجديدة'));
    await tester.pumpAndSettle();
    final review = find.byType(CheckboxListTile);
    await tester.ensureVisible(review);
    await tester.pumpAndSettle();
    await tester.tap(review);
    await tester.pumpAndSettle();
    await tester.tap(find.text('حفظ سياسة الاستقبال'));
    await tester.pumpAndSettle();
    expect(api.serviceWrites, 1);
    expect(c.service!.flags['acceptingOrders'], false);
  });
}
