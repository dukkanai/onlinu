import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:restaurant_admin_prototype/core/api.dart';
import 'package:restaurant_admin_prototype/core/controller.dart';
import 'package:restaurant_admin_prototype/core/business_profile.dart';
import 'package:restaurant_admin_prototype/core/business_pane.dart';
import 'package:restaurant_admin_prototype/core/transport.dart';
import 'core_fakes.dart';

void main() {
  test(
      'business profile rejects private fields and sends only reviewed changes',
      () async {
    expect(() => validatedProfileChanges({'taxNumber': 'private'}),
        throwsA(isA<CoreException>()));
    expect(() => validatedProfileChanges({'name': ' '}),
        throwsA(isA<CoreException>()));
    final session = FakeCoreSession()..hasSession = true,
        api = CoreApi(session),
        profile = FakeCoreGateway().currentBusinessProfile;
    session.transport.handler = (_, __, body) async => CoreReply(200, {
          'tenantId': 'demo-a',
          'version': 2,
          ...profile.fields,
          'description': body!['description']
        });
    await api.patchBusinessProfile(profile, {'description': '  وصف جديد  '});
    expect(session.transport.calls.single['body'],
        {'expectedVersion': 1, 'description': 'وصف جديد'});
    session.transport.handler = (_, __, ___) async =>
        CoreReply(200, {'tenantId': 'demo-b', 'version': 3, ...profile.fields});
    await expectLater(
        api.businessProfile('demo-a'), throwsA(isA<CoreException>()));
  });
  test('profile controller rejects stale and read-only updates', () async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['settings:read', 'settings:update']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    expect(c.section, CoreSection.business);
    final before = c.business!;
    await c.patchBusiness(before, {'name': 'جديد'});
    expect(api.profileWrites, 1);
    expect(c.business!.fields['name'], 'جديد');
    await c.patchBusiness(before, {'name': 'قديم'});
    expect(api.profileWrites, 1);
    api.currentProfile = profileFixture(permissions: ['settings:read']);
    await c.refresh();
    await c.patchBusiness(c.business!, {'name': 'ممنوع'});
    expect(api.profileWrites, 1);
  });
  testWidgets(
      'public profile form requires review and cancellation never publishes',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['settings:read', 'settings:update']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    await c.start(restore: false);
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: Directionality(
                textDirection: TextDirection.rtl,
                child: BusinessPane(controller: c)))));
    await tester.tap(find.text('تعديل البيانات العامة'));
    await tester.pumpAndSettle();
    await tester.enterText(
        find.widgetWithText(TextField, 'اسم المطعم العام'), 'مطعم جديد');
    expect(
        tester
            .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'حفظ البيانات العامة'))
            .onPressed,
        isNull);
    await tester.tap(find.text('إلغاء'));
    await tester.pumpAndSettle();
    expect(api.profileWrites, 0);
    await tester.tap(find.text('تعديل البيانات العامة'));
    await tester.pumpAndSettle();
    await tester.enterText(
        find.widgetWithText(TextField, 'اسم المطعم العام'), 'مطعم جديد');
    final review = find.widgetWithText(
        CheckboxListTile, 'راجعت المعلومات العامة التي ستُنشر');
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pumpAndSettle();
    await tester.ensureVisible(review);
    await tester.pumpAndSettle();
    await tester.tap(review);
    await tester.pumpAndSettle();
    await tester.tap(find.text('حفظ البيانات العامة'));
    await tester.pumpAndSettle();
    expect(api.profileWrites, 1);
    await tester.pumpWidget(const SizedBox());
    c.dispose();
  });
}
