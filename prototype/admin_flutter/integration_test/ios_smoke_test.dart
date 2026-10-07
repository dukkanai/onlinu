import 'dart:io';
import 'dart:math';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:restaurant_admin_prototype/core/app.dart';
import 'package:restaurant_admin_prototype/core/controller.dart';
import 'package:restaurant_admin_prototype/core/session_store.dart';
import 'package:restaurant_admin_prototype/core/auth.dart';
import 'package:restaurant_admin_prototype/core/transport.dart';
import '../test/core_auth_test.dart' show FakeTransport, token;
import '../test/core_fakes.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('iOS Keychain isolates and removes only synthetic test values',
      (tester) async {
    expect(Platform.isIOS, true,
        reason: 'Requires an actual iOS Simulator plugin, not a channel mock.');
    final nonce =
        List.generate(20, (_) => Random.secure().nextInt(16).toRadixString(16))
            .join();
    final origin = 'https://ios-storage-$nonce.invalid';
    final first = OsCoreSessionStore(origin);
    final second = OsCoreSessionStore('https://ios-other-$nonce.invalid');
    try {
      expect(await first.read(), isNull);
      await first.write('synthetic-ios-$nonce');
      await second.write('independent-ios-$nonce');
      expect(await OsCoreSessionStore(origin).read(), 'synthetic-ios-$nonce');
      await first.delete();
      expect(await first.read(), isNull);
      expect(await second.read(), 'independent-ios-$nonce');
    } finally {
      await first.delete();
      await second.delete();
    }
    // Capability observation only: no browser or external account is opened.
    expect(await supportsLaunchMode(LaunchMode.externalApplication), true);
  });
  testWidgets(
      'iOS owned URL scheme reaches active PKCE login through the native plugin',
      (tester) async {
    expect(Platform.isIOS, true);
    const origin = 'https://control.invalid';
    final store = OsCoreSessionStore(origin);
    final transport = FakeTransport(base: origin);
    transport.handler = (_, body) async {
      expect(body!['client_id'], 'onlinu-native-ios-v1');
      expect(
          body['redirect_uri'], 'invalid.control.onlinu.ios:/oauth/callback');
      return CoreReply(200, {
        'access_token': token('a'),
        'refresh_token': token('A'),
        'expires_in': 900,
        'token_type': 'Bearer',
        'scope': nativeScope,
        'resource': '$origin/native/api',
      });
    };
    final auth = CoreAuth(origin,
        store: store,
        transport: transport,
        loginTimeout: const Duration(seconds: 30), launch: (authorize) async {
      // Route only to this disposable test app. No real identity provider,
      // browser account, external HTTPS page or credential is contacted.
      final values = authorize.queryParameters;
      expect(values['client_id'], 'onlinu-native-ios-v1');
      final callback =
          Uri.parse(values['redirect_uri']!).replace(queryParameters: {
        'code': token('c'),
        'state': values['state']!,
        'iss': '$origin/native',
      });
      return launchUrl(callback, mode: LaunchMode.externalApplication);
    });
    try {
      await auth.login();
      expect(auth.hasSession, true);
      expect(transport.calls.length, 1);
      expect(await store.read(), isNotNull);
      final result = await auth.signOut();
      expect(result.localCleared, true);
      expect(result.remoteRevoked, true);
      expect(await store.read(), isNull);
    } finally {
      auth.close();
      await store.delete();
    }
  });
  testWidgets(
      'iOS renderer shows Arabic orders and clears details after logout',
      (tester) async {
    expect(Platform.isIOS, true);
    final controller = CoreController(FakeCoreGateway(),
        pollInterval: const Duration(hours: 1));
    final boundary = GlobalKey();
    await tester.pumpWidget(
        RepaintBoundary(key: boundary, child: CoreApp(controller: controller)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('الدخول عبر المتصفح'));
    await tester.pumpAndSettle();
    expect(find.text('123.45 ر.س'), findsOneWidget);
    expect(Directionality.of(tester.element(find.text('آخر 100 طلب'))),
        TextDirection.rtl);
    await tester.ensureVisible(find.text('تفاصيل الطلب'));
    await tester.tap(find.text('تفاصيل الطلب'));
    await tester.pumpAndSettle();
    expect(find.textContaining('بدون ملح'), findsOneWidget);
    final render =
        boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final picture = await render.toImage(pixelRatio: 1);
    final bytes = await picture.toByteData(format: ui.ImageByteFormat.png);
    picture.dispose();
    expect(bytes, isNotNull);
    await File('${Directory.systemTemp.path}/onlinu-ios-orders.png')
        .writeAsBytes(bytes!.buffer.asUint8List());
    await tester.tap(find.byTooltip('إغلاق التفاصيل'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('تسجيل الخروج'));
    await tester.pumpAndSettle();
    expect(find.textContaining('بدون ملح'), findsNothing);
    expect(find.text('الدخول عبر المتصفح'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
}
