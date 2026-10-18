import { QUEUE_EVENT_LABELS } from '@mip/shared';
import { fmtDateTime } from '../../lib/format';
import { interactionLabel, type InteractionDetail } from './interaction';

export function ProcessingHistory({ detail, compact = false }: { detail: InteractionDetail; compact?: boolean }) {
  const feedback = detail.feedback ?? [], queueEvents = detail.queueEvents ?? [], events = detail.events ?? [];
  const entries = [
    ...feedback.map(event => ({ at: event.created_at, label: `تصحيح التصنيف · ${interactionLabel(event.human_value)}`, reason: event.reason })),
    ...queueEvents.map(event => ({ at: event.created_at, label: QUEUE_EVENT_LABELS[event.event_type] ?? event.event_type, reason: event.reason })),
    ...(detail.canReadAudit ? events.map(event => ({ at: event.occurred_at, label: event.action, reason: event.reason })) : []),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const visible = compact ? entries.slice(0, 3) : entries;
  return <div className="ic-processing-history">
    {!entries.length && <p className="muted">لا أحداث معالجة أو تصحيحات متاحة ضمن نطاقك.</p>}
    {!!visible.length && <ol className="ic-timeline">{visible.map((entry, i) => <li key={i}><strong>{entry.label}</strong><time>{fmtDateTime(entry.at)}</time>{entry.reason && <p>{entry.reason}</p>}</li>)}</ol>}
    {compact && entries.length > 3 && <p className="muted">{entries.length - 3} أحداث إضافية متاحة في التفاصيل.</p>}
    {!detail.canReadAudit && <p className="ic-scope-note">سجل التدقيق يتطلب صلاحية قراءة سجل الإجراءات.</p>}
  </div>;
}
