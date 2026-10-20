import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, BadgeCheck, CheckCircle2, CheckSquare, Flame, Hand, MessageSquareText, PauseCircle, RotateCcw, ServerCrash, Ticket, TriangleAlert, UserRoundPlus, Zap } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { PERMISSIONS as P, QUEUE_REVIEW_OUTCOME_LABELS, type QueueReviewOutcome } from '@mip/shared';
import { useAuth } from '../lib/auth';
import { fmtCompact, fmtDateTime, fmtNum, fmtRelative } from '../lib/format';
import { CHANNEL_LABELS, SOURCE_FILTERS, TICKET_STATUS_LABELS, TICKET_STATUS_TONE, type TicketRow, type TicketStatus } from '../lib/tickets';
import type { QueueItem } from '../lib/queue';
import { useBrowsingParams } from '../lib/useBrowsingParams';
import { contentDirection } from '../lib/content-direction';
import { useDateRange } from '../lib/useDateRange';
import DateRangeFilter from '../components/DateRangeFilter';
import Avatar from '../components/Avatar';
import { ProgramChip } from '../components/ui/ProgramChip';
import { OverflowMenu } from '../components/ui/OverflowMenu';
import { SOURCE_BADGE_LABELS, SourceBadge, sourceKeyOf } from '../components/queue/SourceParts';
import TicketDrawer from '../components/tickets/TicketDrawer';
import { Button } from '../components/ui/Button';
import '../components/search/search.css';
import '../components/reports/reports.css';

const STATUS_FILTERS: Array<{key: string; ar: string; statuses: TicketStatus[] | null}> = [
  {key: 'active', ar: 'النشطة', statuses: ['open', 'assigned', 'in_progress', 'pending', 'escalated', 'resolved']},
  {key: 'open', ar: 'غير مسندة', statuses: ['open']}, {key: 'mine', ar: 'مسندة لي', statuses: null},
  {key: 'escalated', ar: 'مصعّدة', statuses: ['escalated']}, {key: 'closed', ar: 'مغلقة', statuses: ['closed']}, {key: 'review', ar: 'تحتاج مراجعة', statuses: null},
];

/** The queue card's interaction_type for a ticket channel, so SourceBadge and the stripes match exactly. */
const CHANNEL_TYPE: Record<string, QueueItem['interaction_type']> = {
  x_mention: 'post', x_reply: 'post', x_dm: 'post', x_story: 'story',
  news_article: 'news', youtube_video: 'youtube_video', youtube_comment: 'youtube_comment',
};
const msgsNoun = (n: number) => (n === 1 ? 'رسالة' : n === 2 ? 'رسالتان' : n <= 10 ? 'رسائل' : 'رسالة');
/** The card preview highlights the words; bare links stay one click away in the details. */
const previewText = (text: string) => text.replace(/https?:\/\/\S+/g, '').replace(/\s{2,}/g, ' ').trim() || text;

/**
 * Bulk actions. Queue-managed tickets (the normal case while queue links are active) route through their
 * queue card's own endpoints — the same rules the card enforces; the rest use the ticket state machine.
 * Priority and review-clearing are QUEUE_SAFE ticket actions, so they always take the ticket path.
 */
const BULK_ACTIONS: Array<{key: string; ar: string; icon: typeof Hand}> = [
  {key: 'claim', ar: 'استلام', icon: Hand},
  {key: 'assign', ar: 'إسناد / تحويل', icon: UserRoundPlus},
  {key: 'close', ar: 'إغلاق التفاعل', icon: CheckSquare},
  {key: 'reopen', ar: 'إعادة فتح', icon: RotateCcw},
  {key: 'escalate', ar: 'تصعيد', icon: TriangleAlert},
  {key: 'set_priority', ar: 'الأولوية', icon: Flame},
];
const MORE_ACTIONS = [{key: 'resolve', ar: 'حل (تذاكر خارج الطابور)'}, {key: 'hold', ar: 'تعليق'}, {key: 'clear_review', ar: 'إنهاء المراجعة'}];
const BULK_NEEDS: Record<string, {assignee?: boolean; reason?: 'required' | 'optional'; priority?: boolean; outcome?: boolean}> = {
  claim: {}, assign: {assignee: true, reason: 'optional'}, close: {outcome: true, reason: 'optional'}, resolve: {reason: 'optional'},
  reopen: {reason: 'required'}, escalate: {reason: 'required'}, set_priority: {priority: true}, hold: {reason: 'required'}, clear_review: {reason: 'required'},
};
const ACTION_AR: Record<string, string> = Object.fromEntries([...BULK_ACTIONS, ...MORE_ACTIONS].map((a) => [a.key, a.ar]));
type BulkResult = {num: string; ok: boolean; message?: string};
type AgentOpt = {id: string; full_name: string};

