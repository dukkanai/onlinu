import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:restaurant_admin_prototype/core/app.dart';
import 'package:restaurant_admin_prototype/core/controller.dart';
import 'core_fakes.dart';

void main() {
  testWidgets(
      'real mode is Arabic, has no fixture identities, and switches restaurants',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile = profileFixture(tenants: ['demo-a', 'demo-b']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    await tester.pumpWidget(CoreApp(controller: c));
    await tester.pumpAndSettle();
    expect(find.text('الدخول عبر المتصفح'), findsOneWidget);
    expect(find.textContaining('merchant-a'), findsNothing);
    await tester.tap(find.text('الدخول عبر المتصفح'));
    await tester.pumpAndSettle();
    expect(find.text('اختر المطعم الذي تريد إدارته.'), findsOneWidget);
    await tester.tap(find.byType(DropdownButtonFormField<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('demo-b').last);
    await tester.pumpAndSettle();
    expect(c.selectedTenant, 'demo-b');
    expect(find.text('123.45 ر.س'), findsOneWidget);
    expect(Directionality.of(tester.element(find.text('آخر 100 طلب'))),
        TextDirection.rtl);
    await tester.tap(find.text('تفاصيل الطلب'));
    await tester.pumpAndSettle();
    expect(find.textContaining('بدون ملح'), findsOneWidget);
    await tester.tap(find.text('تسجيل الخروج'));
    await tester.pumpAndSettle();
    expect(find.textContaining('بدون ملح'), findsNothing);
    expect(find.text('الدخول عبر المتصفح'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets(
      'cash collection requires explicit confirmation and supports cancel on narrow layout',
      (tester) async {
    tester.view.physicalSize = const Size(420, 850);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final api = FakeCoreGateway()
      ..currentOrder =
          orderFixture(mode: 'table', method: 'cash_before', payment: 'unpaid');
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    await tester.pumpWidget(CoreApp(controller: c));
    await tester.pumpAndSettle();
    await tester.tap(find.text('الدخول عبر المتصفح'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.ensureVisible(find.text('تسجيل استلام النقد'));
    await tester.tap(find.text('تسجيل استلام النقد'));
    await tester.pumpAndSettle();
    expect(api.writes, 0);
    expect(find.textContaining('هل استلمت فعليًا'), findsOneWidget);
    await tester.tap(find.text('رجوع'));
    await tester.pumpAndSettle();
    expect(api.writes, 0);
    await tester.tap(find.text('تسجيل استلام النقد'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('تأكيد'));
    await tester.pumpAndSettle();
    expect(api.writes, 1);
    expect(c.orders.single.paymentStatus, 'paid');
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
}
