import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { fmtRelative } from '../lib/format';
import {
  Bell, Check, MailPlus, Play, Plus, Send, Trash2, X,
} from 'lucide-react';

interface Channel {
  id: string; type: 'email' | 'telegram'; name: string; is_active: boolean;
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

const emptyChannelForm = { type: 'email' as 'email' | 'telegram', name: '', host: '', port: 465, secure: true, user: '', pass: '', from: '', to: '', botToken: '', chatId: '' };
const emptyRuleForm = { name: '', conditionType: 'keyword_match', keywords: '', minFollowers: 1000, programId: '', messageTemplate: '', channelIds: [] as string[] };

export default function Notifications() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'channels' | 'rules' | 'log'>('rules');
  const [addingChannel, setAddingChannel] = useState(false);
  const [channelForm, setChannelForm] = useState(emptyChannelForm);
  const [addingRule, setAddingRule] = useState(false);
  const [ruleForm, setRuleForm] = useState(emptyRuleForm);

  const { data: channels } = useQuery({ queryKey: ['notify-channels'], queryFn: () => api.get<{ items: Channel[] }>('/notify/channels') });
  const { data: rules } = useQuery({ queryKey: ['notify-rules'], queryFn: () => api.get<{ items: Rule[] }>('/notify/rules') });
  const { data: deliveries } = useQuery({
    queryKey: ['notify-deliveries'], queryFn: () => api.get<{ items: Delivery[] }>('/notify/deliveries?limit=100'), enabled: tab === 'log',
  });
  const { data: programs } = useQuery({ queryKey: ['programs'], queryFn: () => api.get<{ items: Program[] }>('/programs') });

