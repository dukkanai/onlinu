import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'models.dart';

class AdminApiException implements Exception {
  const AdminApiException(this.code, {this.status});
  final String code;
  final int? status;

  String get message => switch (status) {
        401 => 'انتهت جلسة التطوير. اختر الهوية من جديد.',
        403 => 'هذه الهوية غير مخولة للوصول إلى المطعم.',
        404 => 'الطلب غير متاح لهذه الهوية.',
        409 => 'تغير الطلب. حدّث القائمة قبل إعادة الإجراء.',
        _ => code == 'invalid_response'
            ? 'تعذر التحقق من استجابة الخادم. أوقفت التعديلات.'
            : 'تعذر الاتصال بالخادم المحلي. أوقفت التعديلات حتى نجاح التحديث.',
      };
}

abstract interface class AdminApi {
  Future<void> signIn(String identity);
  Future<List<Restaurant>> restaurants();
  Future<List<RestaurantOrder>> orders(String tenantId);
  Future<RestaurantOrder> updateStatus(
    String tenantId,
    RestaurantOrder order,
    String nextStatus,
  );
  void clearSession();
  void close();
}

/// Development fixture authentication is deliberately restricted to loopback.
/// No bearer, cookie, service token, or merchant identity is persisted to disk.
class RestAdminApi implements AdminApi {
  RestAdminApi(String address, {HttpClient? client})
      : baseUri = _localBaseUri(address),
        _client = client ?? HttpClient() {
    _client.connectionTimeout = const Duration(seconds: 5);
  }

  final Uri baseUri;
  final HttpClient _client;
  String? _bearer;
  Set<String> _tenantIds = {};
  int _sessionGeneration = 0;

  static Uri _localBaseUri(String address) {
    final uri = Uri.parse(address);
    if (uri.scheme != 'http' ||
        !{'127.0.0.1', 'localhost', '::1'}.contains(uri.host) ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment ||
        (uri.path.isNotEmpty && uri.path != '/')) {
      throw ArgumentError('The synthetic API must use a loopback HTTP origin.');
    }
    return uri.replace(path: '');
  }

  String get _origin => baseUri.origin;

  Future<Map<String, dynamic>> _request(
    String method,
    List<String> path, {
    Map<String, dynamic>? body,
    bool authenticated = true,
  }) async {
    HttpClientRequest? activeRequest;
    var timedOut = false;
    try {
      if (authenticated && _bearer == null) {
        throw const AdminApiException('unauthorized', status: 401);
      }
      final token = _bearer;
      final future = () async {
        final request = await _client.openUrl(
          method,
          baseUri.replace(pathSegments: path),
        );
        activeRequest = request;
        if (timedOut) {
          request.abort();
          throw const AdminApiException('timeout');
        }
        request.followRedirects = false;
        request.headers.set(HttpHeaders.acceptHeader, 'application/json');
        // /dev/session requires the exact configured local Origin even in a
        // native client. Matching it does not make this production auth.
        request.headers.set('Origin', _origin);
        if (authenticated) {
          request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
        }
        if (body != null) {
          request.headers.contentType = ContentType.json;
          request.write(jsonEncode(body));
        }
        final response = await request.close();
        final bytes = <int>[];
        await for (final chunk in response) {
          if (bytes.length + chunk.length > 256 * 1024) {
            request.abort();
            throw const AdminApiException('invalid_response');
          }
          bytes.addAll(chunk);
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          // Do not display arbitrary server bodies or follow token-bearing
          // redirects. Status alone selects a bounded local message.
          throw AdminApiException('request_failed',
              status: response.statusCode);
        }
        final decoded = jsonDecode(utf8.decode(bytes));
        if (decoded is! Map<String, dynamic>) {
          throw const AdminApiException('invalid_response');
        }
        return decoded;
      }();
      return await future.timeout(const Duration(seconds: 8), onTimeout: () {
        timedOut = true;
        activeRequest?.abort();
        throw const AdminApiException('timeout');
      });
    } on AdminApiException {
      rethrow;
    } on FormatException {
      throw const AdminApiException('invalid_response');
    } on IOException {
      throw const AdminApiException('offline');
    } on StateError {
      throw const AdminApiException('offline');
    }
  }

