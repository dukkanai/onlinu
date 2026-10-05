import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'admin_controller.dart' as admin;
import 'api.dart';
import 'models.dart';
import 'core/api.dart';
import 'core/app.dart';
import 'core/auth.dart';
import 'core/controller.dart';
import 'core/session_store.dart';
import 'core/transport.dart';

void main() {
  const coreUrl = String.fromEnvironment('CORE_API_BASE_URL');
  if (coreUrl.isNotEmpty) {
    WidgetsFlutterBinding.ensureInitialized();
    try {
      final origin = trustedOrigin(coreUrl);
      final auth = CoreAuth(coreUrl, store: OsCoreSessionStore(origin.origin));
      runApp(CoreApp(controller: CoreController(CoreApi(auth))));
    } on CoreException {
      runApp(const MaterialApp(
          home: Scaffold(
              body: Center(
                  child: Directionality(
        textDirection: TextDirection.rtl,
        child: Padding(
            padding: EdgeInsets.all(24),
            child: Text(
                'عنوان منصة الإدارة غير صالح. يلزم أصل HTTPS موثوق في إعداد البناء. لم يتم الاتصال بأي خدمة.')),
      )))));
    }
    return;
  }
  const baseUrl = String.fromEnvironment(
    'PROTOTYPE_API_BASE_URL',
    defaultValue: 'http://127.0.0.1:18787',
  );
  runApp(AdminApp(controller: admin.AdminController(RestAdminApi(baseUrl))));
}

class AdminApp extends StatefulWidget {
  const AdminApp({super.key, required this.controller});
  final admin.AdminController controller;

  @override
  State<AdminApp> createState() => _AdminAppState();
}

class _AdminAppState extends State<AdminApp> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    widget.controller.setSuspended(state != AppLifecycleState.resumed);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'إدارة المطعم • نموذج اصطناعي',
        debugShowCheckedModeBanner: false,
        locale: const Locale('ar'),
        supportedLocales: const [Locale('ar')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        theme: ThemeData(
          useMaterial3: true,
          colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xff155b4e)),
          scaffoldBackgroundColor: const Color(0xfff5f6f3),
          inputDecorationTheme: const InputDecorationTheme(
            border: OutlineInputBorder(),
            isDense: true,
          ),
        ),
        home: AdminScreen(controller: widget.controller),
      );
}

