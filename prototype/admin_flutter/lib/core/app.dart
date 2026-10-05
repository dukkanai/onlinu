import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'controller.dart';
import 'models.dart';

class CoreApp extends StatefulWidget {
  const CoreApp({super.key, required this.controller});
  final CoreController controller;
  @override
  State<CoreApp> createState() => _CoreAppState();
}

class _CoreAppState extends State<CoreApp> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(widget.controller.start());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) =>
      widget.controller.setSuspended(state != AppLifecycleState.resumed);
  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Onlinu • إدارة المطاعم',
        debugShowCheckedModeBanner: false,
        locale: const Locale('ar'),
        supportedLocales: const [Locale('ar')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        theme: ThemeData(
            useMaterial3: true,
            colorScheme:
                ColorScheme.fromSeed(seedColor: const Color(0xff155b4e)),
            scaffoldBackgroundColor: const Color(0xfff5f6f3)),
        home: CoreScreen(controller: widget.controller),
      );
}

class CoreScreen extends StatelessWidget {
  const CoreScreen({super.key, required this.controller});
  final CoreController controller;
  Future<void> _change(BuildContext context, CoreOrder order,
      {bool cash = false}) async {
    final tenant = controller.selectedTenant;
    final accepted = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
              title: Text(cash ? 'تأكيد استلام النقد' : 'تحديث حالة الطلب'),
              content: Text(cash
                  ? 'هل استلمت فعليًا ${money(order.totalMinor)} للطلب ${order.number} في المطعم $tenant؟ هذا يسجل تحصيلًا ماليًا.'
                  : 'الطلب ${order.number} في المطعم $tenant: الانتقال إلى ${coreStatusLabel(order.nextStatus ?? '')}؟'),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(context, false),
                    child: const Text('رجوع')),
                FilledButton(
                    onPressed: () => Navigator.pop(context, true),
                    child: const Text('تأكيد'))
              ],
            ));
    if (!context.mounted ||
        accepted != true ||
        controller.selectedTenant != tenant) return;
    await controller.change(order, cash: cash);
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final c = controller, member = c.membership;
        return Scaffold(
          appBar: AppBar(title: const Text('إدارة المطاعم'), actions: [
            if (c.signedIn)
              TextButton(
                  onPressed: () {
                    unawaited(c.signOut());
                  },
                  child: const Text('تسجيل الخروج'))
          ]),
          body: Center(
              child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 1150),
                  child: ListView(padding: const EdgeInsets.all(20), children: [
                    Text(c.api.session.origin.origin,
                        textDirection: TextDirection.ltr,
                        style: Theme.of(context).textTheme.labelMedium),
                    const SizedBox(height: 12),
                    if (c.message != null)
                      Card(
                          color: Theme.of(context)
                              .colorScheme
                              .surfaceContainerHighest,
                          child: Padding(
                              padding: const EdgeInsets.all(14),
                              child: Text(c.message!,
                                  key: const Key('core-message')))),
                    if (!c.signedIn) ...[
                      const SizedBox(height: 40),
                      const Text('مرحبًا بك في Onlinu',
                          style: TextStyle(
                              fontSize: 30, fontWeight: FontWeight.bold)),
                      const SizedBox(height: 12),
                      const Text(
                          'ادخل بحسابك المعتمد عبر متصفح النظام. ستظهر المطاعم والصلاحيات المسندة إليك فقط.'),
                      const SizedBox(height: 24),
                      if (c.busy) ...[
                        const LinearProgressIndicator(),
                        const SizedBox(height: 12),
                        TextButton(
                            onPressed: () {
                              unawaited(c.signOut());
                            },
                            child: const Text('إلغاء الدخول'))
                      ] else
                        FilledButton.icon(
                            onPressed: () {
                              unawaited(c.start(restore: false));
                            },
                            icon: const Icon(Icons.open_in_browser),
                            label: const Text('الدخول عبر المتصفح')),
                    ] else ...[
                      DropdownButtonFormField<String>(
                          key: ValueKey('tenant-${c.selectedTenant}'),
                          initialValue: c.selectedTenant,
                          decoration: const InputDecoration(
                              labelText: 'المطعم',
                              border: OutlineInputBorder()),
                          items: c.profile!.memberships
                              .map((v) => DropdownMenuItem(
                                  value: v.tenantId,
                                  child: Text(
                                      '${v.tenantId}${v.tenantStatus == 'suspended' ? ' • موقوف' : ''}')))
                              .toList(),
                          onChanged: c.busy
                              ? null
                              : (value) {
                                  unawaited(c.selectTenant(value));
                                }),
                      const SizedBox(height: 12),
                      Wrap(
                          spacing: 12,
                          runSpacing: 8,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            Chip(
                                avatar: Icon(
                                    c.online
                                        ? Icons.cloud_done
                                        : Icons.cloud_off,
                                    size: 18),
                                label: Text(c.online
                                    ? 'بيانات محدثة'
                                    : 'التعديل متوقف حتى التحديث')),
                            if (member != null) Text(roleLabel(member.role)),
                            OutlinedButton.icon(
                                onPressed: c.busy
                                    ? null
                                    : () {
                                        unawaited(c.refresh());
                                      },
                                icon: const Icon(Icons.refresh),
                                label: const Text('تحديث')),
                          ]),
                      if (c.busy) const LinearProgressIndicator(),
                      if (c.selectedTenant == null)
                        const Padding(
                            padding: EdgeInsets.all(24),
                            child: Text('اختر المطعم الذي تريد إدارته.')),
                      if (member?.can('orders:read') == true) ...[
                        const SizedBox(height: 20),
                        const Text('آخر 100 طلب',
                            style: TextStyle(
                                fontSize: 24, fontWeight: FontWeight.bold)),
                        const Text(
                            'تُحدّث القائمة أثناء فتح التطبيق. الإجراءات تحتاج نسخة حديثة واتصالًا بالخادم.'),
                        if (c.orders.isEmpty)
                          const Padding(
                              padding: EdgeInsets.all(24),
                              child: Text('لا توجد طلبات معروضة.')),
                        for (final order in c.orders)
                          Card(
                              key: ValueKey(order.number),
                              child: Padding(
                                  padding: const EdgeInsets.all(16),
                                  child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        Wrap(
                                            spacing: 14,
                                            runSpacing: 8,
                                            children: [
                                              Text(order.number,
                                                  style: const TextStyle(
                                                      fontWeight:
                                                          FontWeight.bold)),
                                              Text(coreStatusLabel(
                                                  order.status)),
                                              Text(money(order.totalMinor)),
                                              Text(order.paymentStatus == 'paid'
                                                  ? 'مدفوع'
                                                  : order.paymentStatus ==
                                                          'unpaid'
                                                      ? 'غير مدفوع'
                                                      : 'الدفع قيد المراجعة'),
                                              Text(modeLabel(order.mode))
                                            ]),
                                        const SizedBox(height: 12),
                                        Wrap(
                                            spacing: 10,
                                            runSpacing: 8,
                                            children: [
                                              OutlinedButton(
                                                  onPressed: () {
                                                    unawaited(c.showDetail(
                                                        order.number));
                                                  },
                                                  child: const Text(
                                                      'تفاصيل الطلب')),
                                              if (member!
                                                      .can('orders:update') &&
                                                  order.nextStatus != null)
                                                FilledButton(
                                                    onPressed: c.writable
                                                        ? () {
                                                            unawaited(_change(
                                                                context,
                                                                order));
                                                          }
                                                        : null,
                                                    child: Text(
                                                        'نقل إلى ${coreStatusLabel(order.nextStatus!)}')),
                                              if (member.can(
                                                      'payments:collect') &&
                                                  order.canCollect)
                                                OutlinedButton.icon(
                                                    onPressed: c.writable
                                                        ? () {
                                                            unawaited(_change(
                                                                context, order,
                                                                cash: true));
                                                          }
                                                        : null,
                                                    icon: const Icon(Icons
                                                        .payments_outlined),
                                                    label: const Text(
                                                        'تسجيل استلام النقد')),
                                            ]),
                                      ]))),
                      ],
                      if (c.loadingDetail)
                        Row(children: [
                          const Expanded(child: LinearProgressIndicator()),
                          TextButton(
                              onPressed: c.closeDetail,
                              child: const Text('إغلاق التفاصيل'))
                        ]),
                      if (c.detail != null)
                        _Detail(order: c.detail!, close: c.closeDetail),
                    ],
                  ]))),
        );
      });
}

