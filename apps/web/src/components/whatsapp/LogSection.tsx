import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, RotateCcw, Send, X as Close } from 'lucide-react';
import { WHATSAPP_EVENTS, WHATSAPP_PERMISSIONS as W, WHATSAPP_STATUS_LABELS, WHATSAPP_STATUSES, type WhatsAppStatus } from '@mip/shared';
import { api, type ApiError } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import AsyncState from '../AsyncState';
import ModalSurface, { ModalCloseButton } from '../ModalSurface';
import { useConfirmAction } from '../ConfirmAction';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { OverflowMenu } from '../ui/OverflowMenu';
import { ERROR_CLASS_LABELS, STATUS_TONE, type WaAccess, type WaMessage, type WaRecipient, type WaTemplate } from './types';

interface Attempt { attempt_no: number; started_at: string; finished_at: string | null; outcome: string; http_status: number | null; error_code: string | null; error_message: string | null }
const eventLabel = (k: string) => (k === 'test_message' ? 'رسالة تجريبية' : WHATSAPP_EVENTS.find((e) => e.key === k)?.label ?? k);
const shortId = (id: string | null) => (id ? `${id.slice(0, 10)}…${id.slice(-6)}` : '—');

/** Delivery log: masked recipients, statuses from Meta's webhooks, attempts, and guarded manual retry. */
export default function LogSection({ access }: { access: WaAccess }) {
  const qc = useQueryClient();
  const confirmation = useConfirmAction();
  const [f, setF] = useState({ status: '', eventType: '', programId: '', recipientId: '', from: '', to: '' });
  const [attemptsOf, setAttemptsOf] = useState<WaMessage | null>(null);
  const [testing, setTesting] = useState(false);
  const qs = (before?: string) => {
    const p = new URLSearchParams();
    if (f.status) p.set('status', f.status); if (f.eventType) p.set('eventType', f.eventType);
    if (f.programId) p.set('programId', f.programId); if (f.recipientId) p.set('recipientId', f.recipientId);
    if (f.from) p.set('from', new Date(`${f.from}T00:00:00+03:00`).toISOString());
    if (f.to) p.set('to', new Date(`${f.to}T23:59:59+03:00`).toISOString());
    if (before) p.set('before', before);
    return p.toString();
  };
  const log = useInfiniteQuery({
    queryKey: ['wa-messages', f], initialPageParam: '' as string,
    queryFn: ({ pageParam }) => api.get<{ items: WaMessage[]; nextBefore: string | null }>(`/whatsapp/messages?${qs(pageParam || undefined)}`),
    getNextPageParam: (last) => last.nextBefore ?? undefined, refetchInterval: 30_000,
  });
  const recipients = useQuery({ queryKey: ['wa-recipients'], queryFn: () => api.get<{ items: WaRecipient[] }>('/whatsapp/recipients'), enabled: access.recipients });
  const programs = useQuery({ queryKey: ['programs'], queryFn: () => api.get<{ items: Array<{ id: string; name_ar: string }> }>('/programs') });
  const retry = useMutation({
    mutationFn: (v: { id: string; ack?: boolean }) => api.post(`/whatsapp/messages/${v.id}/retry`, { acknowledgeDuplicateRisk: !!v.ack }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['wa-messages'] }),
  });
  const items = log.data?.pages.flatMap((p) => p.items) ?? [];
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  return (
    <section className="card wa-section" aria-labelledby="wa-log-h">
      {confirmation.dialog}
      <div className="wa-section-head">
        <div><h2 id="wa-log-h">سجل رسائل واتساب</h2>
          <p>«تم قبول الطلب» يعني أن Meta استلمت الطلب فقط. التسليم والقراءة يصلان من إشعارات Meta عند توفرها.</p></div>
        {access.test && <Button variant="ghost" icon={<Send size={16} aria-hidden="true" />} onClick={() => setTesting(true)}>إرسال تجريبي</Button>}
      </div>
      <div className="wa-filters" role="search" aria-label="فلاتر السجل">
        <select className="input" aria-label="الحالة" value={f.status} onChange={set('status')}><option value="">كل الحالات</option>
          {WHATSAPP_STATUSES.map((s) => <option key={s} value={s}>{WHATSAPP_STATUS_LABELS[s]}</option>)}</select>
        <select className="input" aria-label="نوع التنبيه" value={f.eventType} onChange={set('eventType')}><option value="">كل التنبيهات</option>
          <option value="test_message">رسالة تجريبية</option>
          {WHATSAPP_EVENTS.filter((e) => e.availability !== 'unavailable').map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}</select>
        <select className="input" aria-label="البرنامج" value={f.programId} onChange={set('programId')}><option value="">كل البرامج</option>
          {(programs.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name_ar}</option>)}</select>
        {access.recipients && <select className="input" aria-label="المستلم" value={f.recipientId} onChange={set('recipientId')}><option value="">كل المستلمين</option>
          {(recipients.data?.items ?? []).map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}</select>}
        <input className="input" type="date" aria-label="من تاريخ" value={f.from} onChange={set('from')} />
        <input className="input" type="date" aria-label="إلى تاريخ" value={f.to} onChange={set('to')} />
      </div>
      {retry.error && <p className="text-xs text-(--status-danger)" role="alert">{(retry.error as ApiError).message}</p>}
      <AsyncState loading={log.isLoading} error={log.error} onRetry={() => log.refetch()} empty={!items.length} emptyMessage="لا توجد رسائل مطابقة.">
        <div className="wa-table-wrap"><table className="wa-table">
          <thead><tr><th>#</th><th>التنبيه</th><th>المستلم</th><th>البرنامج</th><th>أُنشئ</th><th>أُرسل</th><th>الحالة</th><th>المحاولات</th><th>القالب</th><th>معرّف Meta</th><th><span className="sr-only">إجراءات</span></th></tr></thead>
          <tbody>{items.map((m) => (
            <tr key={m.id}>
              <td className="wa-code">{m.id}</td>
              <td>{eventLabel(m.event_type)}</td>
              <td><div>{m.recipient_name}</div><bdi dir="ltr" className="text-xs muted">{m.recipient_phone}</bdi></td>
              <td>{m.program_name ?? '—'}</td>
              <td className="whitespace-nowrap">{fmtDateTime(m.created_at)}</td>
              <td className="whitespace-nowrap">{m.accepted_at ? fmtDateTime(m.accepted_at) : '—'}</td>
              <td><Badge tone={STATUS_TONE[m.status] ?? 'neutral'}>{WHATSAPP_STATUS_LABELS[m.status as WhatsAppStatus] ?? m.status}</Badge>
                {m.last_error_message && <div className="text-xs muted mt-1">{m.error_class ? `${ERROR_CLASS_LABELS[m.error_class] ?? m.error_class}: ` : ''}{m.last_error_message}</div>}</td>
              <td className="num">{m.attempts}</td>
              <td><bdi dir="ltr" className="wa-code">{m.template_name}</bdi></td>
              <td><bdi dir="ltr" className="wa-code" title={m.meta_message_id ?? undefined}>{shortId(m.meta_message_id)}</bdi></td>
              <td className="text-end"><OverflowMenu label="إجراءات" items={[
                { key: 'attempts', label: 'سجل المحاولات', icon: <History size={16} />, onSelect: () => setAttemptsOf(m) },
                ...(access.toggle && m.status === 'failed' && !m.meta_message_id && m.error_class !== 'permanent' && m.error_class !== 'policy' ? [{
                  key: 'retry', label: 'إعادة المحاولة', icon: <RotateCcw size={16} />, onSelect: () => confirmation.request(m.error_class === 'uncertain'
                    ? { title: 'إعادة إرسال قد تكرر الرسالة', description: 'انقطع الاتصال بعد إرسال الطلب، فربما وصلت الرسالة فعلًا. أعد الإرسال فقط إذا تأكدت أنها لم تصل.', confirmLabel: 'إعادة الإرسال رغم احتمال التكرار', danger: true, allowed: (can) => can(W.TOGGLE), execute: () => retry.mutateAsync({ id: m.id, ack: true }) }
                    : { title: 'إعادة المحاولة', description: 'تعود الرسالة إلى قائمة الإرسال إن لم تنتهِ صلاحيتها.', confirmLabel: 'إعادة المحاولة', allowed: (can) => can(W.TOGGLE), execute: () => retry.mutateAsync({ id: m.id }) }),
                }] : []),
              ]} /></td>
            </tr>
          ))}</tbody>
        </table></div>
        {log.hasNextPage && <div className="mt-3"><Button variant="ghost" loading={log.isFetchingNextPage} onClick={() => log.fetchNextPage()}>عرض المزيد</Button></div>}
      </AsyncState>
      {attemptsOf && <AttemptsDialog message={attemptsOf} onClose={() => setAttemptsOf(null)} />}
      {testing && <TestDialog onClose={() => setTesting(false)} onDone={() => { setTesting(false); qc.invalidateQueries({ queryKey: ['wa-messages'] }); }} />}
    </section>
  );
}

