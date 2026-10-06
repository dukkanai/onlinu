import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:restaurant_admin_prototype/core/api.dart';
import 'package:restaurant_admin_prototype/core/controller.dart';
import 'package:restaurant_admin_prototype/core/models.dart';
import 'package:restaurant_admin_prototype/core/support_models.dart';
import 'package:restaurant_admin_prototype/core/support_pane.dart';
import 'package:restaurant_admin_prototype/core/transport.dart';
import 'core_fakes.dart';

const complaintId = '22345678-1234-4234-8234-123456789abc';
Map<String, dynamic> supportFixture() => {
      ...orderJson(status: 'preparing', version: 3),
      'demo': true,
      'cancellationPending': true,
      'openComplaints': 1,
      'cancellation': {
        'id': principalId,
        'status': 'requested',
        'reason': 'Synthetic private customer reason',
        'decisionReason': '',
        'requestedAt': '2026-10-05T12:00:00Z',
        'requestedBeforePreparation': false
      },
      'complaints': [
        {
          'id': complaintId,
          'status': 'open',
          'reason': 'Synthetic missing sauce',
          'resolution': '',
          'requestedAt': '2026-10-05T12:00:00Z'
        }
      ],
      'cancellationHistory': [],
      'historyLimit': 20,
      'historyTruncated': false
    };

class SupportGateway extends FakeCoreGateway {
  SupportGateway({bool manage = true}) {
    currentProfile = profileFixture(permissions: [
      'orders:read',
      'orders:update',
      'payments:read',
      'refunds:manage',
      if (manage) 'support:manage'
    ]);
  }
  Map<String, dynamic> data = supportFixture();
  int supportWrites = 0, supportReads = 0;
  bool lost = false;
  Completer<CoreSupportDetail>? gate, readSupportGate;
  @override
  Future<CoreSupportQueue> support(String tenant) async => CoreSupportQueue({
        'orders': data['cancellationPending'] == true ||
                (data['openComplaints'] as int) > 0
            ? [data]
            : [],
        'limit': 100,
        'hasMore': false
      }, tenantId: tenant);
  @override
  Future<CoreSupportDetail> supportDetail(String tenant, String number) async {
    supportReads++;
    return readSupportGate?.future ?? CoreSupportDetail(data, tenantId: tenant);
  }

  @override
  Future<CoreSupportDetail> supportCommand(
      CoreSupportDetail expected, String id, String action,
      {bool? approve, required String reason}) async {
    supportWrites++;
    if (gate != null) return gate!.future;
    if (action == 'decide') {
      data = {
        ...data,
        'version': expected.order.version + 1,
        'cancellationPending': false,
        'status': approve == true ? 'cancelled' : data['status'],
        'paymentStatus': approve == true ? 'review' : data['paymentStatus'],
        'cancellation': {
          ...object(data['cancellation']),
          'status': approve == true ? 'approved' : 'rejected',
          'decisionReason': reason
        }
      };
    } else {
      data = {
        ...data,
        'version': expected.order.version + 1,
        'openComplaints': 0,
        'complaints': [
          for (final c in array(data['complaints']))
            {...object(c), 'status': 'resolved', 'resolution': reason}
        ]
      };
    }
    if (lost)
      throw const CoreException('order_outcome_unknown', uncertain: true);
    return CoreSupportDetail(data, tenantId: expected.order.tenantId);
  }
}

Future<void> openSupport(CoreController c) async {
  await c.start(restore: false);
  await c.selectSection(CoreSection.support);
  await c.showSupport('R1234567890');
}

