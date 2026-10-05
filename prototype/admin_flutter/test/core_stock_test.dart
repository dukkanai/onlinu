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
  test('stock-only staff can enter inventory without order or menu privileges',
      () async {
    final api = FakeCoreGateway()
      ..currentProfile = profileFixture(permissions: ['stock:read']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    expect(c.section, CoreSection.stock);
    expect(api.reads, 0);
    expect(c.stock.single.name, 'وجبة');
    await c.recount(c.stock.single, tracked: true, available: 30);
    expect(api.stockWrites, 0);
  });
  test('recount is versioned, keeps holds and never replays ambiguous results',
      () async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['stock:read', 'stock:update']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    final old = c.stock.single;
    await c.recount(old, tracked: true, available: 25);
    expect(c.stock.single.available, 25);
    expect(c.stock.single.held, 3);
    expect(c.stock.single.version, 2);
    await c.recount(old, tracked: true, available: 50);
    expect(api.stockWrites, 1);
    expect(c.message, contains('تغير المخزون'));
    api.writeError = const CoreException('offline', uncertain: true);
    await c.recount(c.stock.single, tracked: true, available: 50);
    expect(api.stockWrites, 2);
    expect(c.stock.single.available, 25);
    expect(c.message, contains('لم تتأكد'));
  });
  test('switching sections and logout discard pending inventory results',
      () async {
    final api = FakeCoreGateway()
      ..currentProfile = profileFixture(
          permissions: ['orders:read', 'stock:read', 'stock:update']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    api.stockGate = Completer<List<CoreStockItem>>();
    final old = c.selectSection(CoreSection.stock);
    await Future<void>.delayed(Duration.zero);
    await c.selectSection(CoreSection.orders);
    api.stockGate!.complete([stockFixture()]);
    await old;
    expect(c.stock, isEmpty);
    expect(c.orders, isNotEmpty);
    api.stockGate = null;
    await c.selectSection(CoreSection.stock);
    await c.signOut();
    expect(c.stock, isEmpty);
  });
  test(
      'native stock API never sends holds or caller-selected restaurant identity',
      () async {
    final session = FakeCoreSession()..hasSession = true,
        api = CoreApi(session);
    session.transport.handler = (method, path, body) async => CoreReply(200, {
          'tenantId': 'demo-a',
          'itemId': 'meal',
          'name': 'وجبة',
          'tracked': true,
          'available': 20,
          'held': 3,
          'version': 2
        });
    final result = await api.setStock('demo-a', stockFixture(),
        tracked: true, available: 20);
    expect(result.held, 3);
    expect(session.transport.calls.single['body'],
        {'version': 1, 'tracked': true, 'available': 20});
    await expectLater(
        api.setStock('demo-b', stockFixture(), tracked: true, available: 20),
        throwsA(isA<CoreException>()));
    await expectLater(
        api.setStock('demo-a', stockFixture(), tracked: false, available: 20),
        throwsA(isA<CoreException>()));
    expect(session.transport.calls.length, 1);
  });
  test(
      'untracked is not zero and recount accepts Arabic digits without rounding',
      () {
    final item = stockFixture(version: 0, tracked: false, available: 0);
    expect(item.tracked, false);
    expect(item.version, 0);
    expect(stockQuantity('١٢٣'), 123);
    expect(stockQuantity('۱۲۳'), 123);
    expect(stockQuantity('1000000'), 1000000);
    for (final raw in ['-1', '1.5', '1e3', '1000001', '1,000', '', ' ١ ٢ '])
      expect(stockQuantity(raw), isNull);
  });
  testWidgets(
      'inventory form validates quantity, cancel is inert, and save keeps reservations',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['stock:read', 'stock:update']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    await tester.pumpWidget(CoreApp(controller: c));
    await tester.pumpAndSettle();
    await tester.tap(find.text('الدخول عبر المتصفح'));
    await tester.pumpAndSettle();
    expect(find.text('المتاح للبيع: 12'), findsOneWidget);
    expect(find.text('محجوز للطلبات: 3'), findsOneWidget);
    expect(find.text('آخر 100 طلب'), findsNothing);
    await tester.ensureVisible(find.text('تعديل الجرد'));
    await tester.tap(find.text('تعديل الجرد'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('إلغاء'));
    await tester.pumpAndSettle();
    expect(api.stockWrites, 0);
    await tester.tap(find.text('تعديل الجرد'));
    await tester.pumpAndSettle();
    final field =
        find.widgetWithText(TextField, 'الكمية المتاحة للبيع خارج الحجوزات');
    await tester.enterText(field, '1.5');
    await tester.tap(find.text('تأكيد الجرد'));
    await tester.pumpAndSettle();
    expect(find.text('أدخل عددًا صحيحًا ضمن الحد.'), findsOneWidget);
    expect(api.stockWrites, 0);
    await tester.enterText(field, '٢٥');
    await tester.tap(find.text('تأكيد الجرد'));
    await tester.pumpAndSettle();
    expect(api.stockWrites, 1);
    expect(find.text('المتاح للبيع: 25'), findsOneWidget);
    expect(find.text('محجوز للطلبات: 3'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
}
