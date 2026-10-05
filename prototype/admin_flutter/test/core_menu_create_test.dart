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
      'creation IDs are stable opaque menu keys without caller-controlled paths',
      () {
    final values = List.generate(100, (_) => newMenuId(false));
    expect(values.toSet().length, 100);
    for (final value in values) {
      expect(value, startsWith('i_'));
      expect(menuKey(value), value);
    }
    expect(newMenuId(true), startsWith('c_'));
  });
  test(
      'native category and item creation reuse catalogue version and start items disabled',
      () async {
    final session = FakeCoreSession()..hasSession = true,
        api = CoreApi(session),
        menu = menuFixture();
    session.transport.handler = (method, path, body) async {
      expect(method, 'POST');
      expect(body!['expectedVersion'], 1);
      if (path.endsWith('/categories'))
        return CoreReply(201,
            {'tenantId': 'demo-a', 'version': 2, 'category': body['category']});
      return CoreReply(201, {
        'tenantId': 'demo-a',
        'version': 2,
        'currency': 'SAR',
        'item': body['item']
      });
    };
    await api.createMenuCategory(menu, id: 'c_new', name: 'مشروبات', sort: 3);
    expect(session.transport.calls.last['body'], {
      'expectedVersion': 1,
      'category': {'id': 'c_new', 'name': 'مشروبات', 'sort': 3}
    });
    await api.createMenuItem(menu,
        id: 'i_new', name: 'عصير', categoryId: 'main', price: 500, sort: 4);
    final body = session.transport.calls.last['body'] as Map;
    expect(body.keys.toSet(), {'expectedVersion', 'item'});
    expect(body['item'], {
      'id': 'i_new',
      'name': 'عصير',
      'categoryId': 'main',
      'priceMinor': 500,
      'sort': 4,
      'available': false,
      'description': '',
      'imageUrl': '',
      'options': []
    });
    await expectLater(
        api.createMenuItem(menu,
            id: '../escape', name: 'x', categoryId: 'main', price: 1, sort: 0),
        throwsA(isA<CoreException>()));
    expect(session.transport.calls.length, 2);
  });
  test(
      'controller prevents stale, unauthorized and automatically repeated creations',
      () async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['menu:read', 'menu:update']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    final old = c.menu!;
    await c.createMenuEntry(old, id: 'c_new', name: 'مشروبات', sort: 0);
    expect(c.menu!.categories.length, 3);
    await c.createMenuEntry(old, id: 'c_again', name: 'آخر', sort: 0);
    expect(api.menuWrites, 1);
    await c.createMenuEntry(c.menu!,
        id: 'i_new', name: 'عصير', sort: 0, categoryId: 'c_new', price: 500);
    expect(c.menu!.items.length, 2);
    expect(c.menu!.items.where((v) => v.id == 'i_new').single.available, false);
    api.writeError = const CoreException('offline', uncertain: true);
    await c.createMenuEntry(c.menu!,
        id: 'i_unknown', name: 'آخر', sort: 0, categoryId: 'main', price: 100);
    expect(api.menuWrites, 3);
    expect(c.message, contains('لم تتأكد'));
    expect(c.menu!.items.length, 2);
    api.currentProfile = profileFixture(permissions: ['menu:read']);
    await c.refresh();
    await c.createMenuEntry(c.menu!, id: 'c_denied', name: 'مرفوض', sort: 0);
    expect(api.menuWrites, 3);
  });
  test(
      'catalogue supports 5000 bounded items without quadratic category lookup',
      () {
    final doc = menuJson();
    doc['items'] = List.generate(
        5000,
        (i) => {
              'id': 'i_$i',
              'categoryId': 'main',
              'name': 'Item',
              'priceMinor': 1,
              'available': false
            });
    expect(CoreMenu(doc, tenantId: 'demo-a').items.length, 5000);
    (doc['items'] as List).add({
      'id': 'extra',
      'categoryId': 'main',
      'name': 'Item',
      'priceMinor': 1,
      'available': false
    });
    expect(
        () => CoreMenu(doc, tenantId: 'demo-a'), throwsA(isA<CoreException>()));
  });
  testWidgets(
      'creation forms cancel without writes and add reviewed disabled items',
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
    await tap(find.text('إضافة تصنيف'));
    await tap(find.text('إلغاء'));
    expect(api.menuWrites, 0);
    await tap(find.text('إضافة تصنيف'));
    await tester.enterText(
        find.widgetWithText(TextField, 'اسم التصنيف الجديد'), 'مشروبات');
    await tap(find.text('إنشاء'));
    expect(c.menu!.categories.length, 3);
    await tap(find.text('إضافة صنف'));
    await tester.enterText(
        find.widgetWithText(TextField, 'اسم الصنف الجديد'), 'عصير');
    await tester.enterText(
        find.widgetWithText(TextField, 'السعر بالريال السعودي'), '٥٫٥٠');
    await tap(find.text('إنشاء'));
    final created = c.menu!.items.where((v) => v.name == 'عصير').single;
    expect(created.priceMinor, 550);
    expect(created.available, false);
    expect(api.menuWrites, 2);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
}
