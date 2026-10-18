/**
 * Advanced search — execution. One statement per request part, each inside a
 * read-only transaction with a statement timeout; bounded page sizes and
 * offsets. Entity access is checked by the caller (routes.ts) before any of
 * this runs, and tickets are additionally filtered by the caller's queue scope
 * in SQL, so neither rows nor counts leak across permissions.
 */
import { analyticsSql as sql } from '@mip/db';
import type { SearchEntity, SearchNode } from '@mip/shared';
import { bucketExpr, granularityFor } from '../dashboard/monitoring.js';
import { interactions, type Fragment } from '../dashboard/base.js';
import { OPEN_FROM, OPEN_TO, type Filters, type Window } from '../dashboard/filters.js';
import { queueScope, type QueueActor } from '../../lib/authz.js';
import { redactRows } from '../../lib/privacy.js';
import {
  compile, DIALECTS, likeContains, newsDate, NEWS_TEXT, postsEngagement, resolveNames, dayStart, dayEnd, type Resolved,
} from './compile.js';
import { HttpError } from '../../lib/errors.js';

export const STATEMENT_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS ?? 8000);
export const MAX_OFFSET = 10_000;

export const SORTS: Record<SearchEntity, string[]> = {
  posts: ['newest', 'oldest', 'relevance', 'engagement', 'followers'],
  news: ['newest', 'oldest', 'relevance'],
  accounts: ['followers', 'recent', 'name'],
  tickets: ['newest', 'oldest', 'updated'],
};

export class SearchTimeout extends HttpError {
  constructor() { super(422, 'البحث استغرق وقتًا أطول من المسموح — ضيّق الفترة أو أضف شروطًا أدق', 'SEARCH_TIMEOUT'); }
}

