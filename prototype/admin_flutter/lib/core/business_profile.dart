import 'models.dart';
import 'transport.dart';

const profileLabels = {
  'name': 'اسم المطعم العام',
  'description': 'وصف المطعم',
  'address': 'عنوان المطعم',
  'phone': 'هاتف المطعم',
  'openingHours': 'ساعات العمل (نص معلوماتي)',
  'pickupInstructions': 'تعليمات الاستلام'
};
const profileLimits = {
  'name': 120,
  'description': 2000,
  'address': 1000,
  'phone': 40,
  'openingHours': 1000,
  'pickupInstructions': 2000
};

class CoreBusinessProfile {
  CoreBusinessProfile(Map<String, dynamic> json, {required this.tenantId})
      : version = integer(json['version'], min: 1),
        fields = Map.unmodifiable({
          for (final key in profileLabels.keys)
            key: textField(json[key], max: profileLimits[key]! * 2)
        });
  final String tenantId;
  final int version;
  final Map<String, String> fields;
}

Map<String, String> validatedProfileChanges(Map<String, String> fields) {
  if (fields.isEmpty ||
      fields.keys.any((key) => !profileLabels.containsKey(key)))
    throw const CoreException('invalid_request');
  final result = {
    for (final entry in fields.entries) entry.key: entry.value.trim()
  };
  if (result.entries.any((v) =>
      v.value.runes.length > profileLimits[v.key]! ||
      (v.key == 'name' && v.value.isEmpty) ||
      RegExp(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]').hasMatch(v.value)))
    throw const CoreException('invalid_request');
  return result;
}
