import 'auth.dart';
import 'models.dart';
import 'transport.dart';

abstract interface class CoreGateway {
  CoreSession get session;
  Future<CoreProfile> profile();
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
      {Map<String, dynamic>? body}) async {
    final bearer = await session.token();
    final reply = await session.transport
        .request(method, path, body: body, bearer: bearer);
    if (reply.status == 401) {
      await session.signOut();
      throw const CoreException('authentication_required', status: 401);
    }
    if (reply.status < 200 || reply.status >= 300) {
      const safe = {
        'forbidden',
        'conflict',
        'payment_required',
        'invalid_status',
        'invalid_payment_method',
        'order_not_found',
        'restaurant_unavailable',
        'order_outcome_unknown',
        'rate_limited'
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
      if (result.number != order.number || result.version <= order.version)
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
      if (result.itemId != item.itemId || result.version <= item.version)
        invalidResponse();
      return result;
    } on CoreException {
      throw const CoreException('invalid_response', uncertain: true);
    }
  }
}
