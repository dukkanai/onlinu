import 'dart:typed_data';
import 'auth.dart';
import 'models.dart';
import 'team_models.dart';
import 'business_profile.dart';
import 'delivery_models.dart';
import 'courier_models.dart';
import 'service_policy.dart';
import 'payment_methods.dart';
import 'tax_models.dart';
import 'finance_models.dart';
import 'refund_models.dart';
import 'brand_models.dart';
import 'support_models.dart';
import 'transport.dart';

abstract interface class CoreGateway {
  CoreSession get session;
  Future<CoreCourierLinks> courierLinks(String tenant);
  Future<void> setCourierLink(
      CoreCourierLinks expected, CoreCourierLink link, String principal);
  Future<CoreCourierWork> courierWork(String tenant);
  Future<CoreCourierDetail> courierDetail(
      CoreCourierWork expected, CoreOrder order);
  Future<void> courierChange(CoreCourierWork expected, CoreOrder order,
      {bool cash = false});
  Future<void> courierAvailability(
      CoreCourierWork expected, String availability);
  Future<CoreTaxConfig> tax(String tenant);
  Future<void> patchTax(CoreTaxConfig expected,
      {required bool enabled, required int rateBps, required String taxNumber});
  Future<CorePaymentMethods> paymentMethods(String tenant);
  Future<void> patchPaymentMethods(
      CorePaymentMethods expected, String mode, List<String> methods);
  Future<CoreServicePolicy> service(String tenant);
  Future<void> patchService(
      CoreServicePolicy expected, Map<String, bool> changes);
  Future<CoreSupportQueue> support(String tenant);
  Future<CoreSupportDetail> supportDetail(String tenant, String number);
  Future<CoreSupportDetail> supportCommand(
      CoreSupportDetail expected, String id, String action,
      {bool? approve, required String reason});
  Future<CoreBrandState> brand(String tenant);
  Future<CoreBrandState> brandCommand(
      CoreBrandState expected, String action, Map<String, dynamic> changes);
  Future<CoreRefundDetail> refund(String tenant, String number, String id);
  Future<CoreRefundDetail> refundCommand(
      CoreRefundDetail expected, String action,
      {String? reference, String? reason});
  Future<CoreFinance> finance(String tenant, String number);
  Future<CoreProfile> profile();
  Future<CoreDelivery> delivery(String tenant);
  Future<void> setDeliveryPricing(CoreDelivery expected,
      {required String mode, required int fee, required int minimum});
  Future<void> setDeliveryZone(CoreDelivery expected,
      {required String district, required bool enabled, required int? fee});
  Future<void> setDeliveryLocation(
      CoreDelivery expected, DeliveryLocationChange change);
  Future<CoreGeography> geography(String tenant, String kind, {String? parent});
  Future<CoreBusinessProfile> businessProfile(String tenant);
  Future<void> patchBusinessProfile(
      CoreBusinessProfile expected, Map<String, String> changes);
  Future<List<CoreTeamMember>> team(String tenant);
  Future<CoreTeamMember> setMember(String tenant, TeamChange change);
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
  Future<List<CoreCourier>> couriers(String tenant);
  Future<CoreOrder> assignCourier(
      String tenant, CoreOrder expected, String courier);
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
        'brand_changed',
        'brand_invalid',
        'brand_contrast',
        'brand_no_draft',
        'invalid_service_modes',
        'forbidden',
        'not_found',
        'mode_unavailable',
        'conflict',
        'catalog_changed',
        'payment_required',
        'invalid_status',
        'invalid_payment_method',
        'order_not_found',
        'invalid_order_access',
        'restaurant_unavailable',
        'order_outcome_unknown',
        'rate_limited',
        'image_invalid',
        'image_too_large',
        'upload_busy',
        'version_conflict',
        'last_owner_required',
        'invalid_owner_permissions',
        'identity_disabled',
        'invalid_delivery_zones',
        'invalid_geography'
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
  Future<CoreSupportQueue> support(String tenant) async {
    final data = await _request(
        'GET', '/native/api/restaurants/${tenantKey(tenant)}/staff/support');
    _tenant(data, tenant);
    return CoreSupportQueue(data, tenantId: tenant);
  }

