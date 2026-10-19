import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Pencil, Plus, RefreshCw, Trash2, X as Close } from 'lucide-react';
import { TEMPLATE_STATUS_LABELS, WHATSAPP_EVENTS, WHATSAPP_PERMISSIONS as W, WHATSAPP_TEMPLATE_VARIABLES, type WhatsAppTemplateVariable } from '@mip/shared';
import { api, type ApiError } from '../../lib/api';
import { fmtRelative } from '../../lib/format';
import AsyncState from '../AsyncState';
import ModalSurface, { ModalCloseButton } from '../ModalSurface';
import { useConfirmAction } from '../ConfirmAction';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { OverflowMenu } from '../ui/OverflowMenu';
import { TEMPLATE_TONE, type WaAccess, type WaTemplate } from './types';

const SAMPLE: Record<string, string> = {
  program: 'إيجار', alert_type: 'شكوى عالية الأولوية', priority: 'مرتفعة', detected_at: '2026-10-19 14:05',
  summary: 'تفاعل مُسند بانتظار المعالجة', ticket_number: 'MIP-2026-000123', details_url: 'https://radar.example/queue', count: '3',
};
const EXAMPLE_BODY = 'رادار 360 | تنبيه رصد\nالبرنامج: {{1}}\nنوع التنبيه: {{2}}\nالأولوية: {{3}}\nتاريخ الرصد: {{4}}\nملخص: {{5}}\nرقم التذكرة: {{6}}\nرابط التفاصيل: {{7}}';
const EXAMPLE_VARS: WhatsAppTemplateVariable[] = ['program', 'alert_type', 'priority', 'detected_at', 'summary', 'ticket_number', 'details_url'];
const preview = (body: string, vars: string[]) => body.replace(/\{\{(\d{1,2})\}\}/g, (m, n) => SAMPLE[vars[Number(n) - 1]] ?? m);
const placeholders = (body: string) => Math.max(0, ...[...body.matchAll(/\{\{(\d{1,2})\}\}/g)].map((m) => Number(m[1])));

interface SyncResult { updated: number; missingAtMeta: number; unregistered: Array<{ name: string; language: string; status: string; body: string | null }> }

