import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:restaurant_admin_prototype/core/api.dart';
import 'package:restaurant_admin_prototype/core/controller.dart';
import 'package:restaurant_admin_prototype/core/refund_models.dart';
import 'package:restaurant_admin_prototype/core/refund_dialog.dart';
import 'package:restaurant_admin_prototype/core/transport.dart';
import 'core_fakes.dart';

Map<String, dynamic> refundJson() => {
      'id': principalId,
      'version': 1,
      'status': 'requested',
      'provider': 'stripe',
      'currency': 'SAR',
      'amountMinor': 1000,
      'taxMinor': 130,
      'confirmation': '',
      'authorized': false,
      'submitted': false,
      'updatedAt': '2026-10-05T12:00:00Z',
      'number': 'R1234567890',
      'orderVersion': 2,
      'orderTotalMinor': 1000,
      'capturedMinor': 1000,
      'demo': true,
      'reason': 'Synthetic private reason',
      'providerReference': '',
      'manualReference': '',
      'resolutionReason': '',
      'capability': {
        'automatic': true,
        'partial': true,
        'manual': true,
        'reason': 'provider_verified'
      }
    };

class RefundGateway extends FakeCoreGateway {
  RefundGateway() {
    currentProfile = profileFixture(
        permissions: ['orders:read', 'payments:read', 'refunds:manage']);
  }
  Map<String, dynamic> data = refundJson();
  int refundWrites = 0, refundReads = 0;
  bool lost = false;
  Completer<CoreRefundDetail>? gate;
  @override
  Future<CoreRefundDetail> refund(
      String tenant, String number, String id) async {
    refundReads++;
    return CoreRefundDetail(data, tenantId: tenant);
  }

  @override
  Future<CoreRefundDetail> refundCommand(
      CoreRefundDetail expected, String action,
      {String? reference, String? reason}) async {
    refundWrites++;
    if (gate != null) return gate!.future;
    data = {...data, 'version': 2, 'authorized': true};
    if (lost)
      throw const CoreException('order_outcome_unknown', uncertain: true);
    return CoreRefundDetail(data, tenantId: expected.tenantId);
  }
}

