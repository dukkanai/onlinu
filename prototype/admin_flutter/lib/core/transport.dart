import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:crypto/crypto.dart';

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
      {Map<String, dynamic>? body,
      String? bearer,
      Uint8List? binary,
      int? catalogVersion});
  Future<Uint8List> image(String path);
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
  static const maxImageBytes = 5 * 1024 * 1024;

  @override
  Future<CoreReply> request(String method, String path,
      {Map<String, dynamic>? body,
      String? bearer,
      Uint8List? binary,
      int? catalogVersion}) async {
    if (!path.startsWith('/') ||
        path.startsWith('//') ||
        path.contains('?') ||
        path.contains('#') ||
        path.contains('\\') ||
        !{'GET', 'POST', 'PUT'}.contains(method)) {
      throw const CoreException('invalid_request');
    }

    if (binary != null &&
        (body != null ||
            method != 'POST' ||
            !RegExp(r'^/native/api/restaurants/[a-z0-9][a-z0-9-]{0,63}/staff/menu/items/[A-Za-z0-9][A-Za-z0-9_-]{0,79}/image$')
                .hasMatch(path) ||
            catalogVersion == null ||
            catalogVersion < 1 ||
            catalogVersion > 9007199254740990))
      throw const CoreException('invalid_request');
    if (binary == null && catalogVersion != null)
      throw const CoreException('invalid_request');
    if (binary != null && (binary.isEmpty || binary.length > maxImageBytes))
      throw const CoreException('image_too_large');
    final payload = binary == null ? null : Uint8List.fromList(binary);
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
        if (payload != null) {
          request.headers.contentType =
              ContentType('application', 'octet-stream');
          request.headers.set('x-menu-version', catalogVersion.toString());
          request.add(payload);
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
      return await operation
          .timeout(Duration(seconds: payload == null ? 10 : 30), onTimeout: () {
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
  Future<Uint8List> image(String path) async {
    final match = RegExp(
            r'^/restaurant-media/[a-z0-9][a-z0-9-]{0,63}/([a-f0-9]{64})\.(png|jpg)$')
        .firstMatch(path);
    if (match == null) throw const CoreException('invalid_request');
    HttpClientRequest? active;
    var timedOut = false;
    try {
      final operation = () async {
        final request = await _client.getUrl(origin.replace(path: path));
        active = request;
        if (timedOut) {
          request.abort();
          throw const CoreException('timeout');
        }
        request.followRedirects = false;
        request.headers.set(HttpHeaders.acceptHeader, 'image/png,image/jpeg');
        // Public content-addressed media never receives a bearer or cookie.
        final response = await request.close();
        if (response.statusCode != 200) {
          request.abort();
          throw CoreException('image_unavailable', status: response.statusCode);
        }
        final expectedType = match[2] == 'png' ? 'image/png' : 'image/jpeg';
        if (response.contentLength > maxImageBytes ||
            response.headers.contentType?.mimeType != expectedType) {
          request.abort();
          throw const CoreException('invalid_response');
        }
        final builder = BytesBuilder(copy: false);
        var size = 0;
        await for (final chunk in response) {
          size += chunk.length;
          if (size > maxImageBytes) {
            request.abort();
            throw const CoreException('invalid_response');
          }
          builder.add(chunk);
        }
        final bytes = builder.takeBytes();
        final magic = match[2] == 'png'
            ? const [137, 80, 78, 71, 13, 10, 26, 10]
            : const [255, 216, 255];
        if (bytes.length < magic.length ||
            List.generate(magic.length, (i) => bytes[i] == magic[i])
                .contains(false) ||
            sha256.convert(bytes).toString() != match[1])
          throw const CoreException('invalid_response');
        return bytes;
      }();
      return await operation.timeout(const Duration(seconds: 15),
          onTimeout: () {
        timedOut = true;
        active?.abort();
        throw const CoreException('timeout');
      });
    } on CoreException {
      rethrow;
    } on IOException {
      throw const CoreException('image_unavailable');
    } on StateError {
      throw const CoreException('image_unavailable');
    }
  }

  @override
  void close() => _client.close(force: true);
}
