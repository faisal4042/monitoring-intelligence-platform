/**
 * Monitoring-team performance and AI review quality. Both are scoped per user
 * from the queue permissions (agent: own work, supervisor: own teams,
 * queue:view_all: everything) and are never cached.
 *
 * Snapshot metrics are the queue's state now; period metrics are events
 * (closures, reviews) inside the window.
 */
import { sql } from '@mip/db';
import { QUEUE, queueScope, resolveScope, type QueueActor } from '../../lib/authz.js';
import { queueStats } from '../queue/stats.js';
import type { Filters, Window } from './filters.js';

const statsWindow = (f: Filters) => f.range.preset === 'all' ? { range: 'all' } : { from: f.current.from, to: f.current.to };

export async function operations(actor: QueueActor, f: Filters) {
  const own = resolveScope(actor.permissions, QUEUE) === 'own';
  const program = f.program?.id ?? null;
  const scoped = sql`(${queueScope(actor)}) AND q.merged_into_id IS NULL AND (q.story_item_id IS NULL OR q.status<>'new')
    AND (${program}::uuid IS NULL OR q.program_id=${program}::uuid)`;
  const [{ warn }] = await sql<{ warn: number }[]>`SELECT coalesce((SELECT value::text::int FROM settings WHERE key='queue.wait_warning_minutes'),60) AS warn`;
  const [snapshot] = await sql<Record<string, number>[]>`SELECT
      count(*) FILTER (WHERE q.status='new')::int AS unassigned,
      -- Legacy in_progress items are open work in a box, like assigned ones.
      count(*) FILTER (WHERE q.status IN ('assigned','in_progress'))::int AS assigned,count(*) FILTER (WHERE q.status='escalated')::int AS escalated,
      count(*) FILTER (WHERE q.status IN ('assigned','in_progress') AND q.assigned_at<now()-make_interval(mins=>${warn}))::int AS overdue
    FROM queue_items q WHERE ${scoped} AND (${!own} OR q.assignee_id=${actor.id}::uuid OR q.status='new')`;
  const stats = await queueStats(actor, { ...statsWindow(f), programId: program ?? undefined });
  // Waiting for assignment, per closed review cycle (entered → assigned).
  const [extra] = await sql<{ avg_wait_assign_min: number | null }[]>`SELECT
      round((avg(extract(epoch FROM r.assigned_at-r.entered_at))/60)::numeric,1)::float AS avg_wait_assign_min
    FROM queue_reviews r JOIN queue_items q ON q.id=r.queue_item_id
    WHERE (${queueScope(actor)}) AND q.merged_into_id IS NULL AND (${program}::uuid IS NULL OR q.program_id=${program}::uuid)
      AND r.reviewed_at>=${stats.range.from}::timestamptz AND r.reviewed_at<${stats.range.to}::timestamptz
      AND (${!own} OR r.reviewer_id=${actor.id}::uuid)`;
  // Open work per employee, inside the same scope as the period figures.
  const open = own ? [] : await sql<{ id: string; open: number }[]>`SELECT q.assignee_id AS id,count(*)::int AS open FROM queue_items q
    WHERE ${scoped} AND q.assignee_id IS NOT NULL AND q.status IN ('assigned','in_progress','escalated') GROUP BY 1`;
  const names = own ? [] : await sql<{ id: string; full_name: string }[]>`SELECT id,full_name FROM users
    WHERE id=ANY(${[...new Set([...open.map((o) => o.id), ...stats.employees.map((e) => e.id as string)])]}::uuid[])`;
  const employees = names.map((u) => {
    const s = stats.employees.find((e) => e.id === u.id);
    return { id: u.id, full_name: u.full_name, open: open.find((o) => o.id === u.id)?.open ?? 0,
      closed_items: s?.closed_items ?? 0, review_cycles: s?.review_cycles ?? 0, corrected: s?.corrected ?? 0,
      avg_assignment_to_close_min: s?.avg_assignment_to_close_min ?? null };
  }).sort((a, b) => b.closed_items - a.closed_items || b.open - a.open || a.full_name.localeCompare(b.full_name));
  return { scope: own ? 'own' : resolveScope(actor.permissions, QUEUE), warnMinutes: warn, snapshot,
    period: { ...stats.totals, avg_wait_assign_min: extra.avg_wait_assign_min }, employees };
}

/** Fields compared between the AI snapshot and the reviewer's values (post reviews only). */
export const AI_FIELDS = [['program', 'program_id'], ['intent', 'intent'], ['topic', 'topic_id'], ['subtopic', 'subtopic_id'], ['sentiment', 'sentiment']] as const;

/**
 * Agreement with human review. Methodology: the latest review of each item
 * reviewed in the window (a reopened item counts once, by its last review);
 * per field, the denominator is the reviews where the AI gave a value.
 * This is agreement with reviewers on the reviewed sample, not model accuracy
 * over all data.
 */
