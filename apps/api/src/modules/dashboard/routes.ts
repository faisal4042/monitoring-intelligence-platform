/**
 * Unified analytics dashboard: one page, all programs or one. Every route
 * needs posts:read (the dashboard itself) plus the section's own permission;
 * queue figures are additionally scoped in SQL by queueScope. Definitions of
 * every figure: docs/dashboard-metrics.md.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '@mip/db';
import { PERMISSIONS as P } from '@mip/shared';
import { QUEUE, requireScope, resolveScope } from '../../lib/authz.js';
import { badRequest } from '../../lib/errors.js';
import { redactSensitiveText } from '../../lib/privacy.js';
import { parse } from '../queue/validation.js';
import { cached } from './base.js';
import { parseFilters, type Filters } from './filters.js';
import { influencers, news, stories } from './entities.js';
import { insights } from './insights.js';
import { classifications, drillInteractions, granularityFor, hashtags, overview, programs, sentiments, trends } from './monitoring.js';
import { aiQuality, operations } from './operations.js';
import { getPreferences, layoutSchema, resetPreferences, savePreferences } from './preferences.js';

const has = (req: FastifyRequest, p: string) => req.user.permissions.includes(p);
const capabilities = (req: FastifyRequest) => ({
  influencers: has(req, P.INFLUENCERS_READ), stories: has(req, P.TOPICS_READ), news: has(req, P.NEWS_READ),
  queue: resolveScope(req.user.permissions, QUEUE) !== null, queueScope: resolveScope(req.user.permissions, QUEUE),
});
/** Every response carries the resolved window so the page can label it exactly. */
const meta = (f: Filters) => ({ range: f.range, current: f.current, previous: f.previous, program: f.program, generatedAt: new Date().toISOString() });

export default async function dashboardRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);
  const base = app.requirePermission(P.POSTS_READ);
  type Check = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  const guard = (...more: Check[]) => ({ preHandler: [base, ...more] });
  const timed = async <T>(req: FastifyRequest, section: string, run: () => Promise<T>) => {
    const started = Date.now();
    const out = await run();
    req.log.debug({ section, ms: Date.now() - started }, 'dashboard section');
    return out;
  };

  app.get('/meta', guard(), async (req) => {
    const list = await sql`SELECT id,key,name_ar,color FROM programs WHERE deleted_at IS NULL AND is_active ORDER BY name_ar`;
    const [{ now }] = await sql<{ now: string }[]>`SELECT now()::text AS now`;
    return { programs: list, capabilities: capabilities(req), serverNow: new Date(now).toISOString(), timeZone: 'Asia/Riyadh' };
  });

  app.get('/overview', guard(), async (req) => {
    const f = await parseFilters(req.query);
    const can = capabilities(req);
    // Cache key carries the visible-KPI permissions, so no permission sees another's figures.
    const data = await timed(req, 'overview', () => cached(`overview:${can.influencers}:${can.stories}`, f, () => overview(f, can)));
    return { ...meta(f), ...data };
  });
  app.get('/trends', guard(), async (req) => {
    const f = await parseFilters(req.query);
    return { ...meta(f), ...await timed(req, 'trends', () => cached('trends', f, () => trends(f))) };
  });
  app.get('/programs', guard(), async (req) => {
    const f = await parseFilters(req.query);
    const canInf = has(req, P.INFLUENCERS_READ);
    return { ...meta(f), ...await timed(req, 'programs', () => cached(`programs:${canInf}`, f, () => programs(f, canInf))) };
  });
  app.get('/classifications', guard(), async (req) => {
    const f = await parseFilters(req.query);
    return { ...meta(f), ...await timed(req, 'classifications', () => cached('classifications', f, () => classifications(f))) };
  });
  app.get('/sentiments', guard(), async (req) => {
    const f = await parseFilters(req.query);
    const g = await granularityFor(f.current);
    return { ...meta(f), granularity: g.unit, ...await timed(req, 'sentiments', () => cached('sentiments', f, () => sentiments(f, g.unit))) };
  });
  app.get('/hashtags', guard(), async (req) => {
    const f = await parseFilters(req.query);
    return { ...meta(f), ...await timed(req, 'hashtags', () => cached('hashtags', f, () => hashtags(f), 120_000)) };
  });
  app.get('/influencers', guard(app.requirePermission(P.INFLUENCERS_READ)), async (req) => {
    const f = await parseFilters(req.query);
    return { ...meta(f), ...await timed(req, 'influencers', () => cached('influencers', f, () => influencers(f), 120_000)) };
  });
  app.get('/stories', guard(app.requirePermission(P.TOPICS_READ)), async (req) => {
    const f = await parseFilters(req.query);
    return { ...meta(f), ...await timed(req, 'stories', () => cached('stories', f, () => stories(f))) };
  });
  app.get('/news', guard(app.requirePermission(P.NEWS_READ)), async (req) => {
    const f = await parseFilters(req.query);
    return { ...meta(f), ...await timed(req, 'news', () => cached('news', f, () => news(f), 120_000)) };
  });
  // Per-user scope: never cached.
  app.get('/operations', guard(requireScope(QUEUE)), async (req) => {
    const f = await parseFilters(req.query);
    return { ...meta(f), ...await timed(req, 'operations', () => operations(req.user, f)) };
  });
  app.get('/ai-quality', guard(requireScope(QUEUE)), async (req) => {
    const f = await parseFilters(req.query);
    return { ...meta(f), ...await timed(req, 'ai-quality', () => aiQuality(req.user, f)) };
  });
  app.get('/insights', guard(), async (req) => {
    const f = await parseFilters(req.query);
    const can = capabilities(req);
    return { ...meta(f), ...await timed(req, 'insights', () => insights(f, req.user, can)) };
  });

  // Drill-down: the posts behind a clicked figure, with the same filters.
  const drillShape = {
    bucket: z.string().max(40).optional(), unit: z.enum(['hour', 'day', 'week']).optional(),
    programId: z.string().uuid().optional(), unlinked: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
    subtopicId: z.string().uuid().optional(), hashtag: z.string().trim().min(1).max(140).optional(),
    influencerId: z.string().uuid().optional(), storyId: z.string().uuid().optional(),
    series: z.enum(['total', 'relevant', 'complaints', 'inquiries', 'excluded', 'negative']).optional(),
    cursor: z.string().max(400).optional(), limit: z.coerce.number().int().min(1).max(50).default(20),
  };
  app.get('/interactions', guard(), async (req) => {
    const f = await parseFilters(req.query, drillShape) as unknown as Filters & z.infer<z.ZodObject<typeof drillShape>>;
    if (f.influencerId && !has(req, P.INFLUENCERS_READ)) throw badRequest('تتطلب تفاصيل المؤثرين صلاحية عرضهم');
    if (f.storyId) return { ...meta(f), ...await storyMembers(req, f.storyId, f.limit, f.cursor) };
    return { ...meta(f), ...await timed(req, 'interactions', () => drillInteractions(f, f)) };
  });

  // Customisation — the caller's own layout only.
  const scopeQuery = z.object({ program: z.string().trim().max(64).regex(/^[A-Za-z0-9_-]+$/).optional() }).strict();
  const programIdOf = async (key?: string) => {
    if (!key) return null;
    const [row] = await sql<{ id: string }[]>`SELECT id FROM programs WHERE deleted_at IS NULL AND (key=${key} OR id::text=${key})`;
    if (!row) throw badRequest('البرنامج غير موجود', 'UNKNOWN_PROGRAM');
    return row.id;
  };
  app.get('/preferences', guard(), async (req) => {
    const q = parse(scopeQuery, req.query);
    return getPreferences(req.user.id, await programIdOf(q.program));
  });
  app.put('/preferences', guard(), async (req) => {
    const body = parse(z.object({ program: z.string().trim().max(64).regex(/^[A-Za-z0-9_-]+$/).nullable().optional(), layout: layoutSchema }).strict(), req.body);
    return savePreferences(req.user.id, await programIdOf(body.program ?? undefined), body.layout);
  });
  app.delete('/preferences', guard(), async (req) => {
    const q = parse(scopeQuery, req.query);
    return resetPreferences(req.user.id, await programIdOf(q.program));
  });
}

