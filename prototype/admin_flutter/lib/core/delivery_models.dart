import 'models.dart';
import 'transport.dart';

bool boolField(Object? value) => value is bool ? value : invalidResponse();

class CoreDeliveryZone {
  CoreDeliveryZone(Map<String, dynamic> json)
      : id = menuKey(json['districtId']),
        enabled = boolField(json['enabled']),
        fee = json['feeMinor'] == null
            ? null
            : integer(json['feeMinor'], max: 100000000),
        name = textField(json['nameAr'] ?? '', max: 4096),
        nameEn = textField(json['nameEn'] ?? '', max: 4096),
        city = textField(json['cityName'] ?? '', max: 4096),
        region = textField(json['regionName'] ?? '', max: 4096),
        active = boolField(json['active']) {
    if (enabled && fee == null) invalidResponse();
  }
  final String id, name, nameEn, city, region;
  final bool enabled, active;
  final int? fee;
  String get label => name.isNotEmpty
      ? name
      : nameEn.isNotEmpty
          ? nameEn
          : id;
}

class CoreDelivery {
  CoreDelivery(Map<String, dynamic> json, {required this.tenantId})
      : version = integer(json['version'], min: 1),
        mode = textField(json['mode'], max: 20),
        fee = integer(json['feeMinor'], max: 100000000),
        minimum = integer(json['minimumMinor'], max: 100000000),
        enabled = boolField(json['enabled']),
        accepting = boolField(json['acceptingOrders']),
        requireLocation = boolField(json['requireLocation']),
        radius = json['radiusKm'] is num
            ? (json['radiusKm'] as num).toDouble()
            : invalidResponse(),
        zones = List.unmodifiable(array(json['zones'], max: 10000)
            .map((v) => CoreDeliveryZone(object(v)))) {
    if (json['currency'] != 'SAR' ||
        !{'flat', 'district'}.contains(mode) ||
        !radius.isFinite ||
        radius < 0 ||
        radius > 500 ||
        zones.map((v) => v.id).toSet().length != zones.length)
      invalidResponse();
  }
  final String tenantId, mode;
  final int version, fee, minimum;
  final bool enabled, accepting, requireLocation;
  final double radius;
  final List<CoreDeliveryZone> zones;
}

class GeoPlace {
  GeoPlace(Map<String, dynamic> json)
      : id = menuKey(json['id']),
        name = textField(json['nameAr'], max: 4096),
        nameEn = textField(json['nameEn'], max: 4096),
        region = json['regionId'] == null ? null : menuKey(json['regionId']),
        city = json['cityId'] == null ? null : menuKey(json['cityId']);
  final String id, name, nameEn;
  final String? region, city;
  String get label => name.isNotEmpty
      ? name
      : nameEn.isNotEmpty
          ? nameEn
          : id;
}

class CoreGeography {
  CoreGeography(Map<String, dynamic> json, String kind, {String? parent})
      : version = integer(json['version'], min: 1),
        source = textField(object(json['source'])['name']),
        license = textField(object(json['source'])['license'], max: 100),
        notice = textField(object(json['source'])['notice']),
        places = List.unmodifiable(
            array(json[kind], max: 10000).map((v) => GeoPlace(object(v)))) {
    if (!{'regions', 'cities', 'districts'}.contains(kind) ||
        places.map((v) => v.id).toSet().length != places.length ||
        kind == 'cities' && places.any((v) => v.region != parent) ||
        kind == 'districts' && places.any((v) => v.city != parent))
      invalidResponse();
  }
  final int version;
  final String source, license, notice;
  final List<GeoPlace> places;
}

void deliveryAmount(int value) {
  if (value < 0 || value > 100000000)
    throw const CoreException('invalid_request');
}
