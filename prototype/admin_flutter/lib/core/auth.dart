import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:app_links/app_links.dart';
import 'package:crypto/crypto.dart';
import 'package:url_launcher/url_launcher.dart';

import 'native_client.dart';
import 'session_store.dart';
import 'transport.dart';

const nativeClientId = 'onlinu-native-windows-v1';
const nativeScope = 'staff:access';
typedef BrowserLauncher = Future<bool> Function(Uri uri);

class LogoutResult {
  const LogoutResult({required this.localCleared, required this.remoteRevoked});
  final bool localCleared;
  final bool remoteRevoked;
}

class _Tokens {
  const _Tokens(this.access, this.refresh, this.expiresAt);
  final String access;
  final String refresh;
  final DateTime expiresAt;
}

/// Separate native issuer/audience. Refresh is single-flight and never replayed
/// after an ambiguous result. Generation + serialized OS storage fence logout.
abstract interface class CoreSession {
  Uri get origin;
  CoreTransport get transport;
  bool get hasSession;
  Future<void> login();
  Future<bool> restore();
  Future<String> token();
  Future<LogoutResult> signOut();
  Future<LogoutResult> cancelLogin();
  void close();
}

class CoreAuth implements CoreSession {
  CoreAuth(String baseUrl,
      {required this.store,
      CoreTransport? transport,
      BrowserLauncher? launch,
      NativeClientPlatform? platform,
      Stream<String>? links,
      DateTime Function()? now,
      this.loginTimeout = const Duration(minutes: 5)})
      : origin = trustedOrigin(baseUrl),
        clientPlatform = platform ?? currentNativePlatform(),
        transport = transport ?? BoundedCoreTransport(baseUrl),
        _launch = launch ??
            ((uri) => launchUrl(uri, mode: LaunchMode.externalApplication)),
        _now = now ?? DateTime.now {
    if (this.transport.origin != origin)
      throw const CoreException('invalid_configuration');
    if (clientPlatform != NativeClientPlatform.windows) {
      if (baseUrl != origin.origin) {
        throw const CoreException('invalid_configuration');
      }
      mobileCallback(origin, clientPlatform);
      _linkSubscription = (links ?? AppLinks().stringLinkStream).listen(
        (value) => _receiveMobile?.call(value),
        onError: (Object _) => _linksUnavailable(),
        onDone: _linksUnavailable,
      );
    }
  }

  final Uri origin;
  final NativeClientPlatform clientPlatform;
  final CoreSessionStore store;
  final CoreTransport transport;
  final BrowserLauncher _launch;
  final DateTime Function() _now;
  final Duration loginTimeout;
  static final _opaque = RegExp(r'^[A-Za-z0-9_-]{43}$');
  int _generation = 0;
  bool _closed = false;
  _Tokens? _tokens;
  String? _candidate;
  HttpServer? _listener;
  StreamSubscription<String>? _linkSubscription;
  void Function(String)? _receiveMobile;
  bool _linksAvailable = true;
  Completer<Map<String, String>>? _pending;
  Future<void> _storageTail = Future<void>.value();
  Future<String>? _refreshing;
  int? _refreshGeneration;
  Future<bool>? _restoring;
  int? _restoreGeneration;

  String get clientId => nativeClientIdentifier(clientPlatform);
  String get issuer => '${origin.origin}/native';
  String get resource => '$issuer/api';
  bool get hasSession => !_closed && _tokens != null;
  bool _current(int generation) => !_closed && generation == _generation;
  String _random() {
    final random = Random.secure();
    return base64Url
        .encode(List<int>.generate(32, (_) => random.nextInt(256)))
        .replaceAll('=', '');
  }

  Future<T> _storage<T>(Future<T> Function() operation) {
    final result = _storageTail.then((_) => operation());
    _storageTail =
        result.then<void>((_) {}, onError: (Object _, StackTrace __) {});
    return result;
  }

  void _invalidate() {
    _generation++;
    _receiveMobile = null;
    _tokens = null;
    _candidate = null;
    final pending = _pending;
    _pending = null;
    if (pending != null && !pending.isCompleted)
      pending.complete({'error': 'cancelled'});
    final listener = _listener;
    _listener = null;
    if (listener != null) unawaited(listener.close(force: true));
  }

