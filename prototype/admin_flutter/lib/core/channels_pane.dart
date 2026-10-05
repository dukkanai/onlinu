import 'dart:async';
import 'package:flutter/material.dart';
import 'controller.dart';
import 'models.dart';

class ChannelsPane extends StatelessWidget {
  const ChannelsPane({super.key, required this.controller});
  final CoreController controller;
  Future<void> _change(BuildContext context, CoreChannel channel) async {
    final enabled = !channel.newOrdersEnabled,
        tenant = controller.selectedTenant;
    final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
              title: Text(
                  '${enabled ? 'تفعيل' : 'إيقاف'} الطلبات الجديدة من ${channelLabels[channel.channel]}'),
              content: Text(
                  'المطعم: $tenant\nهذا الإعداد يخص استقبال طلبات جديدة فقط. لا يلغي الطلبات المقبولة، ولا يوقف التسوية، ولا يسجل الخروج من حساب واتساب.'),
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
        confirmed != true ||
        controller.selectedTenant != tenant) return;
    await controller.changeChannel(channel, enabled);
  }

  @override
  Widget build(BuildContext context) =>
      Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        const SizedBox(height: 20),
        const Text('قنوات الطلب',
            style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
        const Text(
            'تفعيل استقبال الطلبات ليس إثباتًا لربط الحساب أو جاهزية الاشتراك. تظل حالة المطعم وإعداداته وصلاحياته مطلوبة.'),
        for (final channel in controller.channels)
          Card(
              child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(channelLabels[channel.channel]!,
                            style: Theme.of(context).textTheme.titleMedium),
                        const SizedBox(height: 8),
                        Text(!channel.adapterImplemented
                            ? 'مسار استقبال الطلبات لهذه القناة لم يكتمل بعد.'
                            : channel.newOrdersEnabled
                                ? 'استقبال الطلبات الجديدة مفعّل'
                                : 'استقبال الطلبات الجديدة متوقف'),
                        if (channel.adapterImplemented)
                          OutlinedButton(
                              onPressed: controller.writable
                                  ? () {
                                      unawaited(_change(context, channel));
                                    }
                                  : null,
                              child: Text(channel.newOrdersEnabled
                                  ? 'إيقاف الطلبات الجديدة'
                                  : 'تفعيل الطلبات الجديدة')),
                      ]))),
      ]);
}
