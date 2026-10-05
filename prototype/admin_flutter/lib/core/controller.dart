import 'dart:async';
import 'package:flutter/foundation.dart';
import 'api.dart';
import 'auth.dart';
import 'models.dart';
import 'transport.dart';

enum CoreSection { orders, stock, channels, menu }

extension CoreSectionPermission on CoreSection {
  String get permission => switch (this) {
        CoreSection.orders => 'orders:read',
        CoreSection.stock => 'stock:read',
        CoreSection.channels => 'channels:manage',
        CoreSection.menu => 'menu:read'
      };
}

class CoreController extends ChangeNotifier {
  CoreController(this.api,
      {this.pollInterval = const Duration(seconds: 10),
      DateTime Function()? now})
      : _now = now ?? DateTime.now;
  final CoreGateway api;
  final Duration pollInterval;
  final DateTime Function() _now;
  CoreSection section = CoreSection.orders;
  List<CoreStockItem> stock = const [];
  List<CoreChannel> channels = const [];
  CoreMenu? menu;
  CoreProfile? profile;
  String? selectedTenant;
  List<CoreOrder> orders = const [];
  CoreOrder? detail;
  bool busy = false, loadingDetail = false, online = false, suspended = false;
  String? message;
  DateTime? refreshedAt;
  int _generation = 0, _detailGeneration = 0;
  int? _refreshGeneration;
  bool _disposed = false;
  Timer? _timer;
  bool get signedIn => api.session.hasSession && profile != null;
  CoreMembership? get membership {
    for (final member in profile?.memberships ?? <CoreMembership>[]) {
      if (member.tenantId == selectedTenant) return member;
    }
    return null;
  }

  bool get writable =>
      signedIn &&
      online &&
      !busy &&
      !suspended &&
      refreshedAt != null &&
      _now().difference(refreshedAt!) < const Duration(seconds: 25);
  bool _current(int generation) => !_disposed && generation == _generation;
  void _emit() {
    if (!_disposed) notifyListeners();
  }

  void _clearData() {
    menu = null;
    channels = const [];
    stock = const [];
    orders = const [];
    detail = null;
    online = false;
    refreshedAt = null;
    loadingDetail = false;
    _detailGeneration++;
  }

  void _chooseSection() {
    if (membership?.can(section.permission) == true) return;
    for (final value in CoreSection.values) {
      if (membership?.can(value.permission) == true) {
        section = value;
        return;
      }
    }
  }

  Future<void> selectSection(CoreSection value) async {
    if (busy ||
        !signedIn ||
        value == section ||
        membership?.can(value.permission) != true) return;
    ++_generation;
    section = value;
    message = null;
    _clearData();
    _emit();
    await refresh();
  }

  void _poll() {
    _timer?.cancel();
    if (!_disposed && !suspended && signedIn)
      _timer = Timer.periodic(pollInterval, (_) {
        if (!busy) unawaited(refresh());
      });
  }

  Future<void> start({bool restore = true}) async {
    if (busy || _disposed) return;
    final generation = ++_generation;
    busy = true;
    message = null;
    profile = null;
    selectedTenant = null;
    _clearData();
    _emit();
    try {
      final ready = restore
          ? await api.session.restore()
          : await api.session.login().then((_) => true);
      if (!_current(generation) || !ready) return;
      final result = await api.profile();
      if (!_current(generation)) return;
      profile = result;
      if (result.memberships.length == 1)
        selectedTenant = result.memberships.single.tenantId;
      _chooseSection();
    } catch (error) {
      if (_current(generation)) message = errorMessage(error);
    } finally {
      if (_current(generation)) {
        busy = false;
        _emit();
        _poll();
        if (signedIn) await refresh();
      }
    }
  }

