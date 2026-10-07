import 'dart:io';

import 'transport.dart';

enum NativeClientPlatform { windows, android, ios }

NativeClientPlatform currentNativePlatform() => Platform.isAndroid
    ? NativeClientPlatform.android
    : Platform.isIOS
        ? NativeClientPlatform.ios
        : NativeClientPlatform.windows;

String nativeClientIdentifier(NativeClientPlatform platform) =>
    'onlinu-native-${platform.name}-v1';

/// Mirrors the server's operator-configured reverse-domain callback policy.
/// This validates syntax, not publisher domain ownership or OS registration.
String mobileCallback(Uri origin, NativeClientPlatform platform) {
  final labels = origin.host.split('.');
  if (platform == NativeClientPlatform.windows ||
      origin.scheme != 'https' ||
      origin.hasPort ||
      origin.host.length > 253 ||
      labels.length < 2 ||
      !RegExp(r'^[a-z]').hasMatch(labels.last) ||
      labels.any((label) =>
          !RegExp(r'^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$').hasMatch(label)) ||
      {'localhost', 'local', 'internal'}.contains(labels.last)) {
    throw const CoreException('invalid_configuration');
  }
  return '${labels.reversed.join('.')}.onlinu.${platform.name}:/oauth/callback';
}
