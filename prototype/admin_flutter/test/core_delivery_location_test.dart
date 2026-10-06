import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:restaurant_admin_prototype/core/api.dart';
import 'package:restaurant_admin_prototype/core/controller.dart';
import 'package:restaurant_admin_prototype/core/delivery_models.dart';
import 'package:restaurant_admin_prototype/core/delivery_pane.dart';
import 'package:restaurant_admin_prototype/core/transport.dart';

import 'core_fakes.dart';

Map<String, dynamic> locationData() => {
      ...FakeCoreGateway().deliveryData,
      'latitude': null,
      'longitude': null,
    };

void main() {
  test(
      'location response capability preserves old core reads and rejects inconsistent origins',
      () {
    expect(
      CoreDelivery(
        FakeCoreGateway().deliveryData,
        tenantId: 'demo-a',
      ).locationKnown,
      false,
    );
    final base = locationData();
    expect(CoreDelivery(base, tenantId: 'demo-a').locationKnown, true);
    for (final diff in [
      {'latitude': 0},
      {'latitude': null, 'longitude': 0},
      {'radiusKm': 1},
      {'latitude': 91, 'longitude': 0},
      {'latitude': 0, 'longitude': 181},
      {'latitude': double.nan, 'longitude': 0},
      {'latitude': '0', 'longitude': 0},
    ]) {
      expect(
        () => CoreDelivery({...base, ...diff}, tenantId: 'demo-a'),
        throwsA(isA<CoreException>()),
      );
    }
    final partial = {...base}..remove('longitude');
    expect(
      () => CoreDelivery(partial, tenantId: 'demo-a'),
      throwsA(isA<CoreException>()),
    );
    final origin = CoreDelivery({
      ...base,
      'latitude': 0,
      'longitude': 0,
      'radiusKm': 1,
    }, tenantId: 'demo-a');
    expect(origin.latitude, 0);
    expect(origin.longitude, 0);
  });
  test(
    'location changes reject invalid clear, bounds and localized empty numbers',
    () {
      for (final change in [
        const DeliveryLocationChange(
          latitude: null,
          longitude: 0,
          radius: 0,
          requireLocation: false,
        ),
        const DeliveryLocationChange(
          latitude: null,
          longitude: null,
          radius: 1,
          requireLocation: false,
        ),
        const DeliveryLocationChange(
          latitude: 91,
          longitude: 0,
          radius: 0,
          requireLocation: false,
        ),
        const DeliveryLocationChange(
          latitude: 0,
          longitude: 181,
          radius: 0,
          requireLocation: false,
        ),
        const DeliveryLocationChange(
          latitude: 0,
          longitude: 0,
          radius: 501,
          requireLocation: false,
        ),
        DeliveryLocationChange(
          latitude: 0,
          longitude: 0,
          radius: double.nan,
          requireLocation: false,
        ),
      ]) {
        expect(() => change.toJson(1), throwsA(isA<CoreException>()));
      }
      expect(deliveryDecimal('٠', -90, 90), 0);
      expect(deliveryDecimal('۱۲٫۵', -90, 90), 12.5);
      expect(deliveryDecimal('1e-7', -90, 90), 1e-7);
      for (final value in ['', ' ', 'Infinity', 'NaN', '0x10', '1,2,3', '91']) {
        expect(deliveryDecimal(value, -90, 90), isNull);
      }
    },
  );
  test(
      'native location write binds full intent, validates acknowledgement and never retries',
      () async {
    final session = FakeCoreSession()..hasSession = true,
        api = CoreApi(session);
    final expected = CoreDelivery(locationData(), tenantId: 'demo-a');
    const change = DeliveryLocationChange(
      latitude: 0,
      longitude: 0,
      radius: 1,
      requireLocation: true,
    );
    var result = <String, dynamic>{
      'tenantId': 'demo-a',
      ...locationData(),
      'version': expected.version + 1,
      'latitude': 0,
      'longitude': 0,
      'radiusKm': 1,
      'requireLocation': true,
    };
    session.transport.handler = (method, path, body) async {
      expect(method, 'POST');
      expect(path, '/native/api/restaurants/demo-a/staff/delivery/location');
      expect(body, change.toJson(expected.version));
      return CoreReply(200, result);
    };
    await api.setDeliveryLocation(expected, change);
    expect(session.transport.calls.length, 1);
    for (final diff in [
      {'latitude': 2},
      {'longitude': null},
      {'radiusKm': 2},
      {'requireLocation': false},
      {'version': expected.version},
      {'tenantId': 'demo-b'},
    ]) {
      final saved = {...result};
      result = {...result, ...diff};
      final count = session.transport.calls.length;
      await expectLater(
        api.setDeliveryLocation(expected, change),
        throwsA(
          isA<CoreException>().having((e) => e.uncertain, 'uncertain', true),
        ),
      );
      expect(session.transport.calls.length, count + 1);
      result = saved;
    }
    final older = CoreDelivery(
          FakeCoreGateway().deliveryData,
          tenantId: 'demo-a',
        ),
        count = session.transport.calls.length;
    await expectLater(
      api.setDeliveryLocation(older, change),
      throwsA(isA<CoreException>()),
    );
    expect(session.transport.calls.length, count);
  });
  testWidgets(
    'location editor reviews before saving and respects cancellation and revoked writes',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(1000, 1000));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final api = FakeCoreGateway()
        ..currentProfile = profileFixture(
          permissions: ['settings:read', 'settings:update'],
        )
        ..deliveryData = locationData();
      final c = CoreController(api, pollInterval: const Duration(hours: 1));
      await c.start(restore: false);
      await c.selectSection(CoreSection.coverage);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ListenableBuilder(
              listenable: c,
              builder: (context, _) => Directionality(
                textDirection: TextDirection.rtl,
                child: DeliveryPane(controller: c),
              ),
            ),
          ),
        ),
      );
      Future<void> open() async {
        await tester.tap(find.text('تعديل موقع ونطاق التوصيل'));
        await tester.pumpAndSettle();
      }

      Future<void> fill(String label, String value) async {
        final f = find.widgetWithText(TextField, label);
        await tester.ensureVisible(f);
        await tester.enterText(f, value);
      }

      await open();
      await fill('خط عرض المطعم', '٠');
      await fill('خط طول المطعم', '٠');
      await fill('نطاق التوصيل بالكيلومتر', '١٫٥');
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pumpAndSettle();
      await tester.tap(find.text('مراجعة الموقع والنطاق'));
      await tester.pumpAndSettle();
      expect(api.deliveryWrites, 0);
      expect(find.text('موقع العميل: مطلوب'), findsOneWidget);
      await tester.tap(find.text('إلغاء'));
      await tester.pumpAndSettle();
      expect(api.deliveryWrites, 0);
      await open();
      await fill('خط عرض المطعم', '0');
      await fill('خط طول المطعم', '0');
      await fill('نطاق التوصيل بالكيلومتر', '1.5');
      await tester.tap(find.text('مراجعة الموقع والنطاق'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('تأكيد حفظ الموقع والنطاق'));
      await tester.pumpAndSettle();
      expect(api.deliveryWrites, 1);
      expect(c.coverage!.radius, 1.5);
      expect(c.coverage!.latitude, 0);
      await open();
      await tester.tap(find.text('مراجعة الموقع والنطاق'));
      await tester.pumpAndSettle();
      api.currentProfile = profileFixture(permissions: ['settings:read']);
      await c.refresh();
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'تأكيد حفظ الموقع والنطاق'),
            )
            .onPressed,
        isNull,
      );
      expect(api.deliveryWrites, 1);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    },
  );
}
