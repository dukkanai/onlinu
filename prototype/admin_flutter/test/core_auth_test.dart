import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:restaurant_admin_prototype/core/auth.dart';
import 'package:restaurant_admin_prototype/core/session_store.dart';
import 'package:restaurant_admin_prototype/core/transport.dart';

const origin = 'https://platform.example';
String token(String char) => List.filled(43, char).join();
CoreReply tokens(String char) => CoreReply(200, {
      'access_token': token(char),
      'refresh_token': token(char.toUpperCase()),
      'expires_in': 900,
      'token_type': 'Bearer',
      'scope': nativeScope,
      'resource': '$origin/native/api'
    });

class MemoryStore implements CoreSessionStore {
  String? value;
  bool failWrite = false;
  Completer<void>? writeStarted, writeGate;
  @override
  Future<String?> read() async => value;
  @override
  Future<void> delete() async {
    value = null;
  }

  @override
  Future<void> write(String data) async {
    if (failWrite) throw StateError('synthetic storage failure');
    writeStarted?.complete();
    await writeGate?.future;
    value = data;
  }
}

class FakeTransport implements CoreTransport {
  FakeTransport({String base = 'https://platform.example'})
      : origin = Uri.parse(base);
  @override
  final Uri origin;
  Future<CoreReply> Function(String, Map<String, dynamic>?)? handler;
  final calls = <Map<String, dynamic>>[];
  @override
  Future<CoreReply> request(String method, String path,
      {Map<String, dynamic>? body, String? bearer}) async {
    calls.add({'method': method, 'path': path, 'body': body, 'bearer': bearer});
    if (path.endsWith('/revoke')) return const CoreReply(200, {});
    return handler?.call(path, body) ?? Future.value(tokens('a'));
  }

  @override
  void close() {}
}

Future<int> callback(Uri authorization,
    {String? state,
    String? issuer,
    bool duplicateState = false,
    String? error}) async {
  final params = authorization.queryParameters;
  final uri = Uri.parse(params['redirect_uri']!).replace(queryParameters: {
    'state': state ?? params['state']!,
    'iss': issuer ?? '$origin/native',
    if (error == null) 'code': token('c') else 'error': error,
  });
  final client = HttpClient();
  try {
    final target = duplicateState ? Uri.parse('$uri&state=duplicate') : uri;
    final request = await client.getUrl(target),
        response = await request.close();
    await response.drain<void>();
    return response.statusCode;
  } finally {
    client.close(force: true);
  }
}

Future<CoreAuth> signedIn(MemoryStore store, FakeTransport transport,
    {DateTime Function()? now}) async {
  final auth = CoreAuth(origin, store: store, transport: transport, now: now,
      launch: (uri) async {
    expect(await callback(uri), 200);
    return true;
  });
  await auth.login();
  return auth;
}