  @override
  Future<CoreSupportDetail> supportDetail(String tenant, String number) async {
    final data = await _request('GET',
        '/native/api/restaurants/${tenantKey(tenant)}/staff/support/orders/${orderKey(number)}');
    _tenant(data, tenant);
    final value = CoreSupportDetail(data, tenantId: tenant);
    if (value.order.number != number) invalidResponse();
    return value;
  }

  @override
  Future<CoreSupportDetail> supportCommand(
      CoreSupportDetail expected, String id, String action,
      {bool? approve, required String reason}) async {
    expected.validate(id, action, approve: approve, reason: reason);
    final order = expected.order,
        data = await _request('POST',
            '/native/api/restaurants/${tenantKey(order.tenantId)}/staff/support/orders/${orderKey(order.number)}/${principalKey(id)}/$action',
            body: {
              'version': order.version,
              'reviewed': true,
              if (approve != null) 'approve': approve,
              'reason': reason.trim()
            });
    _tenant(data, order.tenantId);
    final value = CoreSupportDetail(data, tenantId: order.tenantId);
    if (value.order.number != order.number ||
        value.order.version != order.version + 1 ||
        action == 'decide' &&
            (value.cancellation?.id != id ||
                value.cancellation?.status !=
                    (approve == true ? 'approved' : 'rejected')) ||
        action == 'resolve' &&
            !value.complaints.any((v) => v.id == id && v.status == 'resolved'))
      throw const CoreException('order_outcome_unknown', uncertain: true);
    return value;
  }

  @override
  Future<CoreBrandState> brand(String tenant) async {
    final data = await _request(
        'GET', '/native/api/restaurants/${tenantKey(tenant)}/staff/brand');
    _tenant(data, tenant);
    return CoreBrandState(data, tenantId: tenant);
  }

  @override
  Future<CoreBrandState> brandCommand(CoreBrandState expected, String action,
      Map<String, dynamic> changes) async {
    expected.validate(action, changes);
    final data = await _request('POST',
        '/native/api/restaurants/${tenantKey(expected.tenantId)}/staff/brand/$action',
        body: {...expected.review(), ...changes});
    _tenant(data, expected.tenantId);
    return CoreBrandState(data, tenantId: expected.tenantId);
  }

  @override
  Future<CoreRefundDetail> refund(
      String tenant, String number, String id) async {
    final data = await _request('GET',
        '/native/api/restaurants/${tenantKey(tenant)}/staff/orders/${orderKey(number)}/refunds/${principalKey(id)}');
    _tenant(data, tenant);
    final value = CoreRefundDetail(data, tenantId: tenant);
    if (value.number != number || value.id != id) invalidResponse();
    return value;
  }

  @override
  Future<CoreRefundDetail> refundCommand(
      CoreRefundDetail expected, String action,
      {String? reference, String? reason}) async {
    if (!expected.supports(action)) throw const CoreException('invalid_status');
    final data = await _request('POST',
        '/native/api/restaurants/${tenantKey(expected.tenantId)}/staff/orders/${orderKey(expected.number)}/refunds/${principalKey(expected.id)}/$action',
        body: {
          ...expected.review(),
          if (reference != null) 'reference': reference,
          if (reason != null) 'reason': reason
        });
    _tenant(data, expected.tenantId);
    final value = CoreRefundDetail(data, tenantId: expected.tenantId);
    if (value.id != expected.id ||
        value.number != expected.number ||
        value.amount != expected.amount ||
        value.provider != expected.provider ||
        value.demo != expected.demo)
      throw const CoreException('order_outcome_unknown', uncertain: true);
    return value;
  }

  @override
  Future<CoreFinance> finance(String tenant, String number) async {
    final data = await _request('GET',
        '/native/api/restaurants/${tenantKey(tenant)}/staff/orders/${orderKey(number)}/finance');
    _tenant(data, tenant);
    final value = CoreFinance(data, tenantId: tenant);
    if (value.number != number) invalidResponse();
    return value;
  }