  bool _same(String actual, String expected) {
    if (actual.length != expected.length) return false;
    var difference = 0;
    for (var i = 0; i < expected.length; i++) {
      difference |= actual.codeUnitAt(i) ^ expected.codeUnitAt(i);
    }
    return difference == 0;
  }

  void _linksUnavailable() {
    _linksAvailable = false;
    final pending = _pending;
    if (pending != null && !pending.isCompleted) {
      pending.complete({'error': 'callback_unavailable'});
    }
  }

  Map<String, String>? _mobileOutcome(
      String raw, String redirect, String state) {
    if (raw.length > 4096 || !raw.startsWith('$redirect?')) return null;
    try {
      final uri = Uri.parse(raw);
      if (uri.hasFragment || raw.substring(0, raw.indexOf('?')) != redirect) {
        return null;
      }
      final values = uri.queryParametersAll;
      if (!values.keys.every(
              (key) => {'code', 'state', 'iss', 'error'}.contains(key)) ||
          !values.values.every((value) => value.length == 1) ||
          !_same(values['state']?.single ?? '', state) ||
          values['iss']?.single != issuer) return null;
      final code = values['code']?.single, error = values['error']?.single;
      if (error == 'access_denied' && code == null)
        return {'error': 'access_denied'};
      if (error == null && code != null && _opaque.hasMatch(code))
        return {'code': code};
    } on FormatException {/* Untrusted callback: ignore without diagnostics. */}
    return null;
  }

  Future<void> _callback(
      HttpRequest request,
      HttpServer listener,
      Completer<Map<String, String>> pending,
      String state,
      int generation) async {
    Map<String, String>? outcome;
    try {
      final values = request.uri.queryParametersAll;
      final valid = _current(generation) &&
          !pending.isCompleted &&
          request.method == 'GET' &&
          request.uri.path == '/oauth/callback' &&
          request.headers.value(HttpHeaders.hostHeader) ==
              '127.0.0.1:${listener.port}' &&
          request.uri.toString().length <= 4096 &&
          values.keys.every(
              (key) => {'code', 'state', 'iss', 'error'}.contains(key)) &&
          values.values.every((value) => value.length == 1) &&
          _same(values['state']?.single ?? '', state) &&
          values['iss']?.single == issuer;
      if (valid) {
        final code = values['code']?.single, error = values['error']?.single;
        if (error == 'access_denied' && code == null) {
          outcome = {'error': 'access_denied'};
        } else if (error == null && code != null && _opaque.hasMatch(code)) {
          outcome = {'code': code};
        }
      }
      request.response.statusCode = outcome == null ? 400 : 200;
      request.response.headers.contentType = ContentType.html;
      request.response.headers.set('Cache-Control', 'no-store');
      request.response.headers.set('Content-Security-Policy',
          "default-src 'none'; frame-ancestors 'none'");
      request.response.persistentConnection = false;
      request.response.write(outcome == null
          ? '<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><p>استجابة دخول غير صالحة.</p></html>'
          : '<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><p>يمكنك العودة إلى تطبيق Onlinu وإغلاق هذه الصفحة.</p></html>');
      await request.response.close();
      if (outcome != null && _current(generation) && !pending.isCompleted)
        pending.complete(outcome);
    } catch (_) {
      try {
        await request.response.close();
      } catch (_) {/* No sensitive diagnostics. */}
    }
  }

