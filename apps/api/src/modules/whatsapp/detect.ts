/**
 * Event detection for WhatsApp alerts. Reads the platform's existing records
 * (queue events, ticket events, signal stories, kill switches, news health…)
 * after a per-source cursor and turns them into whatsapp_events. Nothing here
 * writes to those source tables or changes their code paths: if WhatsApp is
 * down, misconfigured or disabled, queue, tickets, Telegram and email behave
 * exactly as before.
 *
 * Idempotent by construction: every event has a dedupe_key (UNIQUE), cursors
 * re-read a short overlap window, and a re-run inserts nothing new.
 * A source seen for the first time starts at "now" — enabling the channel never
 * replays history.
 */
import { sql } from '@mip/db';
import { config } from '@mip/config';
import { whatsappEvent, type WhatsAppEventDef } from '@mip/shared';
import { riyadhStamp } from './policy.js';
import type { SettingsRow } from './settings.js';

export interface DetectedEvent {
  eventType: string;
  dedupeKey: string;
  occurredAt: Date;
  programId: string | null;
  assigneeId: string | null;
  /** Template values. Only internal, non-personal fields (see policy.cleanParam). */
  values: Record<string, string | number | null>;
}

const OVERLAP_SECONDS = 120;
/** The driver may hand timestamps back as text; normalize every one before use. */
const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));
/** Timestamps travel to the driver as ISO text with an explicit ::timestamptz cast. */
const iso = (d: Date) => d.toISOString();
const appUrl = () => config.APP_URL.replace(/\/$/, '');
const label = (key: string) => whatsappEvent(key)?.label ?? key;
const PRIORITY_HIGH = 'مرتفعة';
const PRIORITY_NORMAL = 'عادية';

async function tableExists(name: string): Promise<boolean> {
  const [r] = await sql<{ ok: boolean }[]>`SELECT to_regclass(${'public.' + name}) IS NOT NULL AS ok`;
  return !!r?.ok;
}

/** Cursor for a source; created at now() the first time (no backfill). Returns null on first sight. */
async function cursor(source: string): Promise<Date | null> {
  const [row] = await sql<{ since: Date }[]>`
    SELECT GREATEST(position - (${OVERLAP_SECONDS} || ' seconds')::interval, started_at) AS since FROM whatsapp_source_cursors WHERE source = ${source}`;
  if (row) return toDate(row.since);
  await sql`INSERT INTO whatsapp_source_cursors (source, position, started_at) VALUES (${source}, now(), now()) ON CONFLICT (source) DO NOTHING`;
  return null;
}
async function advance(source: string, to: Date | null): Promise<void> {
  if (!to) return;
  await sql`UPDATE whatsapp_source_cursors SET position = GREATEST(position, ${iso(to)}::timestamptz), updated_at = now() WHERE source = ${source}`;
}
const latest = (dates: Array<Date | string>) => (dates.length ? new Date(Math.max(...dates.map((d) => toDate(d).getTime()))) : null);

type Adapter = (enabled: Set<string>, s: SettingsRow) => Promise<DetectedEvent[]>;

const storyAdapter: Adapter = async (enabled) => {
  if (!enabled.has('issue_new') && !enabled.has('topic_rising')) return [];
  const since = await cursor('signal_stories'); if (!since) return [];
  const rows = await sql<{ id: string; state: string; program_id: string; program: string; topic: string | null; post_count: number; updated_at: Date }[]>`
    SELECT s.id, s.state, s.program_id, pr.name_ar AS program, t.name_ar AS topic, s.post_count, s.updated_at
    FROM signal_stories s JOIN programs pr ON pr.id = s.program_id LEFT JOIN topics t ON t.id = s.topic_id
    WHERE s.updated_at > ${iso(since)}::timestamptz AND s.state IN ('new','rising') ORDER BY s.updated_at LIMIT 200`;
  const out: DetectedEvent[] = [];
  for (const r of rows) {
    const type = r.state === 'new' ? 'issue_new' : 'topic_rising';
    if (!enabled.has(type)) continue;
    out.push({ eventType: type, dedupeKey: `story:${r.id}:${r.state}`, occurredAt: toDate(r.updated_at), programId: r.program_id, assigneeId: null,
      values: { program: r.program, alert_type: label(type), priority: type === 'topic_rising' ? PRIORITY_HIGH : PRIORITY_NORMAL,
        detected_at: riyadhStamp(toDate(r.updated_at)), summary: `${r.topic ?? 'موضوع'} · ${r.post_count} تفاعل`, ticket_number: '—',
        details_url: `${appUrl()}/signals`, count: r.post_count } });
  }
  await advance('signal_stories', latest(rows.map((r) => r.updated_at)));
  return out;
};

