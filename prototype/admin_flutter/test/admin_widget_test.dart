import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:restaurant_admin_prototype/admin_controller.dart';
import 'package:restaurant_admin_prototype/api.dart';
import 'package:restaurant_admin_prototype/main.dart';

import 'fakes.dart';

void main() {
  testWidgets(
      'Arabic RTL synthetic identity, money label and offline write gate',
      (tester) async {
    tester.view.physicalSize = const Size(1280, 1100);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final api = FakeAdminApi();
    final controller =
        AdminController(api, pollInterval: const Duration(hours: 1));
    await tester.pumpWidget(AdminApp(controller: controller));
    await tester.pumpAndSettle();
    expect(find.textContaining('لا عملاء أو أموال حقيقية'), findsOneWidget);
    expect(Directionality.of(tester.element(find.byType(AdminScreen))),
        TextDirection.rtl);
    await tester.tap(find.byKey(const Key('merchant-a')));
    await tester.pumpAndSettle();
    expect(find.text('مطعم أ التجريبي'), findsOneWidget);
    expect(find.text('42.00 ر.س'), findsOneWidget);
    expect(find.textContaining('لا تحصيل حقيقي'), findsOneWidget);
    api.readFailure = const AdminApiException('offline');
    await tester.tap(find.byKey(const Key('refresh-orders')));
    await tester.pumpAndSettle();
    final disabled =
        tester.widget<FilledButton>(find.byKey(const Key('advance-order-1')));
    expect(disabled.onPressed, isNull);
    expect(find.byKey(const Key('connection-error')), findsOneWidget);
    await tester.tap(find.byKey(const Key('sign-out')));
    await tester.pumpAndSettle();
    expect(find.text('42.00 ر.س'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    expect(api.closed, isTrue);
  });

  testWidgets('narrow layout keeps identity selector visible without overflow',
      (tester) async {
    tester.view.physicalSize = const Size(420, 860);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final controller = AdminController(FakeAdminApi());
    await tester.pumpWidget(AdminApp(controller: controller));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.byKey(const Key('merchant-b')), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
}
