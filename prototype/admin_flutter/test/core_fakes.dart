import 'dart:async';
import 'package:restaurant_admin_prototype/core/api.dart';
import 'package:restaurant_admin_prototype/core/auth.dart';
import 'package:restaurant_admin_prototype/core/models.dart';
import 'package:restaurant_admin_prototype/core/transport.dart';

const principalId = '12345678-1234-4234-8234-123456789abc';
Map<String, dynamic> memberJson(String tenant,
        {List<String>? permissions, String status = 'active'}) =>
    {
      'principalId': principalId,
      'tenantId': tenant,
      'role': 'owner',
      'enabled': true,
      'tenantStatus': status,
      'permissions':
          permissions ?? ['orders:read', 'orders:update', 'payments:collect'],
      'version': 1,
      'displayName': '',
    };
CoreProfile profileFixture(
        {List<String> tenants = const ['demo-a'], List<String>? permissions}) =>
    CoreProfile({
      'id': principalId,
      'memberships':
          tenants.map((v) => memberJson(v, permissions: permissions)).toList()
    });
Map<String, dynamic> orderJson(
        {String status = 'accepted',
        String payment = 'paid',
        String method = 'card',
        String mode = 'pickup',
        int version = 1,
        String number = 'R1234567890'}) =>
    {
      'number': number,
      'version': version,
      'status': status,
      'paymentStatus': payment,
      'paymentMethod': method,
      'mode': mode,
      'totalMinor': 12345,
      'currency': 'SAR',
      'updatedAt': '2026-10-05T12:00:00Z',
      'items': [
        {
          'name': 'وجبة',
          'quantity': 2,
          'totalMinor': 12345,
          'options': [
            {'name': 'إضافة'}
          ]
        }
      ],
      'notes': 'بدون ملح',
      'tableName': '',
    };
CoreOrder orderFixture(
        {String tenant = 'demo-a',
        String status = 'accepted',
        String payment = 'paid',
        String method = 'card',
        String mode = 'pickup',
        int version = 1,
        String number = 'R1234567890',
        bool detail = false}) =>
    CoreOrder(
        orderJson(
            status: status,
            payment: payment,
            method: method,
            mode: mode,
            version: version,
            number: number),
        tenantId: tenant,
        detail: detail);

class StubTransport implements CoreTransport {
  @override
  final Uri origin = Uri.parse('https://platform.example');
  final calls = <Map<String, dynamic>>[];
  Future<CoreReply> Function(String, String, Map<String, dynamic>?)? handler;
  @override
  Future<CoreReply> request(String method, String path,
      {Map<String, dynamic>? body, String? bearer}) async {
    calls.add({'method': method, 'path': path, 'body': body, 'bearer': bearer});
    return handler?.call(method, path, body) ?? const CoreReply(200, {});
  }

  @override
  void close() {}
}

class FakeCoreSession implements CoreSession {
  @override
  final StubTransport transport = StubTransport();
  @override
  Uri get origin => transport.origin;
  @override
  bool hasSession = false;
  bool restoreAvailable = false, closed = false;
  Completer<void>? loginGate;
  int revocations = 0;
  @override
  Future<void> login() async {
    hasSession = true;
    await loginGate?.future;
  }

  @override
  Future<bool> restore() async {
    hasSession = restoreAvailable;
    return hasSession;
  }

  @override
  Future<String> token() async {
    if (!hasSession) throw const CoreException('authentication_required');
    return List.filled(43, 'a').join();
  }

  @override
  Future<LogoutResult> signOut() async {
    hasSession = false;
    revocations++;
    return const LogoutResult(localCleared: true, remoteRevoked: true);
  }

  @override
  Future<LogoutResult> cancelLogin() => signOut();
  @override
  void close() {
    closed = true;
    hasSession = false;
  }
}

class FakeCoreGateway implements CoreGateway {
  @override
  final FakeCoreSession session = FakeCoreSession();
  CoreProfile currentProfile = profileFixture();
  CoreOrder currentOrder = orderFixture();
  Object? readError, writeError, profileError;
  Completer<List<CoreOrder>>? readGate;
  Completer<CoreOrder>? detailGate, writeGate;
  int writes = 0, reads = 0, profiles = 0;
  String? writeTenant, writeStatus;
  int? writeVersion;
  @override
  Future<CoreProfile> profile() async {
    profiles++;
    if (profileError != null) throw profileError!;
    return currentProfile;
  }

  @override
  Future<List<CoreOrder>> orders(String tenant) async {
    reads++;
    if (readError != null) throw readError!;
    return readGate?.future ??
        [
          CoreOrder(
              orderJson(
                  status: currentOrder.status,
                  version: currentOrder.version,
                  method: currentOrder.paymentMethod,
                  payment: currentOrder.paymentStatus,
                  mode: currentOrder.mode),
              tenantId: tenant)
        ];
  }

  @override
  Future<CoreOrder> detail(String tenant, String number) async =>
      detailGate?.future ??
      orderFixture(tenant: tenant, number: number, detail: true);
  @override
  Future<CoreOrder> change(String tenant, CoreOrder order,
      {String? status, bool cash = false}) async {
    writes++;
    writeTenant = tenant;
    writeStatus = status;
    writeVersion = order.version;
    if (writeError != null) throw writeError!;
    if (writeGate != null) return writeGate!.future;
    currentOrder = orderFixture(
        tenant: tenant,
        status: status ?? order.status,
        payment: cash ? 'paid' : order.paymentStatus,
        method: order.paymentMethod,
        mode: order.mode,
        version: order.version + 1);
    return currentOrder;
  }
}
