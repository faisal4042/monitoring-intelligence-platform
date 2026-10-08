/**
 * Operational queue metrics, always inside the caller's queue scope.
 *
 * Counting rules:
 *  - "closed items" are distinct items; "review cycles" are completed reviews
 *    (an item reopened and closed again is one item, two cycles).
 *  - A merged story never closes on its own, so a merge adds no credit.
 *  - AI accuracy comes only from human reviews of interactions, per field,
 *    over the reviews where the AI actually gave a value (the sample is
 *    returned with each figure). Closing alone proves nothing about the AI.
 */
import { sql } from '@mip/db';
import { QUEUE, queueScope, resolveScope, type QueueActor } from '../../lib/authz.js';
import { dateBoundsFromQuery } from '../../lib/date-range.js';

interface StatsQuery { range?: string; from?: string; to?: string; section?: string; teamId?: string; employeeId?: string }
const minutes = (expr: ReturnType<typeof sql>) => sql`round((avg(extract(epoch FROM ${expr}))/60)::numeric,1)::float`;
const FIELDS = [['program', 'program_id'], ['intent', 'intent'], ['sentiment', 'sentiment'], ['relevance', 'relevance'], ['topic', 'topic_id'], ['subtopic', 'subtopic_id']] as const;

export async function queueStats(actor: QueueActor, q: StatsQuery) {
  const dates = dateBoundsFromQuery({ range: q.range, from: q.from, to: q.to });
  const own = resolveScope(actor.permissions, QUEUE) === 'own';
  // Items in scope, narrowed by the filters. An agent's own figures only.
  const items = sql`(${queueScope(actor)}) AND q.merged_into_id IS NULL
    AND (${q.section ?? null}::text IS NULL OR q.section=${q.section ?? null})
    AND (${q.teamId ?? null}::uuid IS NULL OR q.team_id=${q.teamId ?? null}::uuid)`;
  const who = own ? actor.id : q.employeeId ?? null;
  const reviews = sql`FROM queue_reviews r JOIN queue_items q ON q.id=r.queue_item_id JOIN users u ON u.id=r.reviewer_id
    WHERE ${items} AND r.reviewed_at>=${dates.from}::timestamptz AND r.reviewed_at<${dates.to}::timestamptz
      AND (${who}::uuid IS NULL OR r.reviewer_id=${who}::uuid)`;

  const [totals] = await sql`SELECT count(*)::int AS review_cycles, count(DISTINCT r.queue_item_id)::int AS closed_items,
      count(*) FILTER (WHERE r.outcome='corrected')::int AS corrected, count(*) FILTER (WHERE r.outcome='irrelevant')::int AS irrelevant,
      count(*) FILTER (WHERE r.outcome='confirmed')::int AS confirmed, count(*) FILTER (WHERE r.outcome='no_action')::int AS no_action,
      ${minutes(sql`r.started_at-r.assigned_at`)} AS avg_assignment_wait_min,
      ${minutes(sql`r.completed_at-r.started_at`)} AS avg_review_handling_min,
      ${minutes(sql`r.completed_at-r.entered_at`)} AS avg_close_tat_min
    ${reviews}`;
  const [flow] = await sql`SELECT
      count(DISTINCT e.queue_item_id) FILTER (WHERE e.event_type IN ('assigned','reassigned','deescalated','transferred'))::int AS assigned_items,
      count(*) FILTER (WHERE e.event_type='reopened')::int AS reopened,
      count(*) FILTER (WHERE e.event_type='reassigned')::int AS reassigned
    FROM queue_events e JOIN queue_items q ON q.id=e.queue_item_id
    WHERE ${items} AND e.created_at>=${dates.from}::timestamptz AND e.created_at<${dates.to}::timestamptz
      AND (${who}::uuid IS NULL OR e.to_assignee=${who}::uuid OR (e.event_type='reopened' AND e.actor_id=${who}::uuid))`;
  const [{ warn }] = await sql<{ warn: number }[]>`SELECT coalesce((SELECT value::text::int FROM settings WHERE key='queue.wait_warning_minutes'),60) AS warn`;
  const [backlog] = await sql`SELECT count(*) FILTER (WHERE q.status<>'completed')::int AS open,
      count(*) FILTER (WHERE q.status='new')::int AS unassigned,
      count(*) FILTER (WHERE q.status='escalated')::int AS escalated,
      -- Waiting longer than the configured visual threshold (not an SLA).
      count(*) FILTER (WHERE (q.status='assigned' AND q.assigned_at<now()-make_interval(mins=>${warn}))
        OR (q.status='in_progress' AND q.started_at<now()-make_interval(mins=>${warn})))::int AS overdue
    FROM queue_items q WHERE ${items} AND (q.story_item_id IS NULL OR q.status<>'new')
      AND (${who}::uuid IS NULL OR q.assignee_id=${who}::uuid OR q.status='new' AND ${!own && !q.employeeId})`;
  // Per field: over interaction reviews where the AI had a value.
  const accuracy = await Promise.all(FIELDS.map(async ([field, key]) => {
    const [row] = await sql`SELECT count(*)::int AS sample,
        count(*) FILTER (WHERE NOT (${field}=ANY(r.corrected_fields)))::int AS agreed ${reviews}
        AND r.ai->>'kind'='post' AND r.ai->>${key} IS NOT NULL`;
    return { field, sample: row.sample, agreed: row.agreed, accuracy: row.sample ? Math.round((row.agreed / row.sample) * 1000) / 10 : null };
  }));
  const employees = own ? [] : await sql`SELECT r.reviewer_id AS id,u.full_name,count(DISTINCT r.queue_item_id)::int AS closed_items,
      count(*)::int AS review_cycles,count(*) FILTER (WHERE r.outcome='corrected')::int AS corrected,
      count(*) FILTER (WHERE r.outcome='irrelevant')::int AS irrelevant,${minutes(sql`r.completed_at-r.started_at`)} AS avg_review_handling_min
    ${reviews} GROUP BY r.reviewer_id,u.full_name ORDER BY closed_items DESC,u.full_name`;
  return { range: { from: dates.from, to: dates.to }, warnMinutes: warn, totals: { ...totals, ...flow }, backlog, accuracy, employees };
}