  @override
  Future<CoreTaxConfig> tax(String tenant) async {
    final data = await _request(
        'GET', '/native/api/restaurants/${tenantKey(tenant)}/staff/tax');
    _tenant(data, tenant);
    return CoreTaxConfig(data, tenantId: tenant);
  }

  @override
  Future<void> patchTax(CoreTaxConfig expected,
      {required bool enabled,
      required int rateBps,
      required String taxNumber}) async {
    expected.validate(enabled: enabled, rateBps: rateBps, taxNumber: taxNumber);
    final data = await _request('POST',
        '/native/api/restaurants/${tenantKey(expected.tenantId)}/staff/tax',
        body: {
          'expectedVersion': expected.version,
          'reviewed': true,
          'enabled': enabled,
          'rateBps': rateBps,
          'taxNumber': taxNumber
        });
    _tenant(data, expected.tenantId);
    final saved = CoreTaxConfig(data, tenantId: expected.tenantId);
    if (saved.version != expected.version + 1 ||
        saved.enabled != enabled ||
        saved.rateBps != rateBps ||
        saved.taxNumber != taxNumber)
      throw const CoreException('order_outcome_unknown', uncertain: true);
  }

  @override
  Future<CorePaymentMethods> paymentMethods(String tenant) async {
    final data = await _request('GET',
        '/native/api/restaurants/${tenantKey(tenant)}/staff/payment-methods');
    _tenant(data, tenant);
    return CorePaymentMethods(data, tenantId: tenant);
  }

  @override
  Future<void> patchPaymentMethods(
      CorePaymentMethods expected, String mode, List<String> methods) async {
    final choices = List<String>.unmodifiable(methods);
    expected.validate(mode, choices);
    final data = await _request('POST',
        '/native/api/restaurants/${tenantKey(expected.tenantId)}/staff/payment-methods',
        body: {
          'expectedVersion': expected.version,
          'mode': mode,
          'methods': choices
        });
    try {
      _tenant(data, expected.tenantId);
      final saved = CorePaymentMethods(data, tenantId: expected.tenantId);
      if (saved.version != expected.version + 1 ||
          saved.currency != expected.currency ||
          saved.demo != expected.demo ||
          saved.modes.any((v) {
            final old = expected.mode(v.mode);
            final wanted = v.mode == mode ? choices : old.methods;
            return v.enabled != old.enabled ||
                v.methods.length != wanted.length ||
                !v.methods.toSet().containsAll(wanted);
          })) invalidResponse();
    } catch (_) {
      throw const CoreException('order_outcome_unknown', uncertain: true);
    }
  }

  @override
  Future<CoreServicePolicy> service(String tenant) async {
    final data = await _request(
        'GET', '/native/api/restaurants/${tenantKey(tenant)}/staff/service');
    _tenant(data, tenant);
    return CoreServicePolicy(data, tenantId: tenant);
  }

  @override
  Future<void> patchService(
      CoreServicePolicy expected, Map<String, bool> changes) async {
    expected.validate(changes);
    final data = await _request('POST',
        '/native/api/restaurants/${tenantKey(expected.tenantId)}/staff/service',
        body: {'expectedVersion': expected.version, ...changes});
    _tenant(data, expected.tenantId);
    final saved = CoreServicePolicy(data, tenantId: expected.tenantId);
    if (saved.version != expected.version + 1 ||
        serviceLabels.keys
            .any((k) => saved.flags[k] != (changes[k] ?? expected.flags[k])))
      throw const CoreException('order_outcome_unknown', uncertain: true);
  }

  @override
  Future<CoreCourierLinks> courierLinks(String tenant) async {
    final data = await _request(
        'GET', '/native/api/restaurants/${tenantKey(tenant)}/courier-links');
    _tenant(data, tenant);
    return CoreCourierLinks(data, tenantId: tenant);
  }