  Future<void> login() async {
    if (_closed) throw const CoreException('closed');
    final generation = _generation + 1;
    final previous = await signOut();
    if (!_current(generation)) throw const CoreException('cancelled');
    if (!previous.localCleared)
      throw const CoreException('secure_storage_unavailable');
    final verifier = _random(), state = _random();
    final challenge = base64Url
        .encode(sha256.convert(ascii.encode(verifier)).bytes)
        .replaceAll('=', '');
    HttpServer? listener;
    final pending = Completer<Map<String, String>>();
    try {
      _pending = pending;
      final callback = pending.future
          .timeout(loginTimeout, onTimeout: () => {'error': 'login_timeout'});
      final String redirect;
      if (clientPlatform == NativeClientPlatform.windows) {
        listener =
            await HttpServer.bind(InternetAddress.loopbackIPv4, 0, backlog: 4);
        if (!_current(generation)) throw const CoreException('cancelled');
        if (listener.port < 1024)
          throw const CoreException('callback_unavailable');
        listener.idleTimeout = const Duration(seconds: 10);
        _listener = listener;
        final activeListener = listener;
        listener.listen(
            (request) => unawaited(
                _callback(request, activeListener, pending, state, generation)),
            onError: (Object _) {
          if (!pending.isCompleted)
            pending.complete({'error': 'callback_unavailable'});
        });
        redirect = 'http://127.0.0.1:${listener.port}/oauth/callback';
      } else {
        if (!_linksAvailable) throw const CoreException('callback_unavailable');
        redirect = mobileCallback(origin, clientPlatform);
        _receiveMobile = (raw) {
          if (!_current(generation) || pending.isCompleted) return;
          final outcome = _mobileOutcome(raw, redirect, state);
          if (outcome != null) pending.complete(outcome);
        };
      }
      final authorize =
          origin.replace(path: '/native/oauth/authorize', queryParameters: {
        'client_id': clientId,
        'redirect_uri': redirect,
        'response_type': 'code',
        'resource': resource,
        'scope': nativeScope,
        'state': state,
        'code_challenge_method': 'S256',
        'code_challenge': challenge,
      });
      if (!await _launch(authorize).timeout(loginTimeout,
          onTimeout: () => throw const CoreException('login_timeout')))
        throw const CoreException('browser_unavailable');
      final result = await callback;
      if (!_current(generation)) throw const CoreException('cancelled');
      if (result['error'] != null) throw CoreException(result['error']!);
      final reply =
          await transport.request('POST', '/native/oauth/token', body: {
        'grant_type': 'authorization_code',
        'client_id': clientId,
        'redirect_uri': redirect,
        'resource': resource,
        'code': result['code'],
        'code_verifier': verifier,
      });
      await _accept(reply, generation);
    } on CoreException {
      rethrow;
    } on IOException {
      throw const CoreException('callback_unavailable');
    } catch (_) {
      throw const CoreException('login_failed');
    } finally {
      if (identical(_pending, pending)) {
        _listener = null;
        _pending = null;
        _receiveMobile = null;
      }
      if (!pending.isCompleted) pending.complete({'error': 'cancelled'});
      await listener?.close(force: true);
    }
  }

  _Tokens _parseTokens(CoreReply reply) {
    if (reply.status != 200)
      throw CoreException('authentication_required', status: reply.status);
    final data = reply.data;
    final access = data['access_token'],
        refresh = data['refresh_token'],
        seconds = data['expires_in'];
    if (access is! String ||
        refresh is! String ||
        !_opaque.hasMatch(access) ||
        !_opaque.hasMatch(refresh) ||
        seconds is! int ||
        seconds < 1 ||
        seconds > 900 ||
        data['token_type'] != 'Bearer' ||
        data['resource'] != resource ||
        data['scope'] != nativeScope) {
      throw const CoreException('invalid_response');
    }
    return _Tokens(access, refresh, _now().add(Duration(seconds: seconds)));
  }

  Future<void> _accept(CoreReply reply, int generation) async {
    final tokens = _parseTokens(reply);
    if (!_current(generation)) {
      await _revoke(tokens.refresh);
      throw const CoreException('cancelled');
    }
    try {
      await _storage(() async {
        if (!_current(generation)) throw const CoreException('cancelled');
        await store.write(jsonEncode({
          'version': 1,
          'origin': origin.origin,
          'clientId': clientId,
          'resource': resource,
          'refreshToken': tokens.refresh
        }));
        if (!_current(generation)) {
          await store.delete();
          throw const CoreException('cancelled');
        }
      });
    } catch (error) {
      await _revoke(tokens.refresh);
      if (_current(generation)) {
        _invalidate();
        try {
          await _storage(store.delete);
        } catch (_) {/* Fail closed. */}
      }
      if (error is CoreException) rethrow;
      throw const CoreException('secure_storage_unavailable');
    }
    if (!_current(generation)) {
      await _revoke(tokens.refresh);
      throw const CoreException('cancelled');
    }
    _tokens = tokens;
    _candidate = tokens.refresh;
  }

