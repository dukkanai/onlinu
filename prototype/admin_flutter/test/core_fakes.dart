import 'dart:typed_data';
import 'dart:async';
import 'package:restaurant_admin_prototype/core/api.dart';
import 'package:restaurant_admin_prototype/core/team_models.dart';
import 'package:restaurant_admin_prototype/core/business_profile.dart';
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
      {Map<String, dynamic>? body,
      String? bearer,
      Uint8List? binary,
      int? catalogVersion}) async {
    calls.add({
      'method': method,
      'path': path,
      'body': body,
      'bearer': bearer,
      'binary': binary,
      'catalogVersion': catalogVersion
    });
    return handler?.call(method, path, body) ?? const CoreReply(200, {});
  }

  @override
  Future<Uint8List> image(String path) async =>
      throw const CoreException('image_unavailable');
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

CoreStockItem stockFixture(
        {String tenant = 'demo-a',
        int version = 1,
        bool tracked = true,
        int available = 12,
        int held = 3}) =>
    CoreStockItem({
      'itemId': 'meal',
      'name': 'وجبة',
      'tracked': tracked,
      'available': available,
      'held': held,
      'version': version
    }, tenantId: tenant);

CoreChannel channelFixture(String channel,
        {String tenant = 'demo-a', int version = 1, bool? enabled}) =>
    CoreChannel({
      'channel': channel,
      'version': version,
      'newOrdersEnabled': enabled ?? (channel == 'web' || channel == 'chatgpt'),
      'adapterImplemented': channel == 'web' || channel == 'chatgpt'
    }, tenantId: tenant);

Map<String, dynamic> menuJson(
        {int version = 1,
        String name = 'وجبة',
        int price = 1250,
        bool available = true,
        String category = 'main'}) =>
    {
      'version': version,
      'name': 'مطعم تجريبي',
      'currency': 'SAR',
      'categories': [
        {'id': 'main', 'name': 'الأطباق'},
        {'id': 'side', 'name': 'إضافات'}
      ],
      'items': [
        {
          'id': 'meal',
          'categoryId': category,
          'name': name,
          'priceMinor': price,
          'available': available
        }
      ]
    };
CoreMenu menuFixture(
        {String tenant = 'demo-a',
        int version = 1,
        String name = 'وجبة',
        int price = 1250,
        bool available = true,
        String category = 'main'}) =>
    CoreMenu(
        menuJson(
            version: version,
            name: name,
            price: price,
            available: available,
            category: category),
        tenantId: tenant);

Map<String, dynamic> menuDocument(CoreMenu menu) => {
      'version': menu.version,
      'name': menu.name,
      'currency': 'SAR',
      'categories': menu.categories
          .map((v) => {'id': v.id, 'name': v.name, 'sort': v.sort})
          .toList(),
      'items': menu.items
          .map((v) => {
                'id': v.id,
                'name': v.name,
                'categoryId': v.categoryId,
                'priceMinor': v.priceMinor,
                'available': v.available,
                'sort': v.sort
              })
          .toList()
    };

class FakeCoreGateway implements CoreGateway {
  @override
  final FakeCoreSession session = FakeCoreSession();
  CoreProfile currentProfile = profileFixture();
  CoreOrder currentOrder = orderFixture();
  Object? readError, writeError, profileError;
  Completer<List<CoreOrder>>? readGate;
  Completer<CoreOrder>? detailGate, writeGate;
  int writes = 0, reads = 0, profiles = 0;
  int stockWrites = 0, stockReads = 0;
  int channelWrites = 0;
  int menuWrites = 0;
  String menuDescription = 'وصف الصنف';
  List<CoreOption> menuOptions = [
    CoreOption(
        {'id': 'extra', 'name': 'إضافة', 'priceMinor': 200, 'available': true})
  ];
  Completer<CoreMenuDetails>? menuDetailsGate;
  final itemDetails = <String, Map<String, dynamic>>{};
  CoreMenu currentMenu = menuFixture();
  Completer<CoreMenu>? menuGate;
  List<CoreChannel> currentChannels =
      channelLabels.keys.map((v) => channelFixture(v)).toList();
  CoreStockItem currentStock = stockFixture();
  Completer<List<CoreStockItem>>? stockGate;
  Completer<CoreStockItem>? stockWriteGate;
  String? writeTenant, writeStatus;
  int? writeVersion;
  CoreBusinessProfile currentBusinessProfile = CoreBusinessProfile({
    'version': 1,
    'name': 'مطعم تجريبي',
    for (final key in profileLabels.keys.where((v) => v != 'name')) key: ''
  }, tenantId: 'demo-a');
  int profileWrites = 0;
  @override
  Future<CoreBusinessProfile> businessProfile(String tenant) async =>
      currentBusinessProfile;
  @override
  Future<void> patchBusinessProfile(
      CoreBusinessProfile expected, Map<String, String> changes) async {
    profileWrites++;
    if (writeError != null) throw writeError!;
    currentBusinessProfile = CoreBusinessProfile(
        {'version': expected.version + 1, ...expected.fields, ...changes},
        tenantId: expected.tenantId);
  }

  List<CoreTeamMember> currentTeam = [];
  int teamWrites = 0;
  @override
  Future<List<CoreTeamMember>> team(String tenant) async => currentTeam;
  @override
  Future<CoreTeamMember> setMember(String tenant, TeamChange change) async {
    teamWrites++;
    if (writeError != null) throw writeError!;
    final result = CoreTeamMember({
      ...change.toJson(),
      'tenantId': tenant,
      'principalId': change.principalId,
      'version': (change.expectedVersion ?? 0) + 1
    });
    currentTeam = [
      ...currentTeam.where((v) => v.principalId != change.principalId),
      result
    ];
    return result;
  }

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

