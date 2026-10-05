import 'dart:convert';
import 'package:crypto/crypto.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

abstract interface class CoreSessionStore {
  Future<String?> read();
  Future<void> write(String value);
  Future<void> delete();
}

/// One app/origin-specific OS-secured key; never delete another app's values.
class OsCoreSessionStore implements CoreSessionStore {
  OsCoreSessionStore(String origin, {FlutterSecureStorage? storage})
      : _storage = storage ?? const FlutterSecureStorage(),
        _key = 'onlinu_native_v1_${sha256.convert(utf8.encode(origin))}';
  final FlutterSecureStorage _storage;
  final String _key;
  @override
  Future<String?> read() => _storage.read(key: _key);
  @override
  Future<void> write(String value) => _storage.write(key: _key, value: value);
  @override
  Future<void> delete() => _storage.delete(key: _key);
}
