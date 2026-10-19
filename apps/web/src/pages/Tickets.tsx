import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ServerCrash, Ticket } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { fmtDateTime, fmtNum } from '../lib/format';
import { CHANNEL_LABELS, SOURCE_FILTERS, TICKET_STATUS_LABELS, TICKET_STATUS_TONE, type TicketRow, type TicketStatus } from '../lib/tickets';
import { useBrowsingParams } from '../lib/useBrowsingParams';
import TicketDrawer from '../components/tickets/TicketDrawer';
import { Button } from '../components/ui/Button';
import '../components/search/search.css';
import '../components/reports/reports.css';

const STATUS_FILTERS: Array<{key: string; ar: string; statuses: TicketStatus[] | null}> = [
  {key: 'active', ar: 'النشطة', statuses: ['open', 'assigned', 'in_progress', 'pending', 'escalated', 'resolved']},
  {key: 'open', ar: 'غير مسندة', statuses: ['open']}, {key: 'mine', ar: 'مسندة لي', statuses: null},
  {key: 'escalated', ar: 'مصعّدة', statuses: ['escalated']}, {key: 'closed', ar: 'مغلقة', statuses: ['closed']}, {key: 'review', ar: 'تحتاج مراجعة', statuses: null},
];

/** التذاكر — one open ticket per conversation; closed tickets are never reopened by new messages. */
export default function Tickets() {
  const [params, setParams] = useBrowsingParams();
  const filter = params.get('filter') ?? 'active';
  const open = params.get('ticket');
  const [cursor, setCursor] = useState<string | null>(null);
  const f = STATUS_FILTERS.find((x) => x.key === filter) ?? STATUS_FILTERS[0];
  const sourceKey = params.get('source') ?? 'all';
  const source = SOURCE_FILTERS.find((x) => x.key === sourceKey) ?? SOURCE_FILTERS[0];
  const number = params.get('number') ?? '';
  const [numberDraft, setNumberDraft] = useState(number);
  const setParam = (key: string, value: string) => { setCursor(null); setParams((old) => { const n = new URLSearchParams(old); value ? n.set(key, value) : n.delete(key); return n; }); };
  const qs = new URLSearchParams({limit: '50', ...(f.statuses ? {status: f.statuses.join(',')} : {}), ...(filter === 'mine' ? {assignee: 'me'} : {}),
    ...(filter === 'review' ? {review: '1'} : {}), ...(source.channels ? {channel: source.channels.join(',')} : {}), ...(number ? {q: number} : {}), ...(cursor ? {cursor} : {})});
  const list = useQuery({queryKey: ['tickets', filter, source.key, number, cursor], queryFn: () => api.get<{items: TicketRow[]; nextCursor: string | null}>(`/tickets?${qs}`), retry: false});
  const setOpen = (id: string | null) => setParams((old) => { const n = new URLSearchParams(old); id ? n.set('ticket', id) : n.delete('ticket'); return n; });
  const err = list.error as ApiError | null;

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
        <form className="tk-number" role="search" onSubmit={(e) => { e.preventDefault(); setParam('number', numberDraft.trim().replace(/^#/, '')); }}>
          <input className="input" inputMode="numeric" aria-label="رقم التذكرة" placeholder="رقم التذكرة" value={numberDraft} onChange={(e) => setNumberDraft(e.target.value)} />
          <Button variant="ghost" type="submit">بحث</Button>{number && <Button variant="ghost" type="button" onClick={() => { setNumberDraft(''); setParam('number', ''); }}>مسح</Button>}
        </form>
      </div>
      <div className="as-tabs" role="tablist" aria-label="تصفية التذاكر">
        {STATUS_FILTERS.map((x) => <button key={x.key} role="tab" type="button" className="as-tab" aria-selected={filter === x.key}
          onClick={() => { setCursor(null); setParams((old) => { const n = new URLSearchParams(old); n.set('filter', x.key); return n; }); }}>{x.ar}</button>)}
      </div>
      {err ? (err.status === 503 || err.status === 404 ? (
        <div className="rc-state"><ServerCrash size={24} aria-hidden="true" /><h2>نظام التذاكر غير مفعّل بعد</h2>
          <p>{err.status === 503 ? err.message : 'الخادم الجاري لا يتضمن نظام التذاكر بعد. التفعيل يتطلب اعتماد الترحيل 0047 وإعادة تشغيل الخادم.'}</p></div>
      ) : <p className="rc-error" role="alert">{err.message}</p>) : list.isLoading ? <div className="rc-skeleton" aria-busy="true" aria-label="جارٍ التحميل" />
        : !list.data?.items.length ? <div className="rc-state"><p>لا توجد تذاكر في هذا العرض.</p></div> : (
        <div className="rc-table-wrap" tabIndex={0} role="region" aria-label="قائمة التذاكر">
          <table className="rc-table tk-table">
            <thead><tr><th scope="col">رقم التذكرة</th><th scope="col">الحالة</th><th scope="col">القناة</th><th scope="col">البرنامج</th><th scope="col">العميل</th><th scope="col">المسؤول</th><th scope="col">الرسائل</th><th scope="col">آخر نشاط</th></tr></thead>
            <tbody>{list.data.items.map((t) => (
              <tr key={t.id} className="tk-row" onClick={() => setOpen(t.id)}>
                <td><button type="button" className="rc-link num" onClick={(e) => { e.stopPropagation(); setOpen(t.id); }}><bdi>#{t.ticket_number}</bdi></button>
                  {t.needs_review && <AlertTriangle size={13} className="tk-review" aria-label="تحتاج مراجعة" />}</td>
                <td><span className={`rc-status-pill tone-${TICKET_STATUS_TONE[t.status]}`}>{TICKET_STATUS_LABELS[t.status]}</span>{t.priority === 'high' && <span className="rc-status-pill tone-bad">عالية</span>}</td>
                <td>{CHANNEL_LABELS[t.channel] ?? t.channel}</td>
                <td>{t.program_name ?? '—'}</td>
                <td><bdi dir="ltr">{t.customer_handle ? `@${t.customer_handle}` : t.customer_name ?? '—'}</bdi></td>
                <td>{t.assignee_name ?? <span className="rc-null">غير مسندة</span>}</td>
                <td className="num">{fmtNum(t.message_count)}</td>
                <td>{fmtDateTime(t.last_activity_at)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {list.data?.nextCursor && <div className="rc-actions"><Button variant="ghost" type="button" onClick={() => setCursor(list.data!.nextCursor)}>الصفحة التالية</Button>{cursor && <Button variant="ghost" type="button" onClick={() => setCursor(null)}>العودة للبداية</Button>}</div>}
      {open && <TicketDrawer id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