function AttemptsDialog({ message, onClose }: { message: WaMessage; onClose: () => void }) {
  const q = useQuery({ queryKey: ['wa-attempts', message.id], queryFn: () => api.get<{ items: Attempt[] }>(`/whatsapp/messages/${message.id}/attempts`) });
  return (
    <ModalSurface label="سجل المحاولات" onClose={onClose} panelClassName="card modal-card p-5 w-full max-w-2xl">
      <div className="flex items-center justify-between mb-3"><h2 className="text-lg">محاولات الرسالة <span className="wa-code">#{message.id}</span></h2>
        <ModalCloseButton className="icon-button" aria-label="إغلاق" onClick={onClose}><Close size={18} /></ModalCloseButton></div>
      <AsyncState loading={q.isLoading} error={q.error} empty={!q.data?.items.length} emptyMessage="لم تُجرَ أي محاولة بعد.">
        <div className="wa-table-wrap"><table className="wa-table">
          <thead><tr><th>المحاولة</th><th>البدء</th><th>النتيجة</th><th>HTTP</th><th>الخطأ</th></tr></thead>
          <tbody>{(q.data?.items ?? []).map((a) => (
            <tr key={a.attempt_no}><td className="num">{a.attempt_no}</td><td>{fmtDateTime(a.started_at)}</td>
              <td>{a.outcome === 'accepted' ? 'قبلتها Meta' : a.outcome === 'in_flight' ? 'قيد التنفيذ' : ERROR_CLASS_LABELS[a.outcome] ?? a.outcome}</td>
              <td className="num">{a.http_status ?? '—'}</td><td>{a.error_message ?? '—'}{a.error_code && <span className="wa-code"> ({a.error_code})</span>}</td></tr>
          ))}</tbody>
        </table></div>
      </AsyncState>
    </ModalSurface>
  );
}

function TestDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const recipients = useQuery({ queryKey: ['wa-recipients'], queryFn: () => api.get<{ items: WaRecipient[] }>('/whatsapp/recipients') });
  const templates = useQuery({ queryKey: ['wa-templates'], queryFn: () => api.get<{ items: WaTemplate[] }>('/whatsapp/templates') });
  const [recipientId, setRecipientId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const send = useMutation({ mutationFn: () => api.post('/whatsapp/test-send', { recipientId, templateId }), onSuccess: onDone });
  const eligible = (recipients.data?.items ?? []).filter((r) => r.is_active && r.opt_in_status === 'opted_in');
  const approved = (templates.data?.items ?? []).filter((t) => t.is_active && t.meta_status === 'approved');
  return (
    <ModalSurface as="form" label="إرسال تجريبي" onClose={onClose} busy={send.isPending} onSubmit={(e) => { e.preventDefault(); send.mutate(); }}>
      <h2 className="text-lg mb-1">إرسال رسالة تجريبية</h2>
      <p className="text-sm muted mb-4">تُرسل رسالة حقيقية بقيم تجريبية إلى مستلم وافق على الاستقبال، عبر قالب معتمد، إذا كانت القناة والخادم مفعّلين. تظهر في السجل كرسالة تجريبية.</p>
      <label className="block mb-3"><span className="block text-sm mb-1">المستلم (الموافقون فقط)</span>
        <select className="input" required value={recipientId} onChange={(e) => setRecipientId(e.target.value)}><option value="">اختر</option>
          {eligible.map((r) => <option key={r.id} value={r.id}>{r.full_name} ({r.phone})</option>)}</select></label>
      <label className="block mb-3"><span className="block text-sm mb-1">القالب (المعتمد فقط)</span>
        <select className="input" required value={templateId} onChange={(e) => setTemplateId(e.target.value)}><option value="">اختر</option>
          {approved.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.language})</option>)}</select></label>
      {!eligible.length && <p className="text-xs muted mb-2">لا يوجد مستلم وافق على الاستقبال بعد.</p>}
      {!approved.length && <p className="text-xs muted mb-2">لا يوجد قالب معتمد من Meta بعد.</p>}
      {send.error && <p className="text-xs text-(--status-danger) mb-2" role="alert">{(send.error as ApiError).message}</p>}
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>إلغاء</Button>
        <Button variant="primary" type="submit" loading={send.isPending} disabled={!recipientId || !templateId}>إرسال تجريبي</Button></div>
    </ModalSurface>
  );
}
