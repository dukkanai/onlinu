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
      // Never enumerate or target pre-existing app/user credentials. These random
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
    await capture(boundary, 'windows-orders.png');
    await tester.tap(find.byTooltip('إغلاق التفاصيل'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('تسجيل الخروج'));
    await tester.pumpAndSettle();
    expect(find.textContaining('بدون ملح'), findsNothing);
    expect(find.text('الدخول عبر المتصفح'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets(
      'Windows menu, inventory and channel forms use isolated original-core contracts',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile = profileFixture(permissions: [
        'orders:read',
        'menu:read',
        'menu:update',
        'stock:read',
        'stock:update',
        'channels:manage'
      ]);
    final controller =
            CoreController(api, pollInterval: const Duration(hours: 1)),
        boundary = GlobalKey();
    await tester.pumpWidget(
        RepaintBoundary(key: boundary, child: CoreApp(controller: controller)));
    await tester.pumpAndSettle();
    Future<void> tap(Finder target) async {
      await tester.ensureVisible(target);
      await tester.pumpAndSettle();
      await tester.tap(target);
      await tester.pumpAndSettle();
    }

    await tap(find.text('الدخول عبر المتصفح'));
    await tap(find.widgetWithText(ChoiceChip, 'الأصناف'));
    await tap(find.text('تعديل الصنف'));
    await tester.enterText(
        find.widgetWithText(TextField, 'اسم الصنف'), 'وجبة الاختبار');
    await tester.enterText(
        find.widgetWithText(TextField, 'السعر بالريال السعودي'), '١٢٫٣٠');
    await tap(find.text('حفظ التعديلات'));
    expect(api.menuWrites, 1);
    expect(controller.menu!.items.single.priceMinor, 1230);
    await tap(find.text('إضافة تصنيف'));
    await tester.enterText(find.widgetWithText(TextField, 'اسم التصنيف الجديد'),
        'مشروبات الاختبار');
    await tap(find.text('إنشاء'));
    await tap(find.text('إضافة صنف'));
    await tester.enterText(
        find.widgetWithText(TextField, 'اسم الصنف الجديد'), 'عصير الاختبار');
    await tester.enterText(
        find.widgetWithText(TextField, 'السعر بالريال السعودي'), '٧٫٢٥');
    await capture(boundary, 'windows-create-item.png');
    await tap(find.text('إنشاء'));
    expect(api.menuWrites, 3);
    expect(
        controller.menu!.items
            .where((v) => v.name == 'عصير الاختبار')
            .single
            .available,
        false);
    expect(
        controller.menu!.items
            .where((v) => v.name == 'عصير الاختبار')
            .single
            .priceMinor,
        725);
    await capture(boundary, 'windows-menu.png');
    await tap(find.widgetWithText(ChoiceChip, 'المخزون'));
    await tap(find.text('تعديل الجرد'));
    await tester.enterText(
        find.widgetWithText(TextField, 'الكمية المتاحة للبيع خارج الحجوزات'),
        '٢٨');
    await tap(find.text('تأكيد الجرد'));
    expect(controller.stock.single.available, 28);
    expect(controller.stock.single.held, 3);
    await capture(boundary, 'windows-stock.png');
    await tap(find.widgetWithText(ChoiceChip, 'قنوات الطلب'));
    await tap(find.text('إيقاف الطلبات الجديدة').first);
    await tap(find.text('تأكيد'));
    expect(api.channelWrites, 1);
    expect(controller.channels.first.newOrdersEnabled, false);
    expect(controller.channels.last.adapterImplemented, false);
    await capture(boundary, 'windows-channels.png');
    await tap(find.text('تسجيل الخروج'));
    expect(controller.menu, isNull);
    expect(controller.stock, isEmpty);
    expect(controller.channels, isEmpty);
    await tester.pumpWidget(const SizedBox());
  });
}

Future<void> capture(GlobalKey boundary, String name) async {
  final root = Platform.environment['ONLINU_SMOKE_SCREENSHOT'];
  if (root == null) return;
  final render =
      boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  final picture = await render.toImage(pixelRatio: 1);
  final bytes = await picture.toByteData(format: ui.ImageByteFormat.png);
  picture.dispose();
  if (bytes == null) return;
  final file = File('${File(root).parent.path}${Platform.pathSeparator}$name');
  await file.parent.create(recursive: true);
  await file.writeAsBytes(bytes.buffer.asUint8List());
}