export async function aiQuality(actor: QueueActor, f: Filters) {
  const own = resolveScope(actor.permissions, QUEUE) === 'own';
  const latest = (w: Window) => sql`(SELECT DISTINCT ON (r.queue_item_id) r.*,q.program_id AS item_program_id
    FROM queue_reviews r JOIN queue_items q ON q.id=r.queue_item_id
    WHERE (${queueScope(actor)}) AND q.merged_into_id IS NULL
      AND (${f.program?.id ?? null}::uuid IS NULL OR q.program_id=${f.program?.id ?? null}::uuid)
      AND r.reviewed_at>=${w.from}::timestamptz AND r.reviewed_at<${w.to}::timestamptz
      AND (${!own} OR r.reviewer_id=${actor.id}::uuid)
    ORDER BY r.queue_item_id,r.cycle DESC) lr`;
  const fieldRows = (w: Window) => Promise.all(AI_FIELDS.map(async ([field, key]) => {
    const [row] = await sql<{ sample: number; agreed: number }[]>`SELECT count(*)::int AS sample,
        count(*) FILTER (WHERE NOT (${field}=ANY(lr.corrected_fields)))::int AS agreed
      FROM ${latest(w)} WHERE lr.ai->>'kind'='post' AND lr.ai->>${key} IS NOT NULL`;
    return { field, sample: row.sample, agreed: row.agreed };
  }));
  const [[totals], [cycles], fields, fieldsPrev, byProgram, mostCorrected] = await Promise.all([
    sql<Record<string, number>[]>`SELECT count(*)::int AS reviewed,count(*) FILTER (WHERE lr.outcome='confirmed')::int AS confirmed,
        count(*) FILTER (WHERE lr.outcome='corrected')::int AS corrected,count(*) FILTER (WHERE lr.outcome='irrelevant')::int AS irrelevant,
        count(*) FILTER (WHERE lr.outcome='no_action')::int AS no_action FROM ${latest(f.current)}`,
    sql<{ n: number }[]>`SELECT count(*)::int AS n FROM queue_reviews r JOIN queue_items q ON q.id=r.queue_item_id
      WHERE (${queueScope(actor)}) AND q.merged_into_id IS NULL AND (${f.program?.id ?? null}::uuid IS NULL OR q.program_id=${f.program?.id ?? null}::uuid)
        AND r.reviewed_at>=${f.current.from}::timestamptz AND r.reviewed_at<${f.current.to}::timestamptz AND (${!own} OR r.reviewer_id=${actor.id}::uuid)`,
    fieldRows(f.current), f.previous ? fieldRows(f.previous) : Promise.resolve(null),
    sql`SELECT lr.item_program_id AS id,p.name_ar,p.color,count(*)::int AS reviewed,
        ${sql.unsafe(AI_FIELDS.map(([field, key]) => `count(*) FILTER (WHERE lr.ai->>'kind'='post' AND lr.ai->>'${key}' IS NOT NULL)`).join('+'))} AS comparable,
        ${sql.unsafe(AI_FIELDS.map(([field, key]) => `count(*) FILTER (WHERE lr.ai->>'kind'='post' AND lr.ai->>'${key}' IS NOT NULL AND NOT ('${field}'=ANY(lr.corrected_fields)))`).join('+'))} AS agreed
      FROM ${latest(f.current)} JOIN programs p ON p.id=lr.item_program_id GROUP BY 1,2,3 ORDER BY reviewed DESC`,
    sql`SELECT x.field,x.ai_value,count(*)::int AS corrections,
        coalesce(pr.name_ar,tp.name_ar) AS ai_label
      FROM (SELECT f.field,lr.ai->>f.key AS ai_value FROM ${latest(f.current)}
        CROSS JOIN (VALUES ${sql.unsafe(AI_FIELDS.map(([field, key]) => `('${field}','${key}')`).join(','))}) AS f(field,key)
        WHERE lr.ai->>'kind'='post' AND f.field=ANY(lr.corrected_fields) AND lr.ai->>f.key IS NOT NULL) x
      LEFT JOIN programs pr ON x.field='program' AND pr.id::text=x.ai_value
      LEFT JOIN topics tp ON x.field IN ('topic','subtopic') AND tp.id::text=x.ai_value
      GROUP BY 1,2,4 ORDER BY corrections DESC,x.field LIMIT 10`,
  ]);
  const rate = (agreed: number, sample: number) => sample ? Math.round((agreed / sample) * 1000) / 10 : null;
  const overall = (rows: Array<{ sample: number; agreed: number }> | null) => {
    if (!rows) return null;
    const s = rows.reduce((n, r) => n + r.sample, 0), a = rows.reduce((n, r) => n + r.agreed, 0);
    return { sample: s, agreed: a, rate: rate(a, s) };
  };
  return {
    methodology: 'latest_review_per_item', reviewed: totals.reviewed, cycles: cycles.n,
    outcomes: { confirmed: totals.confirmed, corrected: totals.corrected, irrelevant: totals.irrelevant, no_action: totals.no_action },
    correctionRate: rate(totals.corrected, totals.reviewed),
    overall: overall(fields), overallPrevious: overall(fieldsPrev),
    fields: fields.map((r) => ({ ...r, rate: rate(r.agreed, r.sample) })),
    byProgram: byProgram.map((r) => ({ ...r, rate: rate(r.agreed, r.comparable) })),
    mostCorrected,
  };
}
