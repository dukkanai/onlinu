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
  testWidgets(
      'Windows native secure storage isolates only disposable test keys',
      (tester) async {
    expect(Platform.isWindows, true,
        reason:
            'This is an actual Windows plugin acceptance smoke, not a method-channel mock.');
    final nonce =
        List.generate(16, (_) => Random.secure().nextInt(16).toRadixString(16))
            .join();
    final origin = 'https://storage-$nonce.invalid';
    final first = OsCoreSessionStore(origin),
        second = OsCoreSessionStore('https://other-$nonce.invalid');
    try {
      // Never enumerate, read or delete an existing credential. These random
      // .invalid origin keys contain synthetic values and grant no access.
      expect(await first.read(), isNull);
      await first.write('synthetic-native-smoke-$nonce');
      await second.write('independent-synthetic-$nonce');
      expect(await OsCoreSessionStore(origin).read(),
          'synthetic-native-smoke-$nonce');
      await first.delete();
      expect(await first.read(), isNull);
      expect(await second.read(), 'independent-synthetic-$nonce');
    } finally {
      await first.delete();
      await second.delete();
    }
    // This checks plugin registration/capability only. It does not open a site
    // or prove interactive OIDC, browser consent, or MFA acceptance.
    expect(await supportsLaunchMode(LaunchMode.externalApplication), true);
  });
  testWidgets('Windows renderer shows Arabic staff orders and clears logout',
      (tester) async {
    final api = FakeCoreGateway();
    final controller =
        CoreController(api, pollInterval: const Duration(hours: 1));
    final boundary = GlobalKey();
    await tester.pumpWidget(
        RepaintBoundary(key: boundary, child: CoreApp(controller: controller)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('الدخول عبر المتصفح'));
    await tester.pumpAndSettle();
    expect(find.text('123.45 ر.س'), findsOneWidget);
    expect(Directionality.of(tester.element(find.text('آخر 100 طلب'))),
        TextDirection.rtl);
    await tester.tap(find.text('تفاصيل الطلب'));
    await tester.pumpAndSettle();
    expect(find.textContaining('بدون ملح'), findsOneWidget);
    final render =
        boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final picture = await render.toImage(pixelRatio: 1);
    final bytes = await picture.toByteData(format: ui.ImageByteFormat.png);
    picture.dispose();
    final path = Platform.environment['ONLINU_SMOKE_SCREENSHOT'];
    if (path != null && bytes != null) {
      await File(path).parent.create(recursive: true);
      await File(path).writeAsBytes(bytes.buffer.asUint8List());
    }
    await tester.tap(find.byTooltip('إغلاق التفاصيل'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('تسجيل الخروج'));
    await tester.pumpAndSettle();
    expect(find.textContaining('بدون ملح'), findsNothing);
    expect(find.text('الدخول عبر المتصفح'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
}
