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
  test('category rename/reorder preserves identity and item assignments',
      () async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['menu:read', 'menu:update']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    final old = c.menu!, category = old.categories.first;
    await c.patchCategory(old, category, name: 'أطباق رئيسية', sort: 9);
    expect(c.menu!.categories.where((v) => v.id == category.id).single.name,
        'أطباق رئيسية');
    expect(c.menu!.items.single.categoryId, category.id);
    expect(c.menu!.categories.last.id, category.id);
    await c.patchCategory(old, category, name: 'نسخة قديمة', sort: 0);
    expect(api.menuWrites, 1);
  });
  test('category API uses a narrow versioned patch', () async {
    final session = FakeCoreSession()..hasSession = true,
        api = CoreApi(session),
        menu = menuFixture();
    session.transport.handler = (_, __, body) async => CoreReply(200, {
          'tenantId': 'demo-a',
          'version': 2,
          'category': {
            'id': 'main',
            'name': body!['name'],
            'sort': body['sort']
          }
        });
    await api.patchCategory(menu, menu.categories.first,
        name: 'اسم جديد', sort: 4);
    expect(session.transport.calls.single['body'],
        {'expectedVersion': 1, 'name': 'اسم جديد', 'sort': 4});
  });
  test(
      'description and options keep stable IDs, historical values and omitted fields',
      () async {
    final session = FakeCoreSession()..hasSession = true,
        api = CoreApi(session);
    final old = CoreOption(
        {'id': 'extra', 'name': 'إضافة', 'priceMinor': 200, 'available': true});
    session.transport.handler = (method, _, body) async => CoreReply(200, {
          'tenantId': 'demo-a',
          'version': method == 'GET' ? 1 : 2,
          'currency': 'SAR',
          'item': {
            ...object(menuJson()['items'][0]),
            'description': method == 'GET' ? 'قديم' : body!['description'],
            'options': method == 'GET' ? [old.toJson()] : body!['options']
          }
        });
    final details = await api.menuDetails('demo-a', 'meal');
    final added = CoreOption({
      'id': 'new_extra',
      'name': 'جديد',
      'priceMinor': 150,
      'available': false
    });
    await api.patchMenuDetails(details,
        description: 'وصف جديد', options: [old.withAvailable(false), added]);
    expect(session.transport.calls.last['body'], {
      'expectedVersion': 1,
      'description': 'وصف جديد',
      'options': [old.withAvailable(false).toJson(), added.toJson()]
    });
    await expectLater(
        api.patchMenuDetails(details, description: 'x', options: [added]),
        throwsA(isA<CoreException>()));
    expect(session.transport.calls.length, 2);
  });
  test(
      'details writes reject stale snapshots and uncertain results are not retried',
      () async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['menu:read', 'menu:update']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    final details = await c.menuDetails('meal');
    await c.patchMenuDetails(details,
        description: 'جديد',
        options: [details.options.single.withAvailable(false)]);
    expect(api.menuOptions.single.id, 'extra');
    expect(api.menuOptions.single.available, false);
    expect(c.menu!.items.single.priceMinor, 1250);
    await c.patchMenuDetails(details,
        description: 'قديم', options: details.options);
    expect(api.menuWrites, 1);
    final current = await c.menuDetails('meal');
    api.writeError = const CoreException('offline', uncertain: true);
    await c.patchMenuDetails(current,
        description: 'مجهول', options: current.options);
    expect(api.menuWrites, 2);
    expect(c.message, contains('لم تتأكد'));
  });
  test('late detail reads cannot revive a different session', () async {
    final api = FakeCoreGateway()
      ..currentProfile = profileFixture(permissions: ['menu:read']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    final sample = await api.menuDetails('demo-a', 'meal');
    api.menuDetailsGate = Completer<CoreMenuDetails>();
    final pending = c.menuDetails('meal');
    await c.signOut();
    api.menuDetailsGate!.complete(sample);
    await expectLater(pending, throwsA(isA<CoreException>()));
    expect(c.menu, isNull);
  });
  test(
      'revoked update permission while a form is open yields an explicit no-write message',
      () async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['menu:read', 'menu:update']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    final snapshot = c.menu!;
    api.currentProfile = profileFixture(permissions: ['menu:read']);
    await c.refresh();
    await c.patchCategory(snapshot, snapshot.categories.first,
        name: 'لا يُحفظ', sort: 0);
    expect(api.menuWrites, 0);
    expect(c.message, contains('لم يُرسل التعديل'));
  });
  testWidgets(
      'description/options editing disables instead of deleting, with nested cancel and role revocation',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['menu:read', 'menu:update']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    await tester.pumpWidget(CoreApp(controller: c));
    await tester.pumpAndSettle();
    Future<void> tap(Finder target) async {
      await tester.ensureVisible(target);
      await tester.pumpAndSettle();
      await tester.tap(target);
      await tester.pumpAndSettle();
    }

    await tap(find.text('الدخول عبر المتصفح'));
    await tap(find.text('الوصف والإضافات'));
    expect(find.text('وصف الصنف'), findsWidgets);
    await tap(find.text('إضافة خيار'));
    await tap(find.text('إلغاء'));
    expect(api.menuWrites, 0);
    await tester.enterText(
        find.widgetWithText(TextField, 'وصف الصنف'), 'وصف مُراجع');
    await tap(find.text('متاحة للاختيار'));
    await tap(find.text('إضافة خيار'));
    await tester.enterText(
        find.widgetWithText(TextField, 'اسم الإضافة'), 'صلصة');
    await tester.enterText(
        find.widgetWithText(TextField, 'سعر الإضافة بالريال'), '١٫٥٠');
    await tap(find.text('اعتماد الإضافة'));
    await tap(find.text('حفظ الوصف والإضافات'));
    expect(api.menuWrites, 1);
    expect(api.menuOptions.length, 2);
    expect(api.menuOptions.first.id, 'extra');
    expect(api.menuOptions.first.available, false);
    expect(api.menuOptions.last.priceMinor, 150);
    expect(api.menuOptions.last.available, false);
    await tap(find.text('الوصف والإضافات'));
    api.currentProfile = profileFixture(permissions: []);
    await c.refresh();
    await tester.pumpAndSettle();
    expect(find.text('تغيرت الجلسة أو الصلاحيات. أغلق هذه النافذة.'),
        findsOneWidget);
    expect(find.text('حفظ الوصف والإضافات'), findsNothing);
    await tap(find.text('إغلاق'));
    await tester.pumpWidget(const SizedBox());
  });
  testWidgets('category dialog changes only name and sort after explicit save',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['menu:read', 'menu:update']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    await tester.pumpWidget(CoreApp(controller: c));
    await tester.pumpAndSettle();
    Future<void> tap(Finder target) async {
      await tester.ensureVisible(target);
      await tester.pumpAndSettle();
      await tester.tap(target);
      await tester.pumpAndSettle();
    }

    await tap(find.text('الدخول عبر المتصفح'));
    await tap(find.text('تعديل تصنيف'));
    await tester.enterText(
        find.widgetWithText(TextField, 'اسم التصنيف'), 'أطباقنا');
    await tester.enterText(find.widgetWithText(TextField, 'ترتيب العرض'), '٣');
    await tap(find.text('حفظ التصنيف'));
    expect(
        c.menu!.categories.where((v) => v.id == 'main').single.name, 'أطباقنا');
    expect(c.menu!.items.single.categoryId, 'main');
    expect(api.menuWrites, 1);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
}
