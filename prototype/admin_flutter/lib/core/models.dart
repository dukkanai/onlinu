import 'dart:math';
import 'transport.dart';

Never invalidResponse() => throw const CoreException('invalid_response');
Map<String, dynamic> object(Object? value) =>
    value is Map<String, dynamic> ? value : invalidResponse();
String textField(Object? value, {int max = 4096}) =>
    value is String && value.length <= max ? value : invalidResponse();
int integer(Object? value, {int min = 0, int max = 9007199254740990}) =>
    value is int && value >= min && value <= max ? value : invalidResponse();
List<dynamic> array(Object? value, {int max = 1000}) =>
    value is List && value.length <= max ? value : invalidResponse();
String tenantKey(Object? value) {
  final key = textField(value, max: 64);
  if (!RegExp(r'^[a-z0-9][a-z0-9-]{0,63}$').hasMatch(key)) invalidResponse();
  return key;
}

String orderKey(Object? value) {
  final key = textField(value, max: 21);
  if (!RegExp(r'^R[0-9]{8,20}$').hasMatch(key)) invalidResponse();
  return key;
}

String money(int value) =>
    '${value ~/ 100}.${(value % 100).toString().padLeft(2, '0')} ر.س';

class CoreMembership {
  CoreMembership(Map<String, dynamic> json)
      : tenantId = tenantKey(json['tenantId']),
        tenantName =
            textField(json['tenantName'] ?? json['tenantId'], max: 160),
        role = textField(json['role'], max: 40),
        tenantStatus = textField(json['tenantStatus'], max: 40),
        displayName = textField(json['displayName'] ?? '', max: 120),
        permissions = Set.unmodifiable(array(json['permissions'], max: 50)
            .map((v) => textField(v, max: 80))) {
    if (json['enabled'] != true ||
        !{'active', 'suspended'}.contains(tenantStatus)) invalidResponse();
  }
  final String tenantId, tenantName, role, tenantStatus, displayName;
  final Set<String> permissions;
  bool can(String permission) =>
      permissions.contains(permission) &&
      (tenantStatus == 'active' ||
          tenantStatus == 'suspended' &&
              const {
                'orders:read',
                'orders:update',
                'delivery:read',
                'delivery:assign',
                'payments:read',
                'payments:collect',
                'refunds:manage',
                'support:manage',
                'couriers:link',
                'courier:read',
                'courier:update',
                'courier:collect',
              }.contains(permission));
}

class CoreProfile {
  CoreProfile(Map<String, dynamic> json)
      : id = textField(json['id'], max: 36),
        memberships = List.unmodifiable(
            array(json['memberships']).map((v) => CoreMembership(object(v)))) {
    if (!RegExp(r'^[a-f0-9-]{36}$').hasMatch(id) ||
        memberships.map((v) => v.tenantId).toSet().length != memberships.length)
      invalidResponse();
  }
  final String id;
  final List<CoreMembership> memberships;
}

class CoreLine {
  CoreLine(Map<String, dynamic> json)
      : name = textField(json['name']),
        quantity = integer(json['quantity'], min: 1),
        totalMinor = integer(json['totalMinor'], max: 40000000000),
        options = List.unmodifiable(array(json['options'] ?? [], max: 100)
            .map((v) => textField(object(v)['name'])));
  final String name;
  final int quantity, totalMinor;
  final List<String> options;
}

class CoreOrder {
  CoreOrder(Map<String, dynamic> json,
      {required this.tenantId, bool detail = false})
      : number = orderKey(json['number']),
        version = integer(json['version'], min: 1),
        status = textField(json['status'], max: 40),
        paymentStatus = textField(json['paymentStatus'], max: 40),
        paymentMethod = textField(json['paymentMethod'] ?? '', max: 40),
        mode = textField(json['mode'], max: 20),
        courierId = textField(json['courierId'] ?? '', max: 80),
        courierName = textField(json['courierName'] ?? '', max: 4096),
        deliveryStatus = textField(json['deliveryStatus'] ?? '', max: 40),
        totalMinor = integer(json['totalMinor'], max: 100000000),
        updatedAt = DateTime.tryParse(textField(json['updatedAt'], max: 80)) ??
            invalidResponse(),
        items = detail
            ? List.unmodifiable(
                array(json['items'], max: 50).map((v) => CoreLine(object(v))))
            : const [],
        notes = detail ? textField(json['notes'], max: 2000) : '',
        tableName = detail ? textField(json['tableName'] ?? '') : '' {
    if (json['currency'] != 'SAR' ||
        !{'pickup', 'delivery', 'table'}.contains(mode)) invalidResponse();
  }
  final String tenantId;
  final String number,
      status,
      paymentStatus,
      paymentMethod,
      mode,
      notes,
      tableName,
      courierId,
      courierName,
      deliveryStatus;
  final int version, totalMinor;
  final DateTime updatedAt;
  final List<CoreLine> items;
  bool get canAssign =>
      mode == 'delivery' &&
      !{'completed', 'cancelled'}.contains(status) &&
      deliveryStatus != 'delivered';
  bool get isCash =>
      (mode == 'table' &&
          {'cash_before', 'cash_after'}.contains(paymentMethod)) ||
      (mode == 'delivery' && paymentMethod == 'cash_on_delivery');
  bool get canCollect =>
      isCash &&
      paymentStatus == 'unpaid' &&
      !{'cancelled', 'completed'}.contains(status);
  String? get nextStatus {
    final next = switch (status) {
      'new' => 'accepted',
      'accepted' => 'preparing',
      'preparing' => 'ready',
      'ready' => mode == 'delivery' ? 'out_for_delivery' : 'completed',
      'out_for_delivery' => mode == 'delivery' ? 'completed' : null,
      _ => null,
    };
    if (next == null || (paymentMethod != 'card' && !isCash)) return null;
    if (next != 'accepted' &&
        paymentStatus != 'paid' &&
        (next == 'completed' ||
            paymentMethod == 'card' ||
            paymentMethod == 'cash_before')) return null;
    if (!{'paid', 'unpaid'}.contains(paymentStatus)) return null;
    return next;
  }
}