  @override
  Future<void> setCourierLink(
      CoreCourierLinks expected, CoreCourierLink link, String principal) async {
    if (principal.isNotEmpty) principalKey(principal);
    if (!expected.links.any((v) =>
            v.courier.id == link.courier.id && v.version == link.version) ||
        principal == (link.principalId ?? '') &&
            !(link.bound && link.principalId == null) ||
        principal.isNotEmpty &&
            (!link.courier.active ||
                link.activeOrders > 0 ||
                !expected.candidates.any((v) => v.id == principal)))
      throw const CoreException('invalid_request');
    final data = await _request('POST',
        '/native/api/restaurants/${tenantKey(expected.tenantId)}/courier-links/${courierKey(link.courier.id)}',
        body: {'expectedVersion': link.version, 'principalId': principal});
    _tenant(data, expected.tenantId);
    final saved = CoreCourierLink(object(data['link']));
    if (saved.courier.id != link.courier.id ||
        saved.version != link.version + 1 ||
        saved.principalId != (principal.isEmpty ? null : principal) ||
        saved.bound != principal.isNotEmpty)
      throw const CoreException('order_outcome_unknown', uncertain: true);
  }

  @override
  Future<CoreCourierWork> courierWork(String tenant) async {
    final data = await _request(
        'GET', '/native/api/restaurants/${tenantKey(tenant)}/courier-work');
    _tenant(data, tenant);
    return CoreCourierWork(data, tenantId: tenant);
  }

  @override
  Future<CoreCourierDetail> courierDetail(
      CoreCourierWork expected, CoreOrder order) async {
    final data = await _request('GET',
        '/native/api/restaurants/${tenantKey(expected.tenantId)}/courier-work/orders/${orderKey(order.number)}');
    _tenant(data, expected.tenantId);
    final result = CoreCourierDetail(data, tenant: expected.tenantId);
    if (result.order.number != order.number ||
        result.order.courierId != expected.courier?.id ||
        result.bindingVersion != expected.bindingVersion)
      throw const CoreException('conflict');
    return result;
  }

  @override
  Future<void> courierChange(CoreCourierWork expected, CoreOrder order,
      {bool cash = false}) async {
    final next = courierNextStage(order);
    if (expected.courier == null ||
        expected.bindingVersion < 1 ||
        order.tenantId != expected.tenantId ||
        order.courierId != expected.courier!.id ||
        !expected.orders.any(
            (v) => v.number == order.number && v.version == order.version) ||
        (cash ? !courierCanCollect(order) : next == null))
      throw const CoreException('invalid_request');
    final data = await _request('POST',
        '/native/api/restaurants/${tenantKey(expected.tenantId)}/courier-work/orders/${orderKey(order.number)}/${cash ? 'cash' : 'status'}',
        body: {
          'version': order.version,
          'bindingVersion': expected.bindingVersion,
          if (!cash) 'status': next
        });
    _tenant(data, expected.tenantId);
    final saved = CoreOrder(data, tenantId: expected.tenantId);
    if (saved.number != order.number ||
        saved.version != order.version + 1 ||
        saved.courierId != expected.courier!.id ||
        saved.deliveryStatus != (cash ? order.deliveryStatus : next) ||
        saved.totalMinor != order.totalMinor ||
        saved.paymentMethod != order.paymentMethod ||
        (cash
            ? saved.paymentStatus != 'paid'
            : saved.paymentStatus != order.paymentStatus))
      throw const CoreException('order_outcome_unknown', uncertain: true);
  }

  @override
  Future<void> courierAvailability(
      CoreCourierWork expected, String availability) async {
    if (expected.courier == null ||
        expected.bindingVersion < 1 ||
        !{'available', 'busy', 'offline'}.contains(availability) ||
        availability == expected.courier!.availability)
      throw const CoreException('invalid_request');
    final data = await _request('POST',
        '/native/api/restaurants/${tenantKey(expected.tenantId)}/courier-work/availability',
        body: {
          'bindingVersion': expected.bindingVersion,
          'availability': availability
        });
    _tenant(data, expected.tenantId);
    final saved = CoreCourier(data);
    if (saved.id != expected.courier!.id ||
        !saved.active ||
        saved.availability != availability)
      throw const CoreException('order_outcome_unknown', uncertain: true);
  }

