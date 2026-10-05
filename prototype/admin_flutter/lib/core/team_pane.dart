import 'package:flutter/material.dart';
import 'controller.dart';
import 'team_models.dart';

class TeamPane extends StatefulWidget {
  const TeamPane({super.key, required this.controller});
  final CoreController controller;
  @override
  State<TeamPane> createState() => _TeamPaneState();
}

class _TeamPaneState extends State<TeamPane> {
  String filter = '';
  int page = 0;
  Future<void> edit([CoreTeamMember? member]) async {
    final c = widget.controller, tenant = widget.controller.selectedTenant!;
    final change = await showDialog<TeamChange>(
        context: context,
        builder: (_) =>
            TeamEditor(controller: c, tenant: tenant, member: member));
    if (!mounted || change == null || c.selectedTenant != tenant) return;
    await c.setMember(tenant, change);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    final list = c.team
        .where((v) =>
            filter.isEmpty ||
            v.displayName.toLowerCase().contains(filter) ||
            v.principalId.contains(filter))
        .toList();
    final pages = (list.length / 50).ceil(),
        current = pages == 0 ? 0 : page.clamp(0, pages - 1);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const Text('الفريق والصلاحيات', style: TextStyle(fontSize: 22)),
      const Text(
          'يجب أن يسجل الموظف الدخول بحساب موثّق أولًا، ثم يشارك معرّف حسابه. لا تُنشأ حسابات أو دعوات بريدية من هذه الشاشة.'),
      const Text('معرّف حسابك:'),
      SelectableText(c.profile?.id ?? '', textDirection: TextDirection.ltr),
      FilledButton.icon(
          onPressed: c.writable ? () => edit() : null,
          icon: const Icon(Icons.person_add_outlined),
          label: const Text('إضافة موظف موجود')),
      TextField(
          decoration:
              const InputDecoration(labelText: 'بحث باسم الموظف أو معرّفه'),
          onChanged: (v) => setState(() {
                filter = v.trim().toLowerCase();
                page = 0;
              })),
      for (final member in list.skip(current * 50).take(50))
        Card(
            child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(member.displayName.isEmpty
                          ? 'موظف دون اسم عرض'
                          : member.displayName),
                      SelectableText(member.principalId,
                          textDirection: TextDirection.ltr),
                      Text(
                          '${roleLabels[member.role]} • ${member.enabled ? 'مفعّل' : 'معطّل'} • ${member.permissions.length} صلاحية'),
                      if (member.principalId == c.profile?.id)
                        const Text('هذا حسابك'),
                      OutlinedButton(
                          onPressed: c.writable &&
                                  (c.membership?.role == 'owner' ||
                                      member.role != 'owner')
                              ? () => edit(member)
                              : null,
                          child: const Text('تعديل العضوية')),
                    ]))),
      if (list.isEmpty) const Text('لا توجد عضويات مطابقة.'),
      if (pages > 1)
        Row(children: [
          TextButton(
              onPressed:
                  current > 0 ? () => setState(() => page = current - 1) : null,
              child: const Text('السابق')),
          Text('${current + 1} / $pages'),
          TextButton(
              onPressed: current + 1 < pages
                  ? () => setState(() => page = current + 1)
                  : null,
              child: const Text('التالي'))
        ]),
    ]);
  }
}

class TeamEditor extends StatefulWidget {
  const TeamEditor(
      {super.key, required this.controller, required this.tenant, this.member});
  final CoreController controller;
  final String tenant;
  final CoreTeamMember? member;
  @override
  State<TeamEditor> createState() => _TeamEditorState();
}

class _TeamEditorState extends State<TeamEditor> {
  late final TextEditingController id, name;
  late String role;
  late Set<String> permissions;
  late bool enabled;
  bool review = false;
  String? error;
  @override
  void initState() {
    super.initState();
    final m = widget.member;
    id = TextEditingController(text: m?.principalId ?? '');
    name = TextEditingController(text: m?.displayName ?? '');
    role = m?.role ?? 'kitchen';
    permissions = m?.permissions.toSet() ??
        rolePermissions(role)
            .intersection(widget.controller.membership!.permissions);
    enabled = m?.enabled ?? true;
  }

  @override
  void dispose() {
    id.dispose();
    name.dispose();
    super.dispose();
  }

