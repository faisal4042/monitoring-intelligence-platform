/**
 * «سجل التذكرة»: the item's work history and processing cycles (queue_events),
 * opened from the queue card. Moved out of the details drawer on request.
 */
import {useQuery} from '@tanstack/react-query';
import {X as Close} from 'lucide-react';
import {QUEUE_EVENT_LABELS, QUEUE_RESOLUTION_LABELS, QUEUE_REVIEW_OUTCOME_LABELS, QUEUE_SECTION_LABELS, QUEUE_STATUS_LABELS, type QueueSection} from '@mip/shared';
import ModalSurface, {ModalCloseButton} from '../ModalSurface';
import {api} from '../../lib/api';
import {fmtDateTime} from '../../lib/format';
import type {QueueItem} from '../../lib/queue';

export default function TicketHistoryDialog({id, ticket, onClose}: {id: string; ticket?: string; onClose: () => void}) {
  // Same cache entry as the details drawer.
  const {data: item, isLoading, error} = useQuery({queryKey: ['queue-item', id], queryFn: () => api.get<QueueItem>(`/queue/items/${id}`)});
  return <ModalSurface label="سجل التذكرة" onClose={onClose} panelClassName="card ic-dialog ic-history-dialog">
    <header className="ic-dialog-head"><h2>سجل التذكرة{ticket && <span className="ic-dialog-ticket">التذكرة <bdi>#{ticket}</bdi></span>}</h2>
      <ModalCloseButton type="button" className="ic-dialog-x" aria-label="إغلاق النافذة" onClick={onClose}><Close size={18}/></ModalCloseButton></header>
    {isLoading ? <p className="muted text-sm" role="status">جارٍ تحميل السجل…</p>
      : error || !item ? <p role="alert" className="ic-error">تعذر تحميل سجل التذكرة.</p>
      : !item.events?.length ? <p className="muted text-sm">لا توجد أحداث مسجلة.</p>
      : <div className="ic-history-body"><ol className="space-y-3">{item.events?.map(e=><li key={e.id} className="border-s-2 border-slate-300 ps-3 text-sm"><strong>{QUEUE_EVENT_LABELS[e.event_type]??e.event_type}</strong> · {e.actor_name??'النظام'}
          <p className="muted text-xs">{fmtDateTime(e.created_at)} · {e.from_status&&e.from_status!==e.to_status?QUEUE_STATUS_LABELS[e.from_status]+' ← ':''}{QUEUE_STATUS_LABELS[e.to_status]}</p>
          {e.event_type==='section_changed'&&e.metadata?.from&&e.metadata.to&&<p>{e.metadata.from===e.metadata.to?'انتقل مع قصته المدمجة':`${QUEUE_SECTION_LABELS[e.metadata.from as QueueSection]?.ar} ← ${QUEUE_SECTION_LABELS[e.metadata.to as QueueSection]?.ar}`}</p>}
          {e.event_type==='transferred'&&<p>{e.metadata?.fromTeamName??'—'} ← {e.metadata?.toTeamName??'—'}</p>}
          {e.event_type==='assigned'&&e.metadata?.auto&&<p className="muted">إسناد تلقائي</p>}
          {e.metadata?.override?.includes('not_available')&&<p className="text-(--status-warning)">أُسند يدوياً لموظف غير متاح</p>}
          {e.metadata?.override?.includes('box_full')&&<p className="text-(--status-warning)">أُسند يدوياً رغم امتلاء الصندوق</p>}
          {e.event_type==='priority_changed'&&<p>{e.metadata?.to==='high'?'رُفعت إلى أولوية عالية':'أُعيدت إلى أولوية عادية'}</p>}
          {e.event_type==='section_review'&&<p>{e.metadata?.hold?'التفاعل ضمن قصة يملكها فريق آخر؛ لم يُنقل تلقائياً.':'انتهت حالة المراجعة.'}</p>}
          {e.reason&&<p>{e.reason}</p>}{e.metadata?.outcome?<p>{QUEUE_REVIEW_OUTCOME_LABELS[e.metadata.outcome]}</p>:e.resolution&&<p>{QUEUE_RESOLUTION_LABELS[e.resolution as keyof typeof QUEUE_RESOLUTION_LABELS]} (سجل سابق)</p>}</li>)}</ol></div>}
  </ModalSurface>;
}