String coreStatusLabel(String value) => switch (value) {
      'new' => 'جديد',
      'accepted' => 'مقبول',
      'preparing' => 'قيد التحضير',
      'ready' => 'جاهز',
      'out_for_delivery' => 'في الطريق',
      'completed' => 'مكتمل',
      'cancelled' => 'ملغي',
      _ => 'حالة غير مدعومة',
    };

class CoreStockItem {
  CoreStockItem(Map<String, dynamic> json, {required this.tenantId})
      : itemId = textField(json['itemId'], max: 128),
        name = textField(json['name'] ?? json['itemId']),
        tracked = json['tracked'] is bool
            ? json['tracked'] as bool
            : invalidResponse(),
        available = integer(json['available']),
        held = integer(json['held']),
        version = integer(json['version']) {
    if (!RegExp(r'^[A-Za-z0-9_-]{1,128}$').hasMatch(itemId)) invalidResponse();
  }
  final String tenantId, itemId, name;
  final bool tracked;
  final int available, held, version;
}

int? stockQuantity(String raw) {
  final digits = raw.trim().split('').map((v) {
    final arabic = '٠١٢٣٤٥٦٧٨٩'.indexOf(v), persian = '۰۱۲۳۴۵۶۷۸۹'.indexOf(v);
    return arabic >= 0
        ? '$arabic'
        : persian >= 0
            ? '$persian'
            : v;
  }).join();
  if (!RegExp(r'^[0-9]{1,7}$').hasMatch(digits)) return null;
  final result = int.tryParse(digits);
  return result != null && result <= 1000000 ? result : null;
}

const channelLabels = {
  'web': 'الموقع',
  'chatgpt': 'ChatGPT',
  'whatsapp_qr': 'واتساب QR',
  'whatsapp_cloud': 'واتساب Cloud API'
};

class CoreChannel {
  CoreChannel(Map<String, dynamic> json, {required this.tenantId})
      : channel = textField(json['channel'], max: 40),
        version = integer(json['version'], min: 1),
        newOrdersEnabled = json['newOrdersEnabled'] is bool
            ? json['newOrdersEnabled'] as bool
            : invalidResponse(),
        adapterImplemented = json['adapterImplemented'] is bool
            ? json['adapterImplemented'] as bool
            : invalidResponse() {
    if (!channelLabels.containsKey(channel)) invalidResponse();
  }
  final String tenantId, channel;
  final int version;
  final bool newOrdersEnabled, adapterImplemented;
}

