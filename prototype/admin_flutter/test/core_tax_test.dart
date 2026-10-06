import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:restaurant_admin_prototype/core/api.dart';
import 'package:restaurant_admin_prototype/core/app.dart';
import 'package:restaurant_admin_prototype/core/controller.dart';
import 'package:restaurant_admin_prototype/core/tax_models.dart';
import 'package:restaurant_admin_prototype/core/transport.dart';
import 'core_fakes.dart';

class LostTaxReplyGateway extends FakeCoreGateway {
  @override
  Future<void> patchTax(CoreTaxConfig expected,
      {required bool enabled,
      required int rateBps,
      required String taxNumber}) async {
    await super.patchTax(expected,
        enabled: enabled, rateBps: rateBps, taxNumber: taxNumber);
    throw const CoreException('order_outcome_unknown', uncertain: true);
  }
}

void main() {
  test(
      'tax uses exact basis points with Arabic digits and validates original bounds',
      () {
    expect(taxRateFromPercent('١٥٫٢٥'), 1525);
    expect(taxRateFromPercent('0'), 0);
    expect(taxRateFromPercent('100.00'), 10000);
    for (final value in ['100.01', '-1', '15.001', '1e2', '']) {
      expect(() => taxRateFromPercent(value), throwsA(isA<CoreException>()));
    }
    final config = CoreTaxConfig(FakeCoreGateway().taxData, tenantId: 'demo-a');
    expect(() => config.validate(enabled: true, rateBps: 1500, taxNumber: ''),
        throwsA(isA<CoreException>()));
    expect(
        () => config.validate(
            enabled: false, rateBps: 1500, taxNumber: 'line\nbreak'),
        throwsA(isA<CoreException>()));
    config.validate(enabled: false, rateBps: 0, taxNumber: '');
    expect(
        () => CoreTaxConfig(
            {...FakeCoreGateway().taxData, 'pricesIncludeTax': false},
            tenantId: 'demo-a'),
        throwsA(isA<CoreException>()));
  });
  test(
      'tax API binds explicit false, review and version and detects wrong result',
      () async {
    final session = FakeCoreSession()..hasSession = true,
        api = CoreApi(session),
        fake = FakeCoreGateway(),
        old = await fake.tax('demo-a');
    session.transport.handler = (_, __, ___) async => CoreReply(200,
        {'tenantId': 'demo-a', ...fake.taxData, 'version': 2, 'rateBps': 0});
    await api.patchTax(old, enabled: false, rateBps: 0, taxNumber: '');
    expect(session.transport.calls.single['body'], {
      'expectedVersion': 1,
      'reviewed': true,
      'enabled': false,
      'rateBps': 0,
      'taxNumber': ''
    });
    session.transport.handler = (_, __, ___) async =>
        CoreReply(200, {'tenantId': 'demo-a', ...fake.taxData, 'version': 2});
    await expectLater(
        api.patchTax(old, enabled: false, rateBps: 0, taxNumber: ''),
        throwsA(
            isA<CoreException>().having((e) => e.uncertain, 'unknown', true)));
  });
  test('tax controller refuses duplicate stale background and revoked edits',
      () async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['settings:read', 'settings:update']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    await c.selectSection(CoreSection.tax);
    final old = c.tax!;
    await c.patchTax(old, enabled: true, rateBps: 1500, taxNumber: 'SYNTHETIC');
    await c.patchTax(old, enabled: false, rateBps: 0, taxNumber: '');
    expect(api.taxWrites, 1);
    c.setSuspended(true);
    await c.patchTax(c.tax!, enabled: false, rateBps: 0, taxNumber: '');
    expect(api.taxWrites, 1);
  });
  test(
      'unknown tax result reads current configuration and never repeats the write',
      () async {
    final api = LostTaxReplyGateway()
      ..currentProfile =
          profileFixture(permissions: ['settings:read', 'settings:update']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    await c.selectSection(CoreSection.tax);
    await c.patchTax(c.tax!,
        enabled: true, rateBps: 1500, taxNumber: 'SYNTHETIC-UNKNOWN');
    expect(api.taxWrites, 1);
    expect(c.tax!.enabled, true);
    expect(c.tax!.taxNumber, 'SYNTHETIC-UNKNOWN');
  });
  testWidgets(
      'tax editor requires review, cancel is inert and new edits reset approval',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['settings:read', 'settings:update']);
    api.session.restoreAvailable = true;
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    await tester.pumpWidget(CoreApp(controller: c));
    await tester.pumpAndSettle();
    final tab = find.widgetWithText(ChoiceChip, 'الضريبة');
    await tester.ensureVisible(tab);
    await tester.tap(tab);
    await tester.pumpAndSettle();
    final edit = find.text('مراجعة إعدادات الضريبة');
    await tester.ensureVisible(edit);
    await tester.tap(edit);
    await tester.pumpAndSettle();
    expect(
        tester
            .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'حفظ إعدادات الضريبة'))
            .onPressed,
        isNull);
    await tester.tap(find.text('إلغاء'));
    await tester.pumpAndSettle();
    expect(api.taxWrites, 0);
    await tester.tap(edit);
    await tester.pumpAndSettle();
    final rate = find.widgetWithText(TextField, 'النسبة المئوية، مثل 15.00');
    await tester.enterText(rate, '5.25');
    tester.testTextInput.hide();
    final review = find.byType(CheckboxListTile);
    await tester.ensureVisible(review);
    await tester.pumpAndSettle();
    await tester.tap(review);
    await tester.pumpAndSettle();
    await tester.ensureVisible(rate);
    await tester.enterText(rate, '0');
    tester.testTextInput.hide();
    await tester.pumpAndSettle();
    expect(
        tester
            .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'حفظ إعدادات الضريبة'))
            .onPressed,
        isNull);
    await tester.ensureVisible(review);
    await tester.pumpAndSettle();
    await tester.tap(review);
    await tester.pumpAndSettle();
    await tester.tap(find.text('حفظ إعدادات الضريبة'));
    await tester.pumpAndSettle();
    expect(api.taxWrites, 1);
    expect(c.tax!.rateBps, 0);
  });
  testWidgets('tax revocation masks the private identifier and prevents save',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['settings:read', 'settings:update']);
    api.taxData['taxNumber'] = 'SYNTHETIC-PRIVATE-ID';
    api.session.restoreAvailable = true;
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    await tester.pumpWidget(CoreApp(controller: c));
    await tester.pumpAndSettle();
    final tab = find.widgetWithText(ChoiceChip, 'الضريبة');
    await tester.ensureVisible(tab);
    await tester.tap(tab);
    await tester.pumpAndSettle();
    final edit = find.text('مراجعة إعدادات الضريبة');
    await tester.ensureVisible(edit);
    await tester.tap(edit);
    await tester.pumpAndSettle();
    api.currentProfile = profileFixture(permissions: ['orders:read']);
    await c.refresh();
    await tester.pumpAndSettle();
    expect(find.byType(TextField), findsNothing);
    expect(find.textContaining('SYNTHETIC-PRIVATE-ID'), findsNothing);
    expect(api.taxWrites, 0);
    await tester.tap(find.text('إلغاء'));
    await tester.pumpAndSettle();
  });
}
