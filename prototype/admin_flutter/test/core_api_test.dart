import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:restaurant_admin_prototype/core/api.dart';
import 'package:restaurant_admin_prototype/core/session_store.dart';
import 'package:restaurant_admin_prototype/core/transport.dart';
import 'core_fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('native API uses own bearer and binds tenant, order and version',
      () async {
    final session = FakeCoreSession()..hasSession = true;
    final api = CoreApi(session);
    session.transport.handler = (method, path, body) async {
      if (path.endsWith('/me'))
        return CoreReply(200, {
          'principal': {
            'id': principalId,
            'memberships': [memberJson('demo-a')]
          }
        });
      if (method == 'GET' && path.endsWith('/orders'))
        return CoreReply(200, {
          'tenantId': 'demo-a',
          'limit': 100,
          'orders': [orderJson()]
        });
      return CoreReply(200, {
        'tenantId': 'demo-a',
        ...orderJson(version: 2, status: 'preparing')
      });
    };
    expect((await api.profile()).memberships.single.tenantId, 'demo-a');
    final order = (await api.orders('demo-a')).single;
    final result = await api.change('demo-a', order, status: 'preparing');
    expect(result.version, 2);
    final sent = session.transport.calls.last;
    expect(sent['path'],
        '/native/api/restaurants/demo-a/staff/orders/R1234567890/status');
    expect(sent['body'], {'version': 1, 'status': 'preparing'});
    expect(sent['bearer'], hasLength(43));
    await expectLater(api.change('demo-b', order, status: 'preparing'),
        throwsA(isA<CoreException>()));
    expect(session.transport.calls.length, 3);
  });
  test(
      'cross-tenant, wrong order, duplicate rows and malformed amounts fail closed',
      () async {
    final session = FakeCoreSession()..hasSession = true;
    final api = CoreApi(session);
    session.transport.handler = (_, __, ___) async => CoreReply(200, {
          'tenantId': 'demo-b',
          'limit': 100,
          'orders': [orderJson()]
        });
    await expectLater(api.orders('demo-a'), throwsA(isA<CoreException>()));
    session.transport.handler = (_, __, ___) async => CoreReply(
        200, {'tenantId': 'demo-a', ...orderJson(number: 'R9999999999')});
    await expectLater(
        api.detail('demo-a', 'R1234567890'), throwsA(isA<CoreException>()));
    session.transport.handler = (_, __, ___) async => CoreReply(200, {
          'tenantId': 'demo-a',
          'limit': 100,
          'orders': [orderJson(), orderJson()]
        });
    await expectLater(api.orders('demo-a'), throwsA(isA<CoreException>()));
    session.transport.handler = (_, __, ___) async => CoreReply(200, {
          'tenantId': 'demo-a',
          'limit': 100,
          'orders': [
            {...orderJson(), 'totalMinor': 12.5}
          ]
        });
    await expectLater(api.orders('demo-a'), throwsA(isA<CoreException>()));
  });
  test('401 clears session, errors are sanitized and writes are sent only once',
      () async {
    final session = FakeCoreSession()..hasSession = true;
    final api = CoreApi(session);
    session.transport.handler = (_, __, ___) async =>
        const CoreReply(503, {'error': 'private-token-should-not-appear'});
    await expectLater(
        api.change('demo-a', orderFixture(), status: 'preparing'),
        throwsA(isA<CoreException>()
            .having((v) => v.code, 'sanitized', 'request_failed')
            .having((v) => v.uncertain, 'uncertain', true)));
    expect(session.transport.calls.length, 1);
    session.transport.handler =
        (_, __, ___) async => const CoreReply(401, {'error': 'expired'});
    await expectLater(api.orders('demo-a'), throwsA(isA<CoreException>()));
    expect(session.hasSession, false);
    expect(session.revocations, 1);
  });
  test('malformed successful mutation stays uncertain rather than fabricated',
      () async {
    final session = FakeCoreSession()..hasSession = true;
    final api = CoreApi(session);
    session.transport.handler = (_, __, ___) async =>
        CoreReply(200, {'tenantId': 'demo-a', ...orderJson()});
    await expectLater(
        api.change('demo-a', orderFixture(), status: 'preparing'),
        throwsA(isA<CoreException>()
            .having((v) => v.uncertain, 'uncertain', true)));
    expect(session.transport.calls.length, 1);
  });
  test(
      'secure store is origin-namespaced and deletes only its own key (plugin mock)',
      () async {
    FlutterSecureStorage.setMockInitialValues({'another_app': 'preserve'});
    final a = OsCoreSessionStore('https://a.example'),
        b = OsCoreSessionStore('https://b.example');
    await a.write('synthetic-a');
    await b.write('synthetic-b');
    await a.delete();
    expect(await a.read(), isNull);
    expect(await b.read(), 'synthetic-b');
    expect(await const FlutterSecureStorage().read(key: 'another_app'),
        'preserve');
  });
}
