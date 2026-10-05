import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:restaurant_admin_prototype/core/api.dart';
import 'package:restaurant_admin_prototype/core/app.dart';
import 'package:restaurant_admin_prototype/core/controller.dart';
import 'package:restaurant_admin_prototype/core/finance_models.dart';
import 'package:restaurant_admin_prototype/core/transport.dart';
import 'core_fakes.dart';

Map<String, dynamic> financeJson() => {
      'number': 'R1234567890',
      'orderVersion': 1,
      'totalMinor': 12345,
      'currency': 'SAR',
      'paymentMethod': 'card',
      'paymentStatus': 'paid',
      'provider': 'stripe',
      'demo': true,
      'capturedMinor': 12345,
      'reservedMinor': 1000,
      'refundedMinor': 0,
      'availableMinor': 11345,
      'refunds': [
        {
          'id': principalId,
          'version': 2,
          'status': 'manual_reported',
          'provider': 'stripe',
          'currency': 'SAR',
          'amountMinor': 1000,
          'taxMinor': 130,
          'confirmation': 'manual',
          'authorized': true,
          'submitted': false,
          'updatedAt': '2026-10-05T12:00:00Z'
        }
      ],
      'limit': 100
    };

class DelayedFinance extends FakeCoreGateway {
  Completer<CoreFinance>? gate;
  @override
  Future<CoreFinance> finance(String tenant, String number) =>
      gate?.future ?? super.finance(tenant, number);
}

void main() {
  test(
      'finance preserves pending reservations separately from verified refunds',
      () {
    final value = CoreFinance(financeJson(), tenantId: 'demo-a');
    expect(value.reserved, 1000);
    expect(value.refunded, 0);
    expect(value.refunds.single.status, 'manual_reported');
    expect(refundStatusLabel('manual_reported'), contains('غير مؤكد'));
    expect(
        () => CoreFinance({...financeJson(), 'refundedMinor': 1001},
            tenantId: 'demo-a'),
        throwsA(isA<CoreException>()));
    expect(
        () => CoreFinance({...financeJson(), 'currency': 'USD'},
            tenantId: 'demo-a'),
        throwsA(isA<CoreException>()));
  });
  test(
      'finance API is fixed-route read-only and rejects another order response',
      () async {
    final session = FakeCoreSession()..hasSession = true,
        api = CoreApi(session);
    session.transport.handler = (_, __, ___) async =>
        CoreReply(200, {'tenantId': 'demo-a', ...financeJson()});
    final value = await api.finance('demo-a', 'R1234567890');
    expect(value.available, 11345);
    expect(session.transport.calls.single['method'], 'GET');
    expect(session.transport.calls.single['body'], isNull);
    await expectLater(
        api.finance('demo-a', 'R9999999999'), throwsA(isA<CoreException>()));
  });
  test('closed or revoked finance details cannot return from a late request',
      () async {
    final api = DelayedFinance()
      ..currentProfile =
          profileFixture(permissions: ['orders:read', 'payments:read']);
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    addTearDown(c.dispose);
    await c.start(restore: false);
    api.gate = Completer<CoreFinance>();
    final opening = c.showFinance('R1234567890');
    c.closeDetail();
    api.gate!.complete(CoreFinance(financeJson(), tenantId: 'demo-a'));
    await opening;
    expect(c.finance, isNull);
    api.gate = null;
    await c.showFinance('R1234567890');
    expect(c.finance, isNotNull);
    api.currentProfile = profileFixture(permissions: ['orders:read']);
    await c.refresh();
    expect(c.finance, isNull);
  });
  testWidgets(
      'financial dialog displays verified totals without a payout action',
      (tester) async {
    final api = FakeCoreGateway()
      ..currentProfile =
          profileFixture(permissions: ['orders:read', 'payments:read']);
    api.session.restoreAvailable = true;
    final c = CoreController(api, pollInterval: const Duration(hours: 1));
    await tester.pumpWidget(CoreApp(controller: c));
    await tester.pumpAndSettle();
    final button = find.text('السجل المالي');
    await tester.ensureVisible(button);
    await tester.pumpAndSettle();
    await tester.tap(button);
    await tester.pumpAndSettle();
    expect(find.textContaining('المبلغ المحصل المؤكد:'), findsOneWidget);
    expect(find.textContaining('هذه الشاشة للعرض'), findsOneWidget);
    expect(
        find.descendant(
            of: find.byType(AlertDialog), matching: find.byType(FilledButton)),
        findsNothing);
    await tester.tap(find.text('إغلاق السجل المالي'));
    await tester.pumpAndSettle();
    expect(c.finance, isNull);
  });
}