void main() {
  test(
      'refund action availability preserves explicit authorization and manual uncertainty',
      () {
    final r = CoreRefundDetail(refundJson(), tenantId: 'demo-a');
    expect(r.canAuthorize, true);
    expect(r.canManual, false);
    expect(r.canVerify, false);
    final manual = CoreRefundDetail({
      ...refundJson(),
      'status': 'manual_reported',
      'confirmation': 'manual'
    }, tenantId: 'demo-a');
    expect(manual.canAuthorize, false);
    expect(manual.canRefresh, false);
    final ambiguous = CoreRefundDetail(
        {...refundJson(), 'status': 'review', 'submitted': true},
        tenantId: 'demo-a');
    expect(ambiguous.canManual, false);
    expect(ambiguous.canAuthorize, false);
    expect(ambiguous.canVerify, true);
  });
  test('native refund command binds reviewed facts without adding a new intent',
      () async {
    final session = FakeCoreSession()..hasSession = true,
        api = CoreApi(session),
        r = CoreRefundDetail(refundJson(), tenantId: 'demo-a');
    session.transport.handler = (_, __, ___) async => CoreReply(200, {
          'tenantId': 'demo-a',
          ...refundJson(),
          'authorized': true,
          'version': 2
        });
    final result = await api.refundCommand(r, 'authorize');
    expect(result.authorized, true);
    final call = session.transport.calls.single;
    expect(call['method'], 'POST');
    expect(call['body'], r.review());
    expect(call['path'], endsWith('/refunds/$principalId/authorize'));
    session.transport.handler = (_, __, ___) async => CoreReply(
        200, {'tenantId': 'demo-a', ...refundJson(), 'amountMinor': 999});
    await expectLater(
        api.refundCommand(r, 'authorize'),
        throwsA(isA<CoreException>()
            .having((e) => e.uncertain, 'uncertain', true)));
  });
  test('unknown refund reply recovers same ID with GET and never resends',
      () async {
    final api = RefundGateway()..lost = true,
        c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    await c.showRefund('R1234567890', principalId);
    final r = c.refund!;
    await c.manageRefund(r, 'authorize');
    expect(api.refundWrites, 1);
    expect(api.refundReads, 2);
    expect(c.refund!.authorized, true);
    expect(c.message, contains('لن نكرر'));
  });
  test(
      'duplicate clicks and closing an in-flight refund cannot restore private detail',
      () async {
    final api = RefundGateway()..gate = Completer<CoreRefundDetail>(),
        c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    await c.showRefund('R1234567890', principalId);
    final r = c.refund!;
    final pending = c.manageRefund(r, 'authorize');
    await c.manageRefund(r, 'authorize');
    expect(api.refundWrites, 1);
    c.closeRefund();
    api.gate!.completeError(
        const CoreException('order_outcome_unknown', uncertain: true));
    await pending;
    expect(c.refund, isNull);
    expect(api.refundReads, 1);
    expect(api.refundWrites, 1);
  });
  testWidgets(
      'refund needs review and a checked confirmation; revoked grants mask private form',
      (tester) async {
    final api = RefundGateway(),
        c = CoreController(api, pollInterval: const Duration(hours: 1));
    await c.start(restore: false);
    await c.showRefund('R1234567890', principalId);
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: RefundDialog(
                controller: c, number: 'R1234567890', id: principalId))));
    await tester.pumpAndSettle();
    expect(find.textContaining('Synthetic private reason'), findsOneWidget);
    await tester.ensureVisible(find.text('التصريح بتنفيذ الاسترداد'));
    await tester.tap(find.text('التصريح بتنفيذ الاسترداد'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('مراجعة الإجراء'));
    await tester.tap(find.text('مراجعة الإجراء'));
    await tester.pumpAndSettle();
    expect(
        tester
            .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'تأكيد إجراء الاسترداد'))
            .onPressed,
        isNull);
    expect(api.refundWrites, 0);
    api.currentProfile =
        profileFixture(permissions: ['orders:read', 'payments:read']);
    await c.refresh();
    await tester.pumpAndSettle();
    expect(find.textContaining('Synthetic private reason'), findsNothing);
    expect(find.text('تأكيد إجراء الاسترداد'), findsNothing);
    expect(api.refundWrites, 0);
    await tester.pumpWidget(const SizedBox());
    c.dispose();
  });
  testWidgets(
      'checked refund review submits once and replaces intent with authoritative state',
      (tester) async {
    final api = RefundGateway(),
        c = CoreController(api, pollInterval: const Duration(hours: 1));
    await c.start(restore: false);
    await c.showRefund('R1234567890', principalId);
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: RefundDialog(
                controller: c, number: 'R1234567890', id: principalId))));
    await tester.pumpAndSettle();
    Future<void> tap(Finder f) async {
      await tester.ensureVisible(f);
      await tester.pumpAndSettle();
      await tester.tap(f);
      await tester.pumpAndSettle();
    }

    await tap(find.text('التصريح بتنفيذ الاسترداد'));
    await tap(find.text('مراجعة الإجراء'));
    await tap(find.byType(CheckboxListTile));
    await tap(find.text('تأكيد إجراء الاسترداد'));
    expect(api.refundWrites, 1);
    expect(c.refund!.authorized, true);
    expect(find.text('تأكيد إجراء الاسترداد'), findsNothing);
    await tester.pumpWidget(const SizedBox());
    c.dispose();
  });
  test('stale or backgrounded refund review cannot write', () async {
    final api = RefundGateway(),
        c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    await c.showRefund('R1234567890', principalId);
    final old = c.refund!;
    api.data = {...api.data, 'version': 2};
    await c.refresh();
    await c.manageRefund(old, 'authorize');
    expect(api.refundWrites, 0);
    final current = c.refund!;
    c.setSuspended(true);
    expect(c.refund, isNull);
    await c.manageRefund(current, 'authorize');
    expect(api.refundWrites, 0);
  });
}
