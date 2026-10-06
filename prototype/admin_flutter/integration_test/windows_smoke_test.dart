import '../test/core_support_test.dart' show SupportGateway, complaintId;
import '../test/core_brand_test.dart' show BrandGateway;
import '../test/core_refund_test.dart' show RefundGateway;
import 'package:restaurant_admin_prototype/core/refund_dialog.dart';
import 'dart:convert';
import 'dart:typed_data';
import 'dart:io';
import 'dart:math';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:restaurant_admin_prototype/core/app.dart';
import 'package:restaurant_admin_prototype/core/menu_image_editor.dart';
import 'package:restaurant_admin_prototype/core/menu_image_io.dart';
import 'package:restaurant_admin_prototype/core/models.dart';
import 'package:restaurant_admin_prototype/core/team_models.dart';
import 'package:restaurant_admin_prototype/core/controller.dart';
import 'package:restaurant_admin_prototype/core/session_store.dart';
import '../test/core_fakes.dart';
import '../test/core_courier_test.dart' show ownWork, linksJson;
import 'package:restaurant_admin_prototype/core/courier_models.dart';

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
    await capture(tester, boundary, 'windows-orders.png');
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
    await tap(find.text('تعديل تصنيف'));
    await tester.enterText(
        find.widgetWithText(TextField, 'اسم التصنيف'), 'الأطباق الرئيسية');
    await tester.enterText(find.widgetWithText(TextField, 'ترتيب العرض'), '١');
    await capture(tester, boundary, 'windows-category.png');
    await tap(find.text('حفظ التصنيف'));
    expect(controller.menu!.items.single.categoryId, 'main');
    await tap(find.text('الوصف والإضافات'));
    await tester.enterText(
        find.widgetWithText(TextField, 'وصف الصنف'), 'وصف اختبار Windows');
    await tap(find.text('متاحة للاختيار'));
    await tap(find.text('إضافة خيار'));
    await tester.enterText(
        find.widgetWithText(TextField, 'اسم الإضافة'), 'صلصة إضافية');
    await tester.enterText(
        find.widgetWithText(TextField, 'سعر الإضافة بالريال'), '١٫٥٠');
    await tap(find.text('اعتماد الإضافة'));
    await capture(tester, boundary, 'windows-options.png');
    await tap(find.text('حفظ الوصف والإضافات'));
    expect(api.menuOptions.first.id, 'extra');
    expect(api.menuOptions.first.available, false);
    expect(api.menuOptions.last.priceMinor, 150);
    expect(api.menuOptions.last.available, false);
    await tap(find.text('إضافة تصنيف'));
    await tester.enterText(find.widgetWithText(TextField, 'اسم التصنيف الجديد'),
        'مشروبات الاختبار');
    await tap(find.text('إنشاء'));
    await tap(find.text('إضافة صنف'));
    await tester.enterText(
        find.widgetWithText(TextField, 'اسم الصنف الجديد'), 'عصير الاختبار');
    await tester.enterText(
        find.widgetWithText(TextField, 'السعر بالريال السعودي'), '٧٫٢٥');
    await capture(tester, boundary, 'windows-create-item.png');
    await tap(find.text('إنشاء'));
    expect(api.menuWrites, 5);
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
    await capture(tester, boundary, 'windows-menu.png');
    await tap(find.widgetWithText(ChoiceChip, 'المخزون'));
    await tap(find.text('تعديل الجرد'));
    await tester.enterText(
        find.widgetWithText(TextField, 'الكمية المتاحة للبيع خارج الحجوزات'),
        '٢٨');
    await tap(find.text('تأكيد الجرد'));
    expect(controller.stock.single.available, 28);
    expect(controller.stock.single.held, 3);
    await capture(tester, boundary, 'windows-stock.png');
    await tap(find.widgetWithText(ChoiceChip, 'قنوات الطلب'));
    await tap(find.text('إيقاف الطلبات الجديدة').first);
    await tap(find.text('تأكيد'));
    expect(api.channelWrites, 1);
    expect(controller.channels.first.newOrdersEnabled, false);
    expect(controller.channels.last.adapterImplemented, false);
    await capture(tester, boundary, 'windows-channels.png');
    await tap(find.text('تسجيل الخروج'));
    expect(controller.menu, isNull);
    expect(controller.stock, isEmpty);
    expect(controller.channels, isEmpty);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets(
      'Windows support review separates cancellation from financial payout',
      (tester) async {
    final api = SupportGateway()..session.restoreAvailable = true,
        c = CoreController(api, pollInterval: const Duration(hours: 1)),
        boundary = GlobalKey();
    await tester.pumpWidget(
        RepaintBoundary(key: boundary, child: CoreApp(controller: c)));
    await tester.pumpAndSettle();
    Future<void> tap(Finder f) async {
      await tester.ensureVisible(f);
      await tester.pumpAndSettle();
      await tester.tap(f);
      await tester.pumpAndSettle();
    }

    await tap(find.widgetWithText(ChoiceChip, 'الإلغاء والشكاوى'));
    await tap(find.text('مراجعة الدعم'));
    await tap(find.text('مراجعة الموافقة على الإلغاء'));
    final reason = find.descendant(
        of: find.byType(AlertDialog), matching: find.byType(TextField));
    await tester.enterText(reason, 'Synthetic reviewed approval');
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pumpAndSettle();
    await tap(find.text('مراجعة قرار الدعم'));
    expect(
        tester
            .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'تأكيد قرار الدعم'))
            .onPressed,
        isNull);
    await tap(find.byType(CheckboxListTile));
    await capture(tester, boundary, 'windows-support-decision-review.png');
    await tap(find.text('تأكيد قرار الدعم'));
    expect(api.supportWrites, 1);
    expect(c.supportDetail!.order.status, 'cancelled');
    expect(c.supportDetail!.order.paymentStatus, 'review');
    await tap(find.byKey(const ValueKey('support-resolve-$complaintId')));
    await tester.enterText(reason, 'Synthetic complaint resolved');
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pumpAndSettle();
    await tap(find.text('مراجعة قرار الدعم'));
    await tap(find.byType(CheckboxListTile));
    await tap(find.text('تأكيد قرار الدعم'));
    expect(api.supportWrites, 2);
    expect(c.support!.orders, isEmpty);
    await tap(find.text('إغلاق الدعم'));
    expect(c.supportDetail, isNull);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets('Windows reviewed tax configuration keeps explicit confirmation',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['settings:read', 'settings:update']);
    api.session.restoreAvailable = true;
    final c = CoreController(api, pollInterval: const Duration(hours: 1)),
        boundary = GlobalKey();
    await tester.pumpWidget(
        RepaintBoundary(key: boundary, child: CoreApp(controller: c)));
    await tester.pumpAndSettle();
    Future<void> tap(Finder f) async {
      await tester.ensureVisible(f);
      await tester.pumpAndSettle();
      await tester.tap(f);
      await tester.pumpAndSettle();
    }

    await tap(find.widgetWithText(ChoiceChip, 'الضريبة'));
    await tap(find.text('مراجعة إعدادات الضريبة'));
    await tap(find.widgetWithText(SwitchListTile, 'تفعيل حساب الضريبة'));
    await tester.enterText(
        find.widgetWithText(TextField, 'رقم التسجيل الضريبي'),
        'SYNTHETIC-NOT-A-TAX-ID');
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pumpAndSettle();
    expect(
        tester
            .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'حفظ إعدادات الضريبة'))
            .onPressed,
        isNull);
    await tap(find.byType(CheckboxListTile));
    await capture(tester, boundary, 'windows-tax-review.png');
    await tap(find.text('حفظ إعدادات الضريبة'));
    expect(api.taxWrites, 1);
    expect(c.tax!.enabled, true);
    expect(c.tax!.rateBps, 1500);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets('Windows appearance draft review and separate publication',
      (tester) async {
    final api = BrandGateway()..session.restoreAvailable = true,
        c = CoreController(api, pollInterval: const Duration(hours: 1)),
        boundary = GlobalKey();
    await tester.pumpWidget(
        RepaintBoundary(key: boundary, child: CoreApp(controller: c)));
    await tester.pumpAndSettle();
    Future<void> tap(Finder f) async {
      await tester.ensureVisible(f);
      await tester.pumpAndSettle();
      await tester.tap(f);
      await tester.pumpAndSettle();
    }

    await tap(find.text('مظهر المتجر'));
    await tap(find.text('تعديل مسودة المظهر'));
    await tap(find.byKey(const ValueKey('brand-storefrontTemplate-editorial')));
    await tap(find.text('مراجعة تغييرات المظهر'));
    expect(
        tester
            .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'تأكيد حفظ مسودة خاصة'))
            .onPressed,
        isNull);
    await tap(find.byType(CheckboxListTile));
    await capture(tester, boundary, 'windows-brand-draft-review.png');
    await tap(find.text('تأكيد حفظ مسودة خاصة'));
    expect(api.brandWrites, 1);
    expect(c.appearance!.live.values['storefrontTemplate'], 'classic');
    expect(c.appearance!.draft!.values['storefrontTemplate'], 'editorial');
    await tap(find.text('مراجعة نشر المسودة'));
    await tap(find.byType(CheckboxListTile));
    await tap(find.text('تأكيد نشر المسودة للعملاء'));
    expect(api.brandWrites, 2);
    expect(c.appearance!.live.values['storefrontTemplate'], 'editorial');
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets(
      'Windows existing refund requires reviewed financial confirmation',
      (tester) async {
    final api = RefundGateway(),
        c = CoreController(api, pollInterval: const Duration(hours: 1)),
        boundary = GlobalKey();
    await c.start(restore: false);
    await c.showRefund('R1234567890', principalId);
    await tester.pumpWidget(RepaintBoundary(
        key: boundary,
        child: MaterialApp(
            builder: (context, child) =>
                Directionality(textDirection: TextDirection.rtl, child: child!),
            home: Scaffold(
                body: RefundDialog(
                    controller: c, number: 'R1234567890', id: principalId)))));
    await tester.pumpAndSettle();
    Future<void> tap(Finder f) async {
      await tester.ensureVisible(f);
      await tester.pumpAndSettle();
      await tester.tap(f);
      await tester.pumpAndSettle();
    }

    await tap(find.text('التصريح بتنفيذ الاسترداد'));
    await tap(find.text('مراجعة الإجراء'));
    expect(
        tester
            .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'تأكيد إجراء الاسترداد'))
            .onPressed,
        isNull);
    await tap(find.byType(CheckboxListTile));
    await capture(tester, boundary, 'windows-refund-review.png');
    await tap(find.text('تأكيد إجراء الاسترداد'));
    expect(api.refundWrites, 1);
    expect(c.refund!.authorized, true);
    await tester.pumpWidget(const SizedBox());
    c.dispose();
  });
  testWidgets(
      'Windows financial snapshot is read-only and private on dismissal',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['orders:read', 'payments:read']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1)),
        boundary = GlobalKey();
    await tester.pumpWidget(
        RepaintBoundary(key: boundary, child: CoreApp(controller: c)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('الدخول عبر المتصفح'));
    await tester.pumpAndSettle();
    final button = find.text('السجل المالي');
    await tester.ensureVisible(button);
    await tester.pumpAndSettle();
    await tester.tap(button);
    await tester.pumpAndSettle();
    expect(find.textContaining('المبلغ المحصل المؤكد:'), findsOneWidget);
    await capture(tester, boundary, 'windows-finance-readonly.png');
    await tester.tap(find.text('إغلاق السجل المالي'));
    await tester.pumpAndSettle();
    expect(c.finance, isNull);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets('Windows service intake review preserves existing work',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['settings:read', 'settings:update']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1)),
        boundary = GlobalKey();
    await tester.pumpWidget(
        RepaintBoundary(key: boundary, child: CoreApp(controller: c)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('الدخول عبر المتصفح'));
    await tester.pumpAndSettle();
    final tab = find.widgetWithText(ChoiceChip, 'استقبال الطلبات');
    await tester.ensureVisible(tab);
    await tester.pumpAndSettle();
    await tester.tap(tab);
    await tester.pumpAndSettle();
    final edit = find.text('مراجعة طرق الخدمة');
    await tester.ensureVisible(edit);
    await tester.pumpAndSettle();
    await tester.tap(edit);
    await tester.pumpAndSettle();
    await tester
        .tap(find.widgetWithText(SwitchListTile, 'استقبال الطلبات الجديدة'));
    await tester.pumpAndSettle();
    final reviewed = find.byType(CheckboxListTile);
    await tester.ensureVisible(reviewed);
    await tester.pumpAndSettle();
    await tester.tap(reviewed);
    await tester.pumpAndSettle();
    expect(api.serviceWrites, 0);
    await capture(tester, boundary, 'windows-service-review.png');
    await tester.tap(find.text('حفظ سياسة الاستقبال'));
    await tester.pumpAndSettle();
    expect(api.serviceWrites, 1);
    expect(c.service!.flags['acceptingOrders'], false);
    await capture(tester, boundary, 'windows-service-closed.png');
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets('Windows owned courier cash review and explicit identity binding',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile = profileFixture(permissions: [
        'courier:read',
        'courier:update',
        'courier:collect',
        'couriers:link'
      ])
      ..workValue = ownWork(stage: 'at_door')
      ..linksValue = CoreCourierLinks(linksJson(), tenantId: 'demo-a');
    final c = CoreController(api, pollInterval: const Duration(hours: 1)),
        boundary = GlobalKey();
    await tester.pumpWidget(
        RepaintBoundary(key: boundary, child: CoreApp(controller: c)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('الدخول عبر المتصفح'));
    await tester.pumpAndSettle();
    final cash = find.text('استلمت نقد هذا الطلب');
    await tester.ensureVisible(cash);
    await tester.pumpAndSettle();
    await tester.tap(cash);
    await tester.pumpAndSettle();
    expect(api.courierWrites, isEmpty);
    await capture(tester, boundary, 'windows-courier-cash-review.png');
    await tester.tap(find.text('تأكيد'));
    await tester.pumpAndSettle();
    expect(api.courierWrites, ['cash']);
    final tab = find.widgetWithText(ChoiceChip, 'ربط المندوبين');
    await tester.ensureVisible(tab);
    await tester.pumpAndSettle();
    await tester.tap(tab);
    await tester.pumpAndSettle();
    final edit = find.text('مراجعة الربط');
    await tester.ensureVisible(edit);
    await tester.pumpAndSettle();
    await tester.tap(edit);
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('هوية تجريبية').last);
    await tester.pumpAndSettle();
    final check = find.byType(CheckboxListTile);
    await tester.ensureVisible(check);
    await tester.pumpAndSettle();
    await tester.tap(check);
    await tester.pumpAndSettle();
    await capture(tester, boundary, 'windows-courier-link-review.png');
    await tester.tap(find.text('تأكيد تغيير الربط'));
    await tester.pumpAndSettle();
    expect(api.courierWrites, ['cash', 'link:$principalId']);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets('Windows dispatcher reviews existing courier assignment',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['orders:read', 'delivery:assign'])
      ..currentOrder = orderFixture(mode: 'delivery');
    final c = CoreController(api, pollInterval: const Duration(hours: 1)),
        boundary = GlobalKey();
    await tester.pumpWidget(
        RepaintBoundary(key: boundary, child: CoreApp(controller: c)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('الدخول عبر المتصفح'));
    await tester.pumpAndSettle();
    final assign = find.text('إسناد مندوب');
    await tester.ensureVisible(assign);
    await tester.pumpAndSettle();
    await tester.tap(assign);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(
        DropdownButtonFormField<String>, 'المندوب المطلوب'));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('مندوب تجريبي • متاح').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('مراجعة الإسناد'));
    await tester.pumpAndSettle();
    expect(api.assignments, 0);
    await capture(tester, boundary, 'windows-dispatch-review.png');
    await tester.tap(find.text('تأكيد الإسناد'));
    await tester.pumpAndSettle();
    expect(api.assignments, 1);
    expect(c.orders.single.courierId, api.currentCouriers.single.id);
    await capture(tester, boundary, 'windows-dispatch-assigned.png');
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets(
      'Windows geographic selection and zero-fee review preserve delivery semantics',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['settings:read', 'settings:update']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1)),
        boundary = GlobalKey();
    await tester.pumpWidget(
        RepaintBoundary(key: boundary, child: CoreApp(controller: c)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('الدخول عبر المتصفح'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(ChoiceChip, 'مناطق التوصيل'));
    await tester.pumpAndSettle();
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
    await capture(tester, boundary, 'windows-delivery-zone.png');
    await tester.tap(find.text('مراجعة التوصيل'));
    await tester.pumpAndSettle();
    expect(api.deliveryWrites, 0);
    await capture(tester, boundary, 'windows-delivery-review.png');
    await tester.tap(find.text('تأكيد حفظ التوصيل'));
    await tester.pumpAndSettle();
    expect(api.deliveryWrites, 1);
    expect(c.coverage!.zones.single.fee, 0);
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets('Windows public business profile requires publication review',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['settings:read', 'settings:update']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1)),
        boundary = GlobalKey();
    await tester.pumpWidget(
        RepaintBoundary(key: boundary, child: CoreApp(controller: c)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('الدخول عبر المتصفح'));
    await tester.pumpAndSettle();
    final edit = find.text('تعديل البيانات العامة');
    await tester.ensureVisible(edit);
    await tester.pumpAndSettle();
    await tester.tap(edit);
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextField, 'اسم المطعم العام'),
        'مطعم الاختبار العام');
    await capture(tester, boundary, 'windows-business-profile.png');
    final review = find.widgetWithText(
        CheckboxListTile, 'راجعت المعلومات العامة التي ستُنشر');
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pumpAndSettle();
    await tester.ensureVisible(review);
    await tester.pumpAndSettle();
    await tester.tap(review);
    await tester.pumpAndSettle();
    await tester.tap(find.text('حفظ البيانات العامة'));
    await tester.pumpAndSettle();
    expect(api.profileWrites, 1);
    expect(api.currentBusinessProfile.fields['name'], 'مطعم الاختبار العام');
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets('Windows team permission review and explicit confirmation',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile = profileFixture(permissions: ['members:manage'])
      ..currentTeam = [
        CoreTeamMember({
          'tenantId': 'demo-a',
          'principalId': '12345678-1234-4234-8234-123456789def',
          'role': 'kitchen',
          'permissions': rolePermissions('kitchen').toList(),
          'version': 1,
          'enabled': true,
          'displayName': 'موظف المطبخ'
        })
      ];
    final c = CoreController(api, pollInterval: const Duration(hours: 1)),
        boundary = GlobalKey();
    await tester.pumpWidget(
        RepaintBoundary(key: boundary, child: CoreApp(controller: c)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('الدخول عبر المتصفح'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('تعديل العضوية'));
    await tester.pumpAndSettle();
    await tester.enterText(
        find.widgetWithText(TextField, 'اسم العرض داخل المطعم'),
        'المطبخ المسائي');
    final enabled = find.widgetWithText(SwitchListTile, 'العضوية مفعّلة');
    await tester.ensureVisible(enabled);
    await tester.pumpAndSettle();
    await tester.tap(enabled);
    await tester.pumpAndSettle();
    await tester.tap(find.text('مراجعة التغيير'));
    await tester.pumpAndSettle();
    expect(api.teamWrites, 0);
    await capture(tester, boundary, 'windows-team-review.png');
    await tester.tap(find.text('تأكيد حفظ العضوية'));
    await tester.pumpAndSettle();
    expect(api.teamWrites, 1);
    expect(api.currentTeam.single.enabled, false);
    expect(api.currentTeam.single.displayName, 'المطبخ المسائي');
    await capture(tester, boundary, 'windows-team.png');
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets(
      'Windows image review requires an explicit upload with a synthetic picker',
      (tester) async {
    final api = WindowsImageGateway()
      ..currentProfile =
          profileFixture(permissions: ['menu:read', 'menu:update']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    final boundary = GlobalKey();
    await c.start(restore: false);
    await tester.pumpWidget(RepaintBoundary(
        key: boundary,
        child: MaterialApp(
            home: Directionality(
                textDirection: TextDirection.rtl,
                child: MenuImageEditor(
                    controller: c,
                    tenant: 'demo-a',
                    id: 'meal',
                    picker: () async =>
                        SelectedMenuImage('synthetic.png', windowsImage))))));
    await tester.pumpAndSettle();
    await tester.tap(find.text('اختيار صورة'));
    await tester.pumpAndSettle();
    expect(api.uploads, 0);
    await capture(tester, boundary, 'windows-image-review.png');
    await tester.tap(find.text('رفع الصورة للصنف'));
    await tester.pumpAndSettle();
    expect(api.uploads, 1);
    expect(find.byType(Image), findsOneWidget);
    await capture(tester, boundary, 'windows-image-saved.png');
    await tester.pumpWidget(const SizedBox());
    c.dispose();
  });
}

Future<void> capture(
    WidgetTester tester, GlobalKey boundary, String name) async {
  await tester.pumpAndSettle();
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

// Renderer/flow fixture only. The production OS file chooser is not automated.
final windowsImage = base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGPQyFtFU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAMrBAEz/bT+vAAAAAElFTkSuQmCC');

class WindowsImageGateway extends FakeCoreGateway {
  int uploads = 0;
  @override
  Future<CoreMenuDetails> menuDetails(String tenant, String id) async =>
      CoreMenuDetails({
        'version': currentMenu.version,
        'currency': 'SAR',
        'item': {
          ...object(menuJson()['items'][0]),
          'description': '',
          'options': [],
          'imageUrl': uploads > 0 ? '/restaurant-media/${'a' * 64}.png' : ''
        }
      }, tenantId: tenant);
  @override
  Future<CoreMenuDetails> uploadImage(
      CoreMenuDetails expected, Uint8List bytes) async {
    uploads++;
    currentMenu = CoreMenu(
        {...menuDocument(currentMenu), 'version': expected.version + 1},
        tenantId: expected.tenantId);
    return menuDetails(expected.tenantId, expected.item.id);
  }

  @override
  Future<Uint8List> image(CoreMenuDetails details) async => windowsImage;
}
