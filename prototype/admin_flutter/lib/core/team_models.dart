import 'models.dart';
import 'transport.dart';

const permissionLabels = {
  'orders:read': 'عرض الطلبات',
  'orders:update': 'تحديث الطلبات',
  'menu:read': 'عرض الأصناف',
  'menu:update': 'تعديل الأصناف',
  'stock:read': 'عرض المخزون',
  'stock:update': 'تعديل المخزون',
  'delivery:read': 'عرض التوصيل',
  'delivery:assign': 'تعيين المندوبين',
  'payments:read': 'عرض المدفوعات',
  'payments:collect': 'تأكيد التحصيل',
  'refunds:manage': 'إدارة الاسترداد',
  'support:manage': 'إدارة الإلغاء والشكاوى',
  'settings:read': 'عرض الإعدادات',
  'settings:update': 'تعديل الإعدادات',
  'channels:manage': 'إدارة قنوات الطلب',
  'members:manage': 'إدارة الفريق والصلاحيات',
  'couriers:link': 'ربط هويات المندوبين بحساباتهم',
  'courier:read': 'عرض مهامي كمندوب',
  'courier:update': 'تحديث مهامي وتوفري كمندوب',
  'courier:collect': 'تأكيد نقد طلباتي كمندوب',
};
const roleLabels = {
  'owner': 'مالك',
  'manager': 'مدير',
  'supervisor': 'مشرف',
  'kitchen': 'مطبخ',
  'cashier': 'كاشير',
  'courier': 'مندوب'
};
Set<String> rolePermissions(String role) => switch (role) {
      'owner' => permissionLabels.keys.toSet(),
      'manager' => permissionLabels.keys
          .where((v) =>
              v != 'members:manage' &&
              v != 'couriers:link' &&
              !v.startsWith('courier:'))
          .toSet(),
      'supervisor' => {
          'orders:read',
          'orders:update',
          'menu:read',
          'stock:read',
          'delivery:read',
          'delivery:assign'
        },
      'kitchen' => {'orders:read', 'orders:update', 'menu:read', 'stock:read'},
      'cashier' => {'orders:read', 'payments:read', 'payments:collect'},
      'courier' => {'courier:read', 'courier:update', 'courier:collect'},
      _ => throw const CoreException('invalid_request')
    };
String principalKey(Object? value) {
  final id = textField(value, max: 36);
  if (!RegExp(
          r'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')
      .hasMatch(id)) invalidResponse();
  return id;
}

class CoreTeamMember {
  CoreTeamMember(Map<String, dynamic> json)
      : principalId = principalKey(json['principalId']),
        tenantId = tenantKey(json['tenantId']),
        role = textField(json['role'], max: 40),
        displayName = textField(json['displayName'] ?? '', max: 100),
        enabled = json['enabled'] is bool
            ? json['enabled'] as bool
            : invalidResponse(),
        version = integer(json['version'], min: 1),
        permissions = Set.unmodifiable(
            array(json['permissions'], max: permissionLabels.length)
                .map((v) => textField(v, max: 80))) {
    if (!roleLabels.containsKey(role) ||
        permissions.any((v) => !permissionLabels.containsKey(v)))
      invalidResponse();
  }
  final String principalId, tenantId, role, displayName;
  final bool enabled;
  final int version;
  final Set<String> permissions;
}

class TeamChange {
  TeamChange(
      {required this.principalId,
      required this.role,
      required this.permissions,
      required this.enabled,
      required this.displayName,
      this.expectedVersion});
  final String principalId, role, displayName;
  final Set<String> permissions;
  final bool enabled;
  final int? expectedVersion;
  Map<String, dynamic> toJson() {
    principalKey(principalId);
    if (!roleLabels.containsKey(role) ||
        displayName.trim().length > 100 ||
        RegExp(r'[\x00-\x1f\x7f]').hasMatch(displayName) ||
        permissions.any((v) => !permissionLabels.containsKey(v)) ||
        (role == 'owner' && permissions.length != permissionLabels.length) ||
        (expectedVersion != null && expectedVersion! < 1))
      throw const CoreException('invalid_request');
    return {
      'role': role,
      'permissions': permissions.toList()..sort(),
      'enabled': enabled,
      'displayName': displayName.trim(),
      'expectedVersion': expectedVersion
    };
  }
}
