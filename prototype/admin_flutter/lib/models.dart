class Restaurant {
  const Restaurant({required this.id, required this.name});
  factory Restaurant.fromJson(Map<String, dynamic> json) => Restaurant(
        id: json['id'] as String,
        name: json['name'] as String,
      );
  final String id;
  final String name;
}

class OrderLine {
  const OrderLine({required this.name, required this.quantity});
  factory OrderLine.fromJson(Map<String, dynamic> json) => OrderLine(
        name: (json['name'] ?? json['itemId']) as String,
        quantity: json['quantity'] as int,
      );
  final String name;
  final int quantity;
}

class RestaurantOrder {
  const RestaurantOrder({
    required this.id,
    required this.tenantId,
    required this.status,
    required this.paymentStatus,
    required this.version,
    required this.totalMinor,
    required this.currency,
    required this.items,
  });
  factory RestaurantOrder.fromJson(Map<String, dynamic> json) =>
      RestaurantOrder(
        id: json['id'] as String,
        tenantId: json['tenantId'] as String,
        status: json['status'] as String,
        paymentStatus: json['paymentStatus'] as String,
        version: json['version'] as int,
        totalMinor: json['totalMinor'] as int,
        currency: json['currency'] as String,
        items: (json['items'] as List)
            .map((item) => OrderLine.fromJson(item as Map<String, dynamic>))
            .toList(growable: false),
      );

  final String id;
  final String tenantId;
  final String status;
  final String paymentStatus;
  final int version;
  final int totalMinor;
  final String currency;
  final List<OrderLine> items;

  String? get nextStatus {
    if (paymentStatus != 'paid') return null;
    return switch (status) {
      'accepted' => 'preparing',
      'preparing' => 'ready',
      'ready' => 'completed',
      _ => null,
    };
  }

  String get amount => '${(totalMinor / 100).toStringAsFixed(2)} ر.س';
}

String statusLabel(String status) => switch (status) {
      'pending_payment' => 'بانتظار محاكاة الدفع',
      'accepted' => 'مقبول',
      'preparing' => 'قيد التحضير',
      'ready' => 'جاهز',
      'completed' => 'مكتمل',
      _ => 'حالة غير مدعومة',
    };

String actionLabel(String status) => switch (status) {
      'preparing' => 'بدء التحضير',
      'ready' => 'الطلب جاهز',
      'completed' => 'تأكيد الاكتمال',
      _ => 'لا إجراء متاح',
    };
