import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:restaurant_admin_prototype/core/api.dart';
import 'package:restaurant_admin_prototype/core/app.dart';
import 'package:restaurant_admin_prototype/core/controller.dart';
import 'package:restaurant_admin_prototype/core/opening_schedule.dart';
import 'package:restaurant_admin_prototype/core/transport.dart';
import 'core_fakes.dart';

void main() {
  test(
      'opening model requires explicit policy and validates dates, midnight and overlap',
      () {
    final source = FakeCoreGateway().openingData,
        policy = CoreOpeningSchedule(source, tenantId: 'demo-a');
    for (final key in [
      'enabled',
      'timeZone',
      'weekly',
      'exceptions',
      'version'
    ]) {
      final copy = {...source}..remove(key);
      expect(() => CoreOpeningSchedule(copy, tenantId: 'demo-a'),
          throwsA(isA<CoreException>()));
    }
    final days = List.filled(7, '09:00-14:00, 17:00-24:00');
    final changed = policy.edited(
        enabled: true,
        days: days,
        dates: '2028-02-29 =\n2026-12-01 = 10:00-16:00');
    expect(changed.weekly[0].last.end, 1440);
    expect(changed.exceptions.first.date, '2026-12-01');
    expect(policy.enabled, false);
    expect(policy.weekly.first, isEmpty);
    for (final text in [
      '23:00-02:00',
      '09:00-09:00',
      '23:60-24:00',
      '00:00-24:01',
      '09:00-14:00, 13:00-17:00'
    ]) {
      expect(
          () => policy.edited(
              enabled: true, days: [text, ...days.skip(1)], dates: ''),
          throwsA(isA<CoreException>()));
    }
    for (final dates in [
      '2026-02-29 =',
      '2026-04-31 =',
      '2026-12-01 =\n2026-12-01 ='
    ]) {
      expect(() => policy.edited(enabled: true, days: days, dates: dates),
          throwsA(isA<CoreException>()));
    }
    expect(() => changed.weekly.first.clear(), throwsUnsupportedError);
  });
  test(
      'opening API validates complete echoed revision and never retries unknown results',
      () async {
    final session = FakeCoreSession()..hasSession = true,
        api = CoreApi(session),
        old = await FakeCoreGateway().openingSchedule('demo-a');
    final replacement = old.edited(
        enabled: true, days: List.filled(7, '09:00-18:00'), dates: '');
    session.transport.handler = (_, __, ___) async => CoreReply(
        200, {'tenantId': 'demo-a', 'version': 2, ...replacement.document});
    await api.patchOpeningSchedule(old, replacement);
    expect(session.transport.calls.single['body'],
        {'expectedVersion': 1, 'reviewed': true, ...replacement.document});
    session.transport.handler = (_, __, ___) async =>
        CoreReply(200, {'tenantId': 'demo-a', 'version': 2, ...old.document});
    await expectLater(
        api.patchOpeningSchedule(old, replacement),
        throwsA(isA<CoreException>()
            .having((e) => e.uncertain, 'uncertain', true)));
    expect(session.transport.calls.length, 2);
    session.transport.handler = (_, __, ___) async =>
        CoreReply(200, {'tenantId': 'demo-a', 'version': 2});
    await expectLater(
        api.patchOpeningSchedule(old, replacement),
        throwsA(isA<CoreException>().having(
            (e) => e.uncertain, 'malformed result is uncertain', true)));
    expect(session.transport.calls.length, 3);
  });
  test(
      'opening controller prevents stale, offline and navigation-crossed writes',
      () async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['settings:read', 'settings:update']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    await c.selectSection(CoreSection.opening);
    final old = c.opening!,
        changed = old.edited(
            enabled: true, days: List.filled(7, '09:00-18:00'), dates: '');
    await c.patchOpeningSchedule(old, changed);
    expect(api.openingWrites, 1);
    expect(c.opening!.enabled, true);
    await c.patchOpeningSchedule(old, changed);
    expect(api.openingWrites, 1);
    final current = c.opening!;
    await c.selectSection(CoreSection.service);
    await c.patchOpeningSchedule(current, current);
    expect(api.openingWrites, 1);
    await c.selectSection(CoreSection.opening);
    c.setSuspended(true);
    await c.patchOpeningSchedule(c.opening!, c.opening!);
    expect(api.openingWrites, 1);
  });
  testWidgets(
      'opening editor reviews without writing, cancellation discards, apply requires confirmation',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['settings:read', 'settings:update']);
    api.session.restoreAvailable = true;
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    await tester.pumpWidget(CoreApp(controller: c));
    await tester.pumpAndSettle();
    final tab = find.widgetWithText(ChoiceChip, 'مواعيد العمل');
    await tester.ensureVisible(tab);
    await tester.tap(tab);
    await tester.pumpAndSettle();
    final edit = find.text('تعديل مواعيد العمل');
    await tester.ensureVisible(edit);
    await tester.pumpAndSettle();
    await tester.tap(edit);
    await tester.pumpAndSettle();
    await tester.enterText(
        find.widgetWithText(TextField, 'الأحد'), '09:00-18:00');
    await tester.tap(find.widgetWithText(FilledButton, 'مراجعة المواعيد'));
    await tester.pumpAndSettle();
    expect(api.openingWrites, 0);
    expect(
        tester
            .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'تطبيق المواعيد'))
            .onPressed,
        isNull);
    await tester.tap(find.text('إلغاء'));
    await tester.pumpAndSettle();
    expect(api.openingWrites, 0);
    await tester.ensureVisible(edit);
    await tester.pumpAndSettle();
    await tester.tap(edit);
    await tester.pumpAndSettle();
    expect(
        tester
            .widget<TextField>(find.widgetWithText(TextField, 'الأحد'))
            .controller!
            .text,
        '');
    await tester.enterText(
        find.widgetWithText(TextField, 'الأحد'), '09:00-18:00');
    await tester.tap(find.widgetWithText(FilledButton, 'مراجعة المواعيد'));
    await tester.pumpAndSettle();
    final check = find.byType(CheckboxListTile);
    await tester.ensureVisible(check);
    await tester.tap(check);
    await tester.pumpAndSettle();
    await tester.tap(find.text('تطبيق المواعيد'));
    await tester.pumpAndSettle();
    expect(api.openingWrites, 1);
    expect(c.opening!.weekly[0].first.start, 540);
  });
}
