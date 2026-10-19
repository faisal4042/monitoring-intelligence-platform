import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Clock3, ExternalLink, FileText, Hash, MessageSquareText, Ticket, UserRound, X } from 'lucide-react';
import ModalSurface, { ModalCloseButton } from '../ModalSurface';
import { api, ApiError } from '../../lib/api';
import { fmtDateTime, fmtNum } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import {
  ACTION_LABELS, ACTION_NEEDS, CHANNEL_LABELS, EVENT_LABELS, REVIEW_REASON_LABELS, TICKET_STATUS_LABELS, TICKET_STATUS_TONE, type TicketDetail,
} from '../../lib/tickets';

import { Button } from '../ui/Button';
interface Agent { id: string; full_name: string }

/** Ticket detail with a single timeline (customer messages, agent replies and every recorded action, in time order). */
export default function TicketDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const detail = useQuery({queryKey: ['ticket', id], queryFn: () => api.get<TicketDetail>(`/tickets/${id}`)});
  const agents = useQuery({queryKey: ['ticket-agents'], queryFn: () => api.get<{items: Agent[]}>('/admin/users?limit=200'), enabled: can('users:read'), staleTime: 300_000});
  const [action, setAction] = useState<string | null>(null);
  const [reason, setReason] = useState(''); const [assignee, setAssignee] = useState(''); const [body, setBody] = useState(''); const [priority, setPriority] = useState('high');
  const act = useMutation({
    mutationFn: (a: string) => api.post(`/tickets/${id}/actions/${a}`, {expectedVersion: detail.data!.ticket.version,
      ...(reason.trim() ? {reason: reason.trim()} : {}), ...(ACTION_NEEDS[a]?.assignee ? {assigneeId: assignee} : {}),
      ...(ACTION_NEEDS[a]?.body ? {body} : {}), ...(ACTION_NEEDS[a]?.priority ? {priority} : {})}),
    onSuccess: () => { setAction(null); setReason(''); setBody(''); qc.invalidateQueries({queryKey: ['ticket', id]}); qc.invalidateQueries({queryKey: ['tickets']}); },
  });
  const d = detail.data;
  const t = d?.ticket;
  const timeline = d ? [
    ...d.messages.map((m) => ({at: m.event_at, kind: 'message' as const, m})),
    ...d.events.filter((e) => e.event_type !== 'message_attached').map((e) => ({at: e.occurred_at, kind: 'event' as const, e})),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()) : [];
  const needs = action ? ACTION_NEEDS[action] ?? {} : {};
  const ready = !!action && (!needs.reason || needs.reason === 'optional' || reason.trim()) && (!needs.assignee || assignee) && (!needs.body || body.trim())
    && !(action === 'close' && t?.status === 'open' && !reason.trim());

  return (
    <ModalSurface labelledBy="td-title" onClose={onClose} overlayClassName="as-drawer-overlay" panelClassName="as-drawer td-drawer" busy={act.isPending}>
      <header className="as-drawer-head">
        <h2 id="td-title" className="as-drawer-title"><Ticket size={18} aria-hidden="true" /> {t ? <bdi className="num">#{t.ticket_number}</bdi> : 'التذكرة'}</h2>
        <ModalCloseButton type="button" className="icon-button" aria-label="إغلاق" onClick={onClose}><X size={17} /></ModalCloseButton>
      </header>
      <div className="as-drawer-body">
        {detail.isLoading && <div className="rc-skeleton" aria-busy="true" aria-label="جارٍ التحميل" />}
        {detail.error && <p className="rc-error" role="alert">{(detail.error as ApiError).message}</p>}
        {d && t && <>
          <div className="td-badges">
            <span className={`rc-status-pill tone-${TICKET_STATUS_TONE[t.status]}`}>{TICKET_STATUS_LABELS[t.status]}</span>
            {t.priority === 'high' && <span className="rc-status-pill tone-bad">أولوية عالية</span>}
            <span className="rc-tag">{CHANNEL_LABELS[t.channel] ?? t.channel}</span>
            {d.program && <span className="rc-tag"><span className="inf-dot" style={{background: d.program.color ?? 'var(--accent)'}} />{d.program.name_ar}</span>}
          </div>
          {t.needs_review && <p className="td-review" role="status"><AlertTriangle size={15} aria-hidden="true" /> تحتاج مراجعة: {REVIEW_REASON_LABELS[t.review_reason ?? ''] ?? t.review_reason}</p>}
          <dl className="td-facts">
            <div><dt>العميل</dt><dd><bdi dir="ltr">{d.customer.handle ? `@${d.customer.handle}` : d.customer.display_name ?? '—'}</bdi></dd></div>
            <div><dt>الموظف المسؤول</dt><dd>{d.assignee?.full_name ?? 'غير مسندة'}</dd></div>
            <div><dt>الرسائل</dt><dd><span className="num">{fmtNum(t.message_count)}</span></dd></div>
            <div><dt>أول تواصل</dt><dd>{fmtDateTime(t.opened_at)}</dd></div>
            <div><dt>آخر نشاط</dt><dd>{fmtDateTime(t.last_activity_at)}</dd></div>
            <div><dt>أول رد</dt><dd>{t.first_response_at ? fmtDateTime(t.first_response_at) : 'لم يُرد بعد'}</dd></div>
            <div><dt>آخر رد</dt><dd>{t.last_response_at ? fmtDateTime(t.last_response_at) : '—'}</dd></div>
            <div><dt>وقت الإغلاق</dt><dd>{t.closed_at ? fmtDateTime(t.closed_at) : '—'}</dd></div>
            <div><dt>التصنيف</dt><dd>{[t.intent, t.sentiment].filter(Boolean).join(' · ') || '—'}</dd></div>
            <div><dt>المحادثة</dt><dd>{d.conversation.identity_confidence === 'fallback_message' ? 'بلا معرف محادثة (رسالة مستقلة)' : <>تذاكر المحادثة <span className="num">{d.conversation.ticket_count}</span></>}</dd></div>
          </dl>

          {d.actions.length > 0 && (
            <section className="td-actions" aria-label="إجراءات التذكرة">
              <div className="td-action-list">
                {d.actions.map((a) => <button key={a} type="button" className={action === a ? 'btn-primary' : 'btn-ghost'} aria-pressed={action === a} onClick={() => setAction(action === a ? null : a)}>{ACTION_LABELS[a] ?? a}</button>)}
              </div>
              {action && (
                <form className="td-action-form" onSubmit={(e) => { e.preventDefault(); if (ready) act.mutate(action); }}>
                  {needs.assignee && (agents.data
                    ? <label className="rc-field"><span>الموظف</span><select className="input" required value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">اختر</option>{agents.data.items.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}</select></label>
                    : <label className="rc-field"><span>معرف الموظف</span><input className="input num" dir="ltr" required value={assignee} onChange={(e) => setAssignee(e.target.value)} /></label>)}
                  {needs.priority && <label className="rc-field"><span>الأولوية</span><select className="input" value={priority} onChange={(e) => setPriority(e.target.value)}><option value="high">عالية</option><option value="normal">عادية</option></select></label>}
                  {needs.body && <label className="rc-field"><span>نص الرد (يُسجَّل داخليًا ولا يُرسل لأي منصة)</span><textarea className="input" rows={3} maxLength={20000} required value={body} onChange={(e) => setBody(e.target.value)} /></label>}
                  {(needs.reason || action === 'close') && <label className="rc-field"><span>السبب {needs.reason === 'required' || t.status === 'open' ? '(مطلوب)' : '(اختياري)'}</span><input className="input" maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
                  <div className="rc-actions"><Button variant="primary" type="submit" disabled={!ready || act.isPending}>{act.isPending ? 'جارٍ التنفيذ…' : `تأكيد: ${ACTION_LABELS[action]}`}</Button><Button variant="ghost" type="button" onClick={() => setAction(null)}>إلغاء</Button></div>
                  {act.error && <p className="rc-error" role="alert">{(act.error as ApiError).message}</p>}
                </form>
              )}
            </section>
          )}

          <section aria-labelledby="td-tl" className="td-timeline-wrap">
            <h3 id="td-tl" className="rc-panel-title">سجل المحادثة والتذكرة</h3>
            <ol className="td-timeline">
              {timeline.map((x, i) => x.kind === 'message' ? (
                <li key={`m${x.m.id}`} className={`td-msg td-${x.m.direction}`}>
                  <span className="td-icon" aria-hidden="true">{x.m.direction === 'inbound' ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}</span>
                  <div className="td-body">
                    <div className="td-meta"><b>{x.m.direction === 'inbound' ? 'العميل' : x.m.agent_name ?? 'الموظف'}</b><time>{fmtDateTime(x.m.event_at)}</time>
                      {x.m.disposition === 'late_review' && <span className="rc-status-pill tone-bad">متأخرة — مراجعة</span>}
                      <span className="td-id num" title="معرف الرسالة لدى المزود"><Hash size={11} aria-hidden="true" />{x.m.provider_message_id.slice(-10)}</span></div>
                    {x.m.text ? <p dir="auto">{x.m.text.replace(/\n?https:\/\/\S+\s*$/, '')}</p> : <p className="rc-null">لا يتوفر نص لهذه الرسالة</p>}
                    {/^(news|youtube)$/.test(x.m.provider) && /https:\/\/\S+\s*$/.exec(x.m.text ?? '') && (
                      <div className="td-post-links"><a className="rc-link" href={/https:\/\/\S+\s*$/.exec(x.m.text!)![0].trim()} target="_blank" rel="noreferrer noopener">
                        <ExternalLink size={13} aria-hidden="true" /> {x.m.provider === 'news' ? 'فتح الخبر' : 'فتح على يوتيوب'}</a></div>)}
                    {x.m.post_id && (
                      <div className="td-post-links">
                        {can('posts:read') && <Link className="rc-link" to={`/live?detail=${x.m.post_id}&detailSection=interaction`}><FileText size={13} aria-hidden="true" /> فتح المنشور في MIP</Link>}
                        {x.m.post_url && <a className="rc-link" href={x.m.post_url} target="_blank" rel="noreferrer noopener"><ExternalLink size={13} aria-hidden="true" /> على إكس</a>}
                        {x.m.post_collected_at && <span className="td-collected">جُمع {fmtDateTime(x.m.post_collected_at)}</span>}
                        {x.m.post_status === 'filtered_out' && <span className="rc-status-pill tone-muted">مستبعد من التصنيف</span>}
                        {x.m.post_status === 'duplicate' && <span className="rc-status-pill tone-muted">محتوى مكرر</span>}
                      </div>
                    )}
                  </div>
                </li>
              ) : (
                <li key={`e${x.e.version}-${i}`} className="td-event">
                  <span className="td-icon" aria-hidden="true"><Clock3 size={13} /></span>
                  <div className="td-body"><div className="td-meta"><b>{EVENT_LABELS[x.e.event_type] ?? x.e.event_type}</b><time>{fmtDateTime(x.e.occurred_at)}</time></div>
                    <p className="td-event-line">{x.e.actor_name ? <><UserRound size={12} aria-hidden="true" /> {x.e.actor_name}</> : x.e.actor_kind === 'ingestion' ? 'استلام آلي' : 'النظام'}
                      {x.e.from_status && x.e.from_status !== x.e.to_status && <> · {TICKET_STATUS_LABELS[x.e.from_status as keyof typeof TICKET_STATUS_LABELS] ?? x.e.from_status} ← {TICKET_STATUS_LABELS[x.e.to_status as keyof typeof TICKET_STATUS_LABELS] ?? x.e.to_status}</>}
                      {x.e.assignee_name && <> · المسؤول: {x.e.assignee_name}</>}{x.e.reason && <> · {x.e.reason}</>}</p></div>
                </li>
              ))}
            </ol>
          </section>

          {d.previousTickets.length > 0 && (
            <section aria-labelledby="td-prev"><h3 id="td-prev" className="rc-panel-title"><MessageSquareText size={15} aria-hidden="true" /> تذاكر سابقة لنفس العميل</h3>
              <ul className="td-prev">{d.previousTickets.map((p) => <li key={p.id}><bdi className="num">#{p.ticket_number}</bdi><span className={`rc-status-pill tone-${TICKET_STATUS_TONE[p.status]}`}>{TICKET_STATUS_LABELS[p.status]}</span><time>{fmtDateTime(p.opened_at)}</time></li>)}</ul>
            </section>
          )}
          {d.queueManaged ? <p className="rc-desc td-queue-note">تُعالَج هذه التذكرة من بطاقتها في طابور الرصد: الإسناد والتصعيد والإغلاق تتم هناك وتنعكس هنا تلقائيًا.
            {d.queueItems.map((q) => <Link key={q.id} className="rc-link" to={`/queue?item=${q.id}`}> فتح البطاقة{q.assignee_name ? ` (${q.assignee_name})` : ''}</Link>)}</p>
            : d.queueItems.length > 0 && <p className="rc-desc">مرتبطة بـ <span className="num">{d.queueItems.length}</span> عنصر في طابور الرصد الحالي.</p>}
        </>}
      </div>
    </ModalSurface>
  );
}
