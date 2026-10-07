import 'dart:convert';
import 'models.dart';
import 'transport.dart';

const openingDays = [
  'الأحد',
  'الإثنين',
  'الثلاثاء',
  'الأربعاء',
  'الخميس',
  'الجمعة',
  'السبت'
];

class OpeningWindow {
  OpeningWindow(Map<String, dynamic> value)
      : start = integer(value['startMinute'], max: 1439),
        end = integer(value['endMinute'], min: 1, max: 1440) {
    if (start >= end ||
        value.keys.any((key) => !['startMinute', 'endMinute'].contains(key)))
      invalidResponse();
  }
  final int start, end;
  Map<String, dynamic> toJson() => {'startMinute': start, 'endMinute': end};
  String get label => '${_time(start)}-${_time(end)}';
  static String _time(int value) =>
      '${(value ~/ 60).toString().padLeft(2, '0')}:${(value % 60).toString().padLeft(2, '0')}';
}

List<OpeningWindow> openingWindows(Object? value) {
  final result = array(value, max: 8)
      .map((v) => OpeningWindow(object(v)))
      .toList()
    ..sort((a, b) => a.start.compareTo(b.start));
  for (var i = 1; i < result.length; i++) {
    if (result[i - 1].end > result[i].start) invalidResponse();
  }
  return List.unmodifiable(result);
}

class OpeningException {
  OpeningException(Map<String, dynamic> value)
      : date = textField(value['date'], max: 10),
        windows = openingWindows(value['windows']) {
    final parsed = DateTime.tryParse('${date}T00:00:00Z');
    if (!RegExp(r'^[2-9][0-9]{3}-[0-9]{2}-[0-9]{2}$').hasMatch(date) ||
        parsed == null ||
        parsed.toIso8601String().substring(0, 10) != date ||
        value.keys.any((key) => !['date', 'windows'].contains(key)))
      invalidResponse();
  }
  final String date;
  final List<OpeningWindow> windows;
  Map<String, dynamic> toJson() =>
      {'date': date, 'windows': windows.map((v) => v.toJson()).toList()};
}

class CoreOpeningSchedule {
  CoreOpeningSchedule(Map<String, dynamic> value, {required this.tenantId})
      : version = integer(value['version'], min: 1),
        enabled = value['enabled'] is bool
            ? value['enabled'] as bool
            : invalidResponse(),
        weekly = List.unmodifiable(
            array(value['weekly'], max: 7).map(openingWindows)),
        exceptions = List.unmodifiable((array(value['exceptions'], max: 64)
            .map((v) => OpeningException(object(v)))
            .toList()
          ..sort((a, b) => a.date.compareTo(b.date)))) {
    if (value['timeZone'] != 'Asia/Riyadh' ||
        weekly.length != 7 ||
        exceptions.map((v) => v.date).toSet().length != exceptions.length)
      invalidResponse();
  }
  final String tenantId;
  final int version;
  final bool enabled;
  final List<List<OpeningWindow>> weekly;
  final List<OpeningException> exceptions;
  Map<String, dynamic> get document => {
        'enabled': enabled,
        'timeZone': 'Asia/Riyadh',
        'weekly':
            weekly.map((row) => row.map((v) => v.toJson()).toList()).toList(),
        'exceptions': exceptions.map((v) => v.toJson()).toList()
      };
  String dayText(int day) => weekly[day].map((v) => v.label).join(', ');
  String get exceptionsText => exceptions
      .map((v) => '${v.date} = ${v.windows.map((w) => w.label).join(', ')}')
      .join('\n');
  bool sameDocument(CoreOpeningSchedule other) =>
      jsonEncode(document) == jsonEncode(other.document);
  CoreOpeningSchedule edited(
      {required bool enabled,
      required List<String> days,
      required String dates}) {
    List<Map<String, dynamic>> parse(String text) {
      if (text.length > 160) throw const CoreException('invalid_request');
      if (text.trim().isEmpty) return [];
      return text.split(',').map((part) {
        final m = RegExp(r'^\s*([0-9]{2}):([0-9]{2})-([0-9]{2}):([0-9]{2})\s*$')
            .firstMatch(part);
        if (m == null) throw const CoreException('invalid_request');
        final h1 = int.parse(m[1]!),
            m1 = int.parse(m[2]!),
            h2 = int.parse(m[3]!),
            m2 = int.parse(m[4]!);
        if (h1 > 23 || m1 > 59 || h2 > 24 || m2 > 59 || h2 == 24 && m2 != 0)
          throw const CoreException('invalid_request');
        return <String, dynamic>{
          'startMinute': h1 * 60 + m1,
          'endMinute': h2 * 60 + m2
        };
      }).toList();
    }

    try {
      if (days.length != 7 || dates.length > 12000)
        throw const CoreException('invalid_request');
      final exceptionValues = dates.trim().isEmpty
          ? []
          : dates.trim().split(RegExp(r'\r?\n')).map((line) {
              final m = RegExp(r'^(\d{4}-\d{2}-\d{2})\s*=\s*(.*)$')
                  .firstMatch(line.trim());
              if (m == null) throw const CoreException('invalid_request');
              return {'date': m[1], 'windows': parse(m[2]!)};
            }).toList();
      return CoreOpeningSchedule({
        'version': version,
        'enabled': enabled,
        'timeZone': 'Asia/Riyadh',
        'weekly': days.map(parse).toList(),
        'exceptions': exceptionValues
      }, tenantId: tenantId);
    } catch (_) {
      throw const CoreException('invalid_request');
    }
  }
}