  Future<LogoutResult> signOut() async {
    ++_generation;
    _timer?.cancel();
    busy = false;
    profile = null;
    selectedTenant = null;
    _clearData();
    message = null;
    _emit();
    final generation = _generation;
    final result = await api.session.signOut();
    if (_current(generation)) {
      message = !result.localCleared
          ? 'تعذر مسح جلسة الجهاز. أعد المحاولة قبل ترك هذا الجهاز.'
          : !result.remoteRevoked
              ? 'خرجت من التطبيق. لم يتأكد إبطال الجلسة على الخادم؛ يمكنك إبطالها من صفحة جلسات التطبيق في المتصفح.'
              : 'تم تسجيل الخروج وإبطال الجلسة.';
      _emit();
    }
    return result;
  }

  Future<void> selectTenant(String? tenant) async {
    if (!signedIn ||
        tenant == selectedTenant ||
        tenant == null ||
        !(profile!.memberships.any((v) => v.tenantId == tenant))) return;
    ++_generation;
    selectedTenant = tenant;
    _chooseSection();
    busy = false;
    message = null;
    _clearData();
    _emit();
    await refresh();
  }

  Future<void> refresh() async {
    if (_disposed ||
        suspended ||
        busy ||
        !signedIn ||
        _refreshGeneration == _generation) return;
    final generation = _generation, tenant = selectedTenant;
    _refreshGeneration = generation;
    try {
      final currentProfile = await api.profile();
      if (!_current(generation)) return;
      profile = currentProfile;
      if (tenant == null) {
        _emit();
        return;
      }
      final member = membership;
      if (member == null || !member.can(section.permission)) {
        if (member == null) selectedTenant = null;
        _clearData();
        message = member?.tenantStatus == 'suspended'
            ? 'المطعم موقوف مؤقتًا.'
            : 'لا توجد صلاحية لعرض هذا القسم في المطعم.';
        _emit();
        return;
      }
      if (section == CoreSection.orders) {
        final result = await api.orders(tenant);
        if (!_current(generation)) return;
        orders = result;
      } else if (section == CoreSection.stock) {
        final result = await api.stock(tenant);
        if (!_current(generation)) return;
        stock = result;
      } else if (section == CoreSection.channels) {
        final result = await api.channels(tenant);
        if (!_current(generation)) return;
        channels = result;
      } else {
        final result = await api.menu(tenant);
        if (!_current(generation)) return;
        menu = result;
      }
      online = true;
      refreshedAt = _now();
      if (detail != null &&
          !orders.any((v) =>
              v.number == detail!.number && v.version == detail!.version)) {
        detail = null;
        _detailGeneration++;
      }
      _emit();
    } catch (error) {
      if (_current(generation)) {
        _failure(error);
        _emit();
      }
    } finally {
      if (_refreshGeneration == generation) _refreshGeneration = null;
    }
  }

  void _failure(Object error) {
    online = false;
    message = errorMessage(error);
    if (!api.session.hasSession ||
        error is CoreException && error.status == 401) {
      profile = null;
      selectedTenant = null;
      _clearData();
      _timer?.cancel();
    } else if (error is CoreException && error.status == 403) {
      _clearData();
      profile = null;
      _timer?.cancel();
    }
  }

  Future<void> showDetail(String number) async {
    final tenant = selectedTenant;
    if (section != CoreSection.orders ||
        !signedIn ||
        suspended ||
        tenant == null ||
        membership?.can('orders:read') != true) return;
    final generation = _generation, detailGeneration = ++_detailGeneration;
    loadingDetail = true;
    detail = null;
    _emit();
    try {
      final value = await api.detail(tenant, number);
      if (_current(generation) && detailGeneration == _detailGeneration)
        detail = value;
    } catch (error) {
      if (_current(generation) && detailGeneration == _detailGeneration)
        _failure(error);
    } finally {
      if (_current(generation) && detailGeneration == _detailGeneration) {
        loadingDetail = false;
        _emit();
      }
    }
  }

  void closeDetail() {
    _detailGeneration++;
    detail = null;
    loadingDetail = false;
    _emit();
  }

