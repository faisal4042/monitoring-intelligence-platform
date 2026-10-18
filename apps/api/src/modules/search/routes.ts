/**
 * Advanced search API (/api/v1/search). Read-only over platform data; the
 * only writes are saved-search definitions (and their audit entries).
 *
 * Access is per entity, from the caller's existing permissions:
 *   posts → posts:read · news → news:read · accounts → customers:read
 *   tickets → any queue scope (own/team/all), applied in SQL by queueScope.
 * A tab the caller cannot read is never queried — no rows, no counts.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql as db, analyticsSql } from '@mip/db';
import {
  PERMISSIONS as P, SEARCH_ENTITIES, SEARCH_ENTITY_LABELS, SEARCH_FIELDS, SEARCH_LIMITS, SearchSyntaxError,
  fieldUnavailable, parseSearch, type SearchEntity,
} from '@mip/shared';
import { QUEUE, resolveScope } from '../../lib/authz.js';
import { audit } from '../../lib/audit.js';
import { badRequest, forbidden, HttpError, notFound } from '../../lib/errors.js';
import { dateBoundsFromQuery, rangeMeta } from '../../lib/date-range.js';
import { OPEN_FROM, OPEN_TO } from '../dashboard/filters.js';
import { parse } from '../queue/validation.js';
import { InvalidValue, UnsupportedField, likeContains } from './compile.js';
import { makeContext, searchAnalytics, searchCount, searchPage, SORTS, type SearchContext } from './service.js';

const ANY_SEARCH = [P.POSTS_READ, P.NEWS_READ, P.CUSTOMERS_READ, P.QUEUE_WORK, P.QUEUE_SUPERVISE, P.QUEUE_VIEW_ALL];
const has = (req: FastifyRequest, p: string) => req.user.permissions.includes(p);

/** Which entities this caller may search, with the reason for each one that is closed. */
export function entityAccess(req: FastifyRequest): Record<SearchEntity, { allowed: boolean; reason?: string }> {
  return {
    posts: has(req, P.POSTS_READ) ? { allowed: true } : { allowed: false, reason: 'يتطلب صلاحية عرض المنشورات' },
    news: has(req, P.NEWS_READ) ? { allowed: true } : { allowed: false, reason: 'يتطلب صلاحية عرض الأخبار' },
    accounts: has(req, P.CUSTOMERS_READ) ? { allowed: true } : { allowed: false, reason: 'يتطلب صلاحية عرض سجل العملاء' },
    tickets: resolveScope(req.user.permissions, QUEUE) ? { allowed: true } : { allowed: false, reason: 'يتطلب صلاحية على طابور الرصد' },
  };
}

const period = {
  range: z.string().max(20).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
};
const querySchema = z.object({
  q: z.string().max(SEARCH_LIMITS.maxLength).default(''),
  tab: z.enum(SEARCH_ENTITIES as [SearchEntity, ...SearchEntity[]]),
  ...period,
  sort: z.string().max(20).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().refine((n) => [10, 25, 50, 100].includes(n), 'حجم الصفحة: 10 أو 25 أو 50 أو 100').default(25),
  counts: z.boolean().default(true),
}).strict();
const analyticsSchema = z.object({ q: z.string().max(SEARCH_LIMITS.maxLength).default(''), tab: z.enum(['posts', 'news']), ...period }).strict();
const savedBody = z.object({
  name: z.string().trim().min(1).max(120),
  query: z.string().max(SEARCH_LIMITS.maxLength),
  tab: z.enum(SEARCH_ENTITIES as [SearchEntity, ...SearchEntity[]]),
  period: z.object(period).strict().default({}),
  sort: z.string().max(20).nullable().optional(),
  visibility: z.enum(['private', 'shared']).default('private'),
}).strict();
const idParam = z.object({ id: z.string().uuid() }).strict();

/** Parses the query text into an AST; syntax errors become a 400 with the position. */
function parseOr400(q: string) {
  try {
    return parseSearch(q).ast;
  } catch (e) {
    if (e instanceof SearchSyntaxError) throw new HttpError(400, e.message, 'SEARCH_SYNTAX', { position: e.position });
    throw e;
  }
}

