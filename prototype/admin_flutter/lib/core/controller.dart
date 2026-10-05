import 'dart:async';
import 'package:flutter/foundation.dart';
import 'api.dart';
import 'auth.dart';
import 'models.dart';
import 'team_models.dart';
import 'business_profile.dart';
import 'delivery_models.dart';
import 'courier_models.dart';
import 'transport.dart';

enum CoreSection {
  orders,
  stock,
  channels,
  menu,
  team,
  business,
  coverage,
  courier,
  courierLinks
}

extension CoreSectionPermission on CoreSection {
  String get permission => switch (this) {
        CoreSection.orders => 'orders:read',
        CoreSection.stock => 'stock:read',
        CoreSection.channels => 'channels:manage',
        CoreSection.menu => 'menu:read',
        CoreSection.team => 'members:manage',
        CoreSection.business => 'settings:read',
        CoreSection.coverage => 'settings:read',
        CoreSection.courier => 'courier:read',
        CoreSection.courierLinks => 'couriers:link'
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
  CoreBusinessProfile? business;
  CoreDelivery? coverage;
  CoreCourierLinks? courierLinks;
  CoreCourierWork? courierWork;
  CoreCourierDetail? courierDetail;
  List<CoreTeamMember> team = const [];
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
    business = null;
    coverage = null;
    courierLinks = null;
    courierWork = null;
    courierDetail = null;
    team = const [];
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
      if (section == CoreSection.courierLinks) {
        final result = await api.courierLinks(tenant);
        if (!_current(generation)) return;
        courierLinks = result;
      } else if (section == CoreSection.courier) {
        final result = await api.courierWork(tenant);
        if (!_current(generation)) return;
        courierWork = result;
        if (courierDetail != null &&
            (courierDetail!.bindingVersion != result.bindingVersion ||
                !result.orders.any((v) =>
                    v.number == courierDetail!.order.number &&
                    v.version == courierDetail!.order.version))) {
          courierDetail = null;
          _detailGeneration++;
        }
      } else if (section == CoreSection.orders) {
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
      } else if (section == CoreSection.coverage) {
        final result = await api.delivery(tenant);
        if (!_current(generation)) return;
        coverage = result;
      } else if (section == CoreSection.business) {
        final result = await api.businessProfile(tenant);
        if (!_current(generation)) return;
        business = result;
      } else if (section == CoreSection.team) {
        final result = await api.team(tenant);
        if (!_current(generation)) return;
        team = result;
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
    courierDetail = null;
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
    courierDetail = null;
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

  Future<void> showCourierDetail(CoreOrder order) async {
    final work = courierWork;
    if (work == null ||
        section != CoreSection.courier ||
        !signedIn ||
        suspended ||
        membership?.can('courier:read') != true) return;
    final generation = _generation, detailGeneration = ++_detailGeneration;
    courierDetail = null;
    loadingDetail = true;
    _emit();
    try {
      final result = await api.courierDetail(work, order);
      if (_current(generation) && detailGeneration == _detailGeneration)
        courierDetail = result;
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

  Future<void> _courierMutation(
      String tenant,
      String permission,
      CoreSection target,
      Future<void> Function() action,
      String success) async {
    if (!_writeGuard(tenant, permission, target)) return;
    final generation = ++_generation;
    busy = true;
    online = false;
    message = null;
    courierDetail = null;
    _detailGeneration++;
    _emit();
    try {
      await action();
      if (_current(generation)) message = success;
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

  Future<void> setCourierLink(
      CoreCourierLinks expected, CoreCourierLink link, String principal) async {
    final current = courierLinks;
    if (current == null ||
        current.tenantId != expected.tenantId ||
        !current.links.any((v) =>
            v.courier.id == link.courier.id && v.version == link.version))
      return;
    await _courierMutation(
        expected.tenantId,
        'couriers:link',
        CoreSection.courierLinks,
        () => api.setCourierLink(expected, link, principal),
        'حُفظ ربط هوية المندوب.');
  }

  Future<void> changeCourier(CoreCourierWork expected, CoreOrder order,
      {bool cash = false}) async {
    final current = courierWork;
    if (current == null ||
        current.bindingVersion != expected.bindingVersion ||
        current.courier?.id != expected.courier?.id ||
        !current.orders
            .any((v) => v.number == order.number && v.version == order.version))
      return;
    await _courierMutation(
        expected.tenantId,
        cash ? 'courier:collect' : 'courier:update',
        CoreSection.courier,
        () => api.courierChange(expected, order, cash: cash),
        cash ? 'سُجل استلام نقد الطلب.' : 'حُدثت مرحلة التوصيل.');
  }

  Future<void> setCourierAvailability(
      CoreCourierWork expected, String availability) async {
    final current = courierWork;
    if (current == null ||
        current.bindingVersion != expected.bindingVersion ||
        current.courier?.id != expected.courier?.id) return;
    await _courierMutation(
        expected.tenantId,
        'courier:update',
        CoreSection.courier,
        () => api.courierAvailability(expected, availability),
        'حُدثت حالة توفر المندوب.');
  }

  Future<List<CoreCourier>> couriers(String tenant) async {
    final generation = _generation;
    if (!signedIn ||
        selectedTenant != tenant ||
        membership?.can('delivery:assign') != true)
      throw const CoreException('forbidden');
    try {
      final result = await api.couriers(tenant);
      if (!_current(generation) || selectedTenant != tenant)
        throw const CoreException('cancelled');
      if (!signedIn || membership?.can('delivery:assign') != true)
        throw const CoreException('forbidden', status: 403);
      return result;
    } catch (error) {
      if (_current(generation)) {
        _failure(error);
        _emit();
      }
      rethrow;
    }
  }

  Future<void> assignCourier(CoreOrder expected, String courier) async {
    if (!_writeGuard(expected.tenantId, 'delivery:assign', CoreSection.orders))
      return;
    if (!expected.canAssign ||
        !orders.any((v) =>
            v.number == expected.number && v.version == expected.version)) {
      message = 'تغير الطلب أو لم يعد يقبل إسناد مندوب. حدّث البيانات.';
      _emit();
      return;
    }
    if (courier == expected.courierId) {
      message = 'المندوب المحدد هو المندوب الحالي؛ لم يُرسل تغيير.';
      _emit();
      return;
    }
    final generation = ++_generation;
    busy = true;
    online = false;
    detail = null;
    loadingDetail = false;
    _detailGeneration++;
    message = null;
    _emit();
    try {
      await api.assignCourier(expected.tenantId, expected, courier);
      if (_current(generation))
        message = courier.isEmpty
            ? 'أُلغي إسناد المندوب للطلب.'
            : 'أُسند الطلب للمندوب المحدد.';
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

  Future<CoreGeography> geography(String kind, {String? parent}) async {
    final tenant = selectedTenant, generation = _generation;
    if (!signedIn ||
        tenant == null ||
        section != CoreSection.coverage ||
        membership?.can('settings:read') != true)
      throw const CoreException('forbidden');
    try {
      final result = await api.geography(tenant, kind, parent: parent);
      if (!_current(generation) || tenant != selectedTenant)
        throw const CoreException('cancelled');
      if (!signedIn || membership?.can('settings:read') != true)
        throw const CoreException('forbidden', status: 403);
      return result;
    } catch (error) {
      if (_current(generation)) {
        _failure(error);
        _emit();
      }
      rethrow;
    }
  }

  Future<void> deliveryPricing(CoreDelivery expected,
          {required String mode, required int fee, required int minimum}) =>
      _deliveryWrite(
          expected,
          () => api.setDeliveryPricing(expected,
              mode: mode, fee: fee, minimum: minimum));
  Future<void> deliveryZone(CoreDelivery expected,
          {required String district,
          required bool enabled,
          required int? fee}) =>
      _deliveryWrite(
          expected,
          () => api.setDeliveryZone(expected,
              district: district, enabled: enabled, fee: fee));
  Future<void> _deliveryWrite(
      CoreDelivery expected, Future<void> Function() write) async {
    if (!_writeGuard(
        expected.tenantId, 'settings:update', CoreSection.coverage)) return;
    if (coverage == null || coverage!.version != expected.version) {
      message = 'تغيرت رسوم أو مناطق التوصيل. افتح النسخة الحالية.';
      _emit();
      return;
    }
    final generation = ++_generation;
    busy = true;
    online = false;
    message = null;
    _emit();
    try {
      await write();
      if (_current(generation))
        message = 'حُفظت إعدادات التوصيل. رسوم الطلبات السابقة لم تتغير.';
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

  Future<void> patchBusiness(
      CoreBusinessProfile expected, Map<String, String> changes) async {
    if (!_writeGuard(
        expected.tenantId, 'settings:update', CoreSection.business)) return;
    if (business == null || expected.version != business!.version) {
      message = 'تغيرت بيانات المطعم. افتح النسخة الحالية.';
      _emit();
      return;
    }
    final generation = ++_generation;
    busy = true;
    online = false;
    message = null;
    _emit();
    try {
      await api.patchBusinessProfile(expected, changes);
      if (_current(generation)) message = 'حُفظت بيانات المطعم العامة.';
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

  Future<void> setMember(String tenant, TeamChange change) async {
    if (!_writeGuard(tenant, 'members:manage', CoreSection.team)) return;
    CoreTeamMember? old;
    for (final value in team) {
      if (value.principalId == change.principalId) old = value;
    }
    if (old?.version != change.expectedVersion) {
      message = 'تغيرت عضوية الموظف. حدّث الفريق وأعد مراجعة التعديل.';
      _emit();
      return;
    }
    final member = membership!;
    if (member.role != 'owner' &&
        (old?.role == 'owner' ||
            change.role == 'owner' ||
            !member.permissions.containsAll(change.permissions))) {
      message = 'لا يمكنك منح صلاحيات لا تملكها أو تعديل مالك المطعم.';
      _emit();
      return;
    }
    final generation = ++_generation;
    busy = true;
    online = false;
    message = null;
    _emit();
    try {
      await api.setMember(tenant, change);
      if (_current(generation)) message = 'حُفظت عضوية الموظف وصلاحياته.';
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

  Future<Uint8List> menuImage(CoreMenuDetails details) async {
    final generation = _generation;
    bool allowed() =>
        signedIn &&
        selectedTenant == details.tenantId &&
        membership?.can('menu:read') == true;
    if (!allowed()) throw const CoreException('forbidden');
    final bytes = await api.image(details);
    if (!_current(generation) || !allowed())
      throw const CoreException('cancelled');
    return bytes;
  }

  Future<CoreMenuDetails?> uploadMenuImage(
      CoreMenuDetails expected, Uint8List bytes) async {
    if (!_writeGuard(expected.tenantId, 'menu:update', CoreSection.menu))
      return null;
    if (menu == null || expected.version < menu!.version) {
      message = 'تغير الصنف. افتح نسخته الحالية قبل رفع الصورة.';
      _emit();
      return null;
    }
    final generation = ++_generation;
    busy = true;
    online = false;
    message = null;
    _emit();
    CoreMenuDetails? saved;
    try {
      final result = await api.uploadImage(expected, bytes);
      if (_current(generation)) {
        saved = result;
        message = 'حُفظت صورة الصنف في القائمة العامة.';
      }
    } catch (error) {
      if (_current(generation)) _failure(error);
    } finally {
      if (_current(generation)) {
        busy = false;
        _emit();
        await refresh();
      }
    }
    if (!signedIn ||
        selectedTenant != expected.tenantId ||
        membership?.can('menu:read') != true) return null;
    return saved;
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
    'image_too_large' => 'اختر صورة غير فارغة لا تتجاوز 5 ميغابايت.',
    'image_invalid' => 'الصورة غير صالحة. اختر ملف PNG أو JPEG صالحًا.',
    'image_unavailable' => 'تعذر تحميل الصورة الحالية من خادم المطعم.',
    'access_denied' => 'أُلغي تسجيل الدخول.',
    'secure_storage_unavailable' =>
      'تعذر الوصول إلى مخزن النظام الآمن. لن تُحفظ الجلسة في ملف عادي.',
    'invalid_delivery_zones' =>
      'تحقق من أن الحي متاح وأن له رسم توصيل محددًا. الصفر يعني توصيلًا مجانيًا.',
    'invalid_geography' =>
      'تعذر اختيار هذه المنطقة أو المدينة. حدّث البيانات الجغرافية.',
    'identity_disabled' =>
      'يجب أن يسجل الموظف الدخول بحساب موثّق أولًا وأن يكون حسابه مفعّلًا.',
    'last_owner_required' => 'لا يمكن تعطيل أو إزالة آخر مالك مفعّل للمطعم.',
    'invalid_owner_permissions' => 'يجب أن يحتفظ المالك بجميع صلاحيات المطعم.',
    'version_conflict' ||
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
