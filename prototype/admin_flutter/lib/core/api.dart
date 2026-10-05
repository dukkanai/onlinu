import 'dart:typed_data';
import 'auth.dart';
import 'models.dart';
import 'transport.dart';

abstract interface class CoreGateway {
  CoreSession get session;
  Future<CoreProfile> profile();
  Future<CoreMenu> menu(String tenant);
  Future<CoreMenuDetails> menuDetails(String tenant, String id);
  Future<CoreMenuDetails> uploadImage(
      CoreMenuDetails expected, Uint8List bytes);
  Future<Uint8List> image(CoreMenuDetails details);
  Future<void> patchMenuDetails(CoreMenuDetails details,
      {required String description, required List<CoreOption> options});
  Future<void> patchCategory(CoreMenu menu, CoreCategory category,
      {required String name, required int sort});
  Future<void> createMenuCategory(CoreMenu menu,
      {required String id, required String name, required int sort});
  Future<void> createMenuItem(CoreMenu menu,
      {required String id,
      required String name,
      required String categoryId,
      required int price,
      required int sort});
  Future<void> patchMenu(CoreMenu menu, CoreMenuItem item,
      {required String name,
      required String categoryId,
      required int price,
      required bool available});
  Future<List<CoreChannel>> channels(String tenant);
  Future<CoreChannel> setChannel(
      String tenant, CoreChannel channel, bool enabled);
  Future<List<CoreStockItem>> stock(String tenant);
  Future<CoreStockItem> setStock(String tenant, CoreStockItem item,
      {required bool tracked, required int available});
  Future<List<CoreOrder>> orders(String tenant);
  Future<CoreOrder> detail(String tenant, String number);
  Future<CoreOrder> change(String tenant, CoreOrder order,
      {String? status, bool cash = false});
}

class CoreApi implements CoreGateway {
  CoreApi(this.session);
  @override
  final CoreSession session;
  Future<Map<String, dynamic>> _request(String method, String path,
      {Map<String, dynamic>? body,
      Uint8List? binary,
      int? catalogVersion}) async {
    final bearer = await session.token();
    final reply = await session.transport.request(method, path,
        body: body,
        bearer: bearer,
        binary: binary,
        catalogVersion: catalogVersion);
    if (reply.status == 401) {
      await session.signOut();
      throw const CoreException('authentication_required', status: 401);
    }
    if (reply.status < 200 || reply.status >= 300) {
      const safe = {
        'forbidden',
        'conflict',
        'catalog_changed',
        'payment_required',
        'invalid_status',
        'invalid_payment_method',
        'order_not_found',
        'restaurant_unavailable',
        'order_outcome_unknown',
        'rate_limited',
        'image_invalid',
        'image_too_large',
        'upload_busy'
      };
      final raw = reply.data['error'];
      throw CoreException(safe.contains(raw) ? raw as String : 'request_failed',
          status: reply.status,
          uncertain: method != 'GET' && reply.status >= 500);
    }
    return reply.data;
  }

  String _path(String tenant) =>
      '/native/api/restaurants/${tenantKey(tenant)}/staff/orders';
  void _tenant(Map<String, dynamic> data, String tenant) {
    if (data['tenantId'] != tenant) invalidResponse();
  }

  @override
  Future<CoreProfile> profile() async => CoreProfile(
      object((await _request('GET', '/native/api/me'))['principal']));
  @override
  Future<List<CoreOrder>> orders(String tenant) async {
    final data = await _request('GET', _path(tenant));
    _tenant(data, tenant);
    if (data['limit'] != 100) invalidResponse();
    final rows = array(data['orders'], max: 100)
        .map((v) => CoreOrder(object(v), tenantId: tenant))
        .toList(growable: false);
    if (rows.map((v) => v.number).toSet().length != rows.length)
      invalidResponse();
    return List.unmodifiable(rows);
  }