class AdminScreen extends StatelessWidget {
  const AdminScreen({super.key, required this.controller});
  final admin.AdminController controller;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: controller,
        builder: (context, _) {
          final online = controller.connection == admin.ConnectionState.online;
          final active = controller.orders
              .where((order) => order.status != 'completed')
              .length;
          return Scaffold(
            body: SafeArea(
              child: Column(
                children: [
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.symmetric(
                        horizontal: 24, vertical: 12),
                    color: const Color(0xffffedc5),
                    child: const Text(
                      'نموذج اصطناعي محلي فقط • هويات تطوير دون تحقق • لا عملاء أو أموال حقيقية',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                          color: Color(0xff624400),
                          fontWeight: FontWeight.w700),
                    ),
                  ),
                  Expanded(
                    child: Center(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 1220),
                        child: CustomScrollView(
                          slivers: [
                            SliverPadding(
                              padding:
                                  const EdgeInsets.fromLTRB(24, 28, 24, 12),
                              sliver: SliverToBoxAdapter(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Wrap(
                                      spacing: 16,
                                      runSpacing: 12,
                                      crossAxisAlignment:
                                          WrapCrossAlignment.center,
                                      children: [
                                        Container(
                                          padding: const EdgeInsets.all(14),
                                          decoration: BoxDecoration(
                                            color: const Color(0xff155b4e),
                                            borderRadius:
                                                BorderRadius.circular(18),
                                          ),
                                          child: const Icon(Icons.restaurant,
                                              color: Colors.white, size: 30),
                                        ),
                                        Column(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            Text(
                                              controller.restaurant?.name ??
                                                  'إدارة المطعم',
                                              style: Theme.of(context)
                                                  .textTheme
                                                  .headlineMedium
                                                  ?.copyWith(
                                                      fontWeight:
                                                          FontWeight.w800),
                                            ),
                                            const SizedBox(height: 4),
                                            const Text(
                                                'مساحة عمل Windows • متابعة الطلبات الاصطناعية'),
                                          ],
                                        ),
                                        Chip(
                                          avatar: Icon(
                                              online
                                                  ? Icons.cloud_done_outlined
                                                  : Icons.cloud_off_outlined,
                                              size: 18),
                                          label: Text(
                                              switch (controller.connection) {
                                            admin.ConnectionState.online =>
                                              'متصل',
                                            admin.ConnectionState.connecting =>
                                              'جارٍ الاتصال',
                                            admin.ConnectionState.offline =>
                                              'التعديلات موقوفة',
                                            admin.ConnectionState.signedOut =>
                                              'اختر هوية تطوير',
                                          }),
                                        ),
                                      ],
                                    ),
                                    const SizedBox(height: 24),
                                    _IdentityPanel(controller: controller),
                                    if (controller.error != null) ...[
                                      const SizedBox(height: 16),
                                      Semantics(
                                        liveRegion: true,
                                        child: Container(
                                          width: double.infinity,
                                          padding: const EdgeInsets.all(16),
                                          decoration: BoxDecoration(
                                            color: Theme.of(context)
                                                .colorScheme
                                                .errorContainer,
                                            borderRadius:
                                                BorderRadius.circular(12),
                                          ),
                                          child: Text(controller.error!,
                                              key: const Key(
                                                  'connection-error')),
                                        ),
                                      ),
                                    ],
                                    const SizedBox(height: 20),
                                    if (controller.restaurant != null)
                                      Wrap(
                                        spacing: 12,
                                        runSpacing: 12,
                                        children: [
                                          _Metric(
                                              label: 'طلبات نشطة',
                                              value: '$active'),
                                          _Metric(
                                              label: 'إجمالي الطلبات المعروضة',
                                              value:
                                                  '${controller.orders.length}'),
                                          _Metric(
                                              label: 'آخر تحديث للقائمة',
                                              value: _time(
                                                  controller.lastRefreshed)),
                                        ],
                                      ),
                                    const SizedBox(height: 24),
                                    Row(
                                      children: [
                                        Expanded(
                                            child: Text('الطلبات',
                                                style: Theme.of(context)
                                                    .textTheme
                                                    .titleLarge)),
                                        if (controller.busy)
                                          const Padding(
                                            padding: EdgeInsets.symmetric(
                                                horizontal: 12),
                                            child: SizedBox(
                                                width: 18,
                                                height: 18,
                                                child:
                                                    CircularProgressIndicator(
                                                        strokeWidth: 2)),
                                          ),
                                        OutlinedButton.icon(
                                          key: const Key('refresh-orders'),
                                          onPressed:
                                              controller.restaurant == null ||
                                                      controller.busy
                                                  ? null
                                                  : controller.refresh,
                                          icon: const Icon(Icons.refresh),
                                          label: const Text('تحديث'),
                                        ),
                                      ],
                                    ),
                                    const SizedBox(height: 8),
                                    const Text(
                                        'الحالة والمبلغ من الخادم. لا يُؤكَّد أي تعديل قبل استلام نتيجة العملية.'),
                                  ],
                                ),
                              ),
                            ),
                            if (controller.orders.isEmpty)
                              SliverPadding(
                                padding: const EdgeInsets.all(24),
                                sliver: SliverToBoxAdapter(
                                  child: _EmptyState(
                                      signedIn: controller.restaurant != null),
                                ),
                              )
                            else
                              SliverPadding(
                                padding:
                                    const EdgeInsets.fromLTRB(24, 4, 24, 24),
                                sliver: SliverList.builder(
                                  itemCount: controller.orders.length,
                                  itemBuilder: (context, index) => _OrderCard(
                                    order: controller.orders[index],
                                    canWrite: controller.canWrite,
                                    onAdvance: () => controller
                                        .advance(controller.orders[index]),
                                  ),
                                ),
                              ),
                            const SliverPadding(
                              padding: EdgeInsets.fromLTRB(24, 8, 24, 24),
                              sliver: SliverToBoxAdapter(
                                child: Text(
                                  'حدود النموذج: لا OAuth إنتاجي أو طباعة أو إشعارات خلفية أو إدارة منيو. قبول Windows الفعلي والتوقيع والتحديثات مراحل لاحقة.',
                                  style: TextStyle(
                                      color: Color(0xff53645e), fontSize: 12),
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      );

  String _time(DateTime? value) => value == null
      ? '—'
      : '${value.hour.toString().padLeft(2, '0')}:${value.minute.toString().padLeft(2, '0')}:${value.second.toString().padLeft(2, '0')}';
}

class _IdentityPanel extends StatelessWidget {
  const _IdentityPanel({required this.controller});
  final admin.AdminController controller;

  @override
  Widget build(BuildContext context) => Card(
        margin: EdgeInsets.zero,
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('هوية التطوير',
                  style: TextStyle(fontWeight: FontWeight.w800)),
              const SizedBox(height: 6),
              const Text(
                  'الاختيار مفتوح للتجربة المحلية فقط، ولا يثبت هوية موظف حقيقي.'),
              const SizedBox(height: 14),
              Wrap(
                spacing: 12,
                runSpacing: 12,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  for (final identity in ['merchant-a', 'merchant-b'])
                    FilledButton.tonalIcon(
                      key: Key(identity),
                      onPressed: controller.busy
                          ? null
                          : () => controller.signIn(identity),
                      icon: Icon(controller.identity == identity
                          ? Icons.check_circle
                          : Icons.person_outline),
                      label: Text(identity == 'merchant-a'
                          ? 'مطعم أ • merchant-a'
                          : 'مطعم ب • merchant-b'),
                    ),
                  if (controller.identity != null)
                    TextButton.icon(
                      key: const Key('sign-out'),
                      onPressed: controller.signOut,
                      icon: const Icon(Icons.logout),
                      label: const Text('مسح الجلسة المحلية'),
                    ),
                ],
              ),
            ],
          ),
        ),
      );
}

class _Metric extends StatelessWidget {
  const _Metric({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Container(
        width: 210,
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(
            color: Colors.white, borderRadius: BorderRadius.circular(16)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: const TextStyle(color: Color(0xff53645e))),
            const SizedBox(height: 8),
            Text(value,
                style:
                    const TextStyle(fontSize: 25, fontWeight: FontWeight.w800)),
          ],
        ),
      );
}

class _OrderCard extends StatelessWidget {
  const _OrderCard(
      {required this.order, required this.canWrite, required this.onAdvance});
  final RestaurantOrder order;
  final bool canWrite;
  final VoidCallback onAdvance;