  @override
  Future<void> signIn(String identity) async {
    if (!{'merchant-a', 'merchant-b'}.contains(identity)) {
      throw const AdminApiException('unauthorized', status: 403);
    }
    clearSession();
    final generation = _sessionGeneration;
    final result = await _request(
      'POST',
      ['dev', 'session'],
      body: {'identity': identity},
      authenticated: false,
    );
    final principal = result['principal'];
    final token = result['accessToken'];
    final tenantId = identity == 'merchant-a' ? 'demo-a' : 'demo-b';
    final expiresAt = DateTime.tryParse(result['expiresAt']?.toString() ?? '');
    if (generation != _sessionGeneration ||
        token is! String ||
        token.isEmpty ||
        principal is! Map<String, dynamic> ||
        principal['id'] != identity ||
        principal['role'] != 'merchant' ||
        principal['tenantIds'] is! List ||
        (principal['tenantIds'] as List).length != 1 ||
        (principal['tenantIds'] as List).single != tenantId ||
        expiresAt == null ||
        !expiresAt.isAfter(DateTime.now())) {
      throw const AdminApiException('invalid_response');
    }
    _bearer = token;
    _tenantIds = {tenantId};
  }

  void _checkTenant(String tenantId) {
    if (!_tenantIds.contains(tenantId)) {
      throw const AdminApiException('forbidden', status: 403);
    }
  }

  @override
  Future<List<Restaurant>> restaurants() async {
    final result = await _request('GET', ['api', 'merchant', 'restaurants']);
    try {
      final list = (result['restaurants'] as List)
          .map((item) => Restaurant.fromJson(item as Map<String, dynamic>))
          .toList(growable: false);
      if (list.isEmpty || list.any((item) => !_tenantIds.contains(item.id))) {
        throw const AdminApiException('invalid_response');
      }
      return list;
    } on TypeError {
      throw const AdminApiException('invalid_response');
    }
  }

  RestaurantOrder _order(Map<String, dynamic> json, String tenantId) {
    try {
      final order = RestaurantOrder.fromJson(json);
      if (order.tenantId != tenantId ||
          order.currency != 'SAR' ||
          order.version < 1 ||
          order.totalMinor < 0) {
        throw const AdminApiException('invalid_response');
      }
      return order;
    } on TypeError {
      throw const AdminApiException('invalid_response');
    }
  }

  @override
  Future<List<RestaurantOrder>> orders(String tenantId) async {
    _checkTenant(tenantId);
    final result = await _request(
      'GET',
      ['api', 'merchant', 'restaurants', tenantId, 'orders'],
    );
    try {
      return (result['orders'] as List)
          .map((item) => _order(item as Map<String, dynamic>, tenantId))
          .toList(growable: false);
    } on TypeError {
      throw const AdminApiException('invalid_response');
    }
  }

  @override
  Future<RestaurantOrder> updateStatus(
    String tenantId,
    RestaurantOrder order,
    String nextStatus,
  ) async {
    _checkTenant(tenantId);
    if (order.tenantId != tenantId || order.nextStatus != nextStatus) {
      throw const AdminApiException('invalid_status', status: 409);
    }
    final result = await _request(
      'POST',
      [
        'api',
        'merchant',
        'restaurants',
        tenantId,
        'orders',
        order.id,
        'status'
      ],
      body: {'status': nextStatus, 'expectedVersion': order.version},
    );
    final updated = _order(result, tenantId);
    if (updated.id != order.id ||
        updated.version <= order.version ||
        updated.status != nextStatus) {
      throw const AdminApiException('invalid_response');
    }
    return updated;
  }

  @override
  void clearSession() {
    _sessionGeneration++;
    _bearer = null;
    _tenantIds = {};
  }

  @override
  void close() {
    clearSession();
    _client.close(force: true);
  }
}
