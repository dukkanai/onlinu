import 'dart:io';
import 'dart:math';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:restaurant_admin_prototype/core/app.dart';
import 'package:restaurant_admin_prototype/core/controller.dart';
import 'package:restaurant_admin_prototype/core/session_store.dart';
import '../test/core_fakes.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('iOS Keychain isolates and removes only synthetic test values',
      (tester) async {
    expect(Platform.isIOS, true,
        reason: 'Requires an actual iOS Simulator plugin, not a channel mock.');
    final nonce =
        List.generate(20, (_) => Random.secure().nextInt(16).toRadixString(16))
            .join();
    final origin = 'https://ios-storage-$nonce.invalid';
    final first = OsCoreSessionStore(origin);
    final second = OsCoreSessionStore('https://ios-other-$nonce.invalid');
    try {
      expect(await first.read(), isNull);
      await first.write('synthetic-ios-$nonce');
      await second.write('independent-ios-$nonce');
      expect(await OsCoreSessionStore(origin).read(), 'synthetic-ios-$nonce');
      await first.delete();
      expect(await first.read(), isNull);
      expect(await second.read(), 'independent-ios-$nonce');
    } finally {
      await first.delete();
      await second.delete();
    }
    // Capability observation only: no browser or external account is opened.
    expect(await supportsLaunchMode(LaunchMode.externalApplication), true);
  });
  testWidgets(
      'iOS renderer shows Arabic orders and clears details after logout',
      (tester) async {
    expect(Platform.isIOS, true);
    final controller = CoreController(FakeCoreGateway(),
        pollInterval: const Duration(hours: 1));
    final boundary = GlobalKey();
    await tester.pumpWidget(
        RepaintBoundary(key: boundary, child: CoreApp(controller: controller)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('الدخول عبر المتصفح'));
    await tester.pumpAndSettle();
    expect(find.text('123.45 ر.س'), findsOneWidget);
    expect(Directionality.of(tester.element(find.text('آخر 100 طلب'))),
        TextDirection.rtl);
    await tester.ensureVisible(find.text('تفاصيل الطلب'));
    await tester.tap(find.text('تفاصيل الطلب'));
    await tester.pumpAndSettle();
    expect(find.textContaining('بدون ملح'), findsOneWidget);
    final render =
        boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final picture = await render.toImage(pixelRatio: 1);
    final bytes = await picture.toByteData(format: ui.ImageByteFormat.png);
    picture.dispose();
    expect(bytes, isNotNull);
    await File('${Directory.systemTemp.path}/onlinu-ios-orders.png')
        .writeAsBytes(bytes!.buffer.asUint8List());
    await tester.tap(find.byTooltip('إغلاق التفاصيل'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('تسجيل الخروج'));
    await tester.pumpAndSettle();
    expect(find.textContaining('بدون ملح'), findsNothing);
    expect(find.text('الدخول عبر المتصفح'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
}