/** التذاكر — one open ticket per conversation; closed tickets are never reopened by new messages. */
export default function Tickets() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useBrowsingParams();
  const filter = params.get('filter') ?? 'active';
  const open = params.get('ticket');
  const [cursor, setCursor] = useState<string | null>(null);
  const f = STATUS_FILTERS.find((x) => x.key === filter) ?? STATUS_FILTERS[0];
  const sourceKey = params.get('source') ?? 'all';
  const source = SOURCE_FILTERS.find((x) => x.key === sourceKey) ?? SOURCE_FILTERS[0];
  const number = params.get('number') ?? '';
  const [numberDraft, setNumberDraft] = useState(number);
  const date = useDateRange('all');
  // The date filter lives in the URL, so a change there must restart cursor pagination too.
  useEffect(() => { setCursor(null); }, [date.apiQuery]);
  const setParam = (key: string, value: string) => { setCursor(null); setParams((old) => { const n = new URLSearchParams(old); value ? n.set(key, value) : n.delete(key); return n; }); };
  const qs = new URLSearchParams({limit: '50', ...(f.statuses ? {status: f.statuses.join(',')} : {}), ...(filter === 'mine' ? {assignee: 'me'} : {}),
    ...(filter === 'review' ? {review: '1'} : {}), ...(source.channels ? {channel: source.channels.join(',')} : {}), ...(number ? {q: number} : {}), ...(cursor ? {cursor} : {})});
  const listQs = `${qs}${date.apiQuery ? `&${date.apiQuery}` : ''}`;
  const list = useQuery({queryKey: ['tickets', filter, source.key, number, date.apiQuery, cursor], queryFn: () => api.get<{items: TicketRow[]; nextCursor: string | null; queueLinked?: boolean}>(`/tickets?${listQs}`), enabled: !date.error, retry: false});
  const setOpen = (id: string | null) => setParams((old) => { const n = new URLSearchParams(old); id ? n.set('ticket', id) : n.delete('ticket'); return n; });
  const err = list.error as ApiError | null;
  const items = list.data?.items ?? [];

  // ─── Bulk selection and actions ───────────────────────────────────────────
  const canBulk = can(P.TICKETS_WORK, P.TICKETS_ASSIGN, P.TICKETS_MANAGE);
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkAction, setBulkAction] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [assignee, setAssignee] = useState('');
  const [priority, setPriority] = useState<'high' | 'normal'>('high');
  const [outcome, setOutcome] = useState<QueueReviewOutcome>('no_action');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<BulkResult[] | null>(null);
  const agents = useQuery({queryKey: ['ticket-agents'], queryFn: () => api.get<{items: AgentOpt[]}>('/admin/users?limit=200'), enabled: canBulk && can('users:read'), staleTime: 300_000});
  // A new page, filter or window means a new set of rows: drop the selection with it.
  useEffect(() => { setSelected([]); setBulkAction(null); setResults(null); }, [filter, source.key, number, date.apiQuery, cursor]);
  const chosen = useMemo(() => items.filter((t) => selected.includes(t.id)), [items, selected]);
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const allSelected = items.length > 0 && items.every((t) => selected.includes(t.id));
  const needs = bulkAction ? BULK_NEEDS[bulkAction] ?? {} : {};
  const ready = !busy && chosen.length > 0 && (!needs.reason || needs.reason === 'optional' || reason.trim()) && (!needs.assignee || assignee);
  const openBulk = (key: string) => { setResults(null); setReason(''); setAssignee(''); setPriority('high'); setOutcome('no_action'); setBulkAction((a) => (a === key ? null : key)); };
  const queueLinked = list.data?.queueLinked ?? false;

  const runBulk = async () => {
    if (!bulkAction || !ready) return;
    setBusy(true); setProgress(0);
    const out: BulkResult[] = []; const failedIds: string[] = [];
    const r = reason.trim();
    const reasonOpt = r ? {reason: r} : {};
    const ticketPost = (t: TicketRow, a: string, body: Record<string, unknown>) => api.post(`/tickets/${t.id}/actions/${a}`, {expectedVersion: t.version, ...body});
    const queuePost = (t: TicketRow, path: string, body: Record<string, unknown>) => api.post(`/queue/items/${t.queue_item_id}/${path}`, {expectedVersion: t.queue_item_version, ...body});
    const dispatch = (t: TicketRow): Promise<unknown> => {
      const managed = queueLinked && !!t.queue_item_id;
      switch (bulkAction) {
        case 'claim': return managed ? queuePost(t, 'claim', {}) : ticketPost(t, 'claim', {});
        case 'assign': return managed ? queuePost(t, 'assign', {assigneeId: assignee, ...reasonOpt}) : ticketPost(t, 'assign', {assigneeId: assignee, ...reasonOpt});
        case 'escalate': return managed ? queuePost(t, 'escalate', {reason: r}) : ticketPost(t, 'escalate', {reason: r});
        case 'close': return managed
          ? queuePost(t, 'complete', {review: {outcome, ...(outcome === 'irrelevant' ? {relevant: false} : {}), ...reasonOpt}})
          : ticketPost(t, 'close', reasonOpt);
        case 'reopen':
          if (!managed) return Promise.reject(new Error('إعادة الفتح متاحة لتذاكر الطابور فقط'));
          return queuePost(t, 'reopen', {reason: r});
        case 'set_priority': return ticketPost(t, 'set_priority', {priority});
        default: return ticketPost(t, bulkAction!, reasonOpt); // resolve, hold, clear_review — ticket-engine actions.
      }
    };
    // Sequential on purpose: each row is validated and versioned on its own; one failure never hides the rest.
    for (const t of chosen) {
      try { await dispatch(t); out.push({num: t.ticket_number, ok: true}); }
      catch (e) { out.push({num: t.ticket_number, ok: false, message: (e as Error).message}); failedIds.push(t.id); }
      setProgress(out.length);
    }
    setBusy(false); setResults(out); setSelected(failedIds); if (!failedIds.length) setBulkAction(null);
    void qc.invalidateQueries({queryKey: ['tickets']});
  };

  return (
    <div className="rc-page" dir="rtl">
      <header className="rc-header"><div>
        <span className="eyebrow">العمليات</span>
        <h1 className="rc-h1"><Ticket size={24} className="rc-h1-icon" aria-hidden="true" /> التذاكر</h1>
        <p className="rc-lead">كل ما يرصده النظام من إكس والأخبار ويوتيوب يصبح تذكرة برقم ثابت، ويُعالَج من بطاقته في طابور الرصد. الرسالة بعد الإغلاق تفتح تذكرة جديدة.</p>
      </div></header>
      <div className="tk-filters">
        <div className="as-tabs" role="group" aria-label="المصدر">{SOURCE_FILTERS.map((x) => <button key={x.key} type="button" className="as-tab" aria-pressed={source.key === x.key}
          onClick={() => setParam('source', x.key === 'all' ? '' : x.key)}>{x.ar}</button>)}</div>
        <div className="tk-date" aria-label="فترة آخر نشاط"><DateRangeFilter state={date} /></div>
        <form className="tk-number" role="search" onSubmit={(e) => { e.preventDefault(); setParam('number', numberDraft.trim().replace(/^#/, '')); }}>
          <input className="input" inputMode="numeric" aria-label="رقم التذكرة" placeholder="رقم التذكرة" value={numberDraft} onChange={(e) => setNumberDraft(e.target.value)} />
          <Button variant="ghost" type="submit">بحث</Button>{number && <Button variant="ghost" type="button" onClick={() => { setNumberDraft(''); setParam('number', ''); }}>مسح</Button>}
        </form>
      </div>
      <div className="as-tabs" role="tablist" aria-label="تصفية التذاكر">
        {STATUS_FILTERS.map((x) => <button key={x.key} role="tab" type="button" className="as-tab" aria-selected={filter === x.key}
          onClick={() => { setCursor(null); setParams((old) => { const n = new URLSearchParams(old); n.set('filter', x.key); return n; }); }}>{x.ar}</button>)}
      </div>
      {date.error && <p className="rc-error" role="alert">{date.error}</p>}

      {canBulk && items.length > 0 && <div className="tk-selectbar">
        <label><input type="checkbox" checked={allSelected} onChange={(e) => setSelected(e.target.checked ? items.map((t) => t.id) : [])} aria-label="تحديد كل تذاكر الصفحة" /> تحديد هذه الصفحة</label>
        <span className="muted">{selected.length ? `${fmtNum(selected.length)} محددة` : 'التحديد يقتصر على الصفحة الحالية'}</span>
      </div>}

      {canBulk && selected.length > 0 && <div className="tk-bulkbar" role="toolbar" aria-label="إجراء جماعي">
        <span className="tk-bulk-count">{fmtNum(selected.length)} محددة</span>
        {BULK_ACTIONS.map((a) => <Button key={a.key} variant={bulkAction === a.key ? 'primary' : 'ghost'} size="sm" type="button" icon={<a.icon size={15} aria-hidden="true" />}
          aria-pressed={bulkAction === a.key} onClick={() => openBulk(a.key)}>{a.ar}</Button>)}
        <OverflowMenu label="إجراءات أخرى" items={MORE_ACTIONS.map((a) => ({key: a.key, label: a.ar, icon: <PauseCircle size={15} />, onSelect: () => openBulk(a.key)}))} />
        <Button variant="quiet" size="sm" type="button" className="ms-auto" onClick={() => { setSelected([]); setBulkAction(null); setResults(null); }}>مسح التحديد</Button>
      </div>}

      {canBulk && bulkAction && <div className="tk-bulk-panel card" role="group" aria-label={`تنفيذ ${ACTION_AR[bulkAction]} جماعيًا`}>
        <p className="tk-bulk-title">سيُطبق «{ACTION_AR[bulkAction]}» على {fmtNum(chosen.length)} {chosen.length === 1 ? 'تذكرة' : chosen.length === 2 ? 'تذكرتين' : 'تذاكر'}، والخادم يتحقق من كل تذكرة على حدة.</p>
        <div className="tk-bulk-fields">
          {needs.assignee && (agents.data
            ? <label className="rc-field"><span>الموظف</span><select className="input" required value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">اختر</option>{agents.data.items.map((a) => <option key={a.id} value={a.id}>{a.full_name}</option>)}</select></label>
            : <label className="rc-field"><span>معرف الموظف</span><input className="input num" dir="ltr" required value={assignee} onChange={(e) => setAssignee(e.target.value)} /></label>)}
          {needs.priority && <label className="rc-field"><span>الأولوية</span><select className="input" value={priority} onChange={(e) => setPriority(e.target.value as 'high' | 'normal')}><option value="high">عالية</option><option value="normal">عادية</option></select></label>}
          {needs.outcome && <label className="rc-field"><span>نتيجة المراجعة</span><select className="input" value={outcome} onChange={(e) => setOutcome(e.target.value as QueueReviewOutcome)}>
            {Object.entries(QUEUE_REVIEW_OUTCOME_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>}
          {needs.reason && <label className="rc-field tk-bulk-reason"><span>السبب{needs.reason === 'optional' ? ' (اختياري)' : ''}</span><input className="input" maxLength={2000} required={needs.reason === 'required'} value={reason} onChange={(e) => setReason(e.target.value)} /></label>}
        </div>
        <div className="tk-bulk-run">
          <Button variant="primary" size="sm" type="button" loading={busy} disabled={!ready} onClick={() => void runBulk()}>تنفيذ{busy ? ` (${fmtNum(progress)}/${fmtNum(chosen.length)})` : ''}</Button>
          <Button variant="ghost" size="sm" type="button" disabled={busy} onClick={() => setBulkAction(null)}>إلغاء</Button>
        </div>
      </div>}

      {results && <div className={`tk-bulk-results card ${results.some((r) => !r.ok) ? 'has-fail' : ''}`} role="status">
        <p>{results.filter((r) => r.ok).length ? `تم تنفيذ الإجراء على ${fmtNum(results.filter((r) => r.ok).length)} تذكرة.` : ''}
          {results.some((r) => !r.ok) && ` تعذر على ${fmtNum(results.filter((r) => !r.ok).length)} (تبقى محددة):`}</p>
        {results.filter((r) => !r.ok).slice(0, 8).map((r) => <p key={r.num} className="tk-bulk-fail"><bdi>#{r.num}</bdi> — {r.message}</p>)}
      </div>}

      {err ? (err.status === 503 || err.status === 404 ? (
        <div className="rc-state"><ServerCrash size={24} aria-hidden="true" /><h2>نظام التذاكر غير مفعّل بعد</h2>
          <p>{err.status === 503 ? err.message : 'الخادم الجاري لا يتضمن نظام التذاكر بعد. التفعيل يتطلب اعتماد الترحيل 0047 وإعادة تشغيل الخادم.'}</p></div>
      ) : <p className="rc-error" role="alert">{err.message}</p>) : list.isLoading ? <div className="rc-skeleton" aria-busy="true" aria-label="جارٍ التحميل" />
        : !items.length ? <div className="rc-state"><p>لا توجد تذاكر في هذا العرض.</p></div> : (
        <div className="queue-list" role="list" aria-label="قائمة التذاكر">
          {items.map((t) => {
            const typed = {interaction_type: CHANNEL_TYPE[t.channel] ?? 'post'} as Pick<QueueItem, 'interaction_type'>;
            const key = sourceKeyOf(typed);
            const name = t.customer_name ?? (t.customer_handle ? `@${t.customer_handle}` : 'عميل غير معروف');
            const figures = key === 'x'
              ? [t.followers_count != null ? `${fmtCompact(t.followers_count)} متابع` : null,
                 t.following_count != null ? `${fmtCompact(t.following_count)} يتابع` : null,
                 t.tweet_count != null ? `${fmtCompact(t.tweet_count)} منشور` : null].filter(Boolean).join(' · ')
              : CHANNEL_LABELS[t.channel] ?? t.channel;
            const isChecked = selected.includes(t.id);
            return (
              <article key={t.id} role="listitem" className={`ic-card card tk-selectable queue-card--src-${key} ${open === t.id || isChecked ? 'is-selected' : ''} ${t.priority === 'high' ? 'is-high' : ''}`}
                aria-label={`${SOURCE_BADGE_LABELS[key]}: ${name}`}>
                {canBulk && <input type="checkbox" className="tk-select" checked={isChecked} onChange={() => toggle(t.id)} aria-label={`تحديد التذكرة #${t.ticket_number}`} />}
                <button type="button" className="ic-main" onClick={() => setOpen(t.id)} aria-label={`فتح التذكرة #${t.ticket_number} — ${name}`}>
                  <span className="ic-head">
                    <span className="ic-avatar">
                      <Avatar src={t.profile_image_url ?? undefined} name={t.customer_name ?? t.customer_handle ?? '؟'} username={t.customer_handle ?? undefined} size={44} />
                      <span className={`ic-avatar-source ic-avatar-source--${key}`} aria-hidden="true"><SourceBadge item={typed} iconOnly /></span>
                    </span>
                    <span className="ic-who">
                      <span className="ic-name-row"><strong className="ic-name">{name}</strong>
                        {t.customer_handle && <span className="ic-handle" dir="ltr">@{t.customer_handle}</span>}
                        {t.is_verified && <BadgeCheck size={15} aria-label="حساب موثق" />}</span>
                      <span className="ic-figures">{figures}</span>
                      {t.author_bio && <span className="ic-figures" dir="auto" title={t.author_bio}>{t.author_bio}</span>}
                    </span>
                    <span className="ic-when" title={`آخر نشاط: ${fmtDateTime(t.last_activity_at)}`}><Zap size={15} aria-hidden="true" />آخر نشاط {fmtRelative(t.last_activity_at)}</span>
                  </span>
                  {t.last_message_text && <span className="ic-text" dir={contentDirection(t.last_message_text)}>{previewText(t.last_message_text)}</span>}
                </button>
                <footer className="ic-foot">
                  <span className="ic-foot-start">
                    <span className="ic-ticket">التذكرة <bdi>#{t.ticket_number}</bdi></span>
                    {t.program_name && <ProgramChip name={t.program_name} color={t.program_color} />}
                  </span>
                  <span className="ic-foot-meta">
                    <span className="ic-count" title="رسائل التذكرة"><MessageSquareText size={14} aria-hidden="true" />{fmtNum(t.message_count)} {msgsNoun(t.message_count)}</span>
                    {t.priority === 'high' && <span className="queue-tag queue-tag--hold"><Flame size={11} aria-hidden="true" />أولوية عالية</span>}
                    {t.needs_review && <span className="rc-status-pill tone-warn"><AlertTriangle size={12} aria-hidden="true" /> تحتاج مراجعة</span>}
                    <span className={`rc-status-pill tone-${TICKET_STATUS_TONE[t.status]}`}>{TICKET_STATUS_LABELS[t.status]}</span>
                    <span className="ic-assignee">{t.assignee_name ?? 'بدون مسؤول'}</span>
                  </span>
                </footer>
              </article>
            );
          })}
        </div>
      )}
      {list.data?.nextCursor && <div className="rc-actions"><Button variant="ghost" type="button" onClick={() => setCursor(list.data!.nextCursor)}>الصفحة التالية</Button>{cursor && <Button variant="ghost" type="button" onClick={() => setCursor(null)}>العودة للبداية</Button>}</div>}
      {open && <TicketDrawer id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
