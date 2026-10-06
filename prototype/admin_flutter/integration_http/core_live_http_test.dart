import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:restaurant_admin_prototype/core/api.dart';
import 'package:restaurant_admin_prototype/core/delivery_models.dart';
import 'package:restaurant_admin_prototype/core/team_models.dart';
import 'package:restaurant_admin_prototype/core/auth.dart';
import 'package:restaurant_admin_prototype/core/controller.dart';
import 'package:restaurant_admin_prototype/core/session_store.dart';
import 'package:restaurant_admin_prototype/core/transport.dart';

const base = 'https://platform.example';

class EphemeralStore implements CoreSessionStore {
  String? value;
  @override
  Future<String?> read() async => value;
  @override
  Future<void> write(String input) async {
    value = input;
  }

  @override
  Future<void> delete() async {
    value = null;
  }
}

HttpClient fixtureClient(SecurityContext context, int port,
    {String? verifyHost}) {
  final client = HttpClient(context: context)..findProxy = (_) => 'DIRECT';
  client.connectionTimeout = const Duration(seconds: 5);
  client.connectionFactory = (uri, proxyHost, proxyPort) async {
    if (uri.origin != base || proxyHost != null || proxyPort != null)
      throw StateError('Fixture routing cannot leave the reserved origin');
    // A separate synthetic native device has its own loopback source address.
    // Keep the production per-IP budget intact; the long browser suite uses .1.
    final tcp = await Socket.startConnect(InternetAddress.loopbackIPv4, port,
        sourceAddress: InternetAddress('127.0.0.2'));
    Socket? raw;
    final secured = tcp.socket.then((socket) {
      raw = socket;
      return SecureSocket.secure(socket,
          host: verifyHost ?? uri.host, context: context);
    });
    return ConnectionTask.fromSocket<Socket>(secured, () {
      tcp.cancel();
      raw?.destroy();
    });
  };
  return client;
}

