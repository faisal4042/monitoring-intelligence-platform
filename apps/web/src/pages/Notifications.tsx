import { useConfirmAction } from '../components/ConfirmAction';
import { FormField, FieldInput, FieldSelect, FieldTextarea } from '../components/FormField';
import ModalSurface, { ModalCloseButton } from '../components/ModalSurface';
import AsyncState from '../components/AsyncState';
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PERMISSIONS } from '@mip/shared';
import { fmtRelative } from '../lib/format';
import {
  Bell, Check, Copy, ExternalLink, Link2, MailPlus, Pencil, Play, Plus, Send, Trash2, X,
} from 'lucide-react';

import { Button } from '../components/ui/Button';
interface Channel {
  id: string; type: 'email' | 'telegram'; name: string; is_active: boolean; is_linked: boolean; linked_count: number | null;
  last_test_at: string | null; last_test_ok: boolean | null; created_at: string;
}
interface Rule {
  id: string; name: string; condition_type: string; condition: Record<string, unknown>;
  program_id: string | null; program_name: string | null; message_template: string;
  channel_ids: string[]; channel_names: string[]; is_active: boolean; created_at: string;
}
interface Delivery {
  id: string; entity_type: string; entity_id: string; message: string;
  channel_results: Array<{ channelId: string; ok: boolean; error?: string }>;
  created_at: string; rule_name: string; condition_type: string;
}
interface Program { id: string; name_ar: string }

const CONDITION_LABELS: Record<string, string> = {
  keyword_match: 'كلمات محدّدة في النص',
  follower_threshold: 'عدد متابعين',
  influencer_activity: 'نشاط عميل مؤثر',
  topic_rising: 'ارتفاع موضوع/قصة',
};

const TEMPLATE_HINT = 'المتغيرات المتاحة: {{author}} {{username}} {{text}} {{followers}} {{url}} {{program}} {{topic}} {{rule}}';

interface MessageTemplate { id: string; label: string; conditionType: string; template: string }

const MESSAGE_TEMPLATES: MessageTemplate[] = [
  {
    id: 'keyword_pro', label: 'كلمات محدّدة — احترافي', conditionType: 'keyword_match',
    template: '🔔 {{rule}}\n\nتم رصد كلمة مطابقة في منشور جديد.\n\n👤 الحساب: {{author}} (@{{username}})\n📊 المتابعون: {{followers}}\n🏷️ البرنامج: {{program}}\n\n📝 النص:\n{{text}}\n\n🔗 {{url}}',
  },
  {
    id: 'keyword_brief', label: 'كلمات محدّدة — موجز', conditionType: 'keyword_match',
    template: '🔔 {{rule}}: {{author}} — {{text}}\n{{url}}',
  },
  {
    id: 'followers_pro', label: 'عدد متابعين — احترافي', conditionType: 'follower_threshold',
    template: '⭐ {{rule}}\n\nحساب بعدد متابعين كبير نشر عن أحد برامجنا.\n\n👤 الحساب: {{author}} (@{{username}})\n📊 المتابعون: {{followers}}\n🏷️ البرنامج: {{program}}\n\n📝 النص:\n{{text}}\n\n🔗 {{url}}',
  },
  {
    id: 'influencer_pro', label: 'نشاط عميل مؤثر — احترافي', conditionType: 'influencer_activity',
    template: '🌟 {{rule}}\n\nأحد العملاء المؤثرين المتابَعين نشر تغريدة جديدة.\n\n👤 الحساب: {{author}} (@{{username}})\n🏷️ البرنامج: {{program}}\n\n📝 النص:\n{{text}}\n\n🔗 {{url}}',
  },
  {
    id: 'topic_pro', label: 'ارتفاع موضوع/قصة — احترافي', conditionType: 'topic_rising',
    template: '📈 {{rule}}\n\nقصة بدأت ترتفع بشكل ملحوظ الآن.\n\n🏷️ البرنامج: {{program}}\n📌 الموضوع: {{topic}}\n\n📝 التفاصيل:\n{{text}}',
  },
  {
    id: 'topic_brief', label: 'ارتفاع موضوع/قصة — موجز', conditionType: 'topic_rising',
    template: '📈 {{rule}}: {{topic}} ({{program}}) — {{text}}',
  },
];

