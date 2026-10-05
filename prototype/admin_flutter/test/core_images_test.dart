import 'dart:async';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:restaurant_admin_prototype/core/api.dart';
import 'package:restaurant_admin_prototype/core/controller.dart';
import 'package:restaurant_admin_prototype/core/models.dart';
import 'package:restaurant_admin_prototype/core/menu_image_io.dart';
import 'package:restaurant_admin_prototype/core/menu_image_editor.dart';
import 'package:restaurant_admin_prototype/core/transport.dart';
import 'core_fakes.dart';

final png = Uint8List.fromList([137, 80, 78, 71, 13, 10, 26, 10]);
CoreMenuDetails imageDetails({int version = 1, String image = ''}) =>
    CoreMenuDetails({
      'version': version,
      'currency': 'SAR',
      'item': {
        ...object(menuJson()['items'][0]),
        'description': '',
        'options': [],
        'imageUrl': image
      }
    }, tenantId: 'demo-a');

class ImageGateway extends FakeCoreGateway {
  int uploads = 0;
  Completer<Uint8List>? imageGate;
  @override
  Future<CoreMenuDetails> uploadImage(
      CoreMenuDetails expected, Uint8List bytes) async {
    uploads++;
    if (writeError != null) throw writeError!;
    currentMenu = CoreMenu(
        {...menuDocument(currentMenu), 'version': expected.version + 1},
        tenantId: expected.tenantId);
    return imageDetails(version: expected.version + 1);
  }

  @override
  Future<Uint8List> image(CoreMenuDetails details) async =>
      imageGate?.future ?? png;
}

void main() {
  test('picker content validation rejects empty, SVG and oversized data', () {
    validateMenuImage(png);
    expect(
        () => validateMenuImage(Uint8List(0)), throwsA(isA<CoreException>()));
    expect(() => validateMenuImage(Uint8List.fromList('<svg/>'.codeUnits)),
        throwsA(isA<CoreException>()));
    expect(() => validateMenuImage(Uint8List(5 * 1024 * 1024 + 1)),
        throwsA(isA<CoreException>()));
  });
  test(
      'image API sends binary version only and rejects untrusted returned URLs',
      () async {
    final session = FakeCoreSession()..hasSession = true,
        api = CoreApi(session);
    var url = '/restaurant-media/${'a' * 64}.png';
    session.transport.handler = (_, __, ___) async => CoreReply(200, {
          'tenantId': 'demo-a',
          'version': 2,
          'currency': 'SAR',
          'item': {
            ...object(menuJson()['items'][0]),
            'description': '',
            'options': [],
            'imageUrl': url
          }
        });
    final result = await api.uploadImage(imageDetails(), png);
    expect(result.imageUrl, url);
    final call = session.transport.calls.single;
    expect(call['body'], isNull);
    expect(call['binary'], png);
    expect(call['catalogVersion'], 1);
    expect(call['path'],
        '/native/api/restaurants/demo-a/staff/menu/items/meal/image');
    url = 'https://untrusted.example/image.png';
    await expectLater(
        api.uploadImage(imageDetails(), png),
        throwsA(isA<CoreException>()
            .having((v) => v.uncertain, 'uncertain', true)));
    expect(() => api.image(imageDetails(image: url)),
        throwsA(isA<CoreException>()));
  });
  test(
      'stale and revoked image writes are not sent; late previews cannot cross logout',
      () async {
    final api = ImageGateway()
      ..currentProfile =
          profileFixture(permissions: ['menu:read', 'menu:update']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    final old = await c.menuDetails('meal');
    expect(await c.uploadMenuImage(old, png), isNotNull);
    expect(api.uploads, 1);
    expect(await c.uploadMenuImage(old, png), isNull);
    expect(api.uploads, 1);
    api.currentProfile = profileFixture(permissions: ['menu:read']);
    await c.refresh();
    expect(await c.uploadMenuImage(await c.menuDetails('meal'), png), isNull);
    expect(api.uploads, 1);
    final gate = Completer<Uint8List>();
    api.imageGate = gate;
    final pending = c.menuImage(imageDetails());
    final check = expectLater(pending, throwsA(isA<CoreException>()));
    await c.signOut();
    gate.complete(png);
    await check;
  });
  testWidgets(
      'choosing an image does not upload, cancellation clears choice, explicit upload is required',
      (tester) async {
    final api = ImageGateway()
      ..currentProfile =
          profileFixture(permissions: ['menu:read', 'menu:update']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    await c.start(restore: false);
    int picks = 0;
    await tester.pumpWidget(MaterialApp(
        home: Directionality(
            textDirection: TextDirection.rtl,
            child: MenuImageEditor(
                controller: c,
                tenant: 'demo-a',
                id: 'meal',
                picker: () async => ++picks == 2
                    ? null
                    : SelectedMenuImage('synthetic.png', png)))));
    await tester.pumpAndSettle();
    await tester.tap(find.text('اختيار صورة'));
    await tester.pumpAndSettle();
    expect(api.uploads, 0);
    expect(find.textContaining('synthetic.png'), findsOneWidget);
    await tester.tap(find.text('اختيار صورة'));
    await tester.pumpAndSettle();
    expect(find.textContaining('synthetic.png'), findsNothing);
    await tester.tap(find.text('اختيار صورة'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('رفع الصورة للصنف'));
    await tester.pumpAndSettle();
    expect(api.uploads, 1);
    api.currentProfile = profileFixture(permissions: ['orders:read']);
    await c.refresh();
    await tester.pumpAndSettle();
    expect(find.text('اختيار صورة'), findsNothing);
    expect(find.textContaining('تغيرت الجلسة'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    c.dispose();
  });
}