void main() {
  test(
      'support model validates pending counts and requires explicit approval or rejection',
      () {
    final detail = CoreSupportDetail(supportFixture(), tenantId: 'demo-a');
    expect(detail.cancellationPending, true);
    expect(detail.openComplaints, 1);
    expect(() => detail.validate(principalId, 'decide', reason: 'Synthetic'),
        throwsA(isA<CoreException>()));
    detail.validate(principalId, 'decide',
        approve: false, reason: 'Synthetic rejection');
    expect(
        () => CoreSupportDetail({...supportFixture(), 'openComplaints': 0},
            tenantId: 'demo-a'),
        throwsA(isA<CoreException>()));
  });
  test('support API binds the reviewed request, version and false approval',
      () async {
    final session = FakeCoreSession()..hasSession = true,
        api = CoreApi(session),
        input = CoreSupportDetail(supportFixture(), tenantId: 'demo-a');
    final value = {
      ...supportFixture(),
      'version': 4,
      'cancellationPending': false,
      'cancellation': {
        ...object(supportFixture()['cancellation']),
        'status': 'rejected',
        'decisionReason': 'Synthetic rejection'
      }
    };
    session.transport.handler =
        (_, __, ___) async => CoreReply(200, {'tenantId': 'demo-a', ...value});
    await api.supportCommand(input, principalId, 'decide',
        approve: false, reason: 'Synthetic rejection');
    expect(session.transport.calls.single['body'], {
      'version': 3,
      'reviewed': true,
      'approve': false,
      'reason': 'Synthetic rejection'
    });
    session.transport.handler = (_, __, ___) async => CoreReply(
        200, {'tenantId': 'demo-a', ...value, 'number': 'R9999999999'});
    await expectLater(
        api.supportCommand(input, principalId, 'decide',
            approve: false, reason: 'Synthetic rejection'),
        throwsA(isA<CoreException>()
            .having((v) => v.uncertain, 'uncertain', true)));
  });
  test(
      'order-update alone cannot decide support and closing masks a late detail',
      () async {
    final api = SupportGateway(manage: false),
        c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await openSupport(c);
    await c.changeSupport(c.supportDetail!, principalId, 'decide',
        approve: true, reason: 'Synthetic');
    expect(api.supportWrites, 0);
    api.readSupportGate = Completer<CoreSupportDetail>();
    final pending = c.showSupport('R1234567890');
    c.closeSupport();
    api.readSupportGate!
        .complete(CoreSupportDetail(supportFixture(), tenantId: 'demo-a'));
    await pending;
    expect(c.supportDetail, isNull);
  });
  test(
      'unknown support result is recovered with a read and never a second decision',
      () async {
    final api = SupportGateway()..lost = true,
        c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await openSupport(c);
    await c.changeSupport(c.supportDetail!, principalId, 'decide',
        approve: true, reason: 'Synthetic approval');
    expect(api.supportWrites, 1);
    expect(api.supportReads, 2);
    expect(c.supportDetail!.order.paymentStatus, 'review');
    expect(c.message, contains('دون تكرار'));
  });
  test(
      'duplicate decisions, stale versions and backgrounded detail cannot write',
      () async {
    final api = SupportGateway(),
        c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await openSupport(c);
    final old = c.supportDetail!;
    api.data = {...api.data, 'version': 4};
    await c.refresh();
    await c.changeSupport(old, principalId, 'decide',
        approve: true, reason: 'Synthetic');
    expect(api.supportWrites, 0);
    final current = c.supportDetail!;
    api.gate = Completer<CoreSupportDetail>();
    final pending = c.changeSupport(current, principalId, 'decide',
        approve: true, reason: 'Synthetic');
    await c.changeSupport(current, principalId, 'decide',
        approve: true, reason: 'Synthetic');
    expect(api.supportWrites, 1);
    c.closeSupport();
    api.gate!.completeError(
        const CoreException('order_outcome_unknown', uncertain: true));
    await pending;
    expect(c.supportDetail, isNull);
    expect(api.supportWrites, 1);
    await c.showSupport('R1234567890');
    c.setSuspended(true);
    expect(c.supportDetail, isNull);
    await c.changeSupport(current, principalId, 'decide',
        approve: true, reason: 'Synthetic');
    expect(api.supportWrites, 1);
  });
  test(
      'support can open a permission-checked financial record without granting support rights',
      () async {
    final api = SupportGateway(manage: false),
        c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await openSupport(c);
    await c.showFinance('R1234567890');
    expect(c.finance, isNotNull);
    expect(c.canManageSupport, false);
    expect(c.canManageRefund, true);
  });
  testWidgets(
      'support needs explanation, review and confirmation; revocation hides decision form',
      (tester) async {
    final api = SupportGateway(),
        c = CoreController(api, pollInterval: const Duration(hours: 1));
    await openSupport(c);
    await tester.pumpWidget(MaterialApp(
        builder: (context, child) =>
            Directionality(textDirection: TextDirection.rtl, child: child!),
        home: Scaffold(
            body: SupportDialog(controller: c, number: 'R1234567890'))));
    await tester.pumpAndSettle();
    Future<void> tap(Finder f) async {
      await tester.ensureVisible(f);
      await tester.pumpAndSettle();
      await tester.tap(f);
      await tester.pumpAndSettle();
    }

    await tap(find.text('مراجعة الموافقة على الإلغاء'));
    await tester.enterText(
        find.byType(TextField), 'Synthetic explicit approval');
    await tap(find.text('مراجعة قرار الدعم'));
    expect(
        tester
            .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'تأكيد قرار الدعم'))
            .onPressed,
        isNull);
    expect(api.supportWrites, 0);
    api.currentProfile = profileFixture(permissions: ['orders:read']);
    await c.refresh();
    await tester.pumpAndSettle();
    expect(find.text('تأكيد قرار الدعم'), findsNothing);
    expect(find.byType(TextField), findsNothing);
    api.currentProfile = profileFixture(permissions: ['menu:read']);
    await c.refresh();
    await tester.pumpAndSettle();
    expect(
        find.textContaining('Synthetic private customer reason'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    c.dispose();
  });
  testWidgets('confirmed support decision keeps refund payment review distinct',
      (tester) async {
    final api = SupportGateway(),
        c = CoreController(api, pollInterval: const Duration(hours: 1));
    await openSupport(c);
    await tester.pumpWidget(MaterialApp(
        builder: (context, child) =>
            Directionality(textDirection: TextDirection.rtl, child: child!),
        home: Scaffold(
            body: SupportDialog(controller: c, number: 'R1234567890'))));
    await tester.pumpAndSettle();
    Future<void> tap(Finder f) async {
      await tester.ensureVisible(f);
      await tester.pumpAndSettle();
      await tester.tap(f);
      await tester.pumpAndSettle();
    }

    await tap(find.text('مراجعة الموافقة على الإلغاء'));
    await tester.enterText(find.byType(TextField), 'Synthetic approval');
    await tap(find.text('مراجعة قرار الدعم'));
    await tap(find.byType(CheckboxListTile));
    await tap(find.text('تأكيد قرار الدعم'));
    expect(api.supportWrites, 1);
    expect(c.supportDetail!.order.status, 'cancelled');
    expect(c.supportDetail!.order.paymentStatus, 'review');
    expect(c.supportDetail!.complaints.single.open, true);
    await tester.pumpWidget(const SizedBox());
    c.dispose();
  });
  test(
      'an incompatible legacy terminal state is refused locally without an unhandled decision',
      () async {
    final api = SupportGateway()
          ..data = {...supportFixture(), 'status': 'completed'},
        c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await openSupport(c);
    await c.changeSupport(c.supportDetail!, principalId, 'decide',
        approve: true, reason: 'Synthetic');
    expect(api.supportWrites, 0);
    expect(c.message, contains('لا يسمح'));
  });
}
