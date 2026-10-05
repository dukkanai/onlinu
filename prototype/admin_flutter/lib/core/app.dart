import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'controller.dart';
import 'models.dart';
import 'stock_pane.dart';
import 'channels_pane.dart';
import 'menu_pane.dart';
import 'team_pane.dart';

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

  Future<void> _details(BuildContext context, String number) async {
    unawaited(controller.showDetail(number));
    await showDialog<void>(
        context: context,
        builder: (dialogContext) => ListenableBuilder(
              listenable: controller,
              builder: (context, _) => Dialog(
                  child: ConstrainedBox(
                constraints:
                    const BoxConstraints(maxWidth: 720, maxHeight: 650),
                child: SingleChildScrollView(
                    child: controller.detail != null
                        ? _Detail(
                            order: controller.detail!,
                            close: () => Navigator.pop(dialogContext))
                        : Padding(
                            padding: const EdgeInsets.all(24),
                            child: Column(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  if (controller.loadingDetail)
                                    const LinearProgressIndicator()
                                  else
                                    Text(controller.message ??
                                        'تعذر عرض التفاصيل.'),
                                  TextButton(
                                      onPressed: () =>
                                          Navigator.pop(dialogContext),
                                      child: const Text('إغلاق التفاصيل')),
                                ]))),
              )),
            ));
    controller.closeDetail();
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
                              child: Semantics(
                                  container: true,
                                  liveRegion: true,
                                  child: Text(c.message!,
                                      key: const Key('core-message'))))),
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
                                      '${v.tenantName}${v.tenantName != v.tenantId ? ' • ${v.tenantId}' : ''}${v.tenantStatus == 'suspended' ? ' • موقوف' : ''}')))
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
                      if (c.refreshedAt != null)
                        Text('آخر تحديث: ${localTimestamp(c.refreshedAt!)}',
                            style: Theme.of(context).textTheme.labelSmall),
                      if (member?.tenantStatus == 'suspended')
                        const Text(
                            'المطعم موقوف للطلبات الجديدة. يمكن متابعة الطلبات المقبولة وتسويتها حسب صلاحياتك.'),
                      if (c.busy)
                        const LinearProgressIndicator(
                            semanticsLabel: 'جارٍ تنفيذ العملية'),
                      if (c.selectedTenant == null)
                        const Padding(
                            padding: EdgeInsets.all(24),
                            child: Text('اختر المطعم الذي تريد إدارته.')),
                      if (member != null)
                        Wrap(spacing: 12, children: [
                          if (member.can('orders:read'))
                            ChoiceChip(
                                label: const Text('الطلبات'),
                                selected: c.section == CoreSection.orders,
                                onSelected: c.busy
                                    ? null
                                    : (_) {
                                        unawaited(c
                                            .selectSection(CoreSection.orders));
                                      }),
                          if (member.can('stock:read'))
                            ChoiceChip(
                                label: const Text('المخزون'),
                                selected: c.section == CoreSection.stock,
                                onSelected: c.busy
                                    ? null
                                    : (_) {
                                        unawaited(
                                            c.selectSection(CoreSection.stock));
                                      }),
                          if (member.can('menu:read'))
                            ChoiceChip(
                                label: const Text('الأصناف'),
                                selected: c.section == CoreSection.menu,
                                onSelected: c.busy
                                    ? null
                                    : (_) {
                                        unawaited(
                                            c.selectSection(CoreSection.menu));
                                      }),
                          if (member.can('members:manage'))
                            ChoiceChip(
                                label: const Text('الفريق'),
                                selected: c.section == CoreSection.team,
                                onSelected: c.busy
                                    ? null
                                    : (_) {
                                        unawaited(
                                            c.selectSection(CoreSection.team));
                                      }),
                          if (member.can('channels:manage'))
                            ChoiceChip(
                                label: const Text('قنوات الطلب'),
                                selected: c.section == CoreSection.channels,
                                onSelected: c.busy
                                    ? null
                                    : (_) {
                                        unawaited(c.selectSection(
                                            CoreSection.channels));
                                      }),
                        ]),
                      if (c.section == CoreSection.team &&
                          member?.can('members:manage') == true)
                        TeamPane(
                            key: ValueKey('team-${c.selectedTenant}'),
                            controller: c),
                      if (c.section == CoreSection.menu &&
                          member?.can('menu:read') == true)
                        MenuPane(
                            key: ValueKey('menu-${c.selectedTenant}'),
                            controller: c),
                      if (c.section == CoreSection.channels &&
                          member?.can('channels:manage') == true)
                        ChannelsPane(controller: c),
                      if (c.section == CoreSection.stock &&
                          member?.can('stock:read') == true)
                        StockPane(
                            key: ValueKey('stock-${c.selectedTenant}'),
                            controller: c),
                      if (c.section == CoreSection.orders &&
                          member?.can('orders:read') == true) ...[
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
                                                    unawaited(_details(
                                                        context, order.number));
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

String localTimestamp(DateTime value) {
  final date = value.toLocal();
  String two(int part) => part.toString().padLeft(2, '0');
  return '${date.year}-${two(date.month)}-${two(date.day)} ${two(date.hour)}:${two(date.minute)}:${two(date.second)}';
}