  @override
  Widget build(BuildContext context) => Card(
        margin: const EdgeInsets.only(bottom: 12),
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Wrap(
                spacing: 12,
                runSpacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Text('طلب ${order.id}',
                      style: const TextStyle(fontWeight: FontWeight.w800)),
                  Chip(label: Text(statusLabel(order.status))),
                  Text(order.amount,
                      style: const TextStyle(
                          fontWeight: FontWeight.w800, fontSize: 20)),
                ],
              ),
              const SizedBox(height: 8),
              Text(order.items
                  .map((item) => '${item.quantity} × ${item.name}')
                  .join('  ·  ')),
              const SizedBox(height: 12),
              Wrap(
                spacing: 16,
                runSpacing: 12,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Text(order.paymentStatus == 'paid'
                      ? 'محاكاة الدفع مكتملة • لا تحصيل حقيقي'
                      : 'لا يبدأ التحضير قبل محاكاة الدفع'),
                  Text('نسخة ${order.version}'),
                  if (order.nextStatus != null)
                    FilledButton.icon(
                      key: Key('advance-${order.id}'),
                      onPressed: canWrite ? onAdvance : null,
                      icon: const Icon(Icons.arrow_forward),
                      label: Text(actionLabel(order.nextStatus!)),
                    ),
                ],
              ),
            ],
          ),
        ),
      );
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.signedIn});
  final bool signedIn;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(36),
        decoration: BoxDecoration(
            color: Colors.white, borderRadius: BorderRadius.circular(18)),
        child: Column(
          children: [
            const Icon(Icons.receipt_long_outlined,
                size: 48, color: Color(0xff537c6d)),
            const SizedBox(height: 16),
            Text(signedIn
                ? 'لا توجد طلبات لهذا المطعم بعد'
                : 'ابدأ باختيار مطعم التجربة'),
            const SizedBox(height: 8),
            Text(
              signedIn
                  ? 'أنشئ طلبًا اصطناعيًا من مسار الشراء المحلي ثم حدّث القائمة.'
                  : 'ستعرض كل هوية الطلبات المسموح بها لمطعمها فقط.',
              textAlign: TextAlign.center,
            ),
          ],
        ),
      );
}