  TeamChange change() => TeamChange(
      principalId: id.text.trim(),
      role: role,
      permissions: Set.of(permissions),
      enabled: enabled,
      displayName: name.text.trim(),
      expectedVersion: widget.member?.version);
  void next() {
    try {
      change().toJson();
      setState(() {
        review = true;
        error = null;
      });
    } catch (_) {
      setState(() => error = 'تحقق من معرّف الحساب والاسم والصلاحيات.');
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
      listenable: widget.controller,
      builder: (context, _) {
        final c = widget.controller,
            m = widget.member,
            authority = c.membership;
        final allowed = c.signedIn &&
            c.selectedTenant == widget.tenant &&
            authority?.can('members:manage') == true;
        final owner = authority?.role == 'owner';
        final editable = allowed && c.writable && (owner || m?.role != 'owner');
        final added = permissions.difference(m?.permissions ?? {}),
            removed = (m?.permissions ?? <String>{}).difference(permissions);
        return AlertDialog(
            title: Text(review
                ? 'تأكيد تغيير العضوية'
                : m == null
                    ? 'إضافة موظف موجود'
                    : 'تعديل العضوية'),
            content: SizedBox(
                width: 620,
                child: SingleChildScrollView(
                    child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                      if (!allowed)
                        const Text(
                            'تغيرت الجلسة أو الصلاحيات. أغلق هذه النافذة.'),
                      if (allowed && review) ...[
                        Text(
                            'المطعم: ${authority!.tenantName} (${widget.tenant})'),
                        SelectableText(id.text.trim(),
                            textDirection: TextDirection.ltr),
                        Text('الاسم: ${name.text.trim()}'),
                        Text(
                            'الدور: ${roleLabels[role]} • ${enabled ? 'مفعّل' : 'معطّل'}'),
                        Text(
                            'منح: ${added.isEmpty ? 'لا شيء' : added.map((v) => permissionLabels[v]).join('، ')}'),
                        Text(
                            'سحب: ${removed.isEmpty ? 'لا شيء' : removed.map((v) => permissionLabels[v]).join('، ')}'),
                        const Text(
                            'تسري الصلاحيات الجديدة على طلبات الحساب التالية. لا يمكن تعطيل آخر مالك مفعّل.'),
                        if (id.text.trim() == c.profile?.id)
                          const Text(
                              'أنت تعدّل حسابك. قد تفقد الوصول إلى هذا المطعم أو إدارة الفريق.'),
                      ],
                      if (allowed && !review) ...[
                        TextField(
                            controller: id,
                            readOnly: m != null,
                            decoration: const InputDecoration(
                                labelText: 'معرّف الحساب الموثّق (UUID)'),
                            textDirection: TextDirection.ltr),
                        TextField(
                            controller: name,
                            maxLength: 100,
                            decoration: const InputDecoration(
                                labelText: 'اسم العرض داخل المطعم')),
                        DropdownButtonFormField<String>(
                            initialValue: role,
                            decoration:
                                const InputDecoration(labelText: 'الدور'),
                            items: roleLabels.entries
                                .where((v) =>
                                    owner || v.key != 'owner' || v.key == role)
                                .map((v) => DropdownMenuItem(
                                    value: v.key, child: Text(v.value)))
                                .toList(),
                            onChanged: editable
                                ? (v) => setState(() {
                                      role = v!;
                                      permissions = rolePermissions(role);
                                      if (!owner)
                                        permissions = permissions.intersection(
                                            authority!.permissions);
                                    })
                                : null),
                        SwitchListTile(
                            title: const Text('العضوية مفعّلة'),
                            value: enabled,
                            onChanged: editable
                                ? (v) => setState(() => enabled = v)
                                : null),
                        const Text('الصلاحيات التفصيلية'),
                        for (final entry in permissionLabels.entries)
                          CheckboxListTile(
                              title: Text(entry.value),
                              subtitle: Text(entry.key),
                              value: permissions.contains(entry.key),
                              onChanged: editable &&
                                      role != 'owner' &&
                                      (owner ||
                                          authority!.permissions
                                              .contains(entry.key))
                                  ? (v) => setState(() {
                                        if (v == true) {
                                          permissions.add(entry.key);
                                        } else {
                                          permissions.remove(entry.key);
                                        }
                                      })
                                  : null),
                        if (error != null) Text(error!),
                      ],
                    ]))),
            actions: [
              TextButton(
                  onPressed: () => Navigator.pop(context),
                  child: const Text('إلغاء')),
              if (review)
                TextButton(
                    onPressed:
                        allowed ? () => setState(() => review = false) : null,
                    child: const Text('رجوع للمراجعة')),
              FilledButton(
                  onPressed: editable
                      ? review
                          ? () => Navigator.pop(context, change())
                          : next
                      : null,
                  child: Text(review ? 'تأكيد حفظ العضوية' : 'مراجعة التغيير')),
            ]);
      });
}