  bool _writeGuard(String tenant, String permission, CoreSection target) {
    if (_disposed || busy || tenant != selectedTenant || section != target)
      return false;
    if (!writable || membership?.can(permission) != true) {
      message =
          'لم يُرسل التعديل. تحقق من الاتصال والصلاحيات ثم حدّث البيانات.';
      _emit();
      return false;
    }
    return true;
  }

  Future<void> change(CoreOrder expected, {bool cash = false}) async {
    final tenant = selectedTenant;
    final permission = cash ? 'payments:collect' : 'orders:update';
    if (!_writeGuard(expected.tenantId, permission, CoreSection.orders)) return;
    if (section == CoreSection.orders &&
        expected.tenantId == tenant &&
        !orders.any((v) =>
            v.number == expected.number && v.version == expected.version)) {
      message = 'تغير الطلب أثناء التأكيد. افتح الإجراء من نسخته الحالية.';
      _emit();
      return;
    }
    if (section != CoreSection.orders ||
        expected.tenantId != tenant ||
        !writable ||
        tenant == null ||
        membership?.can(permission) != true ||
        !orders.any((v) =>
            v.number == expected.number && v.version == expected.version) ||
        (cash ? !expected.canCollect : expected.nextStatus == null)) return;
    // Fence all pending reads. A write is sent once; uncertainty requires a read,
    // never a blind retry or an optimistic fabricated payment/status.
    final generation = ++_generation;
    busy = true;
    online = false;
    _detailGeneration++;
    detail = null;
    loadingDetail = false;
    message = null;
    _emit();
    try {
      await api.change(tenant, expected,
          cash: cash, status: cash ? null : expected.nextStatus);
      if (_current(generation))
        message =
            cash ? 'تم تسجيل استلام المبلغ نقدًا.' : 'تم تحديث حالة الطلب.';
    } catch (error) {
      if (_current(generation)) _failure(error);
    } finally {
      if (_current(generation)) {
        busy = false;
        _emit();
        await refresh();
      }
    }
  }

  Future<void> recount(CoreStockItem expected,
      {required bool tracked, required int available}) async {
    if (!_writeGuard(expected.tenantId, 'stock:update', CoreSection.stock))
      return;
    final tenant = selectedTenant;
    if (section == CoreSection.stock &&
        expected.tenantId == tenant &&
        !stock.any((v) =>
            v.itemId == expected.itemId && v.version == expected.version)) {
      message = 'تغير المخزون أثناء الجرد. افتح النموذج من النسخة الحالية.';
      _emit();
      return;
    }
    if (section != CoreSection.stock ||
        !writable ||
        tenant == null ||
        expected.tenantId != tenant ||
        membership?.can('stock:update') != true ||
        !stock.any((v) =>
            v.itemId == expected.itemId && v.version == expected.version) ||
        available < 0 ||
        available > 1000000 ||
        (!tracked && available != 0)) return;
    final generation = ++_generation;
    busy = true;
    online = false;
    message = null;
    _emit();
    try {
      await api.setStock(tenant, expected,
          tracked: tracked, available: available);
      if (_current(generation))
        message = 'حُفظ الجرد دون تغيير الكميات المحجوزة للطلبات.';
    } catch (error) {
      if (_current(generation)) _failure(error);
    } finally {
      if (_current(generation)) {
        busy = false;
        _emit();
        await refresh();
      }
    }
  }

  Future<void> changeChannel(CoreChannel expected, bool enabled) async {
    if (!_writeGuard(
        expected.tenantId, 'channels:manage', CoreSection.channels)) return;
    final tenant = selectedTenant;
    if (section != CoreSection.channels ||
        !writable ||
        tenant == null ||
        expected.tenantId != tenant ||
        !expected.adapterImplemented ||
        membership?.can('channels:manage') != true) return;
    if (!channels.any((v) =>
        v.channel == expected.channel && v.version == expected.version)) {
      message = 'تغير إعداد القناة. راجع النسخة الحالية.';
      _emit();
      return;
    }
    final generation = ++_generation;
    busy = true;
    online = false;
    message = null;
    _emit();
    try {
      await api.setChannel(tenant, expected, enabled);
      if (_current(generation))
        message = enabled
            ? 'فُتح استقبال الطلبات الجديدة لهذه القناة.'
            : 'أُوقف استقبال الطلبات الجديدة لهذه القناة؛ الطلبات المقبولة مستمرة.';
    } catch (error) {
      if (_current(generation)) _failure(error);
    } finally {
      if (_current(generation)) {
        busy = false;
        _emit();
        await refresh();
      }
    }
  }

