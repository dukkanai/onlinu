import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:restaurant_admin_prototype/core/api.dart';
import 'package:restaurant_admin_prototype/core/controller.dart';
import 'package:restaurant_admin_prototype/core/brand_models.dart';
import 'package:restaurant_admin_prototype/core/brand_pane.dart';
import 'package:restaurant_admin_prototype/core/transport.dart';
import 'core_fakes.dart';

Map<String, dynamic> brandFixture() => {
      'storefrontTemplate': 'classic',
      'font': 'system',
      'headingFont': '',
      'bodyFont': '',
      'buttonFont': '',
      'layout': 'grid',
      'textSize': 'normal',
      'radius': 'soft',
      'shadow': 'soft',
      'imageFit': 'cover',
      'hideHero': false,
      'introTitle': 'Synthetic private intro',
      'introText': ''
    };
Map<String, dynamic> brandStateFixture() => {
      'version': 1,
      'catalogVersion': 2,
      'live': brandFixture(),
      'draft': null,
      'hasPrevious': false
    };

class BrandGateway extends FakeCoreGateway {
  BrandGateway() {
    currentProfile =
        profileFixture(permissions: ['settings:read', 'settings:update']);
  }
  Map<String, dynamic> data = brandStateFixture();
  int brandWrites = 0;
  bool lost = false;
  Completer<CoreBrandState>? gate;
  @override
  Future<CoreBrandState> brand(String tenant) async =>
      CoreBrandState(data, tenantId: tenant);
  @override
  Future<CoreBrandState> brandCommand(CoreBrandState expected, String action,
      Map<String, dynamic> changes) async {
    brandWrites++;
    if (gate != null) return gate!.future;
    data = {
      ...data,
      'version': (data['version'] as int) + 1,
      if (action == 'draft')
        'draft': {
          ...(data['draft'] as Map<String, dynamic>? ??
              data['live'] as Map<String, dynamic>),
          ...changes
        },
      if (action == 'publish') ...{
        'live': data['draft'],
        'draft': null,
        'hasPrevious': true,
        'catalogVersion': (data['catalogVersion'] as int) + 1
      }
    };
    if (lost)
      throw const CoreException('order_outcome_unknown', uncertain: true);
    return CoreBrandState(data, tenantId: expected.tenantId);
  }
}

Future<void> openBrand(CoreController c) async {
  await c.start(restore: false);
  await c.selectSection(CoreSection.appearance);
}

void main() {
  test(
      'appearance model preserves font inheritance and rejects unknown choices or no-op edits',
      () {
    final state = CoreBrandState(brandStateFixture(), tenantId: 'demo-a');
    expect(state.live.values['headingFont'], '');
    expect(() => state.validate('draft', {}), throwsA(isA<CoreException>()));
    expect(() => state.validate('publish', {}), throwsA(isA<CoreException>()));
    expect(() => state.validate('draft', {'storefrontTemplate': 'invented'}),
        throwsA(isA<CoreException>()));
    state.validate('draft', {'hideHero': false, 'headingFont': ''});
  });
  test(
      'native appearance commands bind both versions and never send unedited brand fields',
      () async {
    final session = FakeCoreSession()..hasSession = true,
        api = CoreApi(session),
        state = CoreBrandState(brandStateFixture(), tenantId: 'demo-a');
    session.transport.handler = (_, __, ___) async => CoreReply(
        200, {'tenantId': 'demo-a', ...brandStateFixture(), 'version': 2});
    await api.brandCommand(
        state, 'draft', {'storefrontTemplate': 'editorial', 'hideHero': false});
    expect(session.transport.calls.single['body'], {
      ...state.review(),
      'storefrontTemplate': 'editorial',
      'hideHero': false
    });
    expect(
        session.transport.calls.single['path'], endsWith('/staff/brand/draft'));
  });
  test('uncertain draft reply only refreshes current original state', () async {
    final api = BrandGateway()..lost = true,
        c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await openBrand(c);
    await c.changeAppearance(
        c.appearance!, 'draft', {'storefrontTemplate': 'editorial'});
    expect(api.brandWrites, 1);
    expect(c.appearance!.draft!.values['storefrontTemplate'], 'editorial');
    expect(c.message, contains('لم تتأكد'));
  });
  test('stale appearance versions and duplicate clicks do not write twice',
      () async {
    final api = BrandGateway(),
        c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await openBrand(c);
    final old = c.appearance!;
    api.data = {...api.data, 'catalogVersion': 3};
    await c.refresh();
    await c.changeAppearance(old, 'draft', {'storefrontTemplate': 'editorial'});
    expect(api.brandWrites, 0);
    api.gate = Completer<CoreBrandState>();
    final current = c.appearance!;
    final first = c.changeAppearance(
        current, 'draft', {'storefrontTemplate': 'editorial'});
    await c.changeAppearance(
        current, 'draft', {'storefrontTemplate': 'editorial'});
    expect(api.brandWrites, 1);
    api.gate!.complete(current);
    await first;
  });
  testWidgets(
      'appearance choices require review and confirmation; revoked draft text is masked',
      (tester) async {
    final api = BrandGateway(),
        c = CoreController(api, pollInterval: const Duration(hours: 1));
    await openBrand(c);
    await tester.pumpWidget(MaterialApp(
        builder: (context, child) =>
            Directionality(textDirection: TextDirection.rtl, child: child!),
        home: Scaffold(
            body: BrandEditor(
                controller: c, state: c.appearance!, action: 'draft'))));
    await tester.pumpAndSettle();
    await tester
        .tap(find.byKey(const ValueKey('brand-storefrontTemplate-editorial')));
    await tester.tap(find.text('مراجعة تغييرات المظهر'));
    await tester.pumpAndSettle();
    expect(
        tester
            .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'تأكيد حفظ مسودة خاصة'))
            .onPressed,
        isNull);
    expect(api.brandWrites, 0);
    api.currentProfile = profileFixture(permissions: ['orders:read']);
    await c.refresh();
    await tester.pumpAndSettle();
    expect(find.textContaining('المطعم: demo-a'), findsNothing);
    expect(find.text('تأكيد حفظ مسودة خاصة'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    c.dispose();
  });
  testWidgets('saving a reviewed appearance draft leaves publication separate',
      (tester) async {
    final api = BrandGateway(),
        c = CoreController(api, pollInterval: const Duration(hours: 1));
    await openBrand(c);
    await tester.pumpWidget(MaterialApp(
        builder: (context, child) =>
            Directionality(textDirection: TextDirection.rtl, child: child!),
        home: Scaffold(
            body: SingleChildScrollView(child: BrandPane(controller: c)))));
    await tester.pumpAndSettle();
    Future<void> tap(Finder f) async {
      await tester.ensureVisible(f);
      await tester.pumpAndSettle();
      await tester.tap(f);
      await tester.pumpAndSettle();
    }

    await tap(find.text('تعديل مسودة المظهر'));
    await tap(find.byKey(const ValueKey('brand-storefrontTemplate-editorial')));
    await tap(find.text('مراجعة تغييرات المظهر'));
    await tap(find.byType(CheckboxListTile));
    await tap(find.text('تأكيد حفظ مسودة خاصة'));
    expect(api.brandWrites, 1);
    expect(c.appearance!.live.values['storefrontTemplate'], 'classic');
    expect(c.appearance!.draft!.values['storefrontTemplate'], 'editorial');
    await tester.pumpWidget(const SizedBox());
    c.dispose();
  });
}