  @override
  Future<CoreDelivery> delivery(String tenant) async {
    final data = await _request(
        'GET', '/native/api/restaurants/${tenantKey(tenant)}/staff/delivery');
    _tenant(data, tenant);
    return CoreDelivery(data, tenantId: tenant);
  }

  @override
  Future<void> setDeliveryLocation(
    CoreDelivery expected,
    DeliveryLocationChange change,
  ) async {
    if (!expected.locationKnown) throw const CoreException('invalid_request');
    final data = await _request(
      'POST',
      '/native/api/restaurants/${tenantKey(expected.tenantId)}/staff/delivery/location',
      body: change.toJson(expected.version),
    );
    try {
      _tenant(data, expected.tenantId);
      final result = CoreDelivery(data, tenantId: expected.tenantId);
      if (!result.locationKnown ||
          result.version != expected.version + 1 ||
          result.latitude != change.latitude ||
          result.longitude != change.longitude ||
          result.radius != change.radius ||
          result.requireLocation != change.requireLocation) invalidResponse();
    } on CoreException {
      throw const CoreException('invalid_response', uncertain: true);
    }
  }

  @override
  Future<CoreGeography> geography(String tenant, String kind,
      {String? parent}) async {
    if (!{'regions', 'cities', 'districts'}.contains(kind) ||
        (kind == 'regions' ? parent != null : parent == null))
      throw const CoreException('invalid_request');
    final data = await _request('GET',
        '/native/api/restaurants/${tenantKey(tenant)}/staff/geography/$kind${parent == null ? '' : '/${menuKey(parent)}'}');
    _tenant(data, tenant);
    return CoreGeography(data, kind, parent: parent);
  }

  @override
  Future<void> setDeliveryPricing(CoreDelivery expected,
      {required String mode, required int fee, required int minimum}) async {
    if (!{'flat', 'district'}.contains(mode))
      throw const CoreException('invalid_request');
    deliveryAmount(fee);
    deliveryAmount(minimum);
    final data = await _request('POST',
        '/native/api/restaurants/${tenantKey(expected.tenantId)}/staff/delivery/pricing',
        body: {
          'expectedVersion': expected.version,
          'mode': mode,
          'feeMinor': fee,
          'minimumMinor': minimum
        });
    try {
      _tenant(data, expected.tenantId);
      final result = CoreDelivery(data, tenantId: expected.tenantId);
      if (result.version <= expected.version ||
          result.mode != mode ||
          result.fee != fee ||
          result.minimum != minimum) invalidResponse();
    } on CoreException {
      throw const CoreException('invalid_response', uncertain: true);
    }
  }

  @override
  Future<void> setDeliveryZone(CoreDelivery expected,
      {required String district,
      required bool enabled,
      required int? fee}) async {
    menuKey(district);
    if (fee != null) deliveryAmount(fee);
    if (enabled && fee == null) throw const CoreException('invalid_request');
    final data = await _request('POST',
        '/native/api/restaurants/${tenantKey(expected.tenantId)}/staff/delivery/zone',
        body: {
          'expectedVersion': expected.version,
          'zone': {'districtId': district, 'enabled': enabled, 'feeMinor': fee}
        });
    try {
      _tenant(data, expected.tenantId);
      final result = CoreDelivery(data, tenantId: expected.tenantId);
      final zones = result.zones.where((v) => v.id == district);
      if (result.version <= expected.version ||
          zones.length != 1 ||
          zones.single.enabled != enabled ||
          zones.single.fee != fee) invalidResponse();
    } on CoreException {
      throw const CoreException('invalid_response', uncertain: true);
    }
  }