void main() {
  test(
      'real mode refuses plaintext, URL credentials and non-origin configuration',
      () {
    for (final uri in [
      'http://127.0.0.1:1234',
      'https://u:p@platform.example',
      'https://platform.example/path',
      'https://platform.example?key=x',
      'https://platform.example/#x'
    ]) {
      expect(() => trustedOrigin(uri), throwsA(isA<CoreException>()));
    }
    expect(trustedOrigin('$origin/').origin, origin);
  });
  test(
      'system browser PKCE binds exact state/issuer and rejects duplicate callbacks',
      () async {
    final store = MemoryStore(), transport = FakeTransport();
    Uri? opened;
    final auth = CoreAuth(origin, store: store, transport: transport,
        launch: (uri) async {
      opened = uri;
      expect(uri.origin, origin);
      expect(uri.path, '/native/oauth/authorize');
      expect(Uri.parse(uri.queryParameters['redirect_uri']!).host, '127.0.0.1');
      expect(await callback(uri, state: 'forged'), 400);
      expect(await callback(uri, issuer: 'https://other.example/native'), 400);
      expect(await callback(uri, duplicateState: true), 400);
      expect(
          transport.calls
              .where((row) => (row['path'] as String).endsWith('/token')),
          isEmpty);
      expect(await callback(uri), 200);
      return true;
    });
    addTearDown(auth.close);
    await auth.login();
    expect(auth.hasSession, true);
    final request = transport.calls
        .singleWhere((row) => (row['path'] as String).endsWith('/token'));
    final body = request['body'] as Map<String, dynamic>;
    expect(
        base64Url
            .encode(sha256
                .convert(ascii.encode(body['code_verifier'] as String))
                .bytes)
            .replaceAll('=', ''),
        opened!.queryParameters['code_challenge']);
    expect(body['redirect_uri'], opened!.queryParameters['redirect_uri']);
    expect(body['resource'], '$origin/native/api');
    expect(request['bearer'], isNull);
    final saved = jsonDecode(store.value!) as Map<String, dynamic>;
    expect(saved['refreshToken'], token('A'));
    expect(saved.containsKey('access_token'), false);
  });
  test('cancel and denial never establish a session or leave an open flow',
      () async {
    final store = MemoryStore(),
        transport = FakeTransport(),
        launched = Completer<void>();
    final auth =
        CoreAuth(origin, store: store, transport: transport, launch: (_) async {
      launched.complete();
      return true;
    });
    addTearDown(auth.close);
    final login = auth.login();
    await launched.future;
    final expected = expectLater(
        login,
        throwsA(
            isA<CoreException>().having((e) => e.code, 'code', 'cancelled')));
    await auth.cancelLogin();
    await expected;
    expect(store.value, isNull);
    expect(auth.hasSession, false);
    final denied = CoreAuth(origin,
        store: MemoryStore(), transport: FakeTransport(), launch: (uri) async {
      expect(await callback(uri, error: 'access_denied'), 200);
      return true;
    });
    addTearDown(denied.close);
    await expectLater(
        denied.login(),
        throwsA(isA<CoreException>()
            .having((e) => e.code, 'code', 'access_denied')));
  });
  test('login timeout is bounded and cannot mint tokens', () async {
    final transport = FakeTransport();
    final auth = CoreAuth(origin,
        store: MemoryStore(),
        transport: transport,
        loginTimeout: const Duration(milliseconds: 25),
        launch: (_) async => true);
    addTearDown(auth.close);
    await expectLater(
        auth.login(),
        throwsA(isA<CoreException>()
            .having((e) => e.code, 'code', 'login_timeout')));
    expect(transport.calls, isEmpty);
  });
  test(
      'late code exchange after logout is revoked and cannot restore stored credentials',
      () async {
    final transport = FakeTransport(),
        store = MemoryStore(),
        exchange = Completer<CoreReply>(),
        started = Completer<void>();
    transport.handler = (_, __) {
      started.complete();
      return exchange.future;
    };
    final auth = CoreAuth(origin, store: store, transport: transport,
        launch: (uri) async {
      await callback(uri);
      return true;
    });
    addTearDown(auth.close);
    final login = auth.login();
    final expected = expectLater(login, throwsA(isA<CoreException>()));
    await started.future;
    await auth.signOut();
    exchange.complete(tokens('b'));
    await expected;
    expect(auth.hasSession, false);
    expect(store.value, isNull);
    expect(
        transport.calls
            .where((row) => (row['path'] as String).endsWith('/revoke'))
            .length,
        1);
  });
  test(
      'late OS-store write is fenced by logout and no plaintext fallback exists',
      () async {
    final store = MemoryStore()
      ..writeStarted = Completer<void>()
      ..writeGate = Completer<void>();
    final transport = FakeTransport();
    final auth = CoreAuth(origin, store: store, transport: transport,
        launch: (uri) async {
      await callback(uri);
      return true;
    });
    addTearDown(auth.close);
    final login = auth.login();
    final expected = expectLater(login, throwsA(isA<CoreException>()));
    await store.writeStarted!.future;
    final logout = auth.signOut();
    store.writeGate!.complete();
    await expected;
    await logout;
    expect(store.value, isNull);
    expect(auth.hasSession, false);
    final broken = MemoryStore()..failWrite = true;
    final failed = CoreAuth(origin, store: broken, transport: FakeTransport(),
        launch: (uri) async {
      await callback(uri);
      return true;
    });
    addTearDown(failed.close);
    await expectLater(
        failed.login(),
        throwsA(isA<CoreException>()
            .having((e) => e.code, 'code', 'secure_storage_unavailable')));
    expect(broken.value, isNull);
    expect(failed.hasSession, false);
  });
  test('refresh is single-flight and an ambiguous refresh is not retried',
      () async {
    var now = DateTime.utc(2026, 10, 5);
    final transport = FakeTransport(), store = MemoryStore();
    final auth = await signedIn(store, transport, now: () => now);
    addTearDown(auth.close);
    now = now.add(const Duration(minutes: 15));
    final refresh = Completer<CoreReply>();
    var count = 0;
    transport.handler = (_, body) {
      expect(body!['grant_type'], 'refresh_token');
      count++;
      return refresh.future;
    };
    final first = auth.token(), second = auth.token();
    refresh.complete(tokens('b'));
    expect(await first, token('b'));
    expect(await second, token('b'));
    expect(count, 1);
    expect((jsonDecode(store.value!) as Map)['refreshToken'], token('B'));
    now = now.add(const Duration(minutes: 15));
    transport.handler = (_, __) async {
      count++;
      throw const CoreException('offline', uncertain: true);
    };
    await expectLater(auth.token(), throwsA(isA<CoreException>()));
    expect(auth.hasSession, false);
    expect(store.value, isNull);
    await expectLater(auth.token(), throwsA(isA<CoreException>()));
    expect(count, 2);
  });
  test(
      'restore is origin-bound and closing an established app preserves only the secured refresh',
      () async {
    final store = MemoryStore(), transport = FakeTransport();
    final auth = await signedIn(store, transport);
    auth.close();
    expect(store.value, isNotNull);
    final resumed = CoreAuth(origin, store: store, transport: FakeTransport());
    addTearDown(resumed.close);
    expect(await resumed.restore(), true);
    final foreignTransport = FakeTransport(base: 'https://other.example');
    final foreign = CoreAuth('https://other.example',
        store: store, transport: foreignTransport);
    addTearDown(foreign.close);
    final before = foreignTransport.calls.length;
    await expectLater(
        foreign.restore(),
        throwsA(isA<CoreException>()
            .having((e) => e.code, 'code', 'invalid_saved_session')));
    expect(foreignTransport.calls.length, before);
    expect(store.value, isNull);
  });
}