String menuKey(Object? value) {
  final result = textField(value, max: 80);
  if (!RegExp(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$').hasMatch(result))
    invalidResponse();
  return result;
}

class CoreCategory {
  CoreCategory(Map<String, dynamic> json)
      : id = menuKey(json['id']),
        name = textField(json['name']),
        sort = integer(json['sort'] ?? 0, min: -9007199254740990);
  final String id, name;
  final int sort;
}

class CoreMenuItem {
  CoreMenuItem(Map<String, dynamic> json)
      : id = menuKey(json['id']),
        categoryId = menuKey(json['categoryId']),
        sort = integer(json['sort'] ?? 0, min: -9007199254740990),
        name = textField(json['name']),
        priceMinor = integer(json['priceMinor'], max: 100000000),
        available = json['available'] is bool
            ? json['available'] as bool
            : invalidResponse();
  final String id, categoryId, name;
  final int priceMinor, sort;
  final bool available;
}

class CoreMenu {
  CoreMenu(Map<String, dynamic> json, {required this.tenantId})
      : version = integer(json['version'], min: 1),
        name = textField(json['name']),
        categories = List.unmodifiable(array(json['categories'], max: 1000)
            .map((v) => CoreCategory(object(v)))
            .toList()
          ..sort((a, b) {
            final order = a.sort.compareTo(b.sort);
            return order != 0 ? order : a.id.compareTo(b.id);
          })),
        items = List.unmodifiable(array(json['items'], max: 5000)
            .map((v) => CoreMenuItem(object(v)))) {
    final categoryIds = categories.map((v) => v.id).toSet();
    if (json['currency'] != 'SAR' ||
        categoryIds.length != categories.length ||
        items.map((v) => v.id).toSet().length != items.length ||
        items.any((v) => !categoryIds.contains(v.categoryId)))
      invalidResponse();
  }
  final String tenantId, name;
  final int version;
  final List<CoreCategory> categories;
  final List<CoreMenuItem> items;
}

String priceInput(int minor) =>
    '${minor ~/ 100}.${(minor % 100).toString().padLeft(2, '0')}';
int? priceMinor(String raw) {
  final text = raw.trim().split('').map((v) {
    final a = '٠١٢٣٤٥٦٧٨٩'.indexOf(v), p = '۰۱۲۳۴۵۶۷۸۹'.indexOf(v);
    return a >= 0
        ? '$a'
        : p >= 0
            ? '$p'
            : v == '٫'
                ? '.'
                : v;
  }).join();
  if (!RegExp(r'^[0-9]{1,7}(\.[0-9]{1,2})?$').hasMatch(text)) return null;
  final pieces = text.split('.'),
      whole = int.parse(pieces[0]),
      fraction = pieces.length == 1 ? 0 : int.parse(pieces[1].padRight(2, '0'));
  final total = whole * 100 + fraction;
  return total <= 100000000 ? total : null;
}

String newMenuId(bool category) {
  final random = Random.secure();
  return '${category ? 'c' : 'i'}_${List.generate(16, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0')).join()}';
}

class CoreOption {
  CoreOption(Map<String, dynamic> json)
      : id = menuKey(json['id']),
        name = textField(json['name']),
        priceMinor = integer(json['priceMinor'], max: 40000000000),
        available = json['available'] is bool
            ? json['available'] as bool
            : invalidResponse();
  final String id, name;
  final int priceMinor;
  final bool available;
  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'priceMinor': priceMinor,
        'available': available
      };
  CoreOption withAvailable(bool value) =>
      CoreOption({...toJson(), 'available': value});
}

class CoreMenuDetails {
  CoreMenuDetails(Map<String, dynamic> json, {required this.tenantId})
      : version = integer(json['version'], min: 1),
        item = CoreMenuItem(object(json['item'])),
        description = textField(object(json['item'])['description'], max: 4096),
        imageUrl = textField(object(json['item'])['imageUrl'] ?? '', max: 2048),
        options = List.unmodifiable(
            array(object(json['item'])['options'] ?? [], max: 100)
                .map((v) => CoreOption(object(v)))) {
    if (json['currency'] != 'SAR' ||
        options.map((v) => v.id).toSet().length != options.length)
      invalidResponse();
  }
  final String tenantId, description, imageUrl;
  final int version;
  final CoreMenuItem item;
  final List<CoreOption> options;
}

class CoreCourier {
  CoreCourier(Map<String, dynamic> json)
      : id = textField(json['id'], max: 36),
        name = textField(json['name'], max: 4096),
        active =
            json['active'] is bool ? json['active'] as bool : invalidResponse(),
        availability = textField(json['availability'], max: 20) {
    if (!RegExp(r'^[a-f0-9]{32}$').hasMatch(id) ||
        !{'available', 'busy', 'offline'}.contains(availability))
      invalidResponse();
  }
  final String id, name, availability;
  final bool active;
  String get availabilityLabel => switch (availability) {
        'available' => 'متاح',
        'busy' => 'مشغول',
        _ => 'غير متصل'
      };
}

String deliveryStatusLabel(String value) => switch (value) {
      'assigned' => 'تم تعيين مندوب',
      'picked_up' => 'استلم المندوب الطلب',
      'on_the_way' => 'في الطريق',
      'nearby' => 'قريب من الوجهة',
      'at_door' => 'عند الباب',
      'delivered' => 'تم التسليم',
      _ => 'لم يُسند لمندوب'
    };

String courierKey(String id) {
  if (!RegExp(r'^[a-f0-9]{32}$').hasMatch(id))
    throw const CoreException('invalid_request');
  return id;
}

String localTimestamp(DateTime value) {
  final date = value.toLocal();
  String two(int part) => part.toString().padLeft(2, '0');
  return '${date.year}-${two(date.month)}-${two(date.day)} ${two(date.hour)}:${two(date.minute)}:${two(date.second)}';
}
