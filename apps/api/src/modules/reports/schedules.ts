/**
 * Scheduled reports (Asia/Riyadh, UTC+3, no DST). A due schedule produces one run per period: the
 * (schedule_id, period_start) unique key deduplicates retries and concurrent executors. A run only CREATES
 * an export in the history; no email, Telegram or other delivery is sent by this framework.
 * Execution ownership: the runner holds the fencing lease like every other writer; SKIP LOCKED keeps two
 * runners from taking the same schedule.
 */
import {sql} from '@mip/db';
import {workerCheckpoint} from '../../startup/worker-ownership.js';
import type {Actor} from '../tickets/state-machine.js';
import {actorFromDb, assertSchedulesEnabled, createExport, schedulesEnabled} from './jobs.js';
import {ReportError} from './query.js';
import {getTemplate, type TemplateDefinition} from './templates.js';

const OFFSET = 3 * 3600_000;
export type Cadence = 'daily' | 'weekly' | 'monthly';
interface ScheduleShape { cadence: Cadence; run_at_local: string; weekday: number | null; monthday: number | null }
/** Riyadh wall clock ↔ UTC instants. */
const toLocal = (d: Date) => new Date(d.getTime() + OFFSET);
const fromLocal = (y: number, m: number, day: number, h = 0, min = 0) => new Date(Date.UTC(y, m, day, h, min) - OFFSET);
const ymd = (d: Date) => toLocal(d).toISOString().slice(0, 10);