const queueEventAdapter: Adapter = async (enabled) => {
  const wanted = ['interaction_assigned', 'ticket_reassigned', 'ticket_escalated', 'ticket_urgent', 'complaint_high_priority'];
  if (!wanted.some((k) => enabled.has(k))) return [];
  const since = await cursor('queue_events'); if (!since) return [];
  const rows = await sql<{ id: string; event_type: string; actor_id: string | null; to_assignee: string | null; to_priority: string | null;
    item_id: string; program_id: string; program: string | null; intent: string | null; ticket_number: string | null; created_at: Date }[]>`
    SELECT e.id, e.event_type, e.actor_id, e.to_assignee, e.metadata->>'to' AS to_priority, q.id AS item_id, q.program_id,
           COALESCE(pr.name_ar, q.program_snapshot->>'name') AS program, c.intent::text AS intent,
           (SELECT t.ticket_number FROM queue_item_tickets qt JOIN tickets t ON t.id = qt.ticket_id WHERE qt.queue_item_id = q.id ORDER BY t.created_at LIMIT 1) AS ticket_number,
           e.created_at
    FROM queue_events e JOIN queue_items q ON q.id = e.queue_item_id
    LEFT JOIN programs pr ON pr.id = q.program_id
    LEFT JOIN post_classifications c ON c.post_id = q.post_id AND c.posted_at = q.post_posted_at
    WHERE e.created_at > ${iso(since)}::timestamptz AND e.event_type IN ('assigned','reassigned','transferred','escalated','priority_changed')
    ORDER BY e.created_at LIMIT 500`;
  const out: DetectedEvent[] = [];
  const base = (r: (typeof rows)[number], type: string, priority: string): DetectedEvent => ({
    eventType: type, dedupeKey: `qe:${r.id}:${type}`, occurredAt: toDate(r.created_at), programId: r.program_id, assigneeId: r.to_assignee,
    values: { program: r.program ?? '—', alert_type: label(type), priority, detected_at: riyadhStamp(toDate(r.created_at)),
      summary: label(type), ticket_number: r.ticket_number ?? '—', details_url: `${appUrl()}/queue?item=${r.item_id}`, count: 1 } });
  for (const r of rows) {
    // A self-claim is not news to the person who claimed it.
    if (r.event_type === 'assigned' && enabled.has('interaction_assigned') && r.to_assignee && r.actor_id !== r.to_assignee)
      out.push(base(r, 'interaction_assigned', PRIORITY_NORMAL));
    if ((r.event_type === 'reassigned' || r.event_type === 'transferred') && enabled.has('ticket_reassigned') && r.to_assignee && r.actor_id !== r.to_assignee)
      out.push(base(r, 'ticket_reassigned', PRIORITY_NORMAL));
    if (r.event_type === 'escalated' && enabled.has('ticket_escalated')) out.push(base(r, 'ticket_escalated', PRIORITY_HIGH));
    if (r.event_type === 'priority_changed' && r.to_priority === 'high') {
      if (enabled.has('ticket_urgent')) out.push(base(r, 'ticket_urgent', PRIORITY_HIGH));
      if (r.intent === 'complaint' && enabled.has('complaint_high_priority')) out.push(base(r, 'complaint_high_priority', PRIORITY_HIGH));
    }
  }
  await advance('queue_events', latest(rows.map((r) => r.created_at)));
  return out;
};

