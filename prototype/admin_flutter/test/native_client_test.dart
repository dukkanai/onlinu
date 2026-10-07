import 'package:flutter_test/flutter_test.dart';
import 'package:restaurant_admin_prototype/core/native_client.dart';
import 'package:restaurant_admin_prototype/core/transport.dart';

void main() {
  test('mobile callback policy matches server platform-bound reverse domain',
      () {
    for (final platform in [
      NativeClientPlatform.android,
      NativeClientPlatform.ios
    ]) {
      expect(
          mobileCallback(Uri.parse('https://auth.platform.example'), platform),
          'example.platform.auth.onlinu.${platform.name}:/oauth/callback');
      expect(nativeClientIdentifier(platform),
          'onlinu-native-${platform.name}-v1');
    }
  });
  test(
      'mobile callback policy rejects loopback, private-shaped and port origins',
      () {
    for (final origin in [
      'http://platform.example',
      'https://localhost',
      'https://127.0.0.1',
      'https://[::1]',
      'https://platform.example:8443',
      'https://platform.local',
      'https://platform.localhost',
      'https://platform.internal',
      'https://one.1com',
      'https://bad_label.example',
      'https://a..example'
    ]) {
      expect(() => mobileCallback(Uri.parse(origin), NativeClientPlatform.ios),
          throwsA(isA<CoreException>()));
    }
    expect(
        () => mobileCallback(Uri.parse('https://platform.example'),
            NativeClientPlatform.windows),
        throwsA(isA<CoreException>()));
  });
}
