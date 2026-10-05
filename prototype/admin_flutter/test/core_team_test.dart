import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:restaurant_admin_prototype/core/api.dart';
import 'package:restaurant_admin_prototype/core/controller.dart';
import 'package:restaurant_admin_prototype/core/team_models.dart';
import 'package:restaurant_admin_prototype/core/models.dart';
import 'package:restaurant_admin_prototype/core/team_pane.dart';
import 'package:restaurant_admin_prototype/core/transport.dart';
import 'core_fakes.dart';

const employee = '12345678-1234-4234-8234-123456789def';
Map<String, dynamic> row(
        {String id = employee,
        String tenant = 'demo-a',
        String role = 'kitchen',
        int version = 1}) =>
    {
      'tenantId': tenant,
      'principalId': id,
      'role': role,
      'version': version,
      'enabled': true,
      'displayName': 'المطبخ',
      'permissions': rolePermissions(role).toList()
    };
TeamChange change(
        {int? version = 1,
        String role = 'kitchen',
        Set<String>? permissions}) =>
    TeamChange(
        principalId: employee,
        role: role,
        permissions: permissions ?? rolePermissions(role),
        enabled: true,
        displayName: 'موظف',
        expectedVersion: version);
void main() {
  test(
      'team API checks tenant, duplicate principals and exact acknowledged permissions',
      () async {
    final session = FakeCoreSession()..hasSession = true,
        api = CoreApi(session);
    session.transport.handler = (_, __, ___) async => CoreReply(200, {
          'members': [row()]
        });
    expect((await api.team('demo-a')).single.principalId, employee);
    session.transport.handler = (_, __, ___) async => CoreReply(200, {
          'members': [row(tenant: 'demo-b')]
        });
    await expectLater(api.team('demo-a'), throwsA(isA<CoreException>()));
    session.transport.handler = (_, __, ___) async => CoreReply(200, {
          'members': [row(), row()]
        });
    await expectLater(api.team('demo-a'), throwsA(isA<CoreException>()));
    session.transport.handler = (_, __, body) async => CoreReply(
        200, {...row(version: 2), 'displayName': body!['displayName']});
    await api.setMember('demo-a', change());
    expect(session.transport.calls.last['method'], 'PUT');
    expect(session.transport.calls.last['body'], change().toJson());
    session.transport.handler = (_, __, body) async => CoreReply(200, {
          ...row(version: 2),
          'displayName': body!['displayName'],
          'permissions': ['members:manage']
        });
    await expectLater(
        api.setMember('demo-a', change()),
        throwsA(isA<CoreException>()
            .having((v) => v.uncertain, 'uncertain', true)));
  });
  test(
      'owner permissions remain complete; aliases and account IDs are validated',
      () {
    expect(() => change(role: 'owner', permissions: {'orders:read'}).toJson(),
        throwsA(isA<CoreException>()));
    expect(() => principalKey('someone@example.com'),
        throwsA(isA<CoreException>()));
    expect(rolePermissions('cashier'),
        {'orders:read', 'payments:read', 'payments:collect'});
  });
  test(
      'team controller rejects stale writes and clears members after losing permission',
      () async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: permissionLabels.keys.toList())
      ..currentTeam = [CoreTeamMember(row())];
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    await c.selectSection(CoreSection.team);
    await c.setMember('demo-a', change());
    expect(api.teamWrites, 1);
    await c.setMember('demo-a', change());
    expect(api.teamWrites, 1);
    api.currentProfile = profileFixture(permissions: ['orders:read']);
    await c.refresh();
    expect(c.team, isEmpty);
    expect(c.membership!.can('members:manage'), false);
    await c.setMember('demo-a', change(version: 2));
    expect(api.teamWrites, 1);
  });
  test(
      'delegated native team manager cannot grant beyond own permissions or edit owners',
      () async {
    final api = FakeCoreGateway()
      ..currentProfile = CoreProfile({
        'id': principalId,
        'memberships': [
          {
            ...memberJson('demo-a',
                permissions: ['members:manage', 'orders:read']),
            'role': 'manager'
          }
        ]
      })
      ..currentTeam = [CoreTeamMember(row())];
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    await c.selectSection(CoreSection.team);
    await c.setMember('demo-a', change(role: 'owner'));
    expect(api.teamWrites, 0);
    await c.setMember('demo-a', change(permissions: {'refunds:manage'}));
    expect(api.teamWrites, 0);
    await c.setMember('demo-a', change(permissions: {'orders:read'}));
    expect(api.teamWrites, 1);
    api.currentTeam = [CoreTeamMember(row(role: 'owner', version: 2))];
    await c.refresh();
    await c.setMember(
        'demo-a', change(version: 2, permissions: {'orders:read'}));
    expect(api.teamWrites, 1);
  });
  testWidgets(
      'team editor reviews permission differences and cancellation is inert',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: permissionLabels.keys.toList())
      ..currentTeam = [CoreTeamMember(row())];
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    await c.start(restore: false);
    await c.selectSection(CoreSection.team);
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: Directionality(
                textDirection: TextDirection.rtl,
                child: TeamPane(controller: c)))));
    await tester.tap(find.text('تعديل العضوية'));
    await tester.pumpAndSettle();
    await tester.enterText(
        find.widgetWithText(TextField, 'اسم العرض داخل المطعم'),
        'المطبخ الثاني');
    await tester.tap(find.text('مراجعة التغيير'));
    await tester.pumpAndSettle();
    expect(find.text('تأكيد تغيير العضوية'), findsOneWidget);
    expect(find.textContaining('منح:'), findsOneWidget);
    expect(api.teamWrites, 0);
    await tester.tap(find.text('إلغاء'));
    await tester.pumpAndSettle();
    expect(api.teamWrites, 0);
    await tester.tap(find.text('تعديل العضوية'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('مراجعة التغيير'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('تأكيد حفظ العضوية'));
    await tester.pumpAndSettle();
    expect(api.teamWrites, 1);
    await tester.pumpWidget(const SizedBox());
    c.dispose();
  });
}
