/**
 * العملاء المؤثرون — accounts tracked by username. Being on this list only
 * adds `from:username` to the automatic query; it never bypasses program
 * keyword matching (docs/PROJECT_PLAN.md scope extension 2026-08-28).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '@mip/db';
import { PERMISSIONS } from '@mip/shared';
import { badRequest, HttpError, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { cached } from './dashboard/base.js';
import { parseFilters } from './dashboard/filters.js';
import { analytics, finiteWindow, overview } from './influencers.analytics.js';
import { CARD_RECENT_DEFAULT, CARD_RECENT_MAX, CARD_SCOPES, cardAccount, cardData } from './influencers.card.js';
import { loadAvatar } from './influencers.avatar.js';
import cardTemplateRoutes from './influencer-cards/routes.js';
import cardExportRoutes from './influencer-cards/exports.js';
import { requireCardAccess } from './influencer-cards/access.js';
import { parse } from './queue/validation.js';

const usernameSchema = z.string().trim().min(1).max(50).transform((v) => v.replace(/^@/, ''));
const addSchema = z.object({
  usernames: z.array(usernameSchema).min(1).max(200),
  notes: z.string().max(500).optional(),
});
const notesSchema = z.object({ notes: z.string().trim().max(500).nullable() }).strict();

/** Only the period filters apply here; influencersOnly is always forced on. */
const periodQuery = z.object({
  range: z.string().max(20).optional(), from: z.string().max(40).optional(), to: z.string().max(40).optional(),
  program: z.string().max(64).optional(), fresh: z.enum(['true', 'false']).optional(),
}).strict();