  @override
  Future<CoreBusinessProfile> businessProfile(String tenant) async {
    final data = await _request(
        'GET', '/native/api/restaurants/${tenantKey(tenant)}/staff/profile');
    _tenant(data, tenant);
    return CoreBusinessProfile(data, tenantId: tenant);
  }

  @override
  Future<void> patchBusinessProfile(
      CoreBusinessProfile expected, Map<String, String> changes) async {
    final clean = validatedProfileChanges(changes);
    final data = await _request('POST',
        '/native/api/restaurants/${tenantKey(expected.tenantId)}/staff/profile',
        body: {'expectedVersion': expected.version, ...clean});
    try {
      _tenant(data, expected.tenantId);
      final result = CoreBusinessProfile(data, tenantId: expected.tenantId);
      if (result.version <= expected.version ||
          clean.entries.any((v) => result.fields[v.key] != v.value))
        invalidResponse();
    } on CoreException {
      throw const CoreException('invalid_response', uncertain: true);
    }
  }

  @override
  Future<List<CoreTeamMember>> team(String tenant) async {
    final data = await _request(
        'GET', '/native/api/restaurants/${tenantKey(tenant)}/members');
    final rows = array(data['members'], max: 5000)
        .map((v) => CoreTeamMember(object(v)))
        .toList();
    if (rows.any((v) => v.tenantId != tenant) ||
        rows.map((v) => v.principalId).toSet().length != rows.length)
      invalidResponse();
    return List.unmodifiable(rows);
  }

  @override
  Future<CoreTeamMember> setMember(String tenant, TeamChange change) async {
    final body = change.toJson();
    final data = await _request('PUT',
        '/native/api/restaurants/${tenantKey(tenant)}/members/${principalKey(change.principalId)}',
        body: body);
    try {
      final result = CoreTeamMember(data);
      if (result.tenantId != tenant ||
          result.principalId != change.principalId ||
          result.version != (change.expectedVersion ?? 0) + 1 ||
          result.role != change.role ||
          result.enabled != change.enabled ||
          result.displayName != change.displayName.trim() ||
          result.permissions.length != change.permissions.length ||
          !result.permissions.containsAll(change.permissions))
        invalidResponse();
      return result;
    } on CoreException {
      throw const CoreException('invalid_response', uncertain: true);
    }
  }

  @override
  Future<CoreProfile> profile() async => CoreProfile(
      object((await _request('GET', '/native/api/me'))['principal']));
  @override
  Future<List<CoreCourier>> couriers(String tenant) async {
    final data = await _request(
        'GET', '/native/api/restaurants/${tenantKey(tenant)}/staff/couriers');
    _tenant(data, tenant);
    final rows = array(data['couriers'], max: 500)
        .map((v) => CoreCourier(object(v)))
        .toList();
    if (data['limit'] != 500 ||
        rows.map((v) => v.id).toSet().length != rows.length) invalidResponse();
    return List.unmodifiable(rows);
  }

  @override
  Future<CoreOrder> assignCourier(
      String tenant, CoreOrder expected, String courier) async {
    if (expected.tenantId != tenant ||
        !expected.canAssign ||
        courier == expected.courierId)
      throw const CoreException('invalid_request');
    if (courier.isNotEmpty) courierKey(courier);
    final data = await _request(
        'POST', '${_path(tenant)}/${orderKey(expected.number)}/courier',
        body: {'version': expected.version, 'courierId': courier});
    try {
      _tenant(data, tenant);
      final result = CoreOrder(data, tenantId: tenant);
      if (result.number != expected.number ||
          result.version != expected.version + 1 ||
          result.courierId != courier ||
          result.mode != 'delivery' ||
          result.totalMinor != expected.totalMinor ||
          result.paymentStatus != expected.paymentStatus ||
          result.paymentMethod != expected.paymentMethod ||
          result.status != expected.status ||
          result.deliveryStatus != (courier.isEmpty ? '' : 'assigned'))
        invalidResponse();
      return result;
    } on CoreException {
      throw const CoreException('invalid_response', uncertain: true);
    }
  }

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
