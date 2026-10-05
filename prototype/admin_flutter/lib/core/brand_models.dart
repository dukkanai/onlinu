import 'models.dart';
import 'transport.dart';

const brandLabels = {
  'storefrontTemplate': 'قالب واجهة العملاء',
  'font': 'الخط العام',
  'headingFont': 'خط العناوين',
  'bodyFont': 'خط النص',
  'buttonFont': 'خط الأزرار',
  'layout': 'ترتيب الأصناف',
  'textSize': 'حجم النص',
  'radius': 'زوايا البطاقات',
  'shadow': 'الظلال',
  'imageFit': 'عرض الصور',
  'hideHero': 'إخفاء المقدمة',
  'introTitle': 'عنوان المقدمة',
  'introText': 'نص المقدمة'
};
const brandChoices = {
  'storefrontTemplate': {
    'classic': 'كلاسيكي',
    'bistro': 'بيسترو',
    'editorial': 'تحريري',
    'compact': 'مختصر',
    'showcase': 'عرض الصور'
  },
  'font': {'system': 'خط النظام', 'serif': 'خط كلاسيكي'},
  'headingFont': {
    '': 'وراثة الخط العام',
    'system': 'خط النظام',
    'serif': 'خط كلاسيكي',
    'cairo': 'القاهرة',
    'amiri': 'أميري',
    'tajawal': 'تجوال'
  },
  'bodyFont': {
    '': 'وراثة الخط العام',
    'system': 'خط النظام',
    'serif': 'خط كلاسيكي',
    'cairo': 'القاهرة',
    'amiri': 'أميري',
    'tajawal': 'تجوال'
  },
  'buttonFont': {
    '': 'وراثة الخط العام',
    'system': 'خط النظام',
    'serif': 'خط كلاسيكي',
    'cairo': 'القاهرة',
    'amiri': 'أميري',
    'tajawal': 'تجوال'
  },
  'layout': {'grid': 'شبكة', 'list': 'قائمة'},
  'textSize': {'normal': 'عادي', 'large': 'كبير'},
  'radius': {'square': 'مربعة', 'soft': 'ناعمة', 'round': 'دائرية'},
  'shadow': {'none': 'بدون', 'soft': 'خفيفة'},
  'imageFit': {'cover': 'ملء المساحة', 'contain': 'عرض الصورة كاملة'}
};

class CoreBrand {
  CoreBrand(Map<String, dynamic> json)
      : values = Map.unmodifiable({
          for (final key in brandLabels.keys)
            key: key == 'hideHero'
                ? (json[key] is bool ? json[key] as bool : invalidResponse())
                : textField(json[key], max: key == 'introText' ? 8000 : 640)
        }) {
    for (final entry in brandChoices.entries) {
      if (!entry.value.containsKey(values[entry.key])) invalidResponse();
    }
  }
  final Map<String, dynamic> values;
  String label(String key) => key == 'hideHero'
      ? (values[key] == true ? 'نعم' : 'لا')
      : brandChoices[key]?[values[key]] ?? values[key] as String;
}

class CoreBrandState {
  CoreBrandState(Map<String, dynamic> json, {required this.tenantId})
      : version = integer(json['version'], min: 1),
        catalogVersion = integer(json['catalogVersion'], min: 1),
        live = CoreBrand(object(json['live'])),
        draft = json['draft'] == null ? null : CoreBrand(object(json['draft'])),
        hasPrevious = json['hasPrevious'] is bool
            ? json['hasPrevious'] as bool
            : invalidResponse();
  final String tenantId;
  final int version, catalogVersion;
  final CoreBrand live;
  final CoreBrand? draft;
  final bool hasPrevious;
  Map<String, dynamic> review() =>
      {'version': version, 'catalogVersion': catalogVersion, 'reviewed': true};
  void validate(String action, Map<String, dynamic> changes) {
    if (!{'draft', 'publish', 'revert'}.contains(action) ||
        action == 'publish' && draft == null ||
        action == 'revert' && !hasPrevious ||
        action != 'draft' && changes.isNotEmpty)
      throw const CoreException('invalid_request');
    if (action == 'draft') {
      if (changes.isEmpty ||
          changes.keys.any((v) => !brandLabels.containsKey(v)))
        throw const CoreException('invalid_request');
      CoreBrand({...((draft ?? live).values), ...changes});
    }
  }
}