const ACCOUNT_SORTS = ['period_posts', 'total_posts', 'last_seen_at', 'followers', 'username', 'created_at'] as const;
const accountsQuery = periodQuery.omit({ program: true }).extend({
  q: z.string().trim().max(80).optional(),
  status: z.enum(['all', 'active', 'inactive', 'unseen']).default('all'),
  sort: z.enum(ACCOUNT_SORTS).default('period_posts'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(25),
});
const idParams = z.object({ id: z.string().uuid() }).strict();
/**
 * The card's window and program follow the hub's period filters; `limit` is how many latest posts to return,
 * `scope` whether they are any counted post or relevant ones only.
 */
const cardQuery = periodQuery.extend({
  limit: z.coerce.number().int().min(0).max(CARD_RECENT_MAX).default(CARD_RECENT_DEFAULT),
  scope: z.enum(CARD_SCOPES).default('all'),
});
/** ILIKE treats % and _ as wildcards; a search for a handle like ab_cd must match them literally. */
const likeEscape = (v: string) => v.replace(/[\\%_]/g, (m) => `\\${m}`);

export default async function influencersRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);
  // Card template studio and template resolution (influencer-cards/routes.ts); inherits the hook above.
  await app.register(cardTemplateRoutes, { prefix: '/card-templates' });
  // The card export log (influencer-cards/exports.ts): request → technical outcome → hand-off to the browser.
  await app.register(cardExportRoutes, { prefix: '/card-exports' });

  app.get('/', {
    preHandler: [app.requirePermission(PERMISSIONS.INFLUENCERS_READ)],
  }, async () => ({
    items: await sql`
      SELECT ti.id, ti.username, ti.x_user_id, ti.notes, ti.is_active, ti.created_at,
             a.x_author_id, a.display_name, a.profile_image_url, a.followers_count, a.is_verified,
             a.description AS author_bio,
             (SELECT count(*) FROM posts p WHERE p.x_author_id = a.x_author_id)::int AS post_count,
             (SELECT max(p.posted_at) FROM posts p WHERE p.x_author_id = a.x_author_id) AS last_seen_at
      FROM tracked_influencers ti
      LEFT JOIN authors a ON a.username = ti.username
      WHERE ti.is_active
      ORDER BY ti.created_at DESC`,
  }));

  /**
   * Header KPIs for the influencer hub. Same source and window rules as the
   * dashboard's influencer section, so it needs posts:read as well.
   */
  app.get('/overview', {
    preHandler: [app.requirePermission(PERMISSIONS.INFLUENCERS_READ), app.requirePermission(PERMISSIONS.POSTS_READ)],
  }, async (req) => {
    const f = await finiteWindow(await parseFilters({ ...parse(periodQuery, req.query), influencersOnly: 'true' }));
    const data = await cached('influencers-overview', f, () => overview(f));
    return { range: f.range, current: f.current, previous: f.previous, program: f.program, ...data };
  });

  app.get('/analytics', {
    preHandler: [app.requirePermission(PERMISSIONS.INFLUENCERS_READ), app.requirePermission(PERMISSIONS.POSTS_READ)],
  }, async (req) => {
    const f = await finiteWindow(await parseFilters({ ...parse(periodQuery, req.query), influencersOnly: 'true' }));
    const data = await cached('influencers-analytics', f, () => analytics(f));
    return { range: f.range, current: f.current, program: f.program, ...data };
  });

  /**
   * The managed roster, paged, searched and sorted on the server — the page
   * never loads every account. Post counts use the same rule as the overview
   * (not redacted, not duplicates); `period_posts` is inside the window,
   * `total_posts` / `last_seen_at` are over everything collected.
   */
  app.get('/accounts', {
    preHandler: [app.requirePermission(PERMISSIONS.INFLUENCERS_READ)],
  }, async (req) => {
    const q = parse(accountsQuery, req.query);
    const f = await parseFilters({ range: q.range, from: q.from, to: q.to });
    const search = q.q ? `%${likeEscape(q.q.replace(/^@/, ''))}%` : null;
    // CTEs live in a FROM subquery so one fragment serves both the page and its count.
    const filtered = sql`(
      WITH inf AS (
        SELECT ti.id,a.id AS author_id FROM tracked_influencers ti
        LEFT JOIN LATERAL (SELECT a.id FROM authors a WHERE lower(a.username)=lower(ti.username)
          ORDER BY a.updated_at DESC NULLS LAST LIMIT 1) a ON true
        WHERE ti.is_active),
      per AS (
        SELECT inf.id,
          count(p.id) FILTER (WHERE p.posted_at>=${f.current.from}::timestamptz AND p.posted_at<${f.current.to}::timestamptz)::int AS period_posts,
          count(p.id)::int AS total_posts,max(p.posted_at) AS last_seen_at
        FROM inf LEFT JOIN posts p ON p.author_id=inf.author_id AND NOT p.is_redacted AND p.status<>'duplicate'
        GROUP BY inf.id)
      SELECT ti.id,ti.username,ti.notes,ti.created_at,
        a.x_author_id,a.display_name,a.profile_image_url,a.description AS author_bio,a.followers_count,a.is_verified,
        per.period_posts,per.total_posts,per.last_seen_at
      FROM tracked_influencers ti JOIN inf ON inf.id=ti.id JOIN per ON per.id=ti.id
      LEFT JOIN authors a ON a.id=inf.author_id
      WHERE (${search}::text IS NULL OR ti.username ILIKE ${search} OR a.display_name ILIKE ${search})
        AND (${q.status}::text <> 'active' OR per.period_posts > 0)
        AND (${q.status}::text <> 'inactive' OR (per.period_posts = 0 AND inf.author_id IS NOT NULL))
        AND (${q.status}::text <> 'unseen' OR inf.author_id IS NULL)
    ) acc`;
    const order = {
      period_posts: sql`acc.period_posts`, total_posts: sql`acc.total_posts`, last_seen_at: sql`acc.last_seen_at`,
      followers: sql`acc.followers_count`, username: sql`lower(acc.username)`, created_at: sql`acc.created_at`,
    }[q.sort];
    const dir = q.dir === 'asc' ? sql`ASC` : sql`DESC`;
    const [items, [{ n: total }]] = await Promise.all([
      sql`SELECT acc.* FROM ${filtered} ORDER BY ${order} ${dir} NULLS LAST, lower(acc.username) ASC
        LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
      sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${filtered}`,
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize, range: f.range };
  });

  /**
   * Data for one tracked account's influencer card: profile snapshot, the
   * window's figures (same source and rules as /overview and /analytics) and
   * its latest posts with personal data masked. Needs posts:read like the
   * hub's posts and analytics tabs. Read-only; never reaches X.
   */
  app.get('/:id/card', {
    preHandler: [app.requirePermission(PERMISSIONS.INFLUENCERS_READ), app.requirePermission(PERMISSIONS.POSTS_READ), requireCardAccess('read')],
  }, async (req) => {
    const { id } = parse(idParams, req.params);
    const { limit, scope, ...period } = parse(cardQuery, req.query);
    const account = await cardAccount(id);
    if (!account) throw notFound('الحساب غير موجود في القائمة');
    const f = await finiteWindow(await parseFilters({ ...period, influencersOnly: 'true' }));
    const data = await cardData(f, account, limit, scope);
    const { has_profile_image, ...profile } = account;
    return {
      range: f.range, current: f.current, programFilter: f.program, generatedAt: new Date().toISOString(),
      account: {
        ...profile,
        x_url: `https://x.com/${encodeURIComponent(account.username)}`,
        seen: account.x_author_id !== null,
        avatar: has_profile_image ? `/api/v1/influencers/${id}/avatar` : null,
      },
      ...data,
    };
  });

  /** The account's stored X profile picture through the guarded fetch (influencers.avatar.ts); 404 when unavailable. */
  app.get('/:id/avatar', {
    preHandler: [app.requirePermission(PERMISSIONS.INFLUENCERS_READ), app.requirePermission(PERMISSIONS.POSTS_READ), requireCardAccess('read')],
  }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const [row] = await sql<{ url: string | null }[]>`
      SELECT a.profile_image_url AS url FROM tracked_influencers ti
      LEFT JOIN LATERAL (SELECT a.profile_image_url FROM authors a WHERE lower(a.username)=lower(ti.username)
        ORDER BY a.updated_at DESC NULLS LAST LIMIT 1) a ON true
      WHERE ti.id=${id}::uuid AND ti.is_active`;
    if (!row) throw notFound('الحساب غير موجود في القائمة');
    const image = await loadAvatar(row.url);
    if (!image) throw new HttpError(404, 'صورة الحساب غير متوفرة', 'AVATAR_UNAVAILABLE');
    return reply
      .header('content-type', image.contentType)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'")
      .header('cache-control', 'private, max-age=3600')
      .send(image.body);
  });

  /** Edits the internal note on a tracked account. The username itself is the X handle and is not editable. */
  app.patch('/:id', {
    preHandler: [app.requirePermission(PERMISSIONS.INFLUENCERS_WRITE)],
  }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }).strict(), req.params);
    const { notes } = parse(notesSchema, req.body);
    const [before] = await sql<{ username: string; notes: string | null }[]>`
      SELECT username,notes FROM tracked_influencers WHERE id=${id}::uuid AND is_active`;
    if (!before) throw notFound('الحساب غير موجود في القائمة');
    const [row] = await sql<{ id: string; username: string; notes: string | null }[]>`
      UPDATE tracked_influencers SET notes=${notes || null}, updated_at=now()
      WHERE id=${id}::uuid RETURNING id,username,notes`;
    await audit(req, {
      action: 'influencer.update', entityType: 'influencer', entityId: id, entityLabel: row.username,
      oldValue: { notes: before.notes }, newValue: { notes: row.notes },
    });
    return row;
  });

  /** Accepts one or many usernames at once — pasting a whole watchlist is the common case. */
  app.post('/', {
    preHandler: [app.requirePermission(PERMISSIONS.INFLUENCERS_WRITE)],
  }, async (req) => {
    const parsed = addSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const { usernames, notes } = parsed.data;

    const added: string[] = [];
    for (const username of usernames) {
      const [row] = await sql<{ username: string }[]>`
        INSERT INTO tracked_influencers (username, notes, added_by)
        VALUES (${username}, ${notes ?? null}, ${req.user.id}::uuid)
        ON CONFLICT (username) DO UPDATE SET is_active = true
        RETURNING username`;
      if (row) added.push(row.username);
    }

    await audit(req, {
      action: 'influencer.add', entityType: 'influencer',
      entityLabel: added.length === 1 ? added[0] : `${added.length} حسابات`,
      newValue: { usernames: added },
    });
    return { added };
  });

  app.delete('/:id', {
    preHandler: [app.requirePermission(PERMISSIONS.INFLUENCERS_WRITE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const [row] = await sql<{ username: string }[]>`
      UPDATE tracked_influencers SET is_active = false, updated_at = now()
      WHERE id = ${id}::uuid RETURNING username`;
    if (!row) throw notFound('الحساب غير موجود في القائمة');
    await audit(req, {
      action: 'influencer.remove', entityType: 'influencer', entityLabel: row.username,
    });
    return { ok: true };
  });
}