  @override
  Future<CoreOrder> detail(String tenant, String number) async {
    final data = await _request('GET', '${_path(tenant)}/${orderKey(number)}');
    _tenant(data, tenant);
    final result = CoreOrder(data, tenantId: tenant, detail: true);
    if (result.number != number) invalidResponse();
    return result;
  }

  @override
  Future<CoreOrder> change(String tenant, CoreOrder order,
      {String? status, bool cash = false}) async {
    if (order.tenantId != tenant) throw const CoreException('invalid_request');
    if (cash
        ? status != null || !order.canCollect
        : status == null || status != order.nextStatus)
      throw const CoreException('invalid_request');
    final data = await _request('POST',
        '${_path(tenant)}/${orderKey(order.number)}/${cash ? 'cash' : 'status'}',
        body: {'version': order.version, if (!cash) 'status': status});
    try {
      _tenant(data, tenant);
      final result = CoreOrder(data, tenantId: tenant);
      if (result.number != order.number ||
          result.version <= order.version ||
          (cash ? result.paymentStatus != 'paid' : result.status != status))
        invalidResponse();
      return result;
    } on CoreException {
      throw const CoreException('invalid_response', uncertain: true);
    }
  }

  @override
  Future<List<CoreStockItem>> stock(String tenant) async {
    final data = await _request(
        'GET', '/native/api/restaurants/${tenantKey(tenant)}/staff/stock');
    _tenant(data, tenant);
    final rows = array(data['items'], max: 5000)
        .map((v) => CoreStockItem(object(v), tenantId: tenant))
        .toList(growable: false);
    if (rows.map((v) => v.itemId).toSet().length != rows.length)
      invalidResponse();
    return List.unmodifiable(rows);
  }

  @override
  Future<CoreStockItem> setStock(String tenant, CoreStockItem item,
      {required bool tracked, required int available}) async {
    if (item.tenantId != tenant ||
        available < 0 ||
        available > 1000000 ||
        (!tracked && available != 0))
      throw const CoreException('invalid_request');
    final data = await _request('POST',
        '/native/api/restaurants/${tenantKey(tenant)}/staff/stock/${item.itemId}',
        body: {
          'version': item.version,
          'tracked': tracked,
          'available': available
        });
    try {
      _tenant(data, tenant);
      final result = CoreStockItem(data, tenantId: tenant);
      if (result.itemId != item.itemId ||
          result.version <= item.version ||
          result.tracked != tracked ||
          result.available != available) invalidResponse();
      return result;
    } on CoreException {
      throw const CoreException('invalid_response', uncertain: true);
    }
  }

  @override
  Future<List<CoreChannel>> channels(String tenant) async {
    final data = await _request(
        'GET', '/native/api/restaurants/${tenantKey(tenant)}/staff/channels');
    _tenant(data, tenant);
    final rows = array(data['channels'], max: 4)
        .map((v) => CoreChannel(object(v), tenantId: tenant))
        .toList(growable: false);
    if (rows.length != 4 || rows.map((v) => v.channel).toSet().length != 4)
      invalidResponse();
    return List.unmodifiable(rows);
  }

  @override
  Future<CoreChannel> setChannel(
      String tenant, CoreChannel channel, bool enabled) async {
    if (channel.tenantId != tenant || !channel.adapterImplemented)
      throw const CoreException('invalid_request');
    final data = await _request('POST',
        '/native/api/restaurants/${tenantKey(tenant)}/staff/channels/${channel.channel}',
        body: {
          'expectedVersion': channel.version,
          'newOrdersEnabled': enabled
        });
    try {
      _tenant(data, tenant);
      final result = CoreChannel(data, tenantId: tenant);
      if (result.channel != channel.channel ||
          result.version <= channel.version ||
          result.newOrdersEnabled != enabled) invalidResponse();
      return result;
    } on CoreException {
      throw const CoreException('invalid_response', uncertain: true);
    }
  }

  @override
  Future<CoreMenu> menu(String tenant) async {
    final data = await _request(
        'GET', '/native/api/restaurants/${tenantKey(tenant)}/staff/menu');
    _tenant(data, tenant);
    return CoreMenu(data, tenantId: tenant);
  }