  const createChannel = useMutation({
    mutationFn: () => {
      const config = channelForm.type === 'email'
        ? { host: channelForm.host, port: Number(channelForm.port), secure: channelForm.secure, user: channelForm.user, pass: channelForm.pass, from: channelForm.from, to: channelForm.to }
        : { botToken: channelForm.botToken, chatId: channelForm.chatId };
      return api.post('/notify/channels', { type: channelForm.type, name: channelForm.name, config });
    },
    onSuccess: () => { setAddingChannel(false); setChannelForm(emptyChannelForm); qc.invalidateQueries({ queryKey: ['notify-channels'] }); },
  });
  const testChannel = useMutation({ mutationFn: (id: string) => api.post(`/notify/channels/${id}/test`), onSuccess: () => qc.invalidateQueries({ queryKey: ['notify-channels'] }) });
  const toggleChannel = useMutation({
    mutationFn: (v: { id: string; isActive: boolean }) => api.patch(`/notify/channels/${v.id}`, { isActive: v.isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notify-channels'] }),
  });
  const deleteChannel = useMutation({ mutationFn: (id: string) => api.del(`/notify/channels/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['notify-channels'] }) });

  const createRule = useMutation({
    mutationFn: () => {
      const condition = ruleForm.conditionType === 'keyword_match'
        ? { keywords: ruleForm.keywords.split(',').map((k) => k.trim()).filter(Boolean) }
        : ruleForm.conditionType === 'follower_threshold'
          ? { minFollowers: Number(ruleForm.minFollowers) }
          : {};
      return api.post('/notify/rules', {
        name: ruleForm.name, conditionType: ruleForm.conditionType, condition,
        programId: ruleForm.programId || null, messageTemplate: ruleForm.messageTemplate, channelIds: ruleForm.channelIds,
      });
    },
    onSuccess: () => { setAddingRule(false); setRuleForm(emptyRuleForm); qc.invalidateQueries({ queryKey: ['notify-rules'] }); },
  });
  const toggleRule = useMutation({
    mutationFn: (v: { id: string; isActive: boolean }) => api.patch(`/notify/rules/${v.id}`, { isActive: v.isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notify-rules'] }),
  });
  const deleteRule = useMutation({ mutationFn: (id: string) => api.del(`/notify/rules/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['notify-rules'] }) });
  const runNow = useMutation({ mutationFn: () => api.post<{ evaluated: number; sent: number }>('/notify/rules/run-now'), onSuccess: () => qc.invalidateQueries({ queryKey: ['notify-deliveries'] }) });

  return (
    <div className="space-y-5">
      <div className="page-heading">
        <div>
          <h1 className="flex items-center gap-2.5"><Bell size={22} className="text-brand-500" /> الإشعارات والتنبيهات</h1>
          <p>راقب البريد أو تيليجرام تلقائياً عند نشاط عميل مؤثر، ارتفاع قصة، كلمات محدّدة، أو عدد متابعين معيّن.</p>
        </div>
        <button className="btn-ghost" disabled={runNow.isPending} onClick={() => runNow.mutate()}>
          <Play size={16} /> {runNow.isPending ? 'جارٍ الفحص…' : 'فحص الآن'}
        </button>
      </div>

      {runNow.data && (
        <div className="card p-3 text-sm bg-emerald-500/5">
          فُحصت <span className="num font-medium">{runNow.data.evaluated}</span> قاعدة نشطة، وأُرسل <span className="num font-medium text-emerald-600">{runNow.data.sent}</span> إشعار جديد.
        </div>
      )}

      <div className="classification-tabs" role="tablist">
        <button className={tab === 'rules' ? 'is-active' : ''} onClick={() => setTab('rules')}>قواعد التنبيه <span className="num">{rules?.items.length ?? 0}</span></button>
        <button className={tab === 'channels' ? 'is-active' : ''} onClick={() => setTab('channels')}>قنوات الإشعار <span className="num">{channels?.items.length ?? 0}</span></button>
        <button className={tab === 'log' ? 'is-active' : ''} onClick={() => setTab('log')}>سجل الإشعارات</button>
      </div>

      {tab === 'channels' && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <button className="btn-primary" onClick={() => setAddingChannel(true)}><Plus size={16} /> قناة جديدة</button>
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            {(channels?.items ?? []).map((c) => (
              <div key={c.id} className="card p-4">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2">
                    {c.type === 'email' ? <MailPlus size={17} className="text-brand-500" /> : <Send size={17} className="text-brand-500" />}
                    <span className="font-semibold">{c.name}</span>
                  </div>
                  <button
                    className={`badge ${c.is_active ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-slate-500/15 text-slate-500'}`}
                    onClick={() => toggleChannel.mutate({ id: c.id, isActive: !c.is_active })}
                  >{c.is_active ? 'مفعّلة' : 'معطّلة'}</button>
                </div>
                <div className="text-xs muted mb-3">
                  {c.last_test_at
                    ? <span className={c.last_test_ok ? 'text-emerald-600' : 'text-red-600'}>
                        {c.last_test_ok ? <Check size={12} className="inline" /> : <X size={12} className="inline" />} آخر اختبار {fmtRelative(c.last_test_at)}
                      </span>
                    : 'لم يُختبر بعد'}
                </div>
                <div className="flex gap-2">
                  <button className="btn-ghost !text-xs flex-1" disabled={testChannel.isPending} onClick={() => testChannel.mutate(c.id)}>اختبار الاتصال</button>
                  <button className="icon-button !w-9 !h-9 !text-red-600" title="حذف" onClick={() => deleteChannel.mutate(c.id)}><Trash2 size={14} /></button>
                </div>
                {testChannel.isError && testChannel.variables === c.id && (
                  <div className="text-xs text-red-600 mt-2">{(testChannel.error as ApiError).message}</div>
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
            <button className="btn-primary" onClick={() => setAddingRule(true)}><Plus size={16} /> قاعدة جديدة</button>
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
                    <button
                      className={`badge ${r.is_active ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-slate-500/15 text-slate-500'}`}
                      onClick={() => toggleRule.mutate({ id: r.id, isActive: !r.is_active })}
                    >{r.is_active ? 'نشطة' : 'موقوفة'}</button>
                    <button className="icon-button !w-8 !h-8 !text-red-600" title="حذف" onClick={() => deleteRule.mutate(r.id)}><Trash2 size={14} /></button>
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
                        <span key={i} className={`badge ${r.ok ? 'bg-emerald-500/15 text-emerald-600' : 'bg-red-500/15 text-red-600'}`} title={r.error}>
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

      {addingChannel && (
        <div className="fixed inset-0 bg-black/50 grid place-items-center z-50 p-4" onClick={() => setAddingChannel(false)}>
          <form className="card p-5 w-full max-w-sm max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); createChannel.mutate(); }}>
            <h3 className="font-bold mb-4">قناة إشعار جديدة</h3>
            <label className="block text-sm mb-1">النوع</label>
            <select className="input mb-3" value={channelForm.type} onChange={(e) => setChannelForm({ ...channelForm, type: e.target.value as 'email' | 'telegram' })}>
              <option value="email">بريد إلكتروني</option>
              <option value="telegram">بوت تيليجرام</option>
            </select>
            <label className="block text-sm mb-1">اسم القناة</label>
            <input className="input mb-3" value={channelForm.name} onChange={(e) => setChannelForm({ ...channelForm, name: e.target.value })} placeholder="مثال: بريد الفريق" required autoFocus />

            {channelForm.type === 'email' ? (
              <>
                <label className="block text-sm mb-1">SMTP Host</label>
                <input className="input mb-3" style={{ direction: 'ltr' }} value={channelForm.host} onChange={(e) => setChannelForm({ ...channelForm, host: e.target.value })} placeholder="smtp.gmail.com" required />
                <div className="grid grid-cols-2 gap-2 mb-3">
                  <div><label className="block text-sm mb-1">Port</label><input className="input num" type="number" value={channelForm.port} onChange={(e) => setChannelForm({ ...channelForm, port: Number(e.target.value) })} required /></div>
                  <label className="flex items-center gap-2 text-sm self-end pb-2.5"><input type="checkbox" checked={channelForm.secure} onChange={(e) => setChannelForm({ ...channelForm, secure: e.target.checked })} /> SSL/TLS</label>
                </div>
                <label className="block text-sm mb-1">البريد المرسِل</label>
                <input className="input mb-3" style={{ direction: 'ltr' }} type="email" value={channelForm.user} onChange={(e) => setChannelForm({ ...channelForm, user: e.target.value })} placeholder="alerts@example.com" required />
                <label className="block text-sm mb-1">كلمة مرور التطبيق (App Password)</label>
                <input className="input mb-3" type="password" value={channelForm.pass} onChange={(e) => setChannelForm({ ...channelForm, pass: e.target.value })} required />
                <label className="block text-sm mb-1">البريد المستقبِل</label>
                <input className="input mb-4" style={{ direction: 'ltr' }} type="email" value={channelForm.to} onChange={(e) => setChannelForm({ ...channelForm, to: e.target.value })} placeholder="team@example.com" required />
              </>
            ) : (
              <>
                <label className="block text-sm mb-1">Bot Token</label>
                <input className="input mb-3" style={{ direction: 'ltr' }} value={channelForm.botToken} onChange={(e) => setChannelForm({ ...channelForm, botToken: e.target.value })} placeholder="123456:ABC-DEF..." required />
                <label className="block text-sm mb-1">Chat ID</label>
                <input className="input mb-4" style={{ direction: 'ltr' }} value={channelForm.chatId} onChange={(e) => setChannelForm({ ...channelForm, chatId: e.target.value })} placeholder="-1001234567890" required />
                <p className="text-xs muted mb-4 leading-relaxed">أنشئ بوت عبر @BotFather على تيليجرام، وخذ الـ Chat ID من @userinfobot أو من رابط API الخاص بالبوت.</p>
              </>
            )}

            <div className="flex gap-2 justify-end">
              <button type="button" className="btn-ghost" onClick={() => setAddingChannel(false)}>إلغاء</button>
              <button className="btn-primary" disabled={createChannel.isPending}>{createChannel.isPending ? 'جارٍ الحفظ…' : 'حفظ'}</button>
            </div>
            {createChannel.error && <div className="text-xs text-red-600 mt-3">{(createChannel.error as ApiError).message}</div>}
          </form>
        </div>
      )}

      {addingRule && (
        <div className="fixed inset-0 bg-black/50 grid place-items-center z-50 p-4" onClick={() => setAddingRule(false)}>
          <form className="card p-5 w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); createRule.mutate(); }}>
            <h3 className="font-bold mb-4">قاعدة تنبيه جديدة</h3>
            <label className="block text-sm mb-1">اسم القاعدة</label>
            <input className="input mb-3" value={ruleForm.name} onChange={(e) => setRuleForm({ ...ruleForm, name: e.target.value })} placeholder="مثال: تنبيه شكاوى إيجار" required autoFocus />

            <label className="block text-sm mb-1">نوع الشرط</label>
            <select className="input mb-3" value={ruleForm.conditionType} onChange={(e) => setRuleForm({ ...ruleForm, conditionType: e.target.value })}>
              {Object.entries(CONDITION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>

            {ruleForm.conditionType === 'keyword_match' && (
              <>
                <label className="block text-sm mb-1">الكلمات (افصل بفاصلة)</label>
                <input className="input mb-3" value={ruleForm.keywords} onChange={(e) => setRuleForm({ ...ruleForm, keywords: e.target.value })} placeholder="شكوى, تأخير, مشكلة" required />
              </>
            )}
            {ruleForm.conditionType === 'follower_threshold' && (
              <>
                <label className="block text-sm mb-1">الحد الأدنى للمتابعين</label>
                <input className="input mb-3 num" type="number" min={1} value={ruleForm.minFollowers} onChange={(e) => setRuleForm({ ...ruleForm, minFollowers: Number(e.target.value) })} required />
              </>
            )}

            <label className="block text-sm mb-1">البرنامج (اختياري — كل البرامج إن لم يُحدَّد)</label>
            <select className="input mb-3" value={ruleForm.programId} onChange={(e) => setRuleForm({ ...ruleForm, programId: e.target.value })}>
              <option value="">كل البرامج</option>
              {(programs?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name_ar}</option>)}
            </select>

            <label className="block text-sm mb-1">نص التنبيه</label>
            <textarea className="input mb-1" rows={3} value={ruleForm.messageTemplate} onChange={(e) => setRuleForm({ ...ruleForm, messageTemplate: e.target.value })} placeholder="تنبيه: {{author}} نشر عن {{program}}: {{text}}" required />
            <p className="text-xs muted mb-3 leading-relaxed">{TEMPLATE_HINT}</p>

            <label className="block text-sm mb-1.5">القنوات</label>
            <div className="flex flex-wrap gap-2 mb-4">
              {(channels?.items ?? []).filter((c) => c.is_active).map((c) => (
                <label key={c.id} className={`badge cursor-pointer ${ruleForm.channelIds.includes(c.id) ? 'bg-brand-600 text-white' : 'bg-[var(--surface-3)]'}`}>
                  <input
                    type="checkbox" className="hidden"
                    checked={ruleForm.channelIds.includes(c.id)}
                    onChange={(e) => setRuleForm({ ...ruleForm, channelIds: e.target.checked ? [...ruleForm.channelIds, c.id] : ruleForm.channelIds.filter((id) => id !== c.id) })}
                  />
                  {c.name}
                </label>
              ))}
              {!channels?.items?.filter((c) => c.is_active).length && <span className="text-xs muted">أضف قناة مفعّلة أولاً من تبويب "قنوات الإشعار"</span>}
            </div>

            <div className="flex gap-2 justify-end">
              <button type="button" className="btn-ghost" onClick={() => setAddingRule(false)}>إلغاء</button>
              <button className="btn-primary" disabled={createRule.isPending || !ruleForm.channelIds.length}>{createRule.isPending ? 'جارٍ الحفظ…' : 'حفظ'}</button>
            </div>
            {createRule.error && <div className="text-xs text-red-600 mt-3">{(createRule.error as ApiError).message}</div>}
          </form>
        </div>
      )}
    </div>
  );
}