/** Posts of one approved story (any date: a story's posts are its own), redacted, newest first. */
async function storyMembers(req: FastifyRequest, storyId: string, limit: number, cursorRaw?: string) {
  if (!req.user.permissions.includes(P.TOPICS_READ)) throw badRequest('تتطلب تفاصيل القصص صلاحية عرض المواضيع');
  let cursor: { at: string; id: string } | null = null;
  if (cursorRaw) {
    try { cursor = JSON.parse(Buffer.from(cursorRaw, 'base64url').toString()); } catch { throw badRequest('مؤشر الصفحة غير صالح'); }
    if (!cursor || !Number.isFinite(Date.parse(cursor.at)) || !/^[0-9a-f-]{36}$/i.test(cursor.id)) throw badRequest('مؤشر الصفحة غير صالح');
  }
  const [story] = await sql`SELECT id,title_ar,post_count FROM signal_stories WHERE id=${storyId}::uuid AND state<>'candidate'`;
  if (!story) throw badRequest('القصة غير موجودة أو غير معتمدة');
  const [{ total }] = await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM signal_story_members m
    JOIN posts p ON p.id=m.post_id AND p.posted_at=m.posted_at WHERE m.story_id=${storyId}::uuid AND NOT p.is_redacted`;
  const rows = await sql<Array<Record<string, unknown> & { posted_at: Date; id: string }>>`SELECT p.id,p.posted_at,p.text,p.url,c.intent::text AS intent,
      a.username,a.display_name,a.profile_image_url,pr.name_ar AS program_name
    FROM signal_story_members m JOIN posts p ON p.id=m.post_id AND p.posted_at=m.posted_at
    LEFT JOIN post_classifications c ON c.post_id=p.id AND c.posted_at=p.posted_at
    LEFT JOIN authors a ON a.id=p.author_id LEFT JOIN programs pr ON pr.id=c.program_id
    WHERE m.story_id=${storyId}::uuid AND NOT p.is_redacted
      AND (${cursor?.at ?? null}::timestamptz IS NULL OR (p.posted_at,p.id)<(${cursor?.at ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
    ORDER BY p.posted_at DESC,p.id DESC LIMIT ${limit + 1}`;
  const items = rows.slice(0, limit).map((r) => ({ ...r, text: typeof r.text === 'string' ? redactSensitiveText(r.text) : r.text }));
  const last = items.at(-1);
  return { story: { id: story.id, title: story.title_ar, postCount: story.post_count }, total, items,
    nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ at: new Date(last.posted_at).toISOString(), id: last.id })).toString('base64url') : null };
}