/** Local record of templates registered with Meta. Status comes only from Meta (sync), never set by hand. */
export default function TemplatesSection({ access }: { access: WaAccess }) {
  const qc = useQueryClient();
  const confirmation = useConfirmAction();
  const refresh = () => { qc.invalidateQueries({ queryKey: ['wa-templates'] }); qc.invalidateQueries({ queryKey: ['wa-events'] }); };
  const list = useQuery({ queryKey: ['wa-templates'], queryFn: () => api.get<{ items: WaTemplate[] }>('/whatsapp/templates') });
  const sync = useMutation({ mutationFn: () => api.post<SyncResult>('/whatsapp/templates/sync'), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/whatsapp/templates/${id}`), onSuccess: refresh });
  const [editing, setEditing] = useState<Partial<WaTemplate> | null>(null);
  const [viewing, setViewing] = useState<WaTemplate | null>(null);

  return (
    <section className="card wa-section" aria-labelledby="wa-tpl-h">
      {confirmation.dialog}
      <div className="wa-section-head">
        <div><h2 id="wa-tpl-h">قوالب الرسائل</h2>
          <p>تُنشأ القوالب وتُعتمد في مدير واتساب للأعمال لدى Meta، ثم تُسجَّل هنا بالاسم واللغة نفسيهما. الحالة تأتي من Meta بالمزامنة فقط.</p></div>
        {access.templates && <div className="flex gap-2 flex-wrap">
          <Button variant="ghost" icon={<RefreshCw size={16} aria-hidden="true" />} loading={sync.isPending} onClick={() => sync.mutate()}>مزامنة الحالة من Meta</Button>
          <Button variant="primary" icon={<Plus size={16} aria-hidden="true" />} onClick={() => setEditing({ language: 'ar', category: 'UTILITY', body_preview: EXAMPLE_BODY, variables: EXAMPLE_VARS })}>تسجيل قالب</Button>
        </div>}
      </div>
      {sync.data && (
        <div className="wa-note" role="status"><span>حُدّث {sync.data.updated} قالبًا من Meta.{sync.data.missingAtMeta ? ` ${sync.data.missingAtMeta} قالب غير موجود لدى Meta عاد «مسودة».` : ''}
          {sync.data.unregistered.length > 0 && <> قوالب لدى Meta غير مسجّلة هنا: {sync.data.unregistered.map((u) => <button key={u.name + u.language} type="button" className="underline mx-1"
            onClick={() => setEditing({ name: u.name, language: u.language, category: 'UTILITY', body_preview: u.body ?? '', variables: [] })}><bdi dir="ltr">{u.name} ({u.language})</bdi></button>)}</>}</span></div>
      )}
      {(sync.error || remove.error) && <p className="text-xs text-(--status-danger)" role="alert">{((sync.error ?? remove.error) as ApiError).message}</p>}
      <AsyncState loading={list.isLoading} error={list.error} onRetry={() => list.refetch()} empty={!list.data?.items.length} emptyMessage="لا توجد قوالب مسجّلة. اعتمد قالبًا لدى Meta ثم سجّله هنا.">
        <div className="wa-table-wrap"><table className="wa-table">
          <thead><tr><th>القالب</th><th>اللغة</th><th>التنبيه</th><th>حالة Meta</th><th>آخر مزامنة</th><th><span className="sr-only">إجراءات</span></th></tr></thead>
          <tbody>{(list.data?.items ?? []).map((t) => (
            <tr key={t.id} className={t.is_active ? '' : 'muted'}>
              <td><bdi dir="ltr">{t.name}</bdi>{!t.is_active && <span className="text-xs"> · معطّل</span>}</td>
              <td>{t.language}</td>
              <td>{WHATSAPP_EVENTS.find((e) => e.key === t.event_type)?.label ?? '—'}</td>
              <td><Badge tone={TEMPLATE_TONE[t.meta_status]}>{TEMPLATE_STATUS_LABELS[t.meta_status]}</Badge>{t.meta_reason && <div className="text-xs muted mt-1">{t.meta_reason}</div>}</td>
              <td>{t.last_synced_at ? fmtRelative(t.last_synced_at) : '—'}</td>
              <td className="text-end"><OverflowMenu label="إجراءات" items={[
                { key: 'view', label: 'معاينة', icon: <Eye size={16} />, onSelect: () => setViewing(t) },
                ...(access.templates ? [
                  { key: 'edit', label: 'تعديل المعاينة والمتغيرات', icon: <Pencil size={16} />, onSelect: () => setEditing(t) },
                  { key: 'del', label: 'حذف', icon: <Trash2 size={16} />, tone: 'danger' as const, onSelect: () => confirmation.request({ title: 'حذف القالب',
                    description: 'إن استُخدم القالب في رسائل سابقة يُعطَّل بدل الحذف. لا يؤثر ذلك على القالب لدى Meta.', confirmLabel: 'حذف', danger: true,
                    allowed: (can) => can(W.TEMPLATES), execute: () => remove.mutateAsync(t.id) }) },
                ] : []),
              ]} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      </AsyncState>
      {editing && <TemplateDialog initial={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); refresh(); }} />}
      {viewing && (
        <ModalSurface label="معاينة القالب" onClose={() => setViewing(null)} panelClassName="card modal-card p-5 w-full max-w-lg">
          <div className="flex items-center justify-between mb-3"><h2 className="text-lg">معاينة <bdi dir="ltr">{viewing.name}</bdi></h2>
            <ModalCloseButton className="icon-button" aria-label="إغلاق" onClick={() => setViewing(null)}><Close size={18} /></ModalCloseButton></div>
          <div className="wa-preview">{preview(viewing.body_preview, viewing.variables)}</div>
          <p className="text-xs muted mt-3">قيم تجريبية. القيم الفعلية تُنظَّف من أي بيانات شخصية (أسماء الحسابات، الأرقام، البريد، الروابط الخارجية).</p>
        </ModalSurface>
      )}
    </section>
  );
}

function TemplateDialog({ initial, onClose, onDone }: { initial: Partial<WaTemplate>; onClose: () => void; onDone: () => void }) {
  const editing = !!initial.id;
  const [name, setName] = useState(initial.name ?? '');
  const [language, setLanguage] = useState(initial.language ?? 'ar');
  const [eventType, setEventType] = useState(initial.event_type ?? '');
  const [body, setBody] = useState(initial.body_preview ?? '');
  const [vars, setVars] = useState<string[]>(initial.variables ?? []);
  const count = useMemo(() => placeholders(body), [body]);
  // Only as many variables as the text has placeholders; extra choices from an earlier text are ignored.
  const used = vars.slice(0, count);
  const mismatch = used.length !== count || used.some((v) => !v);
  const save = useMutation({
    mutationFn: () => editing
      ? api.patch<{ statusReset: boolean }>(`/whatsapp/templates/${initial.id}`, { bodyPreview: body, variables: used, eventType: eventType || null })
      : api.post('/whatsapp/templates', { name, language, eventType: eventType || null, category: 'UTILITY', bodyPreview: body, variables: used }),
    onSuccess: onDone,
  });
  const setVar = (i: number, v: string) => setVars((a) => { const n = [...a]; n[i] = v; return n; });
  return (
    <ModalSurface as="form" label={editing ? 'تعديل قالب' : 'تسجيل قالب'} onClose={onClose} busy={save.isPending} onSubmit={(e) => { e.preventDefault(); if (!mismatch) save.mutate(); }}
      panelClassName="card modal-card p-5 w-full max-w-2xl">
      <div className="flex items-center justify-between mb-3"><h2 className="text-lg">{editing ? 'تعديل قالب' : 'تسجيل قالب معتمد لدى Meta'}</h2>
        <ModalCloseButton className="icon-button" aria-label="إغلاق" onClick={onClose}><Close size={18} /></ModalCloseButton></div>
      <div className="wa-form">
        <label className="block mb-3"><span className="block text-sm mb-1">اسم القالب لدى Meta</span>
          <input className="input" dir="ltr" required disabled={editing} pattern="[a-z0-9_]+" value={name} onChange={(e) => setName(e.target.value)} placeholder="radar_monitoring_alert" /></label>
        <label className="block mb-3"><span className="block text-sm mb-1">اللغة</span>
          <select className="input" disabled={editing} value={language} onChange={(e) => setLanguage(e.target.value)}><option value="ar">العربية (ar)</option><option value="en_US">الإنجليزية (en_US)</option><option value="en">الإنجليزية (en)</option></select></label>
        <label className="block mb-3"><span className="block text-sm mb-1">التنبيه المرتبط (اختياري)</span>
          <select className="input" value={eventType} onChange={(e) => setEventType(e.target.value)}><option value="">—</option>
            {WHATSAPP_EVENTS.filter((e) => e.availability !== 'unavailable').map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}</select></label>
      </div>
      <label className="block mb-1"><span className="block text-sm mb-1">نص القالب كما اعتمدته Meta</span>
        <textarea className="input" rows={7} required value={body} onChange={(e) => setBody(e.target.value)} /></label>
      <p className="text-xs muted mb-3">تغيير النص أو المتغيرات بعد الاعتماد يعيد الحالة «مسودة» حتى تؤكد المزامنة تطابقه مع Meta.</p>
      <div className="mb-3"><div className="text-sm mb-2">متغيرات القالب بالترتيب ({count} في النص)</div>
        <div className="wa-form">{Array.from({ length: count }, (_, i) => (
          <label key={i} className="block mb-2"><span className="block text-xs muted mb-1">{`{{${i + 1}}}`}</span>
            <select className="input" required value={vars[i] ?? ''} onChange={(e) => setVar(i, e.target.value)}><option value="">اختر</option>
              {Object.entries(WHATSAPP_TEMPLATE_VARIABLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        ))}</div>
      </div>
      <div className="text-sm mb-1">المعاينة</div>
      <div className="wa-preview mb-3">{preview(body, used)}</div>
      {mismatch && <p className="text-xs text-(--status-danger) mb-2" role="alert">اختر متغيرًا لكل موضع في النص ({count} {count === 1 ? 'موضع' : 'مواضع'}).</p>}
      {save.error && <p className="text-xs text-(--status-danger) mb-2" role="alert">{(save.error as ApiError).message}</p>}
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>إلغاء</Button>
        <Button variant="primary" type="submit" loading={save.isPending} disabled={mismatch || !body.trim() || (!editing && !/^[a-z0-9_]+$/.test(name))}>{editing ? 'حفظ' : 'تسجيل'}</Button></div>
    </ModalSurface>
  );
}
