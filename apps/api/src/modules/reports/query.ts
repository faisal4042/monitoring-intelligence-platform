/**
 * Report request → validated plan → parameterized SQL. Values are always bound parameters; expressions come
 * only from definitions.ts. Period boundaries use the shared Asia/Riyadh date-range parser.
 * Streaming reads run in one REPEATABLE READ READ ONLY transaction (a single consistent snapshot) through a
 * server-side cursor, so memory stays bounded whatever the row count. Reads never take the fencing lease.
 */
import {z} from 'zod';
import {sql} from '@mip/db';
import {dateBoundsFromQuery} from '../../lib/date-range.js';
import {ticketScope, ticketsActivated} from '../tickets/service.js';
import type {Actor} from '../tickets/state-machine.js';
import {reportType, type FilterKey, type ReportColumn, type ReportType} from './definitions.js';
import {reportOrderBy} from './order.js';

const ids = z.array(z.string().max(80)).max(200).optional();
export const reportRequestSchema = z.object({
  type: z.string().max(40),
  period: z.object({range: z.string().max(20).optional(), from: z.string().max(10).optional(), to: z.string().max(10).optional()}).strict(),
  filters: z.object({program: ids, channel: ids, status: ids, assignee: ids, intent: ids, sentiment: ids, topic: ids, section: ids, review: z.boolean().optional()}).strict().default({}),
  columns: z.array(z.string().max(60)).min(1).max(80),
  headerLang: z.enum(['ar', 'en']).default('ar'),
}).strict();
export type ReportRequest = z.infer<typeof reportRequestSchema>;

export class ReportError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }

export interface ReportPlan { def: ReportType; columns: ReportColumn[]; from: string; to: string; request: ReportRequest; actor: Actor }

export const columnAllowed = (c: ReportColumn, actor: Actor) => !c.requires || actor.perms.has(c.requires);
export function typeAllowed(def: ReportType, actor: Actor) {
  return actor.perms.has('reports:read') && def.dataPermissions.some((p) => actor.perms.has(p));
}

export async function planReport(actor: Actor, request: ReportRequest): Promise<ReportPlan> {
  const def = reportType(request.type);
  if (!def) throw new ReportError(400, 'UNKNOWN_REPORT', 'نوع تقرير غير معروف');
  if (!typeAllowed(def, actor)) throw new ReportError(403, 'REPORT_FORBIDDEN', 'لا تملك صلاحية بيانات هذا التقرير');
  if (def.needs === 'tickets' && !(await ticketsActivated())) throw new ReportError(503, 'TICKETS_NOT_ACTIVATED', 'تقارير التذاكر تتطلب تفعيل نظام التذاكر (الترحيل 0047)');
  const seen = new Set<string>();
  const columns = request.columns.map((key) => {
    if (seen.has(key)) throw new ReportError(400, 'DUPLICATE_COLUMN', `العمود مكرر: ${key}`);
    seen.add(key);
    const col = def.columns.find((c) => c.key === key);
    if (!col) throw new ReportError(400, 'UNKNOWN_COLUMN', `عمود غير معروف لهذا التقرير: ${key}`);
    if (!columnAllowed(col, actor)) throw new ReportError(403, 'COLUMN_FORBIDDEN', `لا تملك صلاحية العمود: ${col.ar}`);
    return col;
  });
  for (const [k, v] of Object.entries(request.filters)) {
    if (v === undefined || (Array.isArray(v) && !v.length) || v === false) continue;
    if (!def.filters[k as FilterKey]) throw new ReportError(400, 'FILTER_UNSUPPORTED', `الفلتر غير مدعوم لهذا التقرير: ${k}`);
  }
  let bounds;
  try { bounds = dateBoundsFromQuery(request.period); } catch (e) { throw new ReportError(400, 'INVALID_DATE_RANGE', (e as Error).message); }
  return {def, columns, from: bounds.from, to: bounds.to, request, actor};
}

function whereClause(plan: ReportPlan) {
  const {def, request, actor} = plan;
  const parts = [sql`${sql.unsafe(def.dateExpr)} >= ${plan.from}::timestamptz AND ${sql.unsafe(def.dateExpr)} < ${plan.to}::timestamptz`];
  if (def.ticketScope) parts.push(ticketScope(actor, def.ticketScope));
  for (const [key, expr] of Object.entries(def.filters) as [FilterKey, string][]) {
    const v = request.filters[key];
    if (key === 'review') { if (v === true) parts.push(sql`${sql.unsafe(expr)}`); continue; }
    if (Array.isArray(v) && v.length) parts.push(sql`(${sql.unsafe(expr)})::text = ANY(${v}::text[])`);
  }
  return parts.reduce((acc, p) => sql`${acc} AND ${p}`);
}

export function selectQuery(plan: ReportPlan, opts: {limit?: number} = {}) {
  const {def, columns} = plan;
  const select = columns.map((c, i) => sql`${sql.unsafe(c.expr)} AS ${sql(`c${i}`)}`).reduce((acc, p) => sql`${acc}, ${p}`);
  return sql`SELECT ${select} FROM ${sql.unsafe(def.from)} WHERE ${whereClause(plan)}
    ${def.groupBy ? sql`GROUP BY ${sql.unsafe(def.groupBy)}` : sql``}
    ORDER BY ${sql.unsafe(reportOrderBy(def))} ${opts.limit ? sql`LIMIT ${opts.limit}` : sql``}`;
}

/** Row count of the report (groups for aggregated reports). null when it cannot be estimated within 5s. */
export async function estimateRows(plan: ReportPlan): Promise<number | null> {
  const {def} = plan;
  try {
    return await sql.begin('isolation level repeatable read read only', async (tx) => {
      await tx`SET LOCAL statement_timeout = '5s'`;
      const [r] = def.groupBy
        ? await tx`SELECT count(*)::bigint AS n FROM (SELECT 1 FROM ${sql.unsafe(def.from)} WHERE ${whereClause(plan)} GROUP BY ${sql.unsafe(def.groupBy)}) g`
        : await tx`SELECT count(*)::bigint AS n FROM ${sql.unsafe(def.from)} WHERE ${whereClause(plan)}`;
      return Number(r.n);
    });
  } catch (e) {
    if ((e as {code?: string}).code === '57014') return null;
    throw e;
  }
}

export async function previewRows(plan: ReportPlan, limit = 50) {
  return sql.begin('isolation level repeatable read read only', async (tx) => {
    await tx`SET LOCAL statement_timeout = '15s'`;
    const rows = await tx`${selectQuery(plan, {limit})}`;
    return rows.map((r) => plan.columns.map((_, i) => r[`c${i}`]));
  });
}

/**
 * Streams every row in batches through a server-side cursor inside one read-only snapshot.
 * Resolves only after the LAST onBatch has finished. (The callback form of postgres.js cursor() resolves before the
 * final partial batch's callback completes, which let the export runner close files while rows were still being
 * written — found on real data in the local activation test; the async iterator awaits every batch in order.)
 */
export async function streamRows(plan: ReportPlan, onBatch: (rows: unknown[][]) => Promise<void | 'stop'>, batch = 1000) {
  await sql.begin('isolation level repeatable read read only', async (tx) => {
    await tx`SET LOCAL statement_timeout = '0'`;
    for await (const rows of tx`${selectQuery(plan)}`.cursor(batch)) {
      if ((await onBatch(rows.map((r) => plan.columns.map((_, i) => r[`c${i}`])))) === 'stop') break;
    }
  });
}