/** Period → scan window. "All periods" uses the widest instants the drivers accept, not ±infinity. */
function windowOf(p: { range?: string; from?: string; to?: string }) {
  const dates = dateBoundsFromQuery(p.range || p.from || p.to ? p : { range: 'all' });
  return {
    window: { from: dates.from === '-infinity' ? OPEN_FROM : dates.from, to: dates.to === 'infinity' ? OPEN_TO : dates.to },
    range: rangeMeta(dates.range),
  };
}

/** Names in program:/topic: that matched nothing — reported, never silently ignored. */
function unresolvedWarnings(c: SearchContext) {
  const out: string[] = [];
  for (const [v, ids] of c.resolved.programs) if (!ids.length) out.push(`لا يوجد برنامج باسم «${v}» — الشرط لا يطابق شيئًا`);
  for (const [v, ids] of c.resolved.topics) if (!ids.length) out.push(`لا يوجد موضوع باسم «${v}» — الشرط لا يطابق شيئًا`);
  return out;
}

/** Runs fn for one entity, turning "no such data here" into a structured answer instead of an error. */
async function guarded<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; unsupported: { field: string; reason: string } }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    if (e instanceof UnsupportedField) return { ok: false, unsupported: { field: e.field, reason: e.message } };
    if (e instanceof InvalidValue) throw badRequest(e.message, 'SEARCH_VALUE');
    throw e;
  }
}

async function savedAvailable() {
  const [r] = await db<{ ok: boolean }[]>`SELECT to_regclass('public.saved_searches') IS NOT NULL AS ok`;
  return r.ok;
}
const SAVED_MISSING = 'البحث المحفوظ يحتاج تطبيق migration 0043 على قاعدة البيانات (بانتظار الموافقة)';