const ticketEventAdapter: Adapter = async (enabled) => {
  const wanted = ['ticket_assigned', 'ticket_reassigned', 'ticket_escalated', 'ticket_urgent', 'followup_action'];
  if (!wanted.some((k) => enabled.has(k)) || !(await tableExists('ticket_events'))) return [];
  const since = await cursor('ticket_events'); if (!since) return [];
  const rows = await sql<{ id: string; event_type: string; actor_id: string | null; assignee_id: string | null; to_priority: string | null;
    ticket_id: string; ticket_number: string; program_id: string | null; program: string | null; current_assignee: string | null; occurred_at: Date }[]>`
    SELECT e.id, e.event_type, e.actor_id, e.assignee_id, COALESCE(e.payload->>'to', e.payload->>'priority') AS to_priority,
           t.id AS ticket_id, t.ticket_number, t.program_id, pr.name_ar AS program, t.assignee_id AS current_assignee, e.occurred_at
    FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id LEFT JOIN programs pr ON pr.id = t.program_id
    WHERE e.occurred_at > ${iso(since)}::timestamptz AND e.event_type IN ('assigned','reassigned','escalated','priority_changed','message_attached','late_message')
    ORDER BY e.occurred_at LIMIT 500`;
  const out: DetectedEvent[] = [];
  const base = (r: (typeof rows)[number], type: string, priority: string, assignee: string | null): DetectedEvent => ({
    eventType: type, dedupeKey: `te:${r.id}:${type}`, occurredAt: toDate(r.occurred_at), programId: r.program_id, assigneeId: assignee,
    values: { program: r.program ?? '—', alert_type: label(type), priority, detected_at: riyadhStamp(toDate(r.occurred_at)),
      summary: label(type), ticket_number: r.ticket_number, details_url: `${appUrl()}/tickets?number=${encodeURIComponent(r.ticket_number)}`, count: 1 } });
  for (const r of rows) {
    if (r.event_type === 'assigned' && enabled.has('ticket_assigned') && r.assignee_id && r.actor_id !== r.assignee_id) out.push(base(r, 'ticket_assigned', PRIORITY_NORMAL, r.assignee_id));
    if (r.event_type === 'reassigned' && enabled.has('ticket_reassigned') && r.assignee_id && r.actor_id !== r.assignee_id) out.push(base(r, 'ticket_reassigned', PRIORITY_NORMAL, r.assignee_id));
    if (r.event_type === 'escalated' && enabled.has('ticket_escalated')) out.push(base(r, 'ticket_escalated', PRIORITY_HIGH, r.current_assignee));
    if (r.event_type === 'priority_changed' && r.to_priority === 'high' && enabled.has('ticket_urgent')) out.push(base(r, 'ticket_urgent', PRIORITY_HIGH, r.current_assignee));
    if ((r.event_type === 'message_attached' || r.event_type === 'late_message') && enabled.has('followup_action') && r.current_assignee)
      out.push(base(r, 'followup_action', PRIORITY_NORMAL, r.current_assignee));
  }
  await advance('ticket_events', latest(rows.map((r) => r.occurred_at)));
  return out;
};

const influencerAdapter: Adapter = async (enabled) => {
  if (!enabled.has('influencer_post')) return [];
  const since = await cursor('queue_alerts'); if (!since) return [];
  const rows = await sql<{ id: string; item_id: string; program_id: string; program: string | null; created_at: Date }[]>`
    SELECT a.id, q.id AS item_id, q.program_id, COALESCE(pr.name_ar, q.program_snapshot->>'name') AS program, a.created_at
    FROM queue_alerts a JOIN queue_items q ON q.id = a.queue_item_id LEFT JOIN programs pr ON pr.id = q.program_id
    WHERE a.created_at > ${iso(since)}::timestamptz AND a.kind = 'influencer' ORDER BY a.created_at LIMIT 200`;
  await advance('queue_alerts', latest(rows.map((r) => r.created_at)));
  return rows.map((r) => ({ eventType: 'influencer_post', dedupeKey: `qa:${r.id}`, occurredAt: toDate(r.created_at), programId: r.program_id, assigneeId: null,
    values: { program: r.program ?? '—', alert_type: label('influencer_post'), priority: PRIORITY_NORMAL, detected_at: riyadhStamp(toDate(r.created_at)),
      summary: 'منشور من حساب مؤثر متابَع', ticket_number: '—', details_url: `${appUrl()}/queue?section=influencer&item=${r.item_id}`, count: 1 } }));
};

