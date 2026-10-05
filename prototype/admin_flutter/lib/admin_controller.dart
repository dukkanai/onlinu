import 'dart:async';

import 'package:flutter/foundation.dart';

import 'api.dart';
import 'models.dart';

enum ConnectionState { signedOut, connecting, online, offline }

class AdminController extends ChangeNotifier {
  AdminController(this._api, {this.pollInterval = const Duration(seconds: 8)});
  final AdminApi _api;
  final Duration pollInterval;
  Timer? _timer;
  int _generation = 0;
  bool _disposed = false;
  bool _suspended = false;
  bool _busy = false;
  String? identity;
  Restaurant? restaurant;
  List<RestaurantOrder> orders = const [];
  ConnectionState connection = ConnectionState.signedOut;
  DateTime? lastRefreshed;
  String? error;

  bool get busy => _busy;
  bool get canWrite =>
      !_busy && !_suspended && connection == ConnectionState.online;

  void _emit() {
    if (!_disposed) notifyListeners();
  }

  bool _current(int generation) => !_disposed && generation == _generation;

  Future<void> signIn(String selectedIdentity) async {
    if (_disposed || _busy) return;
    signOut();
    final generation = _generation;
    _busy = true;
    connection = ConnectionState.connecting;
    _emit();
    try {
      await _api.signIn(selectedIdentity);
      if (!_current(generation)) return;
      final available = await _api.restaurants();
      if (!_current(generation)) return;
      final selected = available.single;
      final loaded = await _api.orders(selected.id);
      if (!_current(generation)) return;
      identity = selectedIdentity;
      restaurant = selected;
      orders = loaded;
      connection = ConnectionState.online;
      lastRefreshed = DateTime.now();
      _schedule();
    } catch (problem) {
      if (!_current(generation)) return;
      _api.clearSession();
      connection = ConnectionState.signedOut;
      error = _message(problem);
    } finally {
      if (_current(generation)) {
        _busy = false;
        _emit();
      }
    }
  }

  Future<void> refresh() async {
    final currentRestaurant = restaurant;
    if (_disposed || _busy || _suspended || currentRestaurant == null) return;
    final generation = _generation;
    _busy = true;
    _emit();
    try {
      final loaded = await _api.orders(currentRestaurant.id);
      if (!_current(generation)) return;
      orders = loaded;
      connection = ConnectionState.online;
      lastRefreshed = DateTime.now();
      error = null;
    } catch (problem) {
      if (_current(generation)) _fail(problem);
    } finally {
      if (_current(generation)) {
        _busy = false;
        _emit();
      }
    }
  }

  Future<void> advance(RestaurantOrder order) async {
    final next = order.nextStatus;
    final currentRestaurant = restaurant;
    if (!canWrite || next == null || currentRestaurant == null) return;
    // A stale card cannot mutate another restaurant or silently reuse a newer
    // version. The server remains authoritative for role/state/payment checks.
    if (order.tenantId != currentRestaurant.id ||
        !orders.any(
            (item) => item.id == order.id && item.version == order.version)) {
      return;
    }
    final generation = _generation;
    _busy = true;
    _emit();
    try {
      final updated =
          await _api.updateStatus(currentRestaurant.id, order, next);
      if (!_current(generation)) return;
      orders =
          orders.map((item) => item.id == updated.id ? updated : item).toList();
      error = null;
    } catch (problem) {
      // Never retry a mutation automatically after an uncertain response.
      // Refresh fetches the persisted version before another user action.
      if (_current(generation)) _fail(problem);
    } finally {
      if (_current(generation)) {
        _busy = false;
        _emit();
      }
    }
  }

  void _fail(Object problem) {
    error = _message(problem);
    connection = ConnectionState.offline;
    if (problem is AdminApiException && problem.status == 401) {
      final message = error;
      signOut();
      error = message;
      _emit();
    }
  }

  String _message(Object problem) => problem is AdminApiException
      ? problem.message
      : const AdminApiException('invalid_response').message;

  void _schedule() {
    _timer?.cancel();
    if (!_suspended && !_disposed && restaurant != null) {
      _timer = Timer.periodic(pollInterval, (_) => unawaited(refresh()));
    }
  }

  void setSuspended(bool suspended) {
    if (_disposed || _suspended == suspended) return;
    _suspended = suspended;
    _timer?.cancel();
    if (!suspended && restaurant != null) {
      connection = ConnectionState.offline;
      _schedule();
      unawaited(refresh());
    }
    _emit();
  }

  void signOut() {
    _generation++;
    _timer?.cancel();
    _timer = null;
    _api.clearSession();
    identity = null;
    restaurant = null;
    orders = const [];
    error = null;
    lastRefreshed = null;
    connection = ConnectionState.signedOut;
    _busy = false;
    _emit();
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    _timer?.cancel();
    _api.close();
    super.dispose();
  }
}