class _Detail extends StatelessWidget {
  const _Detail({required this.order, required this.close});
  final CoreOrder order;
  final VoidCallback close;
  @override
  Widget build(BuildContext context) => Card(
      child: Padding(
          padding: const EdgeInsets.all(20),
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(
                  child: Text('تفاصيل ${order.number}',
                      style: Theme.of(context).textTheme.titleLarge)),
              IconButton(
                  tooltip: 'إغلاق التفاصيل',
                  onPressed: close,
                  icon: const Icon(Icons.close))
            ]),
            if (order.tableName.isNotEmpty) Text('الطاولة: ${order.tableName}'),
            for (final item in order.items)
              Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Text(
                      '${item.quantity} × ${item.name} • ${money(item.totalMinor)}${item.options.isEmpty ? '' : '\n${item.options.join('، ')}'}')),
            if (order.notes.isNotEmpty) Text('ملاحظات: ${order.notes}'),
            const Divider(),
            Text('الإجمالي: ${money(order.totalMinor)}'),
          ])));
}

String roleLabel(String role) => switch (role) {
      'owner' => 'مالك',
      'manager' => 'مدير',
      'supervisor' => 'مشرف',
      'kitchen' => 'مطبخ',
      'cashier' => 'كاشير',
      'courier' => 'مندوب',
      _ => 'موظف'
    };
String modeLabel(String mode) =>
    switch (mode) { 'table' => 'طاولة', 'delivery' => 'توصيل', _ => 'استلام' };
