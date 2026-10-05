import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:restaurant_admin_prototype/core/api.dart';
import 'package:restaurant_admin_prototype/core/app.dart';
import 'package:restaurant_admin_prototype/core/controller.dart';
import 'package:restaurant_admin_prototype/core/models.dart';
import 'package:restaurant_admin_prototype/core/transport.dart';
import 'core_fakes.dart';

void main() {
  test(
      'price parsing is exact minor units for Arabic, Persian and ASCII decimals',
      () {
    expect(priceMinor('12.30'), 1230);
    expect(priceMinor('١٢٫٣٠'), 1230);
    expect(priceMinor('۱۲.۳'), 1230);
    expect(priceMinor('0.01'), 1);
    expect(priceMinor('1000000'), 100000000);
    expect(priceInput(1230), '12.30');
    for (final value in [
      '-1',
      '1.999',
      '1e3',
      '1,000',
      '١٢٬٣٠',
      '1000000.01',
      '1.',
      'NaN',
      ''
    ]) expect(priceMinor(value), isNull, reason: value);
  });
  test(
      'menu-only read authority does not grant updates or reveal other sections',
      () async {
    final api = FakeCoreGateway()
      ..currentProfile = profileFixture(permissions: ['menu:read']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    expect(c.section, CoreSection.menu);
    expect(api.reads, 0);
    expect(api.stockReads, 0);
    await c.patchMenu(c.menu!, c.menu!.items.single,
        name: 'جديد', categoryId: 'main', price: 100, available: true);
    expect(api.menuWrites, 0);
  });
  test(
      'menu edits preserve catalog version, reject stale forms and clear late tenant data',
      () async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['menu:read', 'menu:update']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    final old = c.menu!;
    await c.patchMenu(old, old.items.single,
        name: 'وجبة جديدة', categoryId: 'side', price: 1230, available: false);
    expect(c.menu!.version, 2);
    expect(c.menu!.items.single.priceMinor, 1230);
    expect(api.menuWrites, 1);
    await c.patchMenu(old, old.items.single,
        name: 'قديم', categoryId: 'main', price: 100, available: true);
    expect(api.menuWrites, 1);
    expect(c.message, contains('تغيرت قائمة'));
    api.menuGate = Completer<CoreMenu>();
    final pending = c.refresh();
    await Future<void>.delayed(Duration.zero);
    await c.signOut();
    api.menuGate!.complete(menuFixture());
    await pending;
    expect(c.menu, isNull);
  });
  test(
      'narrow native menu patch does not replace options, images, stock or settings',
      () async {
    final session = FakeCoreSession()..hasSession = true,
        api = CoreApi(session),
        menu = menuFixture();
    session.transport.handler = (_, __, ___) async => CoreReply(200, {
          'tenantId': 'demo-a',
          'version': 2,
          'currency': 'SAR',
          'item': menuJson(name: 'جديد', price: 1230, available: false)['items']
              [0]
        });
    await api.patchMenu(menu, menu.items.single,
        name: 'جديد', categoryId: 'main', price: 1230, available: false);
    expect(session.transport.calls.single['body'], {
      'expectedVersion': 1,
      'name': 'جديد',
      'categoryId': 'main',
      'priceMinor': 1230,
      'available': false
    });
    await expectLater(
        api.patchMenu(menu, menu.items.single,
            name: 'جديد', categoryId: 'missing', price: 1230, available: false),
        throwsA(isA<CoreException>()));
    expect(session.transport.calls.length, 1);
  });
  test('successful-looking wrong mutation values remain uncertain', () async {
    final session = FakeCoreSession()..hasSession = true,
        api = CoreApi(session);
    session.transport.handler = (_, __, ___) async => CoreReply(200, {
          'tenantId': 'demo-a',
          'version': 2,
          'currency': 'SAR',
          'item': menuJson()['items'][0]
        });
    final menu = menuFixture();
    await expectLater(
        api.patchMenu(menu, menu.items.single,
            name: 'changed', categoryId: 'main', price: 999, available: false),
        throwsA(isA<CoreException>()
            .having((v) => v.uncertain, 'uncertain', true)));
    session.transport.handler = (_, __, ___) async => CoreReply(200,
        {'tenantId': 'demo-a', ...orderJson(version: 2, status: 'accepted')});
    await expectLater(
        api.change('demo-a', orderFixture(), status: 'preparing'),
        throwsA(isA<CoreException>()
            .having((v) => v.uncertain, 'uncertain', true)));
  });
  testWidgets(
      'menu editor validates price and cancel is inert; saves Arabic minor units',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['menu:read', 'menu:update']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    await tester.pumpWidget(CoreApp(controller: c));
    await tester.pumpAndSettle();
    await tester.tap(find.text('الدخول عبر المتصفح'));
    await tester.pumpAndSettle();
    expect(find.text('12.50 ر.س'), findsOneWidget);
    await tester.ensureVisible(find.text('تعديل الصنف'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('تعديل الصنف'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('إلغاء'));
    await tester.pumpAndSettle();
    expect(api.menuWrites, 0);
    await tester.tap(find.text('تعديل الصنف'));
    await tester.pumpAndSettle();
    final price = find.widgetWithText(TextField, 'السعر بالريال السعودي');
    await tester.enterText(price, '1.999');
    await tester.tap(find.text('حفظ التعديلات'));
    await tester.pumpAndSettle();
    expect(find.text('أدخل اسمًا وسعرًا صحيحين.'), findsOneWidget);
    expect(api.menuWrites, 0);
    await tester.enterText(price, '١٢٫٣٠');
    await tester.enterText(
        find.widgetWithText(TextField, 'اسم الصنف'), 'وجبة جديدة');
    await tester.tap(find.text('حفظ التعديلات'));
    await tester.pumpAndSettle();
    expect(api.menuWrites, 1);
    expect(find.text('12.30 ر.س'), findsOneWidget);
    expect(find.text('وجبة جديدة'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
}
