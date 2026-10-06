import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:restaurant_admin_prototype/core/api.dart';
import 'package:restaurant_admin_prototype/core/auth.dart';
import 'package:restaurant_admin_prototype/core/controller.dart';
import 'package:restaurant_admin_prototype/core/transport.dart';
import 'core_live_http_test.dart' show base, EphemeralStore, fixtureClient;

void main() {
  test(
      'actual Dart support decisions preserve original cancellation and payment review',
      () async {
    final env = Platform.environment;
    expect(env['CORE_NATIVE_LIVE_TEST'] == '1', true,
        reason: 'Run only through the isolated Go/Node fixture');
    final port = int.parse(env['CORE_NATIVE_TLS_PORT']!);
    expect(port >= 1024 && port <= 65535, true);
    final cookie = env['CORE_NATIVE_BROWSER_COOKIE']!;
    expect(
        RegExp(r'^__Host-platform_session=[A-Za-z0-9_-]{43}$').hasMatch(cookie),
        true);
    final context = SecurityContext(withTrustedRoots: false)
      ..setTrustedCertificates(env['CORE_NATIVE_CERT_FILE']!);
    // Trust exactly the generated fixture certificate, still verify its hostname.
    // No badCertificateCallback and no OS trust/DNS/proxy settings are changed.
    final bad = BoundedCoreTransport(base,
        client: fixtureClient(context, port, verifyHost: 'wrong.example'));
    await expectLater(
        bad.request('GET', '/health'), throwsA(isA<CoreException>()));
    bad.close();
    final browser = fixtureClient(context, port);
    addTearDown(() => browser.close(force: true));
    final transport =
            BoundedCoreTransport(base, client: fixtureClient(context, port)),
        store = EphemeralStore();
    final now = DateTime.now();
    final auth = CoreAuth(base,
        store: store,
        transport: transport,
        now: () => now,
        launch: (authorization) async {
          expect(authorization.origin, base);
          final get = await browser.getUrl(authorization);
          get.followRedirects = false;
          get.headers.set(HttpHeaders.cookieHeader, cookie);
          final consent = await get.close();
          expect(consent.statusCode, 200);
          expect(consent.certificate != null, true);
          final html = await utf8.decoder.bind(consent).join();
          final csrf = RegExp(r'name="csrf" value="([A-Za-z0-9_-]+)"')
              .firstMatch(html)
              ?.group(1);
          expect(csrf != null, true);
          final approve =
              await browser.postUrl(Uri.parse('$base/native/oauth/authorize'));
          approve.followRedirects = false;
          approve.headers.set(HttpHeaders.cookieHeader, cookie);
          approve.headers.set('origin', base);
          approve.headers.contentType = ContentType.json;
          approve.write(jsonEncode({
            ...authorization.queryParameters,
            'csrf': csrf,
            'approve': 'yes'
          }));
          final response = await approve.close();
          expect(response.statusCode, 303);
          final callback =
              Uri.parse(response.headers.value(HttpHeaders.locationHeader)!);
          await response.drain<void>();
          expect(callback.scheme, 'http');
          expect(callback.host, '127.0.0.1');
          expect(callback.path, '/oauth/callback');
          // A new client ensures no browser cookie/Origin crosses to the callback.
          final local = HttpClient();
          try {
            final request = await local.getUrl(callback);
            request.followRedirects = false;
            final accepted = await request.close();
            expect(accepted.statusCode, 200);
            await accepted.drain<void>();
          } finally {
            local.close(force: true);
          }
          return true;
        });
    addTearDown(auth.close);
    await auth.login();
    expect(auth.hasSession, true);
    expect(store.value!.contains('access_token'), false);
    final api = CoreApi(auth),
        c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start();
    expect(c.profile!.id, env['CORE_NATIVE_PRINCIPAL']);
    await c.selectSection(CoreSection.support);
    final number = env['CORE_NATIVE_ORDER']!;
    expect(c.support!.orders.single.order.number, number);
    expect(c.canManageSupport, true);
    await c.showSupport(number);
    final before = c.supportDetail!;
    expect(before.cancellation!.open, true);
    expect(before.complaints.where((v) => v.open), hasLength(1));
    await c.changeSupport(before, before.cancellation!.id, 'decide',
        approve: true, reason: 'Synthetic native approved cancellation');
    expect(c.supportDetail!.order.status, 'cancelled', reason: c.message);
    expect(c.supportDetail!.order.paymentStatus, 'review');
    await c.showFinance(number);
    expect(c.finance!.refunded, 0);
    expect(c.finance!.refunds.single.authorized, false);
    expect(c.canManageRefund, false);
    c.closeDetail();
    final current = c.supportDetail!;
    await c.changeSupport(
        current, current.complaints.firstWhere((v) => v.open).id, 'resolve',
        reason: 'Synthetic native complaint resolution');
    expect(c.support!.orders, isEmpty, reason: c.message);
    expect(c.supportDetail!.complaints.any((v) => v.open), false);
    expect(c.supportDetail!.order.totalMinor, before.order.totalMinor);
    final logout = await auth.signOut();
    expect(logout.remoteRevoked, true);
    expect(store.value, isNull);
  }, timeout: const Timeout(Duration(seconds: 45)));
}