/** Next run strictly after `after`. */
export function nextRunAt(s: ScheduleShape, after: Date): Date {
  const [h, m] = s.run_at_local.split(':').map(Number);
  const l = toLocal(after);
  let y = l.getUTCFullYear(), mo = l.getUTCMonth(), d = l.getUTCDate();
  for (let i = 0; i < 400; i++) {
    const candidate = fromLocal(y, mo, d + i, h, m);
    const cl = toLocal(candidate);
    const ok = s.cadence === 'daily' || (s.cadence === 'weekly' && cl.getUTCDay() === s.weekday) || (s.cadence === 'monthly' && cl.getUTCDate() === s.monthday);
    if (ok && candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error('no next run');
}
/** Reporting period that a run at `runAt` covers: previous day / previous 7 days / previous calendar month (Riyadh). */
export function periodFor(s: ScheduleShape, runAt: Date): {start: Date; end: Date} {
  const l = toLocal(runAt);
  const dayStart = fromLocal(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate());
  if (s.cadence === 'daily') return {start: new Date(dayStart.getTime() - 86_400_000), end: dayStart};
  if (s.cadence === 'weekly') return {start: new Date(dayStart.getTime() - 7 * 86_400_000), end: dayStart};
  return {start: fromLocal(l.getUTCFullYear(), l.getUTCMonth() - 1, 1), end: fromLocal(l.getUTCFullYear(), l.getUTCMonth(), 1)};
}

export async function listSchedules(actor: Actor) {
  return sql`SELECT s.*, t.name AS template_name, (SELECT count(*)::int FROM report_schedule_runs r WHERE r.schedule_id = s.id) AS runs,
      (SELECT r.error FROM report_schedule_runs r WHERE r.schedule_id = s.id AND r.status = 'failed' ORDER BY r.created_at DESC LIMIT 1) AS last_error
    FROM report_schedules s JOIN report_templates t ON t.id = s.template_id
    WHERE ${actor.perms.has('reports:manage_templates') ? sql`true` : sql`s.owner_id = ${actor.id}::uuid`} ORDER BY s.created_at DESC`;
}
export async function createSchedule(actor: Actor, input: {templateId: string; name: string; cadence: Cadence; runAtLocal: string; weekday?: number | null; monthday?: number | null; format: string}) {
  if (!actor.perms.has('reports:write') || !actor.perms.has('reports:export')) throw new ReportError(403, 'SCHEDULE_FORBIDDEN', 'الجدولة تتطلب صلاحيتي إدارة جدولة التقارير والتصدير');
  assertSchedulesEnabled();
  await getTemplate(actor, input.templateId);
  const shape: ScheduleShape = {cadence: input.cadence, run_at_local: input.runAtLocal, weekday: input.cadence === 'weekly' ? input.weekday ?? 0 : null,
    monthday: input.cadence === 'monthly' ? input.monthday ?? 1 : null};
  await workerCheckpoint();
  const [row] = await sql`INSERT INTO report_schedules (owner_id, template_id, name, cadence, run_at_local, weekday, monthday, format, next_run_at)
    VALUES (${actor.id}::uuid, ${input.templateId}::uuid, ${input.name.trim()}, ${shape.cadence}, ${shape.run_at_local}, ${shape.weekday}, ${shape.monthday},
      ${input.format}, ${nextRunAt(shape, new Date()).toISOString()}) RETURNING *`;
  return row;
}
export async function setScheduleActive(actor: Actor, id: string, active: boolean) {
  // Deactivating is always allowed (it only reduces work); activating needs schedules enabled.
  if (active) assertSchedulesEnabled();
  await workerCheckpoint();
  const [row] = await sql`UPDATE report_schedules SET is_active = ${active}, updated_at = now(),
      next_run_at = CASE WHEN ${active} THEN greatest(next_run_at, now()) ELSE next_run_at END
    WHERE id = ${id}::uuid AND (owner_id = ${actor.id}::uuid OR ${actor.perms.has('reports:manage_templates')}) RETURNING *`;
  if (!row) throw new ReportError(404, 'SCHEDULE_NOT_FOUND', 'الجدولة غير موجودة');
  return row;
}

/** Runs every due schedule once per period. Returns what happened (for tests and logs). */
export async function runDueSchedules(now = new Date(), limit = 20) {
  const out: Array<{scheduleId: string; periodStart: string; result: 'created' | 'duplicate' | 'failed'; error?: string}> = [];
  if (!schedulesEnabled()) return out;
  for (let i = 0; i < limit; i++) {
    await workerCheckpoint();
    const done = await sql.begin(async (tx) => {
      const [s] = await tx<(ScheduleShape & Record<string, any>)[]>`SELECT * FROM report_schedules WHERE is_active AND next_run_at <= ${now.toISOString()}::timestamptz
        ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 1`;
      if (!s) return null;
      const runAt = new Date(s.next_run_at);
      const period = periodFor(s, runAt);
      const [run] = await tx`INSERT INTO report_schedule_runs (schedule_id, period_start, period_end) VALUES (${s.id}, ${period.start.toISOString()}, ${period.end.toISOString()})
        ON CONFLICT (schedule_id, period_start) DO NOTHING RETURNING id`;
      await tx`UPDATE report_schedules SET next_run_at = ${nextRunAt(s, runAt).toISOString()}, last_run_at = now(), updated_at = now() WHERE id = ${s.id}`;
      return {s, run, period};
    });
    if (!done) break;
    const {s, run, period} = done;
    if (!run) { out.push({scheduleId: s.id, periodStart: period.start.toISOString(), result: 'duplicate'}); continue; }
    try {
      const owner = await actorFromDb(s.owner_id);
      if (!owner) throw new ReportError(403, 'OWNER_INACTIVE', 'صاحب الجدولة غير نشط');
      const [t] = await sql`SELECT * FROM report_templates WHERE id = ${s.template_id} AND deleted_at IS NULL`;
      if (!t) throw new ReportError(404, 'TEMPLATE_NOT_FOUND', 'القالب محذوف');
      const def = t.definition as TemplateDefinition;
      const request = {...def.request, period: {range: 'custom', from: ymd(period.start), to: ymd(new Date(period.end.getTime() - 1))}};
      const e = await createExport(owner, {request, options: {...def.options, format: s.format}, idempotencyKey: `schedule:${run.id}`,
        templateId: t.id, templateVersion: t.version, scheduleRunId: run.id});
      await workerCheckpoint();
      await sql`UPDATE report_schedule_runs SET export_id = ${e.id} WHERE id = ${run.id}`;
      await sql`UPDATE report_schedules SET failure_count = 0 WHERE id = ${s.id}`;
      out.push({scheduleId: s.id, periodStart: period.start.toISOString(), result: 'created'});
    } catch (error) {
      const message = (error as Error).message.slice(0, 500);
      await workerCheckpoint().catch(() => {});
      await sql`UPDATE report_schedule_runs SET status = 'failed', error = ${message} WHERE id = ${run.id}`;
      await sql`UPDATE report_schedules SET failure_count = failure_count + 1, is_active = (failure_count + 1 < 5) WHERE id = ${s.id}`;
      out.push({scheduleId: s.id, periodStart: period.start.toISOString(), result: 'failed', error: message});
    }
  }
  return out;
}