const negativeAdapter: Adapter = async (enabled, s) => {
  if (!enabled.has('negative_high_impact')) return [];
  const since = await cursor('negative_posts'); if (!since) return [];
  const rows = await sql<{ id: string; program_id: string | null; program: string | null; followers: number; collected_at: Date }[]>`
    SELECT p.id, c.program_id, pr.name_ar AS program, a.followers_count AS followers, p.collected_at
    FROM posts p
    JOIN post_classifications c ON c.post_id = p.id AND c.posted_at = p.posted_at
    JOIN post_sentiments ps ON ps.post_id = p.id AND ps.posted_at = p.posted_at
    JOIN authors a ON a.id = p.author_id
    LEFT JOIN programs pr ON pr.id = c.program_id
    WHERE p.collected_at > ${iso(since)}::timestamptz AND p.posted_at > ${iso(since)}::timestamptz - interval '7 days'
      AND p.is_redacted = false AND p.status NOT IN ('filtered_out','duplicate')
      AND c.relevance = 'relevant' AND ps.label IN ('negative','very_negative')
      AND COALESCE(a.followers_count, 0) >= ${s.negative_min_followers}
    ORDER BY p.collected_at LIMIT 200`;
  await advance('negative_posts', latest(rows.map((r) => r.collected_at)));
  return rows.map((r) => ({ eventType: 'negative_high_impact', dedupeKey: `neg:${r.id}`, occurredAt: toDate(r.collected_at), programId: r.program_id, assigneeId: null,
    values: { program: r.program ?? '—', alert_type: label('negative_high_impact'), priority: PRIORITY_HIGH, detected_at: riyadhStamp(toDate(r.collected_at)),
      // Reach as a rounded bracket only — never the account itself.
      summary: `منشور سلبي من حساب يتابعه أكثر من ${Math.floor(r.followers / 1000) * 1000} متابع`, ticket_number: '—', details_url: `${appUrl()}/live`, count: 1 } }));
};

const killSwitchAdapter: Adapter = async (enabled) => {
  if (!enabled.has('x_collection_stopped')) return [];
  const since = await cursor('kill_switches'); if (!since) return [];
  const rows = await sql<{ id: string; activated_at: Date }[]>`
    SELECT id, activated_at FROM kill_switches WHERE activated_at > ${iso(since)}::timestamptz AND scope = 'global' ORDER BY activated_at LIMIT 50`;
  await advance('kill_switches', latest(rows.map((r) => r.activated_at)));
  // The stop reason is free text typed by an operator: it stays in the platform, not in WhatsApp.
  return rows.map((r) => ({ eventType: 'x_collection_stopped', dedupeKey: `ks:${r.id}`, occurredAt: toDate(r.activated_at), programId: null, assigneeId: null,
    values: { program: 'كل البرامج', alert_type: label('x_collection_stopped'), priority: PRIORITY_HIGH, detected_at: riyadhStamp(toDate(r.activated_at)),
      summary: 'تم تفعيل الإيقاف العام لجمع بيانات إكس', ticket_number: '—', details_url: `${appUrl()}/cost`, count: 1 } }));
};