  String? _storedRefresh(String? raw) {
    if (raw == null) return null;
    if (raw.length > 4096) throw const CoreException('invalid_saved_session');
    dynamic decoded;
    try {
      decoded = jsonDecode(raw);
    } on FormatException {
      throw const CoreException('invalid_saved_session');
    }
    if (decoded is! Map<String, dynamic> ||
        decoded['version'] != 1 ||
        decoded['origin'] != origin.origin ||
        decoded['clientId'] != clientId ||
        decoded['resource'] != resource ||
        decoded['refreshToken'] is! String ||
        !_opaque.hasMatch(decoded['refreshToken'] as String)) {
      throw const CoreException('invalid_saved_session');
    }
    return decoded['refreshToken'] as String;
  }

  Future<bool> restore() {
    if (_closed) return Future<bool>.value(false);
    if (_tokens != null) return Future<bool>.value(true);
    if (_restoring != null && _restoreGeneration == _generation)
      return _restoring!;
    final generation = _generation;
    final operation = _restore(generation);
    _restoring = operation;
    _restoreGeneration = generation;
    unawaited(operation.then<void>((_) {
      if (identical(_restoring, operation)) _restoring = null;
    }, onError: (Object _, StackTrace __) {
      if (identical(_restoring, operation)) _restoring = null;
    }));
    return operation;
  }

  Future<bool> _restore(int generation) async {
    String? refresh;
    try {
      refresh = _storedRefresh(await _storage(store.read));
      if (!_current(generation) || refresh == null) return false;
      _candidate = refresh;
      await _renew(refresh, generation);
      return _current(generation);
    } catch (error) {
      if (_current(generation)) {
        _invalidate();
        try {
          await _storage(store.delete);
        } catch (_) {/* No plaintext fallback. */}
      }
      if (error is CoreException && error.code == 'cancelled') return false;
      if (error is CoreException) rethrow;
      throw const CoreException('secure_storage_unavailable');
    }
  }

  Future<String> token() {
    final tokens = _tokens;
    if (_closed || tokens == null)
      return Future<String>.error(
          const CoreException('authentication_required'));
    if (tokens.expiresAt.isAfter(_now().add(const Duration(seconds: 30))))
      return Future<String>.value(tokens.access);
    if (_refreshing != null && _refreshGeneration == _generation)
      return _refreshing!;
    final operation = _renew(tokens.refresh, _generation);
    _refreshing = operation;
    _refreshGeneration = _generation;
    unawaited(operation.then<void>((_) {
      if (identical(_refreshing, operation)) _refreshing = null;
    }, onError: (Object _, StackTrace __) {
      if (identical(_refreshing, operation)) _refreshing = null;
    }));
    return operation;
  }

  Future<String> _renew(String refresh, int generation) async {
    try {
      final reply =
          await transport.request('POST', '/native/oauth/token', body: {
        'grant_type': 'refresh_token',
        'client_id': clientId,
        'resource': resource,
        'refresh_token': refresh,
      });
      await _accept(reply, generation);
      if (!_current(generation)) throw const CoreException('cancelled');
      return _tokens!.access;
    } catch (error) {
      if (_current(generation)) {
        _invalidate();
        try {
          await _storage(store.delete);
        } catch (_) {/* Fail closed. */}
        await _revoke(refresh);
      }
      if (error is CoreException) rethrow;
      throw const CoreException('authentication_required');
    }
  }

  Future<bool> _revoke(String? refresh) async {
    if (refresh == null) return true;
    try {
      final reply = await transport.request('POST', '/native/oauth/revoke',
          body: {'client_id': clientId, 'token': refresh});
      return reply.status == 200;
    } catch (_) {
      return false;
    }
  }

  Future<LogoutResult> signOut() async {
    var refresh = _tokens?.refresh ?? _candidate;
    _invalidate();
    var cleared = true;
    if (refresh == null) {
      try {
        refresh = _storedRefresh(await _storage(store.read));
      } catch (_) {/* Still delete the owned key. */}
    }
    try {
      await _storage(store.delete);
    } catch (_) {
      cleared = false;
    }
    return LogoutResult(
        localCleared: cleared, remoteRevoked: await _revoke(refresh));
  }

  Future<LogoutResult> cancelLogin() => signOut();
  void close() {
    if (_closed) return;
    _invalidate();
    _closed = true;
    unawaited(_linkSubscription?.cancel());
    _linkSubscription = null;
    transport.close();
  }
}