void main() {
  test(
      'real native TLS protocol, typed core operations and refresh-family revocation',
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
    var now = DateTime.now();
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
        controller = CoreController(CoreApi(auth),
            pollInterval: const Duration(hours: 1));
    addTearDown(controller.dispose);
    await controller.start();
    expect(controller.profile!.id, env['CORE_NATIVE_PRINCIPAL']);
    expect(controller.selectedTenant, 'restaurant-a');
    final number = env['CORE_NATIVE_ORDER']!;
    expect(controller.orders.any((v) => v.number == number), true);
    await controller.showDetail(number);
    expect(controller.detail!.totalMinor, 3500);
    expect(controller.detail!.items.isNotEmpty, true);
    final existing = controller.orders.firstWhere((v) => v.number == number);
    expect(existing.status, 'accepted');
    await controller.change(existing);
    expect(controller.orders.firstWhere((v) => v.number == number).status,
        'preparing');

    final roster = await api.couriers('restaurant-a');
    expect(roster, hasLength(1));
    final assigned = await api.assignCourier('restaurant-a',
        await api.detail('restaurant-a', number), roster.single.id);
    expect(assigned.courierName, roster.single.name);
    expect(assigned.deliveryStatus, 'assigned');
    final unassigned = await api.assignCourier('restaurant-a', assigned, '');
    expect(unassigned.courierId, '');
    expect(unassigned.version, assigned.version + 1);

    final finance = await api.finance('restaurant-a', number);
    expect(finance.number, number);
    expect(finance.total, 3500);
    expect(finance.captured, 0);
    expect(finance.refunds, isEmpty);

    final intake = await api.service('restaurant-a');
    expect(intake.flags['acceptingOrders'], true);
    await api.patchService(intake, {'acceptingOrders': false});
    final paused = await api.service('restaurant-a');
    expect(paused.flags['acceptingOrders'], false);
    expect(
        (await api.detail('restaurant-a', number)).version, unassigned.version);
    await expectLater(
        api.patchService(intake, {'acceptingOrders': true}),
        throwsA(isA<CoreException>()
            .having((e) => e.code, 'stale service', 'catalog_changed')));
    await api.patchService(paused, {'acceptingOrders': true});
    expect((await api.service('restaurant-a')).flags, intake.flags);

    final beforeBrand = await api.brand('restaurant-a');
    final brandDraft = await api.brandCommand(beforeBrand, 'draft',
        {'storefrontTemplate': 'compact', 'headingFont': 'amiri'});
    expect(brandDraft.draft!.values['storefrontTemplate'], 'compact');
    expect(brandDraft.live.values, beforeBrand.live.values);
    await expectLater(
        api.brandCommand(beforeBrand, 'draft', {'hideHero': true}),
        throwsA(isA<CoreException>()
            .having((e) => e.code, 'stale appearance', 'brand_changed')));
    final publishedBrand = await api.brandCommand(brandDraft, 'publish', {});
    expect(publishedBrand.live.values['storefrontTemplate'], 'compact');
    expect(publishedBrand.draft, isNull);
    final restoredBrand = await api.brandCommand(publishedBrand, 'revert', {});
    expect(restoredBrand.live.values, beforeBrand.live.values);

    final team = await api.team('restaurant-a');
    final self = team.singleWhere(
        (v) => v.principalId == Platform.environment['CORE_NATIVE_PRINCIPAL']);
    final change = TeamChange(
        principalId: self.principalId,
        role: self.role,
        permissions: self.permissions,
        enabled: self.enabled,
        displayName: 'Synthetic native owner',
        expectedVersion: self.version);
    final updatedMember = await api.setMember('restaurant-a', change);
    expect(updatedMember.version, self.version + 1);
    await expectLater(
        api.setMember('restaurant-a', change),
        throwsA(isA<CoreException>()
            .having((v) => v.code, 'stale member', 'version_conflict')));
    await expectLater(
        api.setMember(
            'restaurant-a',
            TeamChange(
                principalId: self.principalId,
                role: self.role,
                permissions: self.permissions,
                enabled: false,
                displayName: updatedMember.displayName,
                expectedVersion: updatedMember.version)),
        throwsA(isA<CoreException>()
            .having((v) => v.code, 'last owner', 'last_owner_required')));

    final business = await api.businessProfile('restaurant-a');
    await api.patchBusinessProfile(
        business, {'description': 'Synthetic native profile'});
    final changedBusiness = await api.businessProfile('restaurant-a');
    expect(changedBusiness.fields['description'], 'Synthetic native profile');
    expect(changedBusiness.fields['name'], business.fields['name']);
    await expectLater(
        api.patchBusinessProfile(business, {'name': 'Stale'}),
        throwsA(isA<CoreException>()
            .having((v) => v.code, 'stale profile', 'catalog_changed')));

    final delivery = await api.delivery('restaurant-a');
    final regions = await api.geography('restaurant-a', 'regions');
    expect(regions.places.map((v) => v.id), contains('sa-r-1'));
    expect(regions.license, 'GPL-2.0');
    final cities =
        await api.geography('restaurant-a', 'cities', parent: 'sa-r-1');
    expect(cities.places.single.id, 'sa-c-1');
    final districts =
        await api.geography('restaurant-a', 'districts', parent: 'sa-c-1');
    expect(districts.places.single.id, 'sa-d-1');
    await api.setDeliveryZone(delivery,
        district: 'sa-d-1', enabled: true, fee: 0);
    final zoned = await api.delivery('restaurant-a');
    expect(zoned.zones.single.fee, 0);
    expect(zoned.zones.single.label, 'السلام');
    expect(zoned.zones.single.active, true);
    await expectLater(
        api.setDeliveryPricing(delivery,
            mode: 'district', fee: delivery.fee, minimum: delivery.minimum),
        throwsA(isA<CoreException>()
            .having((v) => v.code, 'stale delivery', 'catalog_changed')));
    await api.setDeliveryPricing(zoned,
        mode: 'district', fee: delivery.fee, minimum: delivery.minimum);
    final priced = await api.delivery('restaurant-a');
    expect(priced.mode, 'district');
    await api.setDeliveryPricing(priced,
        mode: delivery.mode, fee: delivery.fee, minimum: delivery.minimum);

    final locationBefore = await api.delivery('restaurant-a');
    expect(locationBefore.locationKnown, true);
    const locationChange = DeliveryLocationChange(
        latitude: 0, longitude: 0, radius: 1, requireLocation: true);
    await api.setDeliveryLocation(locationBefore, locationChange);
    final locationAfter = await api.delivery('restaurant-a');
    expect(locationAfter.latitude, 0);
    expect(locationAfter.longitude, 0);
    expect(locationAfter.radius, 1);
    expect(locationAfter.requireLocation, true);
    await expectLater(
        api.setDeliveryLocation(locationBefore, locationChange),
        throwsA(isA<CoreException>()
            .having((e) => e.code, 'stale origin', 'catalog_changed')));
    await api.setDeliveryLocation(
        locationAfter,
        DeliveryLocationChange(
            latitude: locationBefore.latitude,
            longitude: locationBefore.longitude,
            radius: locationBefore.radius,
            requireLocation: locationBefore.requireLocation));
    final locationRestored = await api.delivery('restaurant-a');
    expect(locationRestored.latitude, locationBefore.latitude);
    expect(locationRestored.radius, locationBefore.radius);

    final menu = await api.menu('restaurant-a'), item = menu.items.first;
    await api.patchMenu(menu, item,
        name: item.name,
        categoryId: item.categoryId,
        price: item.priceMinor,
        available: item.available);
    final detail = await api.menuDetails('restaurant-a', item.id);
    await api.patchMenuDetails(detail,
        description: detail.description, options: detail.options);
    final beforeImage = await api.menuDetails('restaurant-a', item.id);
    final imageBytes = base64Decode(Platform.environment['CORE_NATIVE_IMAGE']!);
    final uploaded = await api.uploadImage(beforeImage, imageBytes);
    expect(uploaded.version > beforeImage.version, true);
    expect(uploaded.description, beforeImage.description);
    expect(uploaded.options.map((v) => v.toJson()).toList(),
        beforeImage.options.map((v) => v.toJson()).toList());
    final image = await api.image(uploaded);
    expect(image.take(8), [137, 80, 78, 71, 13, 10, 26, 10]);
    await expectLater(
        api.uploadImage(beforeImage, imageBytes),
        throwsA(isA<CoreException>()
            .having((v) => v.code, 'stale', 'catalog_changed')));
    await expectLater(api.uploadImage(uploaded, base64Decode('PHN2Zy8+')),
        throwsA(isA<CoreException>()));
    final current = await api.menu('restaurant-a'),
        category = current.categories.first;
    await api.patchCategory(current, category,
        name: category.name, sort: category.sort);
    final stock = (await api.stock('restaurant-a')).first;
    final recounted = await api.setStock('restaurant-a', stock,
        tracked: stock.tracked, available: stock.tracked ? stock.available : 0);
    expect(recounted.held, stock.held);
    expect(recounted.version > stock.version, true);
    final channels = await api.channels('restaurant-a');
    expect(channels.length, 4);
    expect(channels.any((v) => !v.adapterImplemented), true);
    final enabled = channels.firstWhere((v) => v.adapterImplemented);
    final changedChannel = await api.setChannel(
        'restaurant-a', enabled, !enabled.newOrdersEnabled);
    final restoredChannel = await api.setChannel(
        'restaurant-a', changedChannel, enabled.newOrdersEnabled);
    expect(restoredChannel.newOrdersEnabled, enabled.newOrdersEnabled);
    final beforeCreate = await api.menu('restaurant-a');
    await api.createMenuCategory(beforeCreate,
        id: 'native-live-category', name: 'تصنيف اختبار Dart', sort: 10);
    final withCategory = await api.menu('restaurant-a');
    await api.createMenuItem(withCategory,
        id: 'native-live-item',
        name: 'صنف اختبار Dart',
        categoryId: 'native-live-category',
        price: 725,
        sort: 10);
    final created = (await api.menu('restaurant-a'))
        .items
        .firstWhere((v) => v.id == 'native-live-item');
    expect(created.available, false);
    expect(created.priceMinor, 725);

    final before = jsonDecode(store.value!) as Map<String, dynamic>;
    now = now.add(const Duration(minutes: 16));
    await api.profile();
    final after = jsonDecode(store.value!) as Map<String, dynamic>;
    expect(before['refreshToken'] != after['refreshToken'], true);
    final reused =
        await transport.request('POST', '/native/oauth/token', body: {
      'grant_type': 'refresh_token',
      'client_id': nativeClientId,
      'resource': '$base/native/api',
      'refresh_token': before['refreshToken']
    });
    expect(reused.status, 400);
    await controller.refresh();
    expect(auth.hasSession, false);
    expect(controller.profile, isNull);
    expect(controller.orders, isEmpty);
    expect(store.value, isNull);
  }, timeout: const Timeout(Duration(seconds: 45)));
}