/** Runs one statement under the search timeout; maps a cancelled statement to a clear 422. */
export async function timed<T>(run: (tx: typeof sql) => Promise<T>): Promise<T> {
  try {
    return await sql.begin('read only', async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = ${Math.max(500, Math.min(STATEMENT_TIMEOUT_MS, 30_000))}`);
      return run(tx as unknown as typeof sql);
    }) as T;
  } catch (e) {
    if ((e as { code?: string }).code === '57014') throw new SearchTimeout();
    throw e;
  }
}

export interface SearchContext {
  ast: SearchNode | null;
  window: Window;            // published/entered window; open sides are OPEN_FROM / OPEN_TO
  actor: QueueActor;
  resolved: Resolved;
}

export async function makeContext(ast: SearchNode | null, window: Window, actor: QueueActor): Promise<SearchContext> {
  return { ast, window: narrowWindow(ast, window), actor, resolved: await resolveNames(ast) };
}

/**
 * Top-level after:/before: also narrow the scan window, so monthly partitions
 * are pruned instead of scanned and filtered. Semantics are unchanged: the
 * same conditions are still in the WHERE clause.
 */
function narrowWindow(ast: SearchNode | null, w: Window): Window {
  const top = !ast ? [] : ast.type === 'and' ? ast.children : [ast];
  let from = w.from; let to = w.to;
  for (const n of top) {
    if (n.type !== 'field') continue;
    if (n.field === 'after' && (from === OPEN_FROM || dayStart(n.value) > from)) from = dayStart(n.value);
    if (n.field === 'before' && (to === OPEN_TO || dayEnd(n.value) < to)) to = dayEnd(n.value);
  }
  return { from, to };
}

const filtersFor = (w: Window): Filters => ({
  program: null, influencersOnly: false, relevantOnly: false, fresh: false,
  range: { preset: 'custom', from: null, to: null, fromDate: null, toDate: null } as Filters['range'],
  current: w, previous: null, key: '',
});

/** FROM clause + WHERE for one entity, with every alias the dialect expects. */
function source(entity: SearchEntity, c: SearchContext, where: Fragment, w: Window = c.window) {
  switch (entity) {
    case 'posts': return sql`FROM ${interactions(filtersFor(w), w)}
      JOIN posts p ON p.id = b.id AND p.posted_at = b.posted_at AND p.posted_at >= ${w.from}::timestamptz AND p.posted_at < ${w.to}::timestamptz
      LEFT JOIN authors a ON a.id = b.author_id
      LEFT JOIN LATERAL (SELECT pm.like_count, pm.repost_count, pm.reply_count, pm.quote_count FROM post_metrics pm
        WHERE pm.post_id = b.id AND pm.posted_at = b.posted_at ORDER BY pm.captured_at DESC LIMIT 1) m ON true
      WHERE ${where}`;
    // OFFSET 0 keeps the subquery from being inlined, so the normalized text is
    // computed once per row (310 ms) instead of once per searched word (1.4 s for 4 words).
    case 'news': return sql`FROM (SELECT n.*, ${NEWS_TEXT} AS nt FROM news_articles n
        WHERE ${newsDate} >= ${w.from}::timestamptz AND ${newsDate} < ${w.to}::timestamptz OFFSET 0) n
      LEFT JOIN news_sources s ON s.id = n.source_id
      WHERE ${where}`;
    case 'accounts': return sql`FROM authors a WHERE ${where}`;
    case 'tickets': return sql`FROM queue_items q
      LEFT JOIN posts p ON q.interaction_type = 'post' AND p.id = q.post_id AND p.posted_at = q.post_posted_at
      LEFT JOIN authors a ON a.id = p.author_id
      LEFT JOIN post_classifications c ON c.post_id = p.id AND c.posted_at = p.posted_at
      LEFT JOIN post_sentiments ps ON ps.post_id = p.id AND ps.posted_at = p.posted_at
      WHERE q.merged_into_id IS NULL AND q.story_item_id IS NULL AND (${queueScope(c.actor)})
        AND q.entered_at >= ${w.from}::timestamptz AND q.entered_at < ${w.to}::timestamptz AND ${where}`;
  }
}

function orderBy(entity: SearchEntity, sort: string, needles: string[]): Fragment {
  const score = needles.length
    ? needles.map((n) => sql`(p.text_normalized LIKE ${likeContains(n)})::int`).reduce((a, b) => sql`${a} + ${b}`)
    : sql`0`;
  switch (entity) {
    case 'posts':
      if (sort === 'oldest') return sql`b.posted_at ASC, b.id`;
      if (sort === 'relevance') return sql`${score} DESC, ${postsEngagement} DESC, b.posted_at DESC, b.id`;
      if (sort === 'engagement') return sql`${postsEngagement} DESC, b.posted_at DESC, b.id`;
      if (sort === 'followers') return sql`a.followers_count DESC NULLS LAST, b.posted_at DESC, b.id`;
      return sql`b.posted_at DESC, b.id`;
    case 'news':
      if (sort === 'oldest') return sql`${newsDate} ASC, n.id`;
      if (sort === 'relevance' && needles.length) {
        const ns = needles.map((n) => sql`(lower(coalesce(n.title,'')) LIKE ${likeContains(n)})::int * 2`).reduce((a, b) => sql`${a} + ${b}`);
        return sql`${ns} DESC, n.is_relevant DESC NULLS LAST, ${newsDate} DESC, n.id`;
      }
      return sql`${newsDate} DESC, n.id`;
    case 'accounts':
      if (sort === 'recent') return sql`a.last_seen_at DESC NULLS LAST, a.id`;
      if (sort === 'name') return sql`lower(coalesce(a.display_name, a.username)), a.id`;
      return sql`a.followers_count DESC NULLS LAST, a.id`;
    case 'tickets':
      if (sort === 'oldest') return sql`q.entered_at ASC, q.id`;
      if (sort === 'updated') return sql`q.updated_at DESC, q.id`;
      return sql`q.entered_at DESC, q.id`;
  }
}

function columns(entity: SearchEntity, context: SearchContext): Fragment {
  switch (entity) {
    case 'posts': return sql`b.id, p.x_post_id, p.x_author_id, p.text, p.url, b.posted_at, p.collected_at, p.lang, b.status,
      b.relevance, b.intent, b.sentiment, b.human_reviewed, p.has_media, cardinality(p.urls) AS link_count,
      a.username, a.display_name, a.profile_image_url, a.followers_count, a.following_count, a.is_verified, a.description AS author_bio,
      p.matched_keywords, p.filter_reason, p.duplicate_type,
      EXISTS(SELECT 1 FROM tracked_influencers ti WHERE ti.is_active AND lower(ti.username)=lower(a.username)) AS is_influencer,
      (SELECT jsonb_build_object('stage',pc.stage,'reason_ar',pc.reason_ar,'model',pc.model,
        'relevance_confidence',pc.relevance_confidence::float,'human_corrected',pc.human_corrected)
        FROM post_classifications pc WHERE pc.post_id=p.id AND pc.posted_at=p.posted_at) AS card_classification,
      (SELECT jsonb_build_object('queue_id',q.id,'queue_status',q.status,
        'assignee_name',(SELECT u.full_name FROM users u WHERE u.id=q.assignee_id))
        FROM queue_items q WHERE q.post_id=p.id AND q.post_posted_at=p.posted_at
          AND q.merged_into_id IS NULL AND (${queueScope(context.actor)})
        ORDER BY q.entered_at DESC LIMIT 1) AS card_queue,
      coalesce((SELECT jsonb_agg(jsonb_build_object('url',md.url,'previewImageUrl',md.preview_image_url,'type',md.type))
        FROM post_media md WHERE md.post_id=p.id AND md.posted_at=p.posted_at),'[]'::jsonb) AS media,
      (SELECT pr.name_ar FROM programs pr WHERE pr.id = b.program_id) AS program_name,
      (SELECT pr.color FROM programs pr WHERE pr.id = b.program_id) AS program_color,
      (SELECT t.name_ar FROM topics t WHERE t.id = coalesce(b.subtopic_id, b.topic_id)) AS topic_name,
      m.like_count, m.repost_count, m.reply_count, ${postsEngagement} AS engagement`;
    case 'news': return sql`n.id, n.title, n.description, n.url, n.image_url, n.published_at, n.discovered_at, n.language, n.is_relevant,
      coalesce(s.name_ar, n.publisher_name) AS source_name, s.country,
      (SELECT pr.name_ar FROM programs pr WHERE pr.id = n.program_id) AS program_name,
      (SELECT pr.color FROM programs pr WHERE pr.id = n.program_id) AS program_color,
      (SELECT t.name_ar FROM topics t WHERE t.id = n.topic_id) AS topic_name`;
    case 'accounts': return sql`a.id, a.x_author_id, a.username, a.display_name, a.profile_image_url, a.description, a.followers_count,
      a.is_verified, a.first_seen_at, a.last_seen_at,
      EXISTS (SELECT 1 FROM tracked_influencers ti WHERE ti.is_active AND lower(ti.username) = lower(a.username)) AS is_influencer`;
    case 'tickets': return sql`q.id, q.status, q.priority, q.section, q.interaction_type, q.entered_at, q.updated_at, q.completed_at,
      q.program_snapshot->>'name' AS program_name, q.program_snapshot->>'color' AS program_color, q.story_snapshot->>'title_ar' AS story_title,
      p.text, p.url, p.posted_at, a.username, a.display_name,
      (SELECT u.full_name FROM users u WHERE u.id = q.assignee_id) AS assignee_name,
      (SELECT tm.name FROM teams tm WHERE tm.id = q.team_id) AS team_name`;
  }
}

/** One page of results plus the exact total for the same conditions. */
export async function searchPage(entity: SearchEntity, c: SearchContext, opts: { sort: string; page: number; pageSize: number }) {
  const { where, needles } = compile(c.ast, DIALECTS[entity], c.resolved);
  const offset = (opts.page - 1) * opts.pageSize;
  if (offset > MAX_OFFSET) throw new HttpError(400, `لا يمكن تجاوز ${MAX_OFFSET} نتيجة بالترقيم — ضيّق البحث`, 'SEARCH_OFFSET');
  const sort = SORTS[entity].includes(opts.sort) ? opts.sort : SORTS[entity][0];
  const [items, [{ total }]] = await Promise.all([
    timed((tx) => tx`SELECT ${columns(entity, c)} ${source(entity, c, where)}
      ORDER BY ${orderBy(entity, sort, needles)} LIMIT ${opts.pageSize} OFFSET ${offset}`),
    timed((tx) => tx<{ total: number }[]>`SELECT count(*)::int AS total ${source(entity, c, where)}`),
  ]);
  let rows = [...items] as Record<string, unknown>[];
  if (entity === 'posts') rows = rows.map(({ card_classification, card_queue, ...row }) => ({
    ...row,
    ...(card_classification as Record<string, unknown> ?? { stage: null }),
    ...(card_queue as Record<string, unknown> ?? { queue_id: null, queue_status: null, assignee_name: null }),
    human_corrected: Boolean(row.human_reviewed || (card_classification as Record<string, unknown> | null)?.human_corrected),
  }));
  if (entity === 'accounts' && rows.length) {
    // Post counts for the page only — never a scan over every author.
    const counts = await timed((tx) => tx<{ author_id: string; n: number }[]>`SELECT author_id, count(*)::int AS n FROM posts
      WHERE author_id = ANY(${sql.array(rows.map((r) => r.id as string))}::uuid[]) AND status <> 'duplicate' AND NOT is_redacted GROUP BY 1`);
    const by = new Map(counts.map((r) => [r.author_id, r.n]));
    rows = rows.map((r) => ({ ...r, post_count: by.get(r.id as string) ?? 0 }));
  }
  if (entity === 'posts' || entity === 'tickets') rows = redactRows(rows);
  return { items: rows, total, sort, needles };
}

/** Exact count only (for the other tabs' badges). */
export async function searchCount(entity: SearchEntity, c: SearchContext) {
  const { where } = compile(c.ast, DIALECTS[entity], c.resolved);
  const [{ total }] = await timed((tx) => tx<{ total: number }[]>`SELECT count(*)::int AS total ${source(entity, c, where)}`);
  return total;
}

// ── Analytics over the same conditions ─────────────────────────────────────

const MIN_SENTIMENT_SAMPLE = 5;

/** The equally long window just before a bounded one, for comparison. */
function previousWindow(w: Window): Window | null {
  if (w.from === OPEN_FROM || w.to === OPEN_TO) return null;
  const from = Date.parse(w.from); const to = Math.min(Date.parse(w.to), Date.now());
  if (!(to > from)) return null;
  return { from: new Date(from - (to - from)).toISOString(), to: new Date(from).toISOString() };
}

export async function searchAnalytics(entity: 'posts' | 'news', c: SearchContext) {
  const { where } = compile(c.ast, DIALECTS[entity], c.resolved);
  const src = source(entity, c, where);
  const dateCol = entity === 'posts' ? sql`b.posted_at` : newsDate;
  // Buckets sized from the window; open windows are sized from the data itself.
  const g = await granularityFor(c.window);
  const prevW = previousWindow(c.window);
  const prevCount = prevW
    ? timed((tx) => tx<{ total: number }[]>`SELECT count(*)::int AS total ${source(entity, { ...c, window: prevW }, where, prevW)}`).then((r) => r[0].total)
    : Promise.resolve(null);
  const trend = g.from && g.to
    ? timed((tx) => tx<{ bucket: string; n: number }[]>`SELECT ${bucketExpr(g.unit, dateCol)} AS bucket, count(*)::int AS n ${src} GROUP BY 1 ORDER BY 1 LIMIT 400`)
    : Promise.resolve([]);

  if (entity === 'news') {
    const [total, series, sources, programs, topics, relevance, previous] = await Promise.all([
      timed((tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n ${src}`).then((r) => r[0].n),
      trend,
      timed((tx) => tx`SELECT coalesce(s.name_ar, n.publisher_name, 'غير معروف') AS name, count(*)::int AS n ${src} GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
      timed((tx) => tx`SELECT pr.name_ar AS name, pr.color, count(*)::int AS n FROM (SELECT n.program_id ${src}) x
        JOIN programs pr ON pr.id = x.program_id GROUP BY pr.name_ar, pr.color ORDER BY 3 DESC LIMIT 8`),
      timed((tx) => tx`SELECT t.name_ar AS name, count(*)::int AS n FROM (SELECT n.topic_id ${src}) x
        JOIN topics t ON t.id = x.topic_id GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
      timed((tx) => tx<{ relevant: number; excluded: number }[]>`SELECT count(*) FILTER (WHERE n.is_relevant)::int AS relevant,
        count(*) FILTER (WHERE n.is_relevant IS NOT TRUE)::int AS excluded ${src}`).then((r) => r[0]),
      prevCount,
    ]);
    return { entity, total, previous, granularity: g.unit, trend: series, sources, programs, topics, relevance };
  }

  const [totals, series, programs, topics, intents, accounts, topPosts, previous] = await Promise.all([
    timed((tx) => tx<Record<string, number>[]>`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE b.sentiment IN ('very_positive','positive'))::int AS positive,
      count(*) FILTER (WHERE b.sentiment = 'neutral')::int AS neutral,
      count(*) FILTER (WHERE b.sentiment IN ('negative','very_negative'))::int AS negative,
      count(*) FILTER (WHERE b.sentiment IS NULL)::int AS unclassified_sentiment,
      count(*) FILTER (WHERE b.relevance = 'relevant')::int AS relevant,
      count(*) FILTER (WHERE NOT b.classified)::int AS unclassified ${src}`).then((r) => r[0]),
    trend,
    timed((tx) => tx`SELECT pr.name_ar AS name, pr.color, count(*)::int AS n FROM (SELECT b.program_id ${src}) x
      JOIN programs pr ON pr.id = x.program_id GROUP BY pr.name_ar, pr.color ORDER BY 3 DESC LIMIT 8`),
    timed((tx) => tx`SELECT t.name_ar AS name, count(*)::int AS n FROM (SELECT coalesce(b.subtopic_id, b.topic_id) AS topic_id ${src}) x
      JOIN topics t ON t.id = x.topic_id GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
    timed((tx) => tx`SELECT b.intent AS key, count(*)::int AS n ${src} AND b.intent IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`),
    timed((tx) => tx`SELECT a.username, a.display_name, a.profile_image_url, a.followers_count, count(*)::int AS n ${src} AND a.username IS NOT NULL
      GROUP BY a.username, a.display_name, a.profile_image_url, a.followers_count ORDER BY 5 DESC, 4 DESC NULLS LAST LIMIT 8`),
    timed((tx) => tx`SELECT b.id, p.text, p.url, b.posted_at, a.username, ${postsEngagement} AS engagement ${src}
      ORDER BY ${postsEngagement} DESC, b.posted_at DESC LIMIT 5`).then((r) => redactRows([...r] as Record<string, unknown>[])),
    prevCount,
  ]);
  const classified = totals.positive + totals.neutral + totals.negative;
  return {
    entity, total: totals.total, previous, granularity: g.unit, trend: series,
    // Unclassified is reported apart from neutral, and the split is withheld below the minimum sample.
    sentiment: { positive: totals.positive, neutral: totals.neutral, negative: totals.negative, unclassified: totals.unclassified_sentiment,
      sample: classified, reliable: classified >= MIN_SENTIMENT_SAMPLE, minSample: MIN_SENTIMENT_SAMPLE },
    relevant: totals.relevant, unclassified: totals.unclassified,
    programs, topics, intents, accounts, topPosts,
  };
}