  @override
  Future<void> patchMenu(CoreMenu menu, CoreMenuItem item,
      {required String name,
      required String categoryId,
      required int price,
      required bool available}) async {
    final trimmed = name.trim();
    if (trimmed.isEmpty ||
        trimmed.length > 320 ||
        price < 0 ||
        price > 100000000 ||
        !menu.items.any((v) => v.id == item.id) ||
        !menu.categories.any((v) => v.id == categoryId))
      throw const CoreException('invalid_request');
    final data = await _request('POST',
        '/native/api/restaurants/${tenantKey(menu.tenantId)}/staff/menu/items/${menuKey(item.id)}',
        body: {
          'expectedVersion': menu.version,
          'name': trimmed,
          'categoryId': menuKey(categoryId),
          'priceMinor': price,
          'available': available
        });
    try {
      _tenant(data, menu.tenantId);
      final changed = CoreMenuItem(object(data['item']));
      if (integer(data['version'], min: 1) <= menu.version ||
          data['currency'] != 'SAR' ||
          changed.id != item.id ||
          changed.name != trimmed ||
          changed.categoryId != categoryId ||
          changed.priceMinor != price ||
          changed.available != available) invalidResponse();
    } on CoreException {
      throw const CoreException('invalid_response', uncertain: true);
    }
  }

  @override
  Future<void> createMenuCategory(CoreMenu menu,
      {required String id, required String name, required int sort}) async {
    final label = name.trim();
    menuKey(id);
    if (label.isEmpty ||
        label.length > 240 ||
        sort < 0 ||
        sort > 10000 ||
        menu.categories.any((v) => v.id == id))
      throw const CoreException('invalid_request');
    final data = await _request('POST',
        '/native/api/restaurants/${tenantKey(menu.tenantId)}/staff/menu/categories',
        body: {
          'expectedVersion': menu.version,
          'category': {'id': id, 'name': label, 'sort': sort}
        });
    try {
      _tenant(data, menu.tenantId);
      final created = CoreCategory(object(data['category']));
      if (integer(data['version'], min: 1) <= menu.version ||
          created.id != id ||
          created.name != label ||
          created.sort != sort) invalidResponse();
    } on CoreException {
      throw const CoreException('invalid_response', uncertain: true);
    }
  }

  @override
  Future<void> createMenuItem(CoreMenu menu,
      {required String id,
      required String name,
      required String categoryId,
      required int price,
      required int sort}) async {
    final label = name.trim();
    menuKey(id);
    menuKey(categoryId);
    if (label.isEmpty ||
        label.length > 320 ||
        price < 0 ||
        price > 100000000 ||
        sort < 0 ||
        sort > 10000 ||
        menu.items.any((v) => v.id == id) ||
        !menu.categories.any((v) => v.id == categoryId))
      throw const CoreException('invalid_request');
    final data = await _request('POST',
        '/native/api/restaurants/${tenantKey(menu.tenantId)}/staff/menu/items',
        body: {
          'expectedVersion': menu.version,
          'item': {
            'id': id,
            'categoryId': categoryId,
            'name': label,
            'description': '',
            'priceMinor': price,
            'imageUrl': '',
            'available': false,
            'sort': sort,
            'options': []
          }
        });
    try {
      _tenant(data, menu.tenantId);
      final created = CoreMenuItem(object(data['item']));
      if (integer(data['version'], min: 1) <= menu.version ||
          data['currency'] != 'SAR' ||
          created.id != id ||
          created.name != label ||
          created.categoryId != categoryId ||
          created.priceMinor != price ||
          created.available ||
          created.sort != sort) invalidResponse();
    } on CoreException {
      throw const CoreException('invalid_response', uncertain: true);
    }
  }

