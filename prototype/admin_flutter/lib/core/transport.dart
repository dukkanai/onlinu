import 'dart:async';
import 'dart:convert';
import 'dart:io';

class CoreException implements Exception {
  const CoreException(this.code, {this.status, this.uncertain = false});
  final String code;
  final int? status;
  final bool uncertain;
  @override
  String toString() => 'CoreException($code)';
}

Uri trustedOrigin(String value) {
  final Uri uri;
  try {
    uri = Uri.parse(value);
  } on FormatException {
    throw const CoreException('invalid_configuration');
  }
  if (value.length > 2048 ||
      uri.scheme != 'https' ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.hasQuery ||
      uri.hasFragment ||
      (uri.path.isNotEmpty && uri.path != '/')) {
    throw const CoreException('invalid_configuration');
  }
  return uri.replace(path: '');
}

class CoreReply {
  const CoreReply(this.status, this.data);
  final int status;
  final Map<String, dynamic> data;
}

abstract interface class CoreTransport {
  Uri get origin;
  Future<CoreReply> request(String method, String path,
      {Map<String, dynamic>? body, String? bearer});
  void close();
}

/// No redirects, cookies, Origin, service keys, raw error bodies or TLS bypass.
class BoundedCoreTransport implements CoreTransport {
  BoundedCoreTransport(String baseUrl, {HttpClient? client})
      : origin = trustedOrigin(baseUrl),
        _client = client ?? HttpClient() {
    _client.connectionTimeout = const Duration(seconds: 5);
  }
  final Uri origin;
  final HttpClient _client;
  static const maxBytes = 2 * 1024 * 1024;

  @override
  Future<CoreReply> request(String method, String path,
      {Map<String, dynamic>? body, String? bearer}) async {
    if (!path.startsWith('/') ||
        path.startsWith('//') ||
        path.contains('?') ||
        path.contains('#') ||
        path.contains('\\') ||
        !{'GET', 'POST', 'PUT'}.contains(method)) {
      throw const CoreException('invalid_request');
    }
    HttpClientRequest? active;
    var timedOut = false;
    try {
      final operation = () async {
        final request =
            await _client.openUrl(method, origin.replace(path: path));
        active = request;
        if (timedOut) {
          request.abort();
          throw const CoreException('timeout');
        }
        request.followRedirects = false;
        request.headers.set(HttpHeaders.acceptHeader, 'application/json');
        if (bearer != null) {
          if (!RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(bearer)) {
            request.abort();
            throw const CoreException('authentication_required');
          }
          request.headers
              .set(HttpHeaders.authorizationHeader, 'Bearer $bearer');
        }
        if (body != null) {
          final encoded = utf8.encode(jsonEncode(body));
          if (encoded.length > 128 * 1024) {
            request.abort();
            throw const CoreException('invalid_request');
          }
          request.headers.contentType = ContentType.json;
          request.add(encoded);
        }
        final response = await request.close();
        if (response.contentLength > maxBytes) {
          request.abort();
          throw CoreException('invalid_response', uncertain: method != 'GET');
        }
        final bytes = <int>[];
        await for (final chunk in response) {
          if (bytes.length + chunk.length > maxBytes) {
            request.abort();
            throw CoreException('invalid_response', uncertain: method != 'GET');
          }
          bytes.addAll(chunk);
        }
        if (response.statusCode >= 300 && response.statusCode < 400) {
          throw CoreException('redirect_rejected',
              status: response.statusCode, uncertain: method != 'GET');
        }
        if (response.headers.contentType?.mimeType != 'application/json') {
          throw CoreException('invalid_response', uncertain: method != 'GET');
        }
        final decoded = jsonDecode(utf8.decode(bytes));
        if (decoded is! Map<String, dynamic>) {
          throw CoreException('invalid_response', uncertain: method != 'GET');
        }
        return CoreReply(response.statusCode, decoded);
      }();
      return await operation.timeout(const Duration(seconds: 10),
          onTimeout: () {
        timedOut = true;
        active?.abort();
        throw CoreException('timeout', uncertain: method != 'GET');
      });
    } on CoreException {
      rethrow;
    } on FormatException {
      throw CoreException('invalid_response', uncertain: method != 'GET');
    } on IOException {
      throw CoreException('offline', uncertain: method != 'GET');
    } on StateError {
      throw CoreException('offline', uncertain: method != 'GET');
    }
  }

  @override
  void close() => _client.close(force: true);
}