  Future<void> patchMenu(CoreMenu expected, CoreMenuItem item,
      {required String name,
      required String categoryId,
      required int price,
      required bool available}) async {
    if (!_writeGuard(expected.tenantId, 'menu:update', CoreSection.menu))
      return;
    if (section != CoreSection.menu ||
        !writable ||
        expected.tenantId != selectedTenant ||
        membership?.can('menu:update') != true) return;
    if (menu?.version != expected.version ||
        !menu!.items.any((v) => v.id == item.id)) {
      message = 'تغيرت قائمة الأصناف أثناء التعديل. افتح النسخة الحالية.';
      _emit();
      return;
    }
    final generation = ++_generation;
    busy = true;
    online = false;
    message = null;
    _emit();
    try {
      await api.patchMenu(expected, item,
          name: name,
          categoryId: categoryId,
          price: price,
          available: available);
      if (_current(generation))
        message = 'حُفظ الصنف دون تغيير الطلبات السابقة أو إعدادات المطعم.';
    } catch (error) {
      if (_current(generation)) _failure(error);
    } finally {
      if (_current(generation)) {
        busy = false;
        _emit();
        await refresh();
      }
    }
  }

  Future<void> createMenuEntry(CoreMenu expected,
      {required String id,
      required String name,
      required int sort,
      String? categoryId,
      int? price}) async {
    if (!_writeGuard(expected.tenantId, 'menu:update', CoreSection.menu))
      return;
    if (section != CoreSection.menu ||
        !writable ||
        expected.tenantId != selectedTenant ||
        membership?.can('menu:update') != true) return;
    if (menu?.version != expected.version) {
      message = 'تغيرت القائمة. راجعها قبل إضافة صنف أو تصنيف.';
      _emit();
      return;
    }
    if (categoryId != null && price == null) return;
    final generation = ++_generation;
    busy = true;
    online = false;
    message = null;
    _emit();
    try {
      if (categoryId == null) {
        await api.createMenuCategory(expected, id: id, name: name, sort: sort);
      } else {
        await api.createMenuItem(expected,
            id: id,
            name: name,
            categoryId: categoryId,
            price: price!,
            sort: sort);
      }
      if (_current(generation))
        message = categoryId == null
            ? 'أُضيف التصنيف.'
            : 'أُضيف الصنف غير متاح للطلب؛ راجعه ثم فعّله عندما يكون جاهزًا.';
    } catch (error) {
      if (_current(generation)) _failure(error);
    } finally {
      if (_current(generation)) {
        busy = false;
        _emit();
        await refresh();
      }
    }
  }

  Future<void> patchCategory(CoreMenu expected, CoreCategory category,
      {required String name, required int sort}) async {
    if (!_writeGuard(expected.tenantId, 'menu:update', CoreSection.menu))
      return;
    if (section != CoreSection.menu ||
        !writable ||
        expected.tenantId != selectedTenant ||
        membership?.can('menu:update') != true) return;
    if (menu?.version != expected.version) {
      message = 'تغيرت القائمة. افتح التصنيف من النسخة الحالية.';
      _emit();
      return;
    }
    final generation = ++_generation;
    busy = true;
    online = false;
    message = null;
    _emit();
    try {
      await api.patchCategory(expected, category, name: name, sort: sort);
      if (_current(generation))
        message = 'حُفظ التصنيف دون تغيير معرّفه أو أصنافه.';
    } catch (error) {
      if (_current(generation)) _failure(error);
    } finally {
      if (_current(generation)) {
        busy = false;
        _emit();
        await refresh();
      }
    }
  }

