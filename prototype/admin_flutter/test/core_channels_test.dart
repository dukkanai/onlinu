import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:restaurant_admin_prototype/core/api.dart';
import 'package:restaurant_admin_prototype/core/app.dart';
import 'package:restaurant_admin_prototype/core/controller.dart';
import 'package:restaurant_admin_prototype/core/transport.dart';
import 'core_fakes.dart';

void main() {
  test(
      'channel-only staff use independent permission for the two active adapters',
      () async {
    final api = FakeCoreGateway()
      ..currentProfile = profileFixture(permissions: ['channels:manage']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    expect(c.section, CoreSection.channels);
    expect(api.reads, 0);
    expect(api.stockReads, 0);
    expect(c.channels.length, 2);
    expect(c.channels.every((v) => v.adapterImplemented), true);
    expect(api.channelWrites, 0);
    final old = c.channels.first;
    await c.changeChannel(old, false);
    expect(api.channelWrites, 1);
    expect(c.channels.first.newOrdersEnabled, false);
    expect(c.channels[1].newOrdersEnabled, true);
    await c.changeChannel(old, true);
    expect(api.channelWrites, 1);
    expect(c.message, contains('تغير إعداد'));
  });
  test(
      'uncertain channel writes are read back once, never automatically replayed',
      () async {
    final api = FakeCoreGateway()
      ..currentProfile = profileFixture(permissions: ['channels:manage']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    api.writeError = const CoreException('offline', uncertain: true);
    await c.changeChannel(c.channels.first, false);
    expect(api.channelWrites, 1);
    expect(c.channels.first.newOrdersEnabled, true);
    expect(c.message, contains('لم تتأكد'));
    api.currentProfile = profileFixture(permissions: []);
    await c.refresh();
    expect(c.channels, isEmpty);
  });
  test(
      'channel API validates tenant, adapter and expected version without other account actions',
      () async {
    final session = FakeCoreSession()..hasSession = true,
        api = CoreApi(session);
    session.transport.handler = (_, __, ___) async => const CoreReply(200, {
          'tenantId': 'demo-a',
          'channel': 'web',
          'version': 2,
          'newOrdersEnabled': false,
          'adapterImplemented': true
        });
    await api.setChannel('demo-a', channelFixture('web'), false);
    expect(session.transport.calls.single['path'],
        '/native/api/restaurants/demo-a/staff/channels/web');
    expect(session.transport.calls.single['body'],
        {'expectedVersion': 1, 'newOrdersEnabled': false});
    await expectLater(api.setChannel('demo-b', channelFixture('web'), false),
        throwsA(isA<CoreException>()));
    expect(() => channelFixture('whatsapp_qr'), throwsA(isA<CoreException>()));
    expect(session.transport.calls.length, 1);
  });
  testWidgets(
      'channel controls explain new-order scope and require confirmation',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile = profileFixture(permissions: ['channels:manage']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    await tester.pumpWidget(CoreApp(controller: c));
    await tester.pumpAndSettle();
    await tester.tap(find.text('الدخول عبر المتصفح'));
    await tester.pumpAndSettle();
    expect(find.text('مسار استقبال الطلبات لهذه القناة لم يكتمل بعد.'),
        findsNothing);
    expect(find.text('إيقاف الطلبات الجديدة'), findsNWidgets(2));
    await tester.tap(find.text('إيقاف الطلبات الجديدة').first);
    await tester.pumpAndSettle();
    expect(find.textContaining('لا يلغي الطلبات المقبولة'), findsOneWidget);
    expect(api.channelWrites, 0);
    await tester.tap(find.text('رجوع'));
    await tester.pumpAndSettle();
    expect(api.channelWrites, 0);
    await tester.tap(find.text('إيقاف الطلبات الجديدة').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('تأكيد'));
    await tester.pumpAndSettle();
    expect(api.channelWrites, 1);
    expect(find.text('تفعيل الطلبات الجديدة'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
}