  @override
  Future<void> patchCategory(CoreMenu menu, CoreCategory category,
      {required String name, required int sort}) async {
    final label = name.trim();
    if (label.isEmpty ||
        label.length > 240 ||
        sort < 0 ||
        sort > 10000 ||
        !menu.categories.any((v) => v.id == category.id))
      throw const CoreException('invalid_request');
    final data = await _request('POST',
        '/native/api/restaurants/${tenantKey(menu.tenantId)}/staff/menu/categories/${menuKey(category.id)}',
        body: {'expectedVersion': menu.version, 'name': label, 'sort': sort});
    try {
      _tenant(data, menu.tenantId);
      final changed = CoreCategory(object(data['category']));
      if (integer(data['version'], min: 1) <= menu.version ||
          changed.id != category.id ||
          changed.name != label ||
          changed.sort != sort) invalidResponse();
    } on CoreException {
      throw const CoreException('invalid_response', uncertain: true);
    }
  }

  @override
  Future<CoreMenuDetails> menuDetails(String tenant, String id) async {
    final data = await _request('GET',
        '/native/api/restaurants/${tenantKey(tenant)}/staff/menu/items/${menuKey(id)}');
    _tenant(data, tenant);
    final detail = CoreMenuDetails(data, tenantId: tenant);
    if (detail.item.id != id) invalidResponse();
    return detail;
  }

  @override
  Future<CoreMenuDetails> uploadImage(
      CoreMenuDetails expected, Uint8List bytes) async {
    if (bytes.isEmpty || bytes.length > BoundedCoreTransport.maxImageBytes)
      throw const CoreException('image_too_large');
    final data = await _request('POST',
        '/native/api/restaurants/${tenantKey(expected.tenantId)}/staff/menu/items/${menuKey(expected.item.id)}/image',
        binary: bytes, catalogVersion: expected.version);
    try {
      _tenant(data, expected.tenantId);
      final result = CoreMenuDetails(data, tenantId: expected.tenantId);
      if (result.item.id != expected.item.id ||
          result.version <= expected.version ||
          !RegExp(r'^/restaurant-media/[a-f0-9]{64}\.(png|jpg)$')
              .hasMatch(result.imageUrl)) invalidResponse();
      return result;
    } on CoreException {
      throw const CoreException('invalid_response', uncertain: true);
    }
  }

  @override
  Future<Uint8List> image(CoreMenuDetails details) {
    if (!RegExp(r'^/restaurant-media/[a-f0-9]{64}\.(png|jpg)$')
        .hasMatch(details.imageUrl))
      throw const CoreException('image_unavailable');
    final file = details.imageUrl.substring('/restaurant-media/'.length);
    return session.transport
        .image('/restaurant-media/${tenantKey(details.tenantId)}/$file');
  }

  @override
  Future<void> patchMenuDetails(CoreMenuDetails details,
      {required String description, required List<CoreOption> options}) async {
    final text = description.trim();
    if (text.length > 4000 ||
        details.options.any((v) => !options.any((c) => c.id == v.id)) ||
        options.length > 50 ||
        options.map((v) => v.id).toSet().length != options.length ||
        options.any((v) =>
            v.name.trim().isEmpty ||
            v.name.length > 240 ||
            v.priceMinor > 100000000))
      throw const CoreException('invalid_request');
    final clean = options
        .map((v) => CoreOption({...v.toJson(), 'name': v.name.trim()}))
        .toList();
    final data = await _request('POST',
        '/native/api/restaurants/${tenantKey(details.tenantId)}/staff/menu/items/${menuKey(details.item.id)}',
        body: {
          'expectedVersion': details.version,
          'description': text,
          'options': clean.map((v) => v.toJson()).toList()
        });
    try {
      _tenant(data, details.tenantId);
      final changed = CoreMenuDetails(data, tenantId: details.tenantId);
      if (changed.version <= details.version ||
          changed.item.id != details.item.id ||
          changed.description != text ||
          changed.options.length != clean.length ||
          clean.any((v) => !changed.options.any((c) =>
              c.id == v.id &&
              c.name == v.name &&
              c.priceMinor == v.priceMinor &&
              c.available == v.available))) invalidResponse();
    } on CoreException {
      throw const CoreException('invalid_response', uncertain: true);
    }
  }
}