  Future<CoreMenuDetails> menuDetails(String id) async {
    final tenant = selectedTenant, generation = _generation;
    if (section != CoreSection.menu ||
        !signedIn ||
        tenant == null ||
        membership?.can('menu:read') != true)
      throw const CoreException('forbidden');
    try {
      final detail = await api.menuDetails(tenant, id);
      if (!_current(generation) || tenant != selectedTenant)
        throw const CoreException('cancelled');
      if (!signedIn || membership?.can('menu:read') != true)
        throw const CoreException('forbidden', status: 403);
      return detail;
    } catch (error) {
      if (_current(generation)) {
        _failure(error);
        _emit();
      }
      rethrow;
    }
  }

  Future<void> patchMenuDetails(CoreMenuDetails expected,
      {required String description, required List<CoreOption> options}) async {
    if (!_writeGuard(expected.tenantId, 'menu:update', CoreSection.menu))
      return;
    if (section != CoreSection.menu ||
        !writable ||
        expected.tenantId != selectedTenant ||
        membership?.can('menu:update') != true) return;
    if (menu == null || expected.version < menu!.version) {
      message = 'تغير الصنف أثناء تحرير التفاصيل. افتح نسخته الحالية.';
      _emit();
      return;
    }
    final generation = ++_generation;
    busy = true;
    online = false;
    message = null;
    _emit();
    try {
      await api.patchMenuDetails(expected,
          description: description, options: options);
      if (_current(generation))
        message = 'حُفظ الوصف والإضافات. الطلبات السابقة لم تتغير.';
    } catch (error) {
      if (_current(generation)) _failure(error);
    } finally {
      if (_current(generation)) {
        busy = false;
        _emit();
        await refresh();
      }
    }
  }

  void setSuspended(bool value) {
    if (_disposed || suspended == value) return;
    suspended = value;
    if (value) {
      _timer?.cancel();
      online = false;
    } else {
      _poll();
      unawaited(refresh());
    }
    _emit();
  }

  @override
  void dispose() {
    _disposed = true;
    ++_generation;
    _timer?.cancel();
    api.session.close();
    super.dispose();
  }
}

String errorMessage(Object error) {
  if (error is! CoreException) return 'تعذر إكمال العملية. أعد تحديث البيانات.';
  if (error.uncertain || error.code == 'order_outcome_unknown')
    return 'لم تتأكد نتيجة العملية. تحقق من البيانات بعد التحديث قبل تنفيذ إجراء آخر.';
  return switch (error.code) {
    'authentication_required' ||
    'invalid_grant' ||
    'invalid_saved_session' =>
      'انتهت الجلسة. سجّل الدخول من جديد.',
    'cancelled' => 'أُلغيت العملية.',
    'access_denied' => 'أُلغي تسجيل الدخول.',
    'secure_storage_unavailable' =>
      'تعذر الوصول إلى مخزن النظام الآمن. لن تُحفظ الجلسة في ملف عادي.',
    'conflict' ||
    'catalog_changed' =>
      'تغيرت البيانات على جهاز آخر. جرى طلب نسخة محدثة.',
    'payment_required' => 'يجب تأكيد الدفع قبل هذه الخطوة.',
    'invalid_status' =>
      'لا يسمح الخادم بهذه الخطوة الآن؛ راجع الطلب أو طلب إلغائه.',
    'forbidden' => 'تغيرت صلاحياتك. سجّل الدخول للتحقق منها.',
    'order_not_found' => 'لم يُعثر على الطلب في هذا المطعم.',
    'rate_limited' => 'طلبات كثيرة. انتظر قليلًا ثم حدّث.',
    'browser_unavailable' => 'تعذر فتح المتصفح. تحقق من وجود متصفح افتراضي.',
    _ => 'تعذر الاتصال أو التحقق من البيانات. التعديلات متوقفة حتى التحديث.',
  };
}