  @override
  Future<List<CoreStockItem>> stock(String tenant) async {
    stockReads++;
    if (readError != null) throw readError!;
    return stockGate?.future ??
        [
          stockFixture(
              tenant: tenant,
              version: currentStock.version,
              tracked: currentStock.tracked,
              available: currentStock.available,
              held: currentStock.held)
        ];
  }

  @override
  Future<CoreStockItem> setStock(String tenant, CoreStockItem item,
      {required bool tracked, required int available}) async {
    stockWrites++;
    if (writeError != null) throw writeError!;
    if (stockWriteGate != null) return stockWriteGate!.future;
    currentStock = stockFixture(
        tenant: tenant,
        version: item.version + 1,
        tracked: tracked,
        available: available,
        held: item.held);
    return currentStock;
  }

  @override
  Future<List<CoreChannel>> channels(String tenant) async {
    if (readError != null) throw readError!;
    return currentChannels
        .map((v) => channelFixture(v.channel,
            tenant: tenant, version: v.version, enabled: v.newOrdersEnabled))
        .toList();
  }

  @override
  Future<CoreChannel> setChannel(
      String tenant, CoreChannel channel, bool enabled) async {
    channelWrites++;
    if (writeError != null) throw writeError!;
    final result = channelFixture(channel.channel,
        tenant: tenant, version: channel.version + 1, enabled: enabled);
    currentChannels = currentChannels
        .map((v) => v.channel == channel.channel ? result : v)
        .toList();
    return result;
  }

  @override
  Future<CoreMenu> menu(String tenant) async {
    if (readError != null) throw readError!;
    return menuGate?.future ??
        CoreMenu(menuDocument(currentMenu), tenantId: tenant);
  }

  @override
  Future<void> patchMenu(CoreMenu menu, CoreMenuItem item,
      {required String name,
      required String categoryId,
      required int price,
      required bool available}) async {
    menuWrites++;
    if (writeError != null) throw writeError!;
    final doc = menuDocument(currentMenu);
    doc['version'] = menu.version + 1;
    doc['items'] = (doc['items'] as List)
        .map((v) => (v as Map<String, dynamic>)['id'] == item.id
            ? <String, dynamic>{
                ...v,
                'name': name,
                'categoryId': categoryId,
                'priceMinor': price,
                'available': available
              }
            : v)
        .toList();
    currentMenu = CoreMenu(doc, tenantId: menu.tenantId);
  }

  @override
  Future<void> createMenuCategory(CoreMenu menu,
      {required String id, required String name, required int sort}) async {
    menuWrites++;
    if (writeError != null) throw writeError!;
    final doc = menuDocument(currentMenu);
    doc['version'] = menu.version + 1;
    (doc['categories'] as List).add({'id': id, 'name': name, 'sort': sort});
    currentMenu = CoreMenu(doc, tenantId: menu.tenantId);
  }

  @override
  Future<void> createMenuItem(CoreMenu menu,
      {required String id,
      required String name,
      required String categoryId,
      required int price,
      required int sort}) async {
    menuWrites++;
    if (writeError != null) throw writeError!;
    final doc = menuDocument(currentMenu);
    doc['version'] = menu.version + 1;
    (doc['items'] as List).add({
      'id': id,
      'name': name,
      'categoryId': categoryId,
      'priceMinor': price,
      'available': false,
      'sort': sort
    });
    currentMenu = CoreMenu(doc, tenantId: menu.tenantId);
  }

  @override
  Future<void> patchCategory(CoreMenu menu, CoreCategory category,
      {required String name, required int sort}) async {
    menuWrites++;
    if (writeError != null) throw writeError!;
    final doc = menuDocument(currentMenu);
    doc['version'] = menu.version + 1;
    doc['categories'] = (doc['categories'] as List)
        .map((v) => object(v)['id'] == category.id
            ? <String, dynamic>{...object(v), 'name': name, 'sort': sort}
            : object(v))
        .toList();
    currentMenu = CoreMenu(doc, tenantId: menu.tenantId);
  }

  @override
  Future<CoreMenuDetails> menuDetails(String tenant, String id) async {
    if (readError != null) throw readError!;
    final extra = id == 'meal'
        ? {
            'description': menuDescription,
            'options': menuOptions.map((v) => v.toJson()).toList()
          }
        : itemDetails[id] ??
            {'description': '', 'options': <Map<String, dynamic>>[]};
    return menuDetailsGate?.future ??
        CoreMenuDetails({
          'version': currentMenu.version,
          'currency': 'SAR',
          'item': {
            ...object((menuDocument(currentMenu)['items'] as List)
                .firstWhere((v) => object(v)['id'] == id)),
            ...extra
          }
        }, tenantId: tenant);
  }

  @override
  Future<CoreMenuDetails> uploadImage(
      CoreMenuDetails expected, Uint8List bytes) async {
    throw const CoreException('image_unavailable');
  }

  @override
  Future<Uint8List> image(CoreMenuDetails details) async {
    throw const CoreException('image_unavailable');
  }

  @override
  Future<void> patchMenuDetails(CoreMenuDetails details,
      {required String description, required List<CoreOption> options}) async {
    menuWrites++;
    if (writeError != null) throw writeError!;
    if (details.item.id == 'meal') {
      menuDescription = description;
      menuOptions = options;
    } else {
      itemDetails[details.item.id] = {
        'description': description,
        'options': options.map((v) => v.toJson()).toList()
      };
    }
    currentMenu = CoreMenu(
        {...menuDocument(currentMenu), 'version': details.version + 1},
        tenantId: details.tenantId);
  }
}