export default async function searchRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);
  const guard = { preHandler: [app.requirePermission(...ANY_SEARCH)] };

  app.get('/fields', guard, async (req) => {
    const access = entityAccess(req);
    return {
      tabs: SEARCH_ENTITIES.map((key) => ({ key, label: SEARCH_ENTITY_LABELS[key], ...access[key], sorts: SORTS[key] })),
      fields: SEARCH_FIELDS.map((f) => ({
        name: f.name, aliases: f.aliases ?? [], kind: f.kind, label: f.label, example: f.example, group: f.group,
        values: f.values ? Object.keys(f.values) : null,
        availability: Object.fromEntries(SEARCH_ENTITIES.map((e) => [e, fieldUnavailable(f, e)])),
      })),
      limits: SEARCH_LIMITS,
      saved: (await savedAvailable()) ? { available: true } : { available: false, reason: SAVED_MISSING },
    };
  });

  app.post('/query', guard, async (req) => {
    const body = parse(querySchema, req.body);
    const access = entityAccess(req);
    if (!access[body.tab].allowed) throw forbidden(access[body.tab].reason);
    const ast = parseOr400(body.q);
    const { window, range } = windowOf(body);
    const c = await makeContext(ast, window, { id: req.user.id, permissions: req.user.permissions });
    const started = Date.now();
    const page = await guarded(() => searchPage(body.tab, c, { sort: body.sort ?? '', page: body.page, pageSize: body.pageSize }));
    // Badges for the other tabs: only tabs the caller can read; unsupported → null with the reason.
    const counts: Record<string, { total: number | null; reason?: string }> = {};
    if (body.counts) {
      await Promise.all(SEARCH_ENTITIES.filter((e) => e !== body.tab).map(async (e) => {
        if (!access[e].allowed) { counts[e] = { total: null, reason: access[e].reason }; return; }
        const r = await guarded(() => searchCount(e, c)).catch(() => ({ ok: false as const, unsupported: { field: '', reason: 'تعذر العد' } }));
        counts[e] = r.ok ? { total: r.value } : { total: null, reason: r.unsupported.reason };
      }));
    }
    const base = { tab: body.tab, page: body.page, pageSize: body.pageSize, range, warnings: unresolvedWarnings(c), counts, tookMs: 0 };
    if (!page.ok) return { ...base, items: [], total: null, sort: null, unsupported: page.unsupported, tookMs: Date.now() - started };
    counts[body.tab] = { total: page.value.total };
    return { ...base, items: page.value.items, total: page.value.total, sort: page.value.sort, highlight: page.value.needles, tookMs: Date.now() - started };
  });

  app.post('/analytics', guard, async (req) => {
    const body = parse(analyticsSchema, req.body);
    const access = entityAccess(req);
    if (!access[body.tab].allowed) throw forbidden(access[body.tab].reason);
    const ast = parseOr400(body.q);
    const { window, range } = windowOf(body);
    const c = await makeContext(ast, window, { id: req.user.id, permissions: req.user.permissions });
    const r = await guarded(() => searchAnalytics(body.tab, c));
    return r.ok ? { range, warnings: unresolvedWarnings(c), ...r.value } : { range, unsupported: r.unsupported };
  });

  /** Value suggestions for a field, limited to data the caller may read. */
  app.get('/suggestions', guard, async (req) => {
    const q = parse(z.object({ field: z.string().max(30), prefix: z.string().max(60).default('') }).strict(), req.query);
    const needle = likeContains(q.prefix.trim().replace(/^[@#]/, '').toLowerCase());
    const normNeedle = q.prefix.trim() ? `%${q.prefix.trim().replace(/[\\%_]/g, '')}%` : '%';
    const items = async () => {
      switch (q.field) {
        case 'program': return analyticsSql`SELECT key AS value, name_ar AS label FROM programs WHERE deleted_at IS NULL
          AND (lower(key) LIKE ${needle} OR name_ar ILIKE ${normNeedle}) ORDER BY is_active DESC, name_ar LIMIT 10`;
        case 'topic':
          if (!has(req, P.POSTS_READ) && !has(req, P.NEWS_READ) && !has(req, P.TOPICS_READ)) return [];
          return analyticsSql`SELECT replace(t.name_ar,' ','_') AS value, t.name_ar || coalesce(' — ' || p.name_ar, '') AS label FROM topics t
            LEFT JOIN programs p ON p.id = t.program_id WHERE t.is_active AND t.name_ar ILIKE ${normNeedle} ORDER BY t.post_count DESC NULLS LAST LIMIT 10`;
        case 'source':
          if (!has(req, P.NEWS_READ)) return [];
          return analyticsSql`SELECT name_ar AS value, name_ar || coalesce(' (' || name_en || ')', '') AS label FROM news_sources
            WHERE name_ar ILIKE ${normNeedle} OR lower(coalesce(name_en,'')) LIKE ${needle} ORDER BY is_active DESC, name_ar LIMIT 10`;
        case 'user': case 'mention':
          if (!has(req, P.POSTS_READ) && !has(req, P.CUSTOMERS_READ)) return [];
          return analyticsSql`SELECT '@' || username AS value, coalesce(display_name, username) AS label FROM authors
            WHERE lower(username) LIKE ${needle} OR display_name ILIKE ${normNeedle} ORDER BY followers_count DESC NULLS LAST LIMIT 10`;
        case 'hashtag':
          if (!has(req, P.POSTS_READ)) return [];
          return analyticsSql`SELECT ltrim(h,'#') AS value, '#' || ltrim(h,'#') AS label FROM (
            SELECT unnest(hashtags) h FROM posts WHERE posted_at > now() - interval '120 days' AND NOT is_redacted) x
            WHERE lower(h) LIKE ${needle} GROUP BY 1, 2 ORDER BY count(*) DESC LIMIT 10`;
        case 'action_by':
          if (!has(req, P.QUEUE_SUPERVISE) && !has(req, P.QUEUE_VIEW_ALL) && !has(req, P.USERS_READ)) return [];
          return analyticsSql`SELECT split_part(email,'@',1) AS value, full_name AS label FROM users
            WHERE is_active AND (full_name ILIKE ${normNeedle} OR lower(email) LIKE ${needle}) ORDER BY full_name LIMIT 10`;
        default: {
          const f = SEARCH_FIELDS.find((x) => x.name === q.field);
          return (f?.values ? Object.keys(f.values) : []).filter((v) => v.startsWith(q.prefix.toLowerCase())).map((v) => ({ value: v, label: v }));
        }
      }
    };
    return { field: q.field, items: await items() };
  });

  // ── Saved searches ─────────────────────────────────────────────────────────

  const requireSaved = async () => { if (!(await savedAvailable())) throw new HttpError(409, SAVED_MISSING, 'SAVED_SEARCH_NOT_INSTALLED'); };
  const own = async (req: FastifyRequest, id: string) => {
    const [row] = await db<Record<string, unknown>[]>`SELECT * FROM saved_searches WHERE id = ${id}::uuid AND deleted_at IS NULL`;
    if (!row || (row.owner_id !== req.user.id && row.visibility !== 'shared')) throw notFound('البحث المحفوظ غير موجود');
    return row;
  };

  app.get('/saved', guard, async (req) => {
    await requireSaved();
    return { items: await db`SELECT s.id, s.name, s.query, s.tab, s.period, s.sort, s.visibility, s.last_run_at, s.run_count, s.created_at, s.updated_at,
        s.owner_id = ${req.user.id}::uuid AS is_owner, u.full_name AS owner_name
      FROM saved_searches s JOIN users u ON u.id = s.owner_id
      WHERE s.deleted_at IS NULL AND (s.owner_id = ${req.user.id}::uuid OR s.visibility = 'shared')
      ORDER BY (s.owner_id = ${req.user.id}::uuid) DESC, s.updated_at DESC LIMIT 200` };
  });

  app.post('/saved', guard, async (req, reply) => {
    await requireSaved();
    const body = parse(savedBody, req.body);
    parseOr400(body.query);
    const [row] = await db`INSERT INTO saved_searches (owner_id, name, query, tab, period, sort, visibility)
      VALUES (${req.user.id}::uuid, ${body.name}, ${body.query}, ${body.tab}, ${JSON.stringify(body.period)}::jsonb, ${body.sort ?? null}, ${body.visibility})
      RETURNING id, name, query, tab, period, sort, visibility, created_at`;
    await audit(req, { action: 'saved_search.create', entityType: 'saved_search', entityId: row.id as string, entityLabel: body.name,
      newValue: { query: body.query, tab: body.tab, visibility: body.visibility } });
    reply.code(201);
    return row;
  });

  app.patch('/saved/:id', guard, async (req) => {
    await requireSaved();
    const { id } = parse(idParam, req.params);
    const body = parse(savedBody.partial().strict(), req.body);
    const before = await own(req, id);
    if (before.owner_id !== req.user.id) throw forbidden('يعدّل البحث المحفوظ مالكه فقط');
    if (body.query !== undefined) parseOr400(body.query);
    const [row] = await db`UPDATE saved_searches SET
        name = coalesce(${body.name ?? null}, name), query = coalesce(${body.query ?? null}, query), tab = coalesce(${body.tab ?? null}, tab),
        period = coalesce(${body.period ? JSON.stringify(body.period) : null}::jsonb, period),
        sort = CASE WHEN ${body.sort !== undefined} THEN ${body.sort ?? null} ELSE sort END,
        visibility = coalesce(${body.visibility ?? null}, visibility), updated_at = now()
      WHERE id = ${id}::uuid RETURNING id, name, query, tab, period, sort, visibility, updated_at`;
    await audit(req, { action: body.visibility && body.visibility !== before.visibility ? 'saved_search.share' : 'saved_search.update',
      entityType: 'saved_search', entityId: id, entityLabel: row.name as string,
      oldValue: { name: before.name, query: before.query, visibility: before.visibility }, newValue: { name: row.name, query: row.query, visibility: row.visibility } });
    return row;
  });

  app.delete('/saved/:id', guard, async (req) => {
    await requireSaved();
    const { id } = parse(idParam, req.params);
    const before = await own(req, id);
    if (before.owner_id !== req.user.id) throw forbidden('يحذف البحث المحفوظ مالكه فقط');
    await db`UPDATE saved_searches SET deleted_at = now(), updated_at = now() WHERE id = ${id}::uuid`;
    await audit(req, { action: 'saved_search.delete', entityType: 'saved_search', entityId: id, entityLabel: before.name as string });
    return { ok: true };
  });

  /** Marks a run (last run time + count) and returns the definition to execute with the caller's own permissions. */
  app.post('/saved/:id/run', guard, async (req) => {
    await requireSaved();
    const { id } = parse(idParam, req.params);
    await own(req, id);
    const [row] = await db`UPDATE saved_searches SET last_run_at = now(), run_count = run_count + 1 WHERE id = ${id}::uuid
      RETURNING id, name, query, tab, period, sort, visibility, last_run_at, run_count`;
    return row;
  });
}
