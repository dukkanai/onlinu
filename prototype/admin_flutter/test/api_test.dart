import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:restaurant_admin_prototype/api.dart';

Map<String, dynamic> orderJson(
        {String tenant = 'demo-a',
        int version = 1,
        String status = 'accepted'}) =>
    {
      'id': 'order-1',
      'tenantId': tenant,
      'status': status,
      'paymentStatus': 'paid',
      'version': version,
      'totalMinor': 4200,
      'currency': 'SAR',
      'items': [
        {'itemId': 'dish-1', 'name': 'طبق تجريبي', 'quantity': 2},
      ],
    };

void main() {
  test('fixture endpoint cannot target a public host or accept URL credentials',
      () {
    for (final address in [
      'https://example.com',
      'http://192.168.1.10:18787',
      'http://user:password@127.0.0.1:18787',
      'http://127.0.0.1:18787/path',
    ]) {
      expect(() => RestAdminApi(address), throwsArgumentError);
    }
  });

  test(
      'native session Origin, bearer routing and optimistic version match contract',
      () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final origin = 'http://127.0.0.1:${server.port}';
    final requests = <Map<String, dynamic>>[];
    final subscription = server.listen((request) async {
      final body = await utf8.decoder.bind(request).join();
      requests.add({
        'path': request.uri.path,
        'origin': request.headers.value('origin'),
        'authorization': request.headers.value('authorization'),
        'body': body.isEmpty ? null : jsonDecode(body),
      });
      Object response;
      if (request.uri.path == '/dev/session') {
        response = {
          'accessToken': 'synthetic-test-token',
          'expiresAt': DateTime.now()
              .add(const Duration(hours: 1))
              .toUtc()
              .toIso8601String(),
          'principal': {
            'id': 'merchant-a',
            'role': 'merchant',
            'tenantIds': ['demo-a']
          },
        };
      } else if (request.uri.path == '/api/merchant/restaurants') {
        response = {
          'restaurants': [
            {'id': 'demo-a', 'name': 'مطعم أ'}
          ]
        };
      } else if (request.uri.path.endsWith('/status')) {
        response = orderJson(version: 2, status: 'preparing');
      } else {
        response = {
          'orders': [orderJson()]
        };
      }
      request.response.headers.contentType = ContentType.json;
      request.response.write(jsonEncode(response));
      await request.response.close();
    });
    final api = RestAdminApi(origin);
    addTearDown(() async {
      api.close();
      await subscription.cancel();
      await server.close(force: true);
    });
    await api.signIn('merchant-a');
    final restaurants = await api.restaurants();
    final orders = await api.orders(restaurants.single.id);
    final updated =
        await api.updateStatus('demo-a', orders.single, 'preparing');
    expect(requests.first['origin'], origin);
    expect(requests.first['authorization'], isNull);
    expect(requests.first['body'], {'identity': 'merchant-a'});
    expect(
        requests.skip(1).every((request) =>
            request['authorization'] == 'Bearer synthetic-test-token'),
        isTrue);
    expect(
        requests.last['body'], {'status': 'preparing', 'expectedVersion': 1});
    expect(updated.version, 2);
    final count = requests.length;
    await expectLater(
        api.orders('demo-b'),
        throwsA(
            isA<AdminApiException>().having((e) => e.status, 'status', 403)));
    expect(requests.length, count);
    api.clearSession();
    await expectLater(
        api.restaurants(),
        throwsA(
            isA<AdminApiException>().having((e) => e.status, 'status', 401)));
    expect(requests.length, count);
  });
}