const sourceHealthAdapter: Adapter = async (enabled) => {
  if (!enabled.has('source_failed')) return [];
  const since = await cursor('news_source_health'); if (!since) return [];
  const rows = await sql<{ source_id: string; name: string; last_success_at: Date | null; updated_at: Date }[]>`
    SELECT h.source_id, s.name_ar AS name, h.last_success_at, h.updated_at FROM news_source_health h JOIN news_sources s ON s.id = h.source_id
    WHERE h.updated_at > ${iso(since)}::timestamptz AND h.state = 'failed' ORDER BY h.updated_at LIMIT 100`;
  await advance('news_source_health', latest(rows.map((r) => r.updated_at)));
  // One alert per failure streak: the streak is identified by the last success before it.
  return rows.map((r) => ({ eventType: 'source_failed', dedupeKey: `nsh:${r.source_id}:${r.last_success_at ? toDate(r.last_success_at).toISOString() : 'never'}`, occurredAt: toDate(r.updated_at), programId: null, assigneeId: null,
    values: { program: 'رصد الأخبار', alert_type: label('source_failed'), priority: PRIORITY_HIGH, detected_at: riyadhStamp(toDate(r.updated_at)),
      summary: `تعطل المصدر: ${r.name}`, ticket_number: '—', details_url: `${appUrl()}/news/sources`, count: 1 } }));
};

const bucket = (minutes: number, now = new Date()) => new Date(Math.floor(now.getTime() / (minutes * 60_000)) * minutes * 60_000);

const newsJobsAdapter: Adapter = async (enabled, s) => {
  if (!enabled.has('news_jobs_failed')) return [];
  const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM news_fetch_jobs WHERE status = 'failed' AND started_at > now() - interval '1 hour'`;
  if (!r || r.n < s.news_failures_per_hour) return [];
  const hour = bucket(60);
  return [{ eventType: 'news_jobs_failed', dedupeKey: `nfj:${hour.toISOString()}`, occurredAt: new Date(), programId: null, assigneeId: null,
    values: { program: 'رصد الأخبار', alert_type: label('news_jobs_failed'), priority: PRIORITY_HIGH, detected_at: riyadhStamp(new Date()),
      summary: `${r.n} مهمة جلب فاشلة خلال الساعة الأخيرة`, ticket_number: '—', details_url: `${appUrl()}/news/sources`, count: r.n } }];
};

async function warnMinutes(): Promise<number> {
  const [r] = await sql<{ v: number }[]>`SELECT COALESCE((SELECT value::text::int FROM settings WHERE key = 'queue.wait_warning_minutes'), 60) AS v`;
  return r?.v ?? 60;
}

const slaAdapter: Adapter = async (enabled, s) => {
  if (!enabled.has('sla_breached') && !enabled.has('tickets_overdue')) return [];
  const warn = await warnMinutes();
  const out: DetectedEvent[] = [];
  if (enabled.has('sla_breached')) {
    const since = await cursor('sla_breaches');
    if (since) {
      // Breach moment = entered_at + warn. Only breaches that happen after the cursor (never a backlog flood).
      const rows = await sql<{ id: string; program_id: string; program: string | null; breached_at: Date }[]>`
        SELECT q.id, q.program_id, COALESCE(pr.name_ar, q.program_snapshot->>'name') AS program,
               q.entered_at + (${warn} || ' minutes')::interval AS breached_at
        FROM queue_items q LEFT JOIN programs pr ON pr.id = q.program_id
        WHERE q.status = 'new' AND q.entered_at + (${warn} || ' minutes')::interval > ${iso(since)}::timestamptz
          AND q.entered_at + (${warn} || ' minutes')::interval <= now()
        ORDER BY breached_at LIMIT 200`;
      for (const r of rows) out.push({ eventType: 'sla_breached', dedupeKey: `sla:${r.id}`, occurredAt: toDate(r.breached_at), programId: r.program_id, assigneeId: null,
        values: { program: r.program ?? '—', alert_type: label('sla_breached'), priority: PRIORITY_HIGH, detected_at: riyadhStamp(toDate(r.breached_at)),
          summary: `تفاعل بانتظار الإسناد أكثر من ${warn} دقيقة`, ticket_number: '—', details_url: `${appUrl()}/queue?item=${r.id}`, count: 1 } });
      await advance('sla_breaches', latest(rows.map((r) => r.breached_at)));
    }
  }
  if (enabled.has('tickets_overdue')) {
    const [r] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM queue_items WHERE status = 'new' AND entered_at < now() - (${warn} || ' minutes')::interval`;
    if (r && r.n > 0) {
      const b = bucket(s.overdue_digest_minutes);
      out.push({ eventType: 'tickets_overdue', dedupeKey: `overdue:${b.toISOString()}`, occurredAt: new Date(), programId: null, assigneeId: null,
        values: { program: 'كل البرامج', alert_type: label('tickets_overdue'), priority: PRIORITY_HIGH, detected_at: riyadhStamp(new Date()),
          summary: `${r.n} تفاعل متأخر بانتظار الإسناد`, ticket_number: '—', details_url: `${appUrl()}/queue/board`, count: r.n } });
    }
  }
  return out;
};

