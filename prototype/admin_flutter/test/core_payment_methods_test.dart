import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:restaurant_admin_prototype/core/api.dart';
import 'package:restaurant_admin_prototype/core/app.dart';
import 'package:restaurant_admin_prototype/core/controller.dart';
import 'package:restaurant_admin_prototype/core/payment_methods.dart';
import 'package:restaurant_admin_prototype/core/transport.dart';
import 'core_fakes.dart';

void main() {
  test('payment methods enforce explicit unique mode-specific choices', () {
    final data = FakeCoreGateway().paymentMethodsData;
    final view = CorePaymentMethods(data, tenantId: 'demo-a');
    view.validate('delivery', ['cash_on_delivery']);
    for (final choices in [
      <String>[],
      ['cash_before'],
      ['card', 'card'],
      ['unknown']
    ]) {
      expect(() => view.validate('delivery', choices),
          throwsA(isA<CoreException>()));
    }
    expect(
        () => view.validate('other', ['card']), throwsA(isA<CoreException>()));
    for (final patch in [
      {'demo': 'true'},
      {'currency': 'USD'},
      {'version': 0},
      {'modes': []},
      {
        'modes': [
          for (var i = 0; i < 3; i++)
            {
              'mode': 'delivery',
              'enabled': true,
              'methods': ['card']
            }
        ]
      },
      {
        'modes': [
          for (final key in paymentChoices.keys)
            {'mode': key, 'enabled': true, 'methods': []}
        ]
      },
    ]) {
      expect(() => CorePaymentMethods({...data, ...patch}, tenantId: 'demo-a'),
          throwsA(isA<CoreException>()));
    }
    final disabled = CorePaymentMethods({
      ...data,
      'modes': [
        for (final key in paymentChoices.keys)
          {'mode': key, 'enabled': false, 'methods': <String>[]}
      ]
    }, tenantId: 'demo-a');
    disabled.validate('pickup', []);
    expect(() => view.mode('delivery').methods.clear(), throwsUnsupportedError);
  });
  test('payment API validates acknowledgement and never retries a write',
      () async {
    final session = FakeCoreSession()..hasSession = true;
    final api = CoreApi(session), fake = FakeCoreGateway();
    final old = await fake.paymentMethods('demo-a');
    await fake.patchPaymentMethods(old, 'delivery', ['cash_on_delivery']);
    session.transport.handler = (_, __, ___) async =>
        CoreReply(200, {'tenantId': 'demo-a', ...fake.paymentMethodsData});
    await api.patchPaymentMethods(old, 'delivery', ['cash_on_delivery']);
    expect(session.transport.calls.single['body'], {
      'expectedVersion': 1,
      'mode': 'delivery',
      'methods': ['cash_on_delivery']
    });
    for (final patch in [
      {'tenantId': 'other'},
      {'version': 1},
      {'demo': false},
      {'modes': []}
    ]) {
      session.transport.calls.clear();
      session.transport.handler = (_, __, ___) async => CoreReply(
          200, {'tenantId': 'demo-a', ...fake.paymentMethodsData, ...patch});
      await expectLater(
          api.patchPaymentMethods(old, 'delivery', ['cash_on_delivery']),
          throwsA(isA<CoreException>()
              .having((e) => e.uncertain, 'uncertain', true)));
      expect(session.transport.calls.length, 1);
    }
  });
  test('controller rejects stale, offline, wrong tenant and revoked read/write',
      () async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['settings:read', 'settings:update']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    await c.selectSection(CoreSection.paymentMethods);
    final old = c.paymentMethods!;
    await c.patchPaymentMethods(old, 'delivery', ['cash_on_delivery']);
    expect(api.paymentMethodsWrites, 1);
    await c.patchPaymentMethods(old, 'delivery', ['card']);
    expect(api.paymentMethodsWrites, 1);
    final fresh = c.paymentMethods!;
    c.online = false;
    await c.patchPaymentMethods(fresh, 'delivery', ['card']);
    c.online = true;
    c.selectedTenant = 'other';
    await c.patchPaymentMethods(fresh, 'delivery', ['card']);
    c.selectedTenant = 'demo-a';
    for (final permissions in [
      ['settings:read'],
      ['settings:update']
    ]) {
      c.profile = profileFixture(permissions: permissions);
      await c.patchPaymentMethods(fresh, 'delivery', ['card']);
    }
    expect(api.paymentMethodsWrites, 1);
  });
  testWidgets(
      'payment review resets on edits, cancels cleanly and guards stale dialog',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['settings:read', 'settings:update']);
    api.session.restoreAvailable = true;
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    await tester.pumpWidget(CoreApp(controller: c));
    await tester.pumpAndSettle();
    final tab = find.widgetWithText(ChoiceChip, 'طرق الدفع');
    await tester.ensureVisible(tab);
    await tester.tap(tab);
    await tester.pumpAndSettle();
    final edit = find.text('مراجعة دفع التوصيل');
    Future<void> open() async {
      await tester.ensureVisible(edit);
      await tester.tap(edit);
      await tester.pumpAndSettle();
    }

    Finder save() => find.widgetWithText(FilledButton, 'حفظ طرق الدفع');
    await open();
    await tester.tap(find.widgetWithText(CheckboxListTile, 'الدفع الإلكتروني'));
    await tester.pumpAndSettle();
    expect(tester.widget<FilledButton>(save()).onPressed, isNull);
    await tester.tap(find.byKey(const ValueKey('payment-review')));
    await tester.pumpAndSettle();
    expect(tester.widget<FilledButton>(save()).onPressed, isNotNull);
    await tester.tap(find.text('إلغاء'));
    await tester.pumpAndSettle();
    expect(api.paymentMethodsWrites, 0);
    await open();
    await tester.tap(find.widgetWithText(CheckboxListTile, 'الدفع الإلكتروني'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('payment-review')));
    await tester.pumpAndSettle();
    await tester.tap(save());
    await tester.pumpAndSettle();
    expect(api.paymentMethodsWrites, 1);
    expect(c.paymentMethods!.mode('delivery').methods, ['cash_on_delivery']);
    await open();
    await tester.tap(find.widgetWithText(CheckboxListTile, 'الدفع الإلكتروني'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('payment-review')));
    await tester.pumpAndSettle();
    api.paymentMethodsData = {...api.paymentMethodsData, 'version': 3};
    await c.refresh();
    await tester.pumpAndSettle();
    expect(tester.widget<FilledButton>(save()).onPressed, isNull);
    api.currentProfile = profileFixture(permissions: ['settings:update']);
    await c.refresh();
    await tester.pumpAndSettle();
    expect(find.text('تغير المطعم أو صلاحياتك. أغلق النموذج.'), findsOneWidget);
    expect(find.text(paymentAvailabilityWarning), findsNothing);
    await tester.tap(find.text('إلغاء'));
    await tester.pumpAndSettle();
    expect(api.paymentMethodsWrites, 1);
  });
}
