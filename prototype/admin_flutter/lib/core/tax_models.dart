import 'models.dart';
import 'transport.dart';

int taxRateFromPercent(String value) {
  final result = priceMinor(value);
  if (result == null || result > 10000)
    throw const CoreException('invalid_request');
  return result;
}

class CoreTaxConfig {
  CoreTaxConfig(Map<String, dynamic> json, {required this.tenantId})
      : version = integer(json['version'], min: 1),
        enabled = json['enabled'] is bool
            ? json['enabled'] as bool
            : invalidResponse(),
        rateBps = integer(json['rateBps'], max: 10000),
        taxNumber = textField(json['taxNumber'], max: 320) {
    if (json['currency'] != 'SAR' ||
        json['pricesIncludeTax'] != true ||
        taxNumber.runes.length > 80 ||
        enabled && taxNumber.trim().isEmpty) invalidResponse();
  }
  final String tenantId, taxNumber;
  final int version, rateBps;
  final bool enabled;
  String get percent =>
      '${rateBps ~/ 100}.${(rateBps % 100).toString().padLeft(2, '0')}';
  void validate(
      {required bool enabled,
      required int rateBps,
      required String taxNumber}) {
    if (rateBps < 0 ||
        rateBps > 10000 ||
        taxNumber.runes.length > 80 ||
        RegExp(r'[\x00-\x1f\x7f]').hasMatch(taxNumber) ||
        enabled && taxNumber.trim().isEmpty)
      throw const CoreException('invalid_request');
  }
}