const quotaAdapter: Adapter = async (enabled, s) => {
  if (!enabled.has('x_quota_near_limit')) return [];
  const rows = await sql<{ period_start: Date; used: number; limit: number }[]>`
    SELECT c.period_start, c.units_used AS used, b.unit_limit AS "limit"
    FROM budget_counters c JOIN api_budgets b ON b.scope = c.scope AND b.period = c.period AND b.is_active AND b.unit_limit IS NOT NULL
    WHERE c.period = 'month' AND c.period_start = date_trunc('month', now()) AND b.unit_limit > 0
      AND c.units_used * 100 >= b.unit_limit * ${s.quota_alert_percent}`;
  return rows.map((r) => ({ eventType: 'x_quota_near_limit', dedupeKey: `quota:${toDate(r.period_start).toISOString()}:${s.quota_alert_percent}`, occurredAt: new Date(), programId: null, assigneeId: null,
    values: { program: 'كل البرامج', alert_type: label('x_quota_near_limit'), priority: PRIORITY_HIGH, detected_at: riyadhStamp(new Date()),
      summary: `الاستهلاك ${Math.round((r.used * 100) / r.limit)}% من الحد الشهري`, ticket_number: '—', details_url: `${appUrl()}/cost`, count: r.used } }));
};

const ADAPTERS: Array<[string, Adapter]> = [
  ['signal_stories', storyAdapter], ['queue_events', queueEventAdapter], ['ticket_events', ticketEventAdapter],
  ['queue_alerts', influencerAdapter], ['negative_posts', negativeAdapter], ['kill_switches', killSwitchAdapter],
  ['news_source_health', sourceHealthAdapter], ['news_fetch_jobs', newsJobsAdapter], ['sla', slaAdapter], ['quota', quotaAdapter],
];

/** Event types an administrator enabled AND the platform can actually produce. */
export async function enabledEventTypes(): Promise<Set<string>> {
  const rows = await sql<{ event_type: string }[]>`SELECT event_type FROM whatsapp_event_settings WHERE enabled`;
  return new Set(rows.map((r) => r.event_type).filter((k) => {
    const def: WhatsAppEventDef | undefined = whatsappEvent(k);
    return !!def && def.availability !== 'unavailable';
  }));
}

/**
 * Runs every adapter. One failing source is logged and skipped; the others still run.
 * Returns the newly recorded events (already de-duplicated).
 */
export async function detectEvents(s: SettingsRow, onError: (source: string, err: unknown) => void): Promise<Array<DetectedEvent & { id: string }>> {
  const enabled = await enabledEventTypes();
  if (!enabled.size) return [];
  const recorded: Array<DetectedEvent & { id: string }> = [];
  for (const [source, adapter] of ADAPTERS) {
    let events: DetectedEvent[] = [];
    try { events = await adapter(enabled, s); } catch (err) { onError(source, err); continue; }
    for (const e of events) {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO whatsapp_events (event_type, dedupe_key, program_id, assignee_id, payload, occurred_at)
        VALUES (${e.eventType}, ${e.dedupeKey}, ${e.programId}::uuid, ${e.assigneeId}::uuid, ${JSON.stringify(e.values)}::jsonb, ${iso(e.occurredAt)}::timestamptz)
        ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`;
      if (row) recorded.push({ ...e, id: row.id });
    }
  }
  return recorded;
}