const emptyChannelForm = { type: 'email' as 'email' | 'telegram', name: '', host: '', port: 465, secure: true, user: '', pass: '', from: '', to: '', botToken: '' };
const emptyRuleForm = { name: '', conditionType: 'keyword_match', keywords: '', minFollowers: 1000, programId: '', messageTemplate: MESSAGE_TEMPLATES[0].template, channelIds: [] as string[] };

export default function Notifications() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const confirmation = useConfirmAction();
  const canWrite = can(PERMISSIONS.ALERTS_WRITE);
  const [tab, setTab] = useState<'channels' | 'rules' | 'log'>('rules');
  const [addingChannel, setAddingChannel] = useState(false);
  const [channelForm, setChannelForm] = useState(emptyChannelForm);
  const [addingRule, setAddingRule] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [ruleForm, setRuleForm] = useState(emptyRuleForm);
  const [linkCopied, setLinkCopied] = useState(false);

  const [linking, setLinking] = useState<{ channel: Channel; botUsername: string; deepLink: string; countBefore: number } | null>(null);
  const channelsRead = useQuery({
    queryKey: ['notify-channels'], queryFn: () => api.get<{ items: Channel[] }>('/notify/channels'),
    refetchInterval: linking ? 3000 : false,
  });
  const { data: channels } = channelsRead;
  const rulesRead = useQuery({ queryKey: ['notify-rules'], queryFn: () => api.get<{ items: Rule[] }>('/notify/rules') });
  const { data: rules } = rulesRead;
  const deliveriesRead = useQuery({
    queryKey: ['notify-deliveries'], queryFn: () => api.get<{ items: Delivery[] }>('/notify/deliveries?limit=100'), enabled: tab === 'log',
  });
  const { data: deliveries } = deliveriesRead;
  const { data: programs } = useQuery({ queryKey: ['programs'], queryFn: () => api.get<{ items: Program[] }>('/programs'), enabled: canWrite && can(PERMISSIONS.PROGRAMS_READ) });

  useEffect(() => {
    if (!linking) return;
    const current = channels?.items.find((c) => c.id === linking.channel.id)?.linked_count ?? 0;
    if (current > linking.countBefore) setLinking(null);
  }, [channels, linking]);

  const createChannel = useMutation({
    mutationFn: () => {
      const config = channelForm.type === 'email'
        ? { host: channelForm.host, port: Number(channelForm.port), secure: channelForm.secure, user: channelForm.user, pass: channelForm.pass, from: channelForm.from, to: channelForm.to }
        : { botToken: channelForm.botToken };
      return api.post<Channel>('/notify/channels', { type: channelForm.type, name: channelForm.name, config });
    },
    onSuccess: async (created) => {
      setAddingChannel(false); setChannelForm(emptyChannelForm);
      await qc.invalidateQueries({ queryKey: ['notify-channels'] });
      if (created.type === 'telegram') startLink.mutate(created);
    },
  });

  const startLink = useMutation({
    mutationFn: (channel: Channel) => api.post<{ botUsername: string; deepLink: string }>(`/notify/channels/${channel.id}/telegram-link`).then((r) => ({ channel, ...r, countBefore: channel.linked_count ?? 0 })),
    onSuccess: (r) => setLinking(r),
  });
  const testChannel = useMutation({ mutationFn: (id: string) => api.post(`/notify/channels/${id}/test`), onSuccess: () => qc.invalidateQueries({ queryKey: ['notify-channels'] }) });
  const toggleChannel = useMutation({
    mutationFn: (v: { id: string; isActive: boolean }) => api.patch(`/notify/channels/${v.id}`, { isActive: v.isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notify-channels'] }),
  });
  const deleteChannel = useMutation({ mutationFn: (id: string) => api.del(`/notify/channels/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['notify-channels'] }) });

  const closeRuleForm = () => { setAddingRule(false); setEditingRuleId(null); setRuleForm(emptyRuleForm); };

  const openEditRule = (r: Rule) => {
    setEditingRuleId(r.id);
    setRuleForm({
      name: r.name,
      conditionType: r.condition_type,
      keywords: Array.isArray(r.condition.keywords) ? (r.condition.keywords as string[]).join(', ') : '',
      minFollowers: typeof r.condition.minFollowers === 'number' ? r.condition.minFollowers : 1000,
      programId: r.program_id ?? '',
      messageTemplate: r.message_template,
      channelIds: r.channel_ids,
    });
    setAddingRule(true);
  };

  const saveRule = useMutation({
    mutationFn: () => {
      const condition = ruleForm.conditionType === 'keyword_match'
        ? { keywords: ruleForm.keywords.split(',').map((k) => k.trim()).filter(Boolean) }
        : ruleForm.conditionType === 'follower_threshold'
          ? { minFollowers: Number(ruleForm.minFollowers) }
          : {};
      const body = {
        name: ruleForm.name, conditionType: ruleForm.conditionType, condition,
        programId: ruleForm.programId || null, messageTemplate: ruleForm.messageTemplate, channelIds: ruleForm.channelIds,
      };
      return editingRuleId ? api.patch(`/notify/rules/${editingRuleId}`, body) : api.post('/notify/rules', body);
    },
    onSuccess: () => { closeRuleForm(); qc.invalidateQueries({ queryKey: ['notify-rules'] }); },
  });
  const toggleRule = useMutation({
    mutationFn: (v: { id: string; isActive: boolean }) => api.patch(`/notify/rules/${v.id}`, { isActive: v.isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notify-rules'] }),
  });
  const deleteRule = useMutation({ mutationFn: (id: string) => api.del(`/notify/rules/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['notify-rules'] }) });
  const runNow = useMutation({ mutationFn: () => api.post<{ evaluated: number; sent: number }>('/notify/rules/run-now'), onSuccess: () => qc.invalidateQueries({ queryKey: ['notify-deliveries'] }) });

  const pageReads = [...(tab === 'channels' ? [channelsRead] : tab === 'rules' ? [rulesRead] : [deliveriesRead])];
  const readError = pageReads.find(read => read.error)?.error;

  return (
    <div className="space-y-5">
      {confirmation.dialog}
      <div className="page-heading">
        <div>
          <h1 className="flex items-center gap-2.5"><Bell size={22} className="text-brand-600" /> الإشعارات والتنبيهات</h1>
          <p>راقب البريد أو تيليجرام تلقائياً عند نشاط عميل مؤثر، ارتفاع قصة، كلمات محدّدة، أو عدد متابعين معيّن.</p>
        </div>
        {canWrite && (<Button variant="ghost" type="submit" disabled={runNow.isPending} onClick={() => confirmation.request({ title: 'فحص قواعد التنبيه الآن', description: 'قد يرسل الفحص إشعارات فعلية عبر القنوات النشطة. لا يمكن سحب الرسائل بعد إرسالها.', confirmLabel: 'فحص وإرسال التنبيهات', allowed: can => can(PERMISSIONS.ALERTS_WRITE), execute: () => runNow.mutateAsync() })}>
          <Play size={16} /> {runNow.isPending ? 'جارٍ الفحص…' : 'فحص الآن'}
        </Button>)}
      </div>

      {runNow.data && (
        <div className="card p-3 text-sm bg-(--status-success)/5">
          فُحصت <span className="num font-medium">{runNow.data.evaluated}</span> قاعدة نشطة، وأُرسل <span className="num font-medium text-(--status-success)">{runNow.data.sent}</span> إشعار جديد.
        </div>
      )}

      <div className="classification-tabs" role="tablist">
        <button className={tab === 'rules' ? 'is-active' : ''} onClick={() => setTab('rules')}>قواعد التنبيه <span className="num">{rules?.items.length ?? 0}</span></button>
        <button className={tab === 'channels' ? 'is-active' : ''} onClick={() => setTab('channels')}>قنوات الإشعار <span className="num">{channels?.items.length ?? 0}</span></button>
        <button className={tab === 'log' ? 'is-active' : ''} onClick={() => setTab('log')}>سجل الإشعارات</button>
      </div>

      <AsyncState loading={pageReads.some(read => read.isLoading)} error={readError}
        onRetry={() => Promise.all(pageReads.map(read => read.refetch()))}>
      {tab === 'channels' && (
        <div className="space-y-3">
          <div className="flex justify-end">
            {canWrite && (<Button variant="primary" type="submit" onClick={() => setAddingChannel(true)}><Plus size={16} /> قناة جديدة</Button>)}
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            {(channels?.items ?? []).map((c) => (
              <div key={c.id} className="card p-4">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2">
                    {c.type === 'email' ? <MailPlus size={17} className="text-brand-600" /> : <Send size={17} className="text-brand-600" />}
                    <span className="font-semibold">{c.name}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {c.type === 'telegram' && (
                      <span className={`badge ${c.is_linked ? 'bg-(--status-success-soft) text-(--status-success)' : 'bg-(--status-warning-soft) text-(--status-warning)'}`}>
                        {c.is_linked ? `مربوط (${c.linked_count})` : 'غير مربوط'}
                      </span>
                    )}
                    {canWrite ? (<button
                      className={`badge ${c.is_active ? 'bg-(--status-success-soft) text-(--status-success)' : 'bg-slate-500/15 text-slate-500'}`}
                      onClick={() => confirmation.request({ title: c.is_active ? 'تعطيل قناة الإشعار' : 'تفعيل قناة الإشعار', description: `سيتم ${c.is_active ? 'إيقاف' : 'استئناف'} الإرسال عبر «${c.name}».`, confirmLabel: c.is_active ? 'تعطيل القناة' : 'تفعيل القناة', danger: c.is_active, allowed: can => can(PERMISSIONS.ALERTS_WRITE), execute: () => toggleChannel.mutateAsync({ id: c.id, isActive: !c.is_active }) })}
                    >{c.is_active ? 'مفعّلة' : 'معطّلة'}</button>) : <span className="badge">{c.is_active ? 'مفعّلة' : 'معطّلة'}</span>}
                  </div>
                </div>
                <div className="text-xs muted mb-3">
                  {c.last_test_at
                    ? <span className={c.last_test_ok ? 'text-(--status-success)' : 'text-(--status-danger)'}>
                        {c.last_test_ok ? <Check size={12} className="inline" /> : <X size={12} className="inline" />} آخر اختبار {fmtRelative(c.last_test_at)}
                      </span>
                    : 'لم يُختبر بعد'}
                </div>
                <div className="flex gap-2">
                  {canWrite && c.type === 'telegram' && (
                    <Button variant="ghost" type="submit" className="!text-xs flex-1" disabled={startLink.isPending} onClick={() => startLink.mutate(c)}>
                      <Link2 size={13} /> ربط شخص
                    </Button>
                  )}
                  {canWrite && (<Button variant="ghost" type="submit" className="!text-xs flex-1" disabled={testChannel.isPending} onClick={() => confirmation.request({title:'إرسال رسالة اختبار',description:`اختبار «${c.name}» يرسل رسالة فعلية عبر القناة. لا يمكن سحب الرسالة بعد إرسالها.`,confirmLabel:'إرسال الاختبار',allowed:can=>can(PERMISSIONS.ALERTS_WRITE),execute:()=>testChannel.mutateAsync(c.id)})}>اختبار الاتصال</Button>)}
                  {canWrite && (<button className="icon-button !w-9 !h-9 !text-(--status-danger)" title="حذف" onClick={() => confirmation.request({ title: 'حذف قناة الإشعار', description: `سيتم حذف «${c.name}» وربطها بقواعد التنبيه. لا يتوفر تراجع من هذه الشاشة.`, confirmLabel: 'حذف القناة', danger: true, allowed: can => can(PERMISSIONS.ALERTS_WRITE), execute: () => deleteChannel.mutateAsync(c.id) })}><Trash2 size={14} /></button>)}
                </div>
                {testChannel.isError && testChannel.variables === c.id && (
                  <div className="text-xs text-(--status-danger) mt-2">{(testChannel.error as ApiError).message}</div>
                )}
                {startLink.isError && startLink.variables?.id === c.id && (
                  <div className="text-xs text-(--status-danger) mt-2">{(startLink.error as ApiError).message}</div>
                )}
              </div>
            ))}
            {!channels?.items?.length && <div className="card p-10 text-center muted col-span-2">لا توجد قنوات بعد — أضف بريداً أو بوت تيليجرام.</div>}
          </div>
        </div>
      )}

      {tab === 'rules' && (
        <div className="space-y-3">
          <div className="flex justify-end">
            {canWrite && (<Button variant="primary" type="submit" onClick={() => { setRuleForm(emptyRuleForm); setEditingRuleId(null); setAddingRule(true); }}><Plus size={16} /> قاعدة جديدة</Button>)}
          </div>
          <div className="space-y-2">
            {(rules?.items ?? []).map((r) => (
              <div key={r.id} className="card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold">{r.name}</span>
                      <span className="badge bg-brand-500/15 text-brand-600 dark:text-brand-400">{CONDITION_LABELS[r.condition_type] ?? r.condition_type}</span>
                      {r.program_name && <span className="text-xs muted">{r.program_name}</span>}
                    </div>
                    <p className="text-xs muted mt-1">{r.message_template}</p>
                    <div className="text-xs muted mt-1.5">القنوات: {r.channel_names.join('، ') || '—'}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {canWrite ? (<button
                      className={`badge ${r.is_active ? 'bg-(--status-success-soft) text-(--status-success)' : 'bg-slate-500/15 text-slate-500'}`}
                      onClick={() => confirmation.request({ title: r.is_active ? 'تعطيل قاعدة التنبيه' : 'تفعيل قاعدة التنبيه', description: `سيتم ${r.is_active ? 'إيقاف' : 'استئناف'} التنبيهات الخاصة بـ«${r.name}».`, confirmLabel: r.is_active ? 'تعطيل القاعدة' : 'تفعيل القاعدة', danger: r.is_active, allowed: can => can(PERMISSIONS.ALERTS_WRITE), execute: () => toggleRule.mutateAsync({ id: r.id, isActive: !r.is_active }) })}
                    >{r.is_active ? 'نشطة' : 'موقوفة'}</button>) : <span className="badge">{r.is_active ? 'نشطة' : 'موقوفة'}</span>}
                    {canWrite && (<button className="icon-button !w-8 !h-8" title="تعديل" onClick={() => openEditRule(r)}><Pencil size={14} /></button>)}
                    {canWrite && (<button className="icon-button !w-8 !h-8 !text-(--status-danger)" title="حذف" onClick={() => confirmation.request({ title: 'حذف قاعدة التنبيه', description: `سيتم حذف «${r.name}» وإيقاف تنبيهاتها. لا يتوفر تراجع من هذه الشاشة.`, confirmLabel: 'حذف القاعدة', danger: true, allowed: can => can(PERMISSIONS.ALERTS_WRITE), execute: () => deleteRule.mutateAsync(r.id) })}><Trash2 size={14} /></button>)}
                  </div>
                </div>
              </div>
            ))}
            {!rules?.items?.length && <div className="card p-10 text-center muted">لا توجد قواعد بعد.</div>}
          </div>
        </div>
      )}

      {tab === 'log' && (
        <div className="card overflow-hidden">
          <table className="w-full">
            <thead style={{ background: 'var(--surface-2)' }}>
              <tr>
                <th className="th">الوقت</th><th className="th">القاعدة</th><th className="th">الرسالة</th><th className="th">النتيجة</th>
              </tr>
            </thead>
            <tbody>
              {(deliveries?.items ?? []).map((d) => (
                <tr key={d.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="td text-xs muted">{fmtRelative(d.created_at)}</td>
                  <td className="td text-xs font-medium">{d.rule_name}</td>
                  <td className="td text-xs max-w-md truncate">{d.message}</td>
                  <td className="td">
                    <div className="flex gap-1">
                      {d.channel_results.map((r, i) => (
                        <span key={i} className={`badge ${r.ok ? 'bg-(--status-success-soft) text-(--status-success)' : 'bg-(--status-danger-soft) text-(--status-danger)'}`} title={r.error}>
                          {r.ok ? <Check size={11} /> : <X size={11} />}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
              {!deliveries?.items?.length && <tr><td colSpan={4} className="td text-center muted py-8">لا توجد إشعارات مرسلة بعد</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      </AsyncState>

      {canWrite && addingChannel && (
        <ModalSurface label={'قناة إشعار جديدة'} onClose={() => setAddingChannel(false)} busy={createChannel.isPending} overlayClassName="fixed inset-0 bg-black/50 grid place-items-center z-50 p-4" panelClassName="card p-5 w-full max-w-sm max-h-[90vh] overflow-y-auto" as="form" onSubmit={(e) => { e.preventDefault(); createChannel.mutate(); }}>
            <h3 className="font-bold mb-4">قناة إشعار جديدة</h3>
            <FormField label={<>النوع</>} labelClassName="block text-sm mb-1">
              <FieldSelect className="input mb-3" value={channelForm.type} onChange={(e) => setChannelForm({ ...channelForm, type: e.target.value as 'email' | 'telegram' })}>
              <option value="email">بريد إلكتروني</option>
              <option value="telegram">بوت تيليجرام</option>
            </FieldSelect>
            </FormField>
            <FormField label={<>اسم القناة</>} labelClassName="block text-sm mb-1">
              <FieldInput className="input mb-3" value={channelForm.name} onChange={(e) => setChannelForm({ ...channelForm, name: e.target.value })} placeholder="مثال: بريد الفريق" required autoFocus data-dialog-initial-focus />
            </FormField>

            {channelForm.type === 'email' ? (
              <>
                <FormField label={<>SMTP Host</>} labelClassName="block text-sm mb-1" required>
                  <FieldInput className="input mb-3" style={{ direction: 'ltr' }} value={channelForm.host} onChange={(e) => setChannelForm({ ...channelForm, host: e.target.value })} placeholder="smtp.gmail.com" required />
                </FormField>
                <div className="grid grid-cols-2 gap-2 mb-3">
                  <div><FormField label={<>Port</>} labelClassName="block text-sm mb-1">
                    <FieldInput className="input num" type="number" value={channelForm.port} onChange={(e) => setChannelForm({ ...channelForm, port: Number(e.target.value) })} required />
                  </FormField></div>
                  <label className="flex items-center gap-2 text-sm self-end pb-2.5"><input type="checkbox" checked={channelForm.secure} onChange={(e) => setChannelForm({ ...channelForm, secure: e.target.checked })} /> SSL/TLS</label>
                </div>
                <FormField label={<>البريد المرسِل</>} labelClassName="block text-sm mb-1" required>
                  <FieldInput className="input mb-3" style={{ direction: 'ltr' }} type="email" value={channelForm.user} onChange={(e) => setChannelForm({ ...channelForm, user: e.target.value })} placeholder="alerts@example.com" required />
                </FormField>
                <FormField label={<>كلمة مرور التطبيق (App Password)</>} labelClassName="block text-sm mb-1" required>
                  <FieldInput className="input mb-3" type="password" value={channelForm.pass} onChange={(e) => setChannelForm({ ...channelForm, pass: e.target.value })} required />
                </FormField>
                <FormField label={<>البريد المستقبِل</>} labelClassName="block text-sm mb-1" required>
                  <FieldInput className="input mb-4" style={{ direction: 'ltr' }} type="email" value={channelForm.to} onChange={(e) => setChannelForm({ ...channelForm, to: e.target.value })} placeholder="team@example.com" required />
                </FormField>
              </>
            ) : (
              <>
                <FormField label={<>Bot Token</>} labelClassName="block text-sm mb-1" required description={<>
                  أنشئ البوت عبر @BotFather أولاً وخذ الـ Token من هناك. بعد الحفظ راح تلقى رابط "ربط الحساب" — تضغطه، يفتح تيليجرام، تضغط زر Start، وخلاص. ما تحتاج تدخل أي Chat ID يدوياً.
                </>} descriptionClassName="text-xs muted mb-4 leading-relaxed">
                  <FieldInput className="input mb-2" style={{ direction: 'ltr' }} value={channelForm.botToken} onChange={(e) => setChannelForm({ ...channelForm, botToken: e.target.value })} placeholder="123456:ABC-DEF..." required />
                </FormField>
              </>
            )}

            <div className="flex gap-2 justify-end">
              <ModalCloseButton type="button" className="btn-ghost" onClick={() => setAddingChannel(false)}>إلغاء</ModalCloseButton>
              <Button variant="primary" type="submit" disabled={createChannel.isPending}>{createChannel.isPending ? 'جارٍ الحفظ…' : 'حفظ'}</Button>
            </div>
            {createChannel.error && <div className="text-xs text-(--status-danger) mt-3">{(createChannel.error as ApiError).message}</div>}
          </ModalSurface>
      )}

      {canWrite && addingRule && (
        <ModalSurface label={editingRuleId ? 'تعديل القاعدة' : 'قاعدة تنبيه جديدة'} onClose={closeRuleForm} busy={saveRule.isPending} overlayClassName="fixed inset-0 bg-black/50 grid place-items-center z-50 p-4" panelClassName="card p-5 w-full max-w-md max-h-[90vh] overflow-y-auto" as="form" onSubmit={(e) => { e.preventDefault(); saveRule.mutate(); }}>
            <h3 className="font-bold mb-4">{editingRuleId ? 'تعديل القاعدة' : 'قاعدة تنبيه جديدة'}</h3>
            <FormField label={<>اسم القاعدة</>} labelClassName="block text-sm mb-1">
              <FieldInput className="input mb-3" value={ruleForm.name} onChange={(e) => setRuleForm({ ...ruleForm, name: e.target.value })} placeholder="مثال: تنبيه شكاوى إيجار" required autoFocus data-dialog-initial-focus />
            </FormField>

            <FormField label={<>نوع الشرط</>} labelClassName="block text-sm mb-1">
              <FieldSelect
              className="input mb-3"
              value={ruleForm.conditionType}
              onChange={(e) => {
                const conditionType = e.target.value;
                const firstTemplate = MESSAGE_TEMPLATES.find((t) => t.conditionType === conditionType)?.template ?? '';
                setRuleForm({ ...ruleForm, conditionType, messageTemplate: firstTemplate });
              }}
            >
              {Object.entries(CONDITION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </FieldSelect>
            </FormField>

            {ruleForm.conditionType === 'keyword_match' && (
              <>
                <FormField label={<>الكلمات (افصل بفاصلة)</>} labelClassName="block text-sm mb-1" required>
                  <FieldInput className="input mb-3" value={ruleForm.keywords} onChange={(e) => setRuleForm({ ...ruleForm, keywords: e.target.value })} placeholder="شكوى, تأخير, مشكلة" required />
                </FormField>
              </>
            )}
            {ruleForm.conditionType === 'follower_threshold' && (
              <>
                <FormField label={<>الحد الأدنى للمتابعين</>} labelClassName="block text-sm mb-1" required>
                  <FieldInput className="input mb-3 num" type="number" min={1} value={ruleForm.minFollowers} onChange={(e) => setRuleForm({ ...ruleForm, minFollowers: Number(e.target.value) })} required />
                </FormField>
              </>
            )}

            <FormField label={<>البرنامج (اختياري — كل البرامج إن لم يُحدَّد)</>} labelClassName="block text-sm mb-1">
              <FieldSelect className="input mb-3" value={ruleForm.programId} onChange={(e) => setRuleForm({ ...ruleForm, programId: e.target.value })}>
              <option value="">كل البرامج</option>
              {(programs?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name_ar}</option>)}
            </FieldSelect>
            </FormField>

            <div className="flex items-center justify-between mb-1">
              <FormField label="قالب جاهز" className="flex items-center justify-between w-full gap-2" labelClassName="block text-sm">
                <FieldSelect
                className="input !w-auto !min-h-0 !py-1 !text-xs"
                value=""
                onChange={(e) => {
                  const tpl = MESSAGE_TEMPLATES.find((t) => t.id === e.target.value);
                  if (tpl) setRuleForm({ ...ruleForm, messageTemplate: tpl.template });
                }}
              >
                <option value="" disabled>📋 اختر قالباً جاهزاً…</option>
                {Object.entries(CONDITION_LABELS).map(([conditionType, label]) => (
                  <optgroup key={conditionType} label={label}>
                    {MESSAGE_TEMPLATES.filter((t) => t.conditionType === conditionType).map((t) => (
                      <option key={t.id} value={t.id}>{t.label}</option>
                    ))}
                  </optgroup>
                ))}
              </FieldSelect>
              </FormField>
            </div>
            <FormField label="نص التنبيه" required description={TEMPLATE_HINT} descriptionClassName="text-xs muted mb-3 leading-relaxed">
            <FieldTextarea className="input mb-1 font-mono text-xs" style={{ direction: 'rtl' }} rows={6} value={ruleForm.messageTemplate} onChange={(e) => setRuleForm({ ...ruleForm, messageTemplate: e.target.value })} placeholder="تنبيه: {{author}} نشر عن {{program}}: {{text}}" required />
            </FormField>

            <fieldset><legend className="block text-sm mb-1.5">القنوات</legend>
            <div className="flex flex-wrap gap-2 mb-4">
              {(channels?.items ?? []).filter((c) => c.is_active).map((c) => (
                <label key={c.id} className={`badge cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand-600 ${ruleForm.channelIds.includes(c.id) ? 'bg-(--selected-bg) text-(--selected-fg)' : 'bg-[var(--surface-3)]'}`}>
                  <input
                    type="checkbox" className="sr-only"
                    checked={ruleForm.channelIds.includes(c.id)}
                    onChange={(e) => setRuleForm({ ...ruleForm, channelIds: e.target.checked ? [...ruleForm.channelIds, c.id] : ruleForm.channelIds.filter((id) => id !== c.id) })}
                  />
                  {c.name}
                </label>
              ))}
              {!channels?.items?.filter((c) => c.is_active).length && <span className="text-xs muted">أضف قناة مفعّلة أولاً من تبويب "قنوات الإشعار"</span>}
            </div></fieldset>

            <div className="flex gap-2 justify-end">
              <ModalCloseButton type="button" className="btn-ghost" onClick={closeRuleForm}>إلغاء</ModalCloseButton>
              <Button variant="primary" type="submit" disabled={saveRule.isPending || !ruleForm.channelIds.length}>{saveRule.isPending ? 'جارٍ الحفظ…' : editingRuleId ? 'حفظ التعديلات' : 'حفظ'}</Button>
            </div>
            {saveRule.error && <div className="text-xs text-(--status-danger) mt-3">{(saveRule.error as ApiError).message}</div>}
          </ModalSurface>
      )}

      {canWrite && linking && (
        <ModalSurface label={'ربط قناة تيليجرام'} onClose={() => setLinking(null)} overlayClassName="fixed inset-0 bg-black/50 grid place-items-center z-50 p-4" panelClassName="card p-5 w-full max-w-sm text-center" as="div">
            <Link2 size={28} className="text-brand-600 mx-auto mb-3" />
            <h3 className="font-bold mb-1">رابط ربط "{linking.channel.name}"</h3>
            <p className="text-xs muted mb-5 leading-relaxed">
              افتح الرابط بنفسك لتربط حسابك، أو انسخه وأرسله لأي شخص (واتساب مثلاً) ليربط حسابه هو بنفسه — كل واحد يضغط <span className="num">Start</span> بمحادثة البوت <span className="num">@{linking.botUsername}</span> على جواله. الرابط صالح 15 دقيقة ولمرة واحدة فقط.
            </p>
            <a href={linking.deepLink} target="_blank" rel="noreferrer" className="btn-primary w-full mb-2">
              <ExternalLink size={16} /> افتح تيليجرام واضغط Start
            </a>
            <Button variant="ghost"
              type="button"
              className="w-full mb-3"
              onClick={() => { navigator.clipboard?.writeText(linking!.deepLink).then(() => { setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2000); }).catch(() => { /* clipboard blocked: the link above stays openable */ }); }}>
              {linkCopied ? <><Check size={16} /> تم النسخ</> : <><Copy size={16} /> نسخ الرابط لإرساله لشخص آخر</>}
            </Button>
            <Button variant="ghost" type="submit" className="w-full" onClick={() => { setLinking(null); qc.invalidateQueries({ queryKey: ['notify-channels'] }); }}>تم — أغلق</Button>
          </ModalSurface>
      )}
    </div>
  );
}
