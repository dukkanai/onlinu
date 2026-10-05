import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:restaurant_admin_prototype/core/api.dart';
import 'package:restaurant_admin_prototype/core/controller.dart';
import 'package:restaurant_admin_prototype/core/delivery_models.dart';
import 'package:restaurant_admin_prototype/core/delivery_pane.dart';
import 'package:restaurant_admin_prototype/core/transport.dart';
import 'core_fakes.dart';

void main() {
  test('zone fees distinguish explicit zero, missing and invalid values', () {
    final base = {
      'districtId': 'd1',
      'enabled': false,
      'feeMinor': null,
      'active': true
    };
    expect(CoreDeliveryZone(base).fee, isNull);
    expect(CoreDeliveryZone({...base, 'enabled': true, 'feeMinor': 0}).fee, 0);
    expect(() => CoreDeliveryZone({...base, 'enabled': true}),
        throwsA(isA<CoreException>()));
    expect(() => CoreDeliveryZone({...base, 'feeMinor': -1}),
        throwsA(isA<CoreException>()));
  });
  test(
      'native delivery writes only pricing or one zone and checks acknowledgement',
      () async {
    final session = FakeCoreSession()..hasSession = true,
        api = CoreApi(session),
        fake = FakeCoreGateway(),
        expected = await fake.delivery('demo-a');
    session.transport.handler = (_, __, body) async => CoreReply(200, {
          'tenantId': 'demo-a',
          ...fake.deliveryData,
          'version': 2,
          'mode': body!['mode'] ?? 'flat',
          'feeMinor': body['feeMinor'] ?? 500,
          'minimumMinor': body['minimumMinor'] ?? 0,
          'zones': body['zone'] == null
              ? []
              : [
                  {
                    ...Map<String, dynamic>.from(body['zone'] as Map),
                    'nameAr': 'حي',
                    'nameEn': 'District',
                    'cityName': 'مدينة',
                    'regionName': 'منطقة',
                    'active': true
                  }
                ]
        });
    await api.setDeliveryZone(expected, district: 'd1', enabled: true, fee: 0);
    expect(session.transport.calls.single['body'], {
      'expectedVersion': 1,
      'zone': {'districtId': 'd1', 'enabled': true, 'feeMinor': 0}
    });
    await expectLater(
        api.setDeliveryZone(expected, district: 'd1', enabled: true, fee: null),
        throwsA(isA<CoreException>()));
    expect(session.transport.calls.length, 1);
    await api.setDeliveryPricing(expected,
        mode: 'district', fee: 500, minimum: 1000);
    expect(session.transport.calls.last['body'], {
      'expectedVersion': 1,
      'mode': 'district',
      'feeMinor': 500,
      'minimumMinor': 1000
    });
  });
  test('delivery controller rejects stale and revoked writes', () async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['settings:read', 'settings:update']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    await c.selectSection(CoreSection.coverage);
    final old = c.coverage!;
    await c.deliveryZone(old, district: 'd1', enabled: true, fee: 0);
    expect(api.deliveryWrites, 1);
    await c.deliveryPricing(old, mode: 'district', fee: 0, minimum: 0);
    expect(api.deliveryWrites, 1);
    api.currentProfile = profileFixture(permissions: ['settings:read']);
    await c.refresh();
    await c.deliveryPricing(c.coverage!, mode: 'flat', fee: 0, minimum: 0);
    expect(api.deliveryWrites, 1);
  });
  testWidgets(
      'geographic hierarchy and explicit review precede free zone creation',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['settings:read', 'settings:update']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    await c.start(restore: false);
    await c.selectSection(CoreSection.coverage);
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: Directionality(
                textDirection: TextDirection.rtl,
                child: DeliveryPane(controller: c)))));
    await tester.tap(find.text('إعداد حي جديد'));
    await tester.pumpAndSettle();
    Future<void> select(String label, String value) async {
      final field = find.widgetWithText(DropdownButtonFormField<String>, label);
      await tester.ensureVisible(field);
      await tester.pumpAndSettle();
      await tester.tap(field);
      await tester.pumpAndSettle();
      await tester.tap(find.text(value).last);
      await tester.pumpAndSettle();
    }

    await select('المنطقة', 'منطقة تجريبية');
    await select('المدينة', 'مدينة تجريبية');
    await select('الحي', 'حي تجريبي');
    final fee = find.widgetWithText(TextField, 'رسم الحي بالريال');
    await tester.ensureVisible(fee);
    await tester.pumpAndSettle();
    await tester.enterText(fee, '٠');
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pumpAndSettle();
    final enabled = find.widgetWithText(SwitchListTile, 'الحي مفعّل للتوصيل');
    await tester.ensureVisible(enabled);
    await tester.pumpAndSettle();
    await tester.tap(enabled);
    await tester.pumpAndSettle();
    await tester.tap(find.text('مراجعة التوصيل'));
    await tester.pumpAndSettle();
    expect(api.deliveryWrites, 0);
    expect(find.textContaining('توصيل مجاني'), findsOneWidget);
    await tester.tap(find.text('تأكيد حفظ التوصيل'));
    await tester.pumpAndSettle();
    expect(api.deliveryWrites, 1);
    expect(c.coverage!.zones.single.fee, 0);
    await tester.pumpWidget(const SizedBox());
    c.dispose();
  });
  testWidgets(
      'a retired enabled district can be disabled but cannot be re-enabled',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['settings:read', 'settings:update']);
    api.deliveryData['zones'] = [
      {'districtId': 'd1', 'enabled': true, 'feeMinor': 0, 'active': false}
    ];
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    await c.start(restore: false);
    await c.selectSection(CoreSection.coverage);
    await tester.pumpWidget(MaterialApp(
        home: DeliveryEditor(
            controller: c,
            expected: c.coverage!,
            zone: c.coverage!.zones.single)));
    await tester.pumpAndSettle();
    final toggle = find.widgetWithText(SwitchListTile, 'الحي مفعّل للتوصيل');
    expect(tester.widget<SwitchListTile>(toggle).onChanged, isNotNull);
    await tester.tap(toggle);
    await tester.pumpAndSettle();
    expect(tester.widget<SwitchListTile>(toggle).value, false);
    expect(tester.widget<SwitchListTile>(toggle).onChanged, isNull);
    await tester.pumpWidget(const SizedBox());
    c.dispose();
  });
}
