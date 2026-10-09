/**
 * Interaction analytics (X posts). Definitions: docs/dashboard-metrics.md.
 *
 * Volume figures (total, excluded) count every collected post in the window;
 * content figures (types, topics, sentiment, hashtags) count relevant posts
 * only, so spam and off-topic noise never shape the analysis.
 */
import { analyticsSql as sql } from '@mip/db';
import { APP_TIME_ZONE } from '@mip/shared';
import { redactSensitiveText } from '../../lib/privacy.js';
import { badRequest } from '../../lib/errors.js';
import { byInfluencer, excluded, hashtagRows, interactions, where, type Fragment } from './base.js';
import { OPEN_FROM, OPEN_TO, type Filters, type Window } from './filters.js';

export interface Kpi { key: string; value: number | null; previous: number | null; available: boolean; reason?: string }
const DAY = 86_400_000;

interface Volume { total: number; relevant: number; excluded: number; unclassified: number; inquiries: number; complaints: number;
  negative: number; sentiment_sample: number; human_reviewed: number; active_influencers: number }
async function volume(f: Filters, w: Window) {
  const [r] = await sql<Volume[]>`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE b.relevance='relevant')::int AS relevant,
      count(*) FILTER (WHERE ${excluded('b')})::int AS excluded,
      count(*) FILTER (WHERE NOT b.classified AND b.status<>'filtered_out')::int AS unclassified,
      count(*) FILTER (WHERE b.relevance='relevant' AND b.intent='inquiry')::int AS inquiries,
      count(*) FILTER (WHERE b.relevance='relevant' AND b.intent='complaint')::int AS complaints,
      count(*) FILTER (WHERE b.relevance='relevant' AND b.sentiment_group='negative')::int AS negative,
      count(*) FILTER (WHERE b.relevance='relevant' AND b.sentiment_group IS NOT NULL)::int AS sentiment_sample,
      count(*) FILTER (WHERE b.human_reviewed)::int AS human_reviewed,
      count(DISTINCT b.author_id) FILTER (WHERE ${byInfluencer('b')})::int AS active_influencers
    FROM ${interactions(f, w)}`;
  const [h] = await sql<{ n: number }[]>`SELECT count(DISTINCT ht.key)::int AS n
    FROM ${hashtagRows(sql`(SELECT * FROM ${interactions(f, w)} WHERE b.relevance='relevant') b`)}`;
  return { ...r, unique_hashtags: h.n };
}

/** Approved stories (state <> candidate) with activity in the window. Not narrowed by interaction filters. */
async function storyCount(f: Filters, w: Window) {
  const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM signal_stories s WHERE s.state<>'candidate'
    AND s.last_seen_at>=${w.from}::timestamptz AND s.last_seen_at<${w.to}::timestamptz
    AND (${f.program?.id ?? null}::uuid IS NULL OR s.program_id=${f.program?.id ?? null}::uuid)`;
  return r.n;
}

export async function overview(f: Filters, can: { influencers: boolean; stories: boolean }) {
  const [cur, prev] = await Promise.all([volume(f, f.current), f.previous ? volume(f, f.previous) : null]);
  const [stories, storiesPrev] = can.stories
    ? await Promise.all([storyCount(f, f.current), f.previous ? storyCount(f, f.previous) : null]) : [null, null];
  const k = (key: string, value: number | null, previous: number | null | undefined, available = true, reason?: string): Kpi =>
    ({ key, value: available ? value : null, previous: available ? previous ?? null : null, available, ...(reason ? { reason } : {}) });
  const kpis: Kpi[] = [
    k('total', cur.total, prev?.total), k('relevant', cur.relevant, prev?.relevant), k('excluded', cur.excluded, prev?.excluded),
    k('inquiries', cur.inquiries, prev?.inquiries), k('complaints', cur.complaints, prev?.complaints),
    k('active_influencers', cur.active_influencers, prev?.active_influencers, can.influencers, 'يتطلب صلاحية عرض المؤثرين'),
    k('approved_stories', stories, storiesPrev, can.stories, 'يتطلب صلاحية عرض المواضيع والقصص'),
    k('unique_hashtags', cur.unique_hashtags, prev?.unique_hashtags),
  ];
  return {
    kpis,
    context: { unclassified: cur.unclassified, humanReviewed: cur.human_reviewed, negative: cur.negative, sentimentSample: cur.sentiment_sample,
      negativePrev: prev?.negative ?? null, sentimentSamplePrev: prev?.sentiment_sample ?? null },
  };
}

/** Bucket size: hourly up to 2 days, daily up to 120 days, otherwise Sunday-based weeks. */
async function granularityFor(w: Window) {
  // Open bounds ("all periods") are sized from the data, never from year 1 to 9999.
  let from = w.from === OPEN_FROM ? NaN : Date.parse(w.from), to = w.to === OPEN_TO ? NaN : Date.parse(w.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    const [r] = await sql<{ lo: string | null; hi: string | null }[]>`SELECT min(posted_at)::text AS lo,max(posted_at)::text AS hi FROM posts
      WHERE posted_at>=${w.from}::timestamptz AND posted_at<${w.to}::timestamptz`;
    if (!r.lo || !r.hi) return { unit: 'day' as const, from: null, to: null };
    from = Number.isFinite(from) ? from : Date.parse(r.lo);
    to = Number.isFinite(to) ? to : Date.parse(r.hi) + 1;
  }
  const span = to - from;
  return { unit: span <= 2 * DAY ? 'hour' as const : span <= 120 * DAY ? 'day' as const : 'week' as const,
    from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}
const trunc = (unit: string, col: Fragment) => unit === 'week'
  ? sql`(date_trunc('week',(${col} AT TIME ZONE ${APP_TIME_ZONE})+interval '1 day')-interval '1 day') AT TIME ZONE ${APP_TIME_ZONE}`
  : sql`date_trunc(${unit},${col},${APP_TIME_ZONE})`;

async function series(f: Filters, w: Window, unit: string, from: string, to: string) {
  return sql<{ bucket: string; total: number; relevant: number; complaints: number; inquiries: number; negative: number }[]>`
    -- Buckets stop at the database's own clock: a running day has no empty future hours.
    WITH buckets AS (SELECT generate_series(${trunc(unit, sql`${from}::timestamptz`)},least(${to}::timestamptz,now())-interval '1 millisecond',
        ${'1 ' + unit}::interval) AS bucket),
    counts AS (SELECT ${trunc(unit, sql`b.posted_at`)} AS bucket,count(*)::int AS total,
        count(*) FILTER (WHERE b.relevance='relevant')::int AS relevant,
        count(*) FILTER (WHERE b.relevance='relevant' AND b.intent='complaint')::int AS complaints,
        count(*) FILTER (WHERE b.relevance='relevant' AND b.intent='inquiry')::int AS inquiries,
        count(*) FILTER (WHERE b.relevance='relevant' AND b.sentiment_group='negative')::int AS negative
      FROM ${interactions(f, w)} GROUP BY 1)
    SELECT bk.bucket,coalesce(c.total,0) AS total,coalesce(c.relevant,0) AS relevant,coalesce(c.complaints,0) AS complaints,
      coalesce(c.inquiries,0) AS inquiries,coalesce(c.negative,0) AS negative
    FROM buckets bk LEFT JOIN counts c ON c.bucket=bk.bucket ORDER BY bk.bucket LIMIT 800`;
}

export async function trends(f: Filters) {
  const g = await granularityFor(f.current);
  if (!g.from || !g.to) return { granularity: g.unit, items: [], previous: [] };
  const items = await series(f, f.current, g.unit, g.from, g.to);
  // The previous window, bucketed the same way and aligned by position.
  const previous = f.previous ? await series(f, f.previous, g.unit, f.previous.from, f.previous.to) : [];
  return { granularity: g.unit, items, previous: previous.slice(0, items.length) };
}

/** Program comparison: every post has at most one program, so program rows never double count a post. */
export async function programs(f: Filters, canInfluencers: boolean) {
  const rows = await sql`WITH b AS (SELECT * FROM ${interactions(f, f.current, { skipProgram: true })}),
    agg AS (SELECT b.program_id,count(*)::int AS posts,count(*) FILTER (WHERE b.relevance='relevant')::int AS relevant,
        count(*) FILTER (WHERE b.relevance='relevant' AND b.intent='complaint')::int AS complaints,
        count(*) FILTER (WHERE b.relevance='relevant' AND b.intent='inquiry')::int AS inquiries,
        count(*) FILTER (WHERE b.relevance='relevant' AND b.sentiment_group='negative')::int AS negative,
        count(*) FILTER (WHERE b.relevance='relevant' AND b.sentiment_group IS NOT NULL)::int AS sentiment_sample,
        count(DISTINCT b.author_id) FILTER (WHERE ${byInfluencer('b')})::int AS active_influencers
      FROM b GROUP BY b.program_id),
    st AS (SELECT s.program_id,count(*)::int AS stories FROM signal_stories s WHERE s.state<>'candidate'
      AND s.last_seen_at>=${f.current.from}::timestamptz AND s.last_seen_at<${f.current.to}::timestamptz GROUP BY 1)
    SELECT p.id,p.key,p.name_ar,p.color,coalesce(a.posts,0) AS posts,coalesce(a.relevant,0) AS relevant,coalesce(a.complaints,0) AS complaints,
      coalesce(a.inquiries,0) AS inquiries,coalesce(a.negative,0) AS negative,coalesce(a.sentiment_sample,0) AS sentiment_sample,
      coalesce(a.active_influencers,0) AS active_influencers,coalesce(st.stories,0) AS stories
    FROM programs p LEFT JOIN agg a ON a.program_id=p.id LEFT JOIN st ON st.program_id=p.id
    WHERE p.deleted_at IS NULL AND (p.is_active OR a.posts>0) ORDER BY coalesce(a.posts,0) DESC,p.name_ar`;
  const [unlinked] = await sql<{ posts: number }[]>`SELECT count(*)::int AS posts FROM ${interactions(f, f.current, { skipProgram: true })} WHERE b.program_id IS NULL`;
  return { items: rows.map((r) => canInfluencers ? r : { ...r, active_influencers: null }), unlinked: unlinked.posts };
}

/** Interaction types and main/sub topics, current vs previous, over relevant posts. */
export async function classifications(f: Filters) {
  const byIntent = (w: Window) => sql<{ intent: string; n: number }[]>`SELECT b.intent,count(*)::int AS n FROM ${interactions(f, w)}
    WHERE b.relevance='relevant' AND b.intent IS NOT NULL GROUP BY 1`;
  const byTopic = (w: Window, col: 'topic_id' | 'subtopic_id') => sql<{ id: string; n: number; complaints: number }[]>`
    SELECT ${sql(col)} AS id,count(*)::int AS n,count(*) FILTER (WHERE b.intent='complaint')::int AS complaints
    FROM ${interactions(f, w)} WHERE b.relevance='relevant' AND ${sql(col)} IS NOT NULL GROUP BY 1`;
  const [intents, intentsPrev, topics, topicsPrev, subs, subsPrev, [base]] = await Promise.all([
    byIntent(f.current), f.previous ? byIntent(f.previous) : [], byTopic(f.current, 'topic_id'), f.previous ? byTopic(f.previous, 'topic_id') : [],
    byTopic(f.current, 'subtopic_id'), f.previous ? byTopic(f.previous, 'subtopic_id') : [],
    sql<{ relevant: number; with_intent: number; with_topic: number }[]>`SELECT count(*)::int AS relevant,
      count(*) FILTER (WHERE b.intent IS NOT NULL)::int AS with_intent,count(*) FILTER (WHERE b.topic_id IS NOT NULL)::int AS with_topic
      FROM ${interactions(f, f.current)} WHERE b.relevance='relevant'`,
  ]);
  const ids = [...new Set([...topics, ...topicsPrev, ...subs, ...subsPrev].map((t) => t.id))];
  type TopicName = { id: string; name_ar: string; parent_id: string | null; program_id: string; is_active: boolean };
  const names: TopicName[] = ids.length ? await sql<{ id: string; name_ar: string; parent_id: string | null; program_id: string; is_active: boolean }[]>`
    SELECT id,name_ar,parent_id,program_id,is_active FROM topics WHERE id=ANY(${ids}::uuid[])` : [];
  const name = (id: string) => names.find((n) => n.id === id);
  const merge = (cur: Array<{ id: string; n: number; complaints: number }>, prev: Array<{ id: string; n: number }>) =>
    cur.map((t) => ({ id: t.id, name: name(t.id)?.name_ar ?? null, parentId: name(t.id)?.parent_id ?? null,
      parentName: name(t.id)?.parent_id ? name(name(t.id)!.parent_id!)?.name_ar ?? null : null,
      count: t.n, previous: f.previous ? prev.find((p) => p.id === t.id)?.n ?? 0 : null, complaints: t.complaints }))
      .filter((t) => t.name).sort((a, b) => b.count - a.count);
  // Parents of subtopics may not appear in the main list; resolve their names too.
  const parentIds = names.filter((n) => n.parent_id && !name(n.parent_id)).map((n) => n.parent_id!);
  if (parentIds.length) names.push(...await sql<TopicName[]>`SELECT id,name_ar,parent_id,program_id,is_active FROM topics WHERE id=ANY(${parentIds}::uuid[])`);
  return {
    sample: base,
    intents: intents.map((i) => ({ intent: i.intent, count: i.n, previous: f.previous ? intentsPrev.find((p) => p.intent === i.intent)?.n ?? 0 : null }))
      .sort((a, b) => b.count - a.count),
    topics: merge(topics, topicsPrev).slice(0, 15),
    subtopics: merge(subs, subsPrev).slice(0, 20),
  };
}

/** Sentiment of relevant posts. Shares are over sentiment-classified posts only; unclassified is counted apart. */
export async function sentiments(f: Filters, granularity: 'hour' | 'day' | 'week') {
  const groups = (w: Window) => sql<{ g: string | null; n: number }[]>`SELECT b.sentiment_group AS g,count(*)::int AS n
    FROM ${interactions(f, w)} WHERE b.relevance='relevant' GROUP BY 1`;
  const [cur, prev, byProgram, byTopic, trend] = await Promise.all([
    groups(f.current), f.previous ? groups(f.previous) : null,
    sql`WITH agg AS (SELECT b.program_id,b.sentiment_group AS g,count(*)::int AS n FROM ${interactions(f, f.current)}
        WHERE b.relevance='relevant' AND b.sentiment_group IS NOT NULL AND b.program_id IS NOT NULL GROUP BY 1,2)
      SELECT agg.program_id AS id,p.name_ar,p.color,agg.g,agg.n FROM agg JOIN programs p ON p.id=agg.program_id`,
    sql`WITH b AS (SELECT * FROM ${interactions(f, f.current)} WHERE b.relevance='relevant' AND b.topic_id IS NOT NULL AND b.sentiment_group IS NOT NULL),
      top AS (SELECT topic_id FROM b GROUP BY 1 ORDER BY count(*) DESC LIMIT 8)
      SELECT x.topic_id AS id,t.name_ar,x.g,x.n FROM (SELECT b.topic_id,b.sentiment_group AS g,count(*)::int AS n FROM b JOIN top USING (topic_id) GROUP BY 1,2) x
        JOIN topics t ON t.id=x.topic_id`,
    sql`SELECT ${trunc(granularity, sql`b.posted_at`)} AS bucket,count(*) FILTER (WHERE b.sentiment_group='negative')::int AS negative,
      count(*) FILTER (WHERE b.sentiment_group IS NOT NULL)::int AS sample FROM ${interactions(f, f.current)}
      WHERE b.relevance='relevant' GROUP BY 1 ORDER BY 1`,
  ]);
  const shape = (rows: Array<{ g: string | null; n: number }> | null) => rows && {
    positive: rows.find((r) => r.g === 'positive')?.n ?? 0, neutral: rows.find((r) => r.g === 'neutral')?.n ?? 0,
    negative: rows.find((r) => r.g === 'negative')?.n ?? 0, unclassified: rows.find((r) => r.g === null)?.n ?? 0,
  };
  return { current: shape(cur)!, previous: shape(prev), byProgram, byTopic, trend };
}

export async function hashtags(f: Filters) {
  const relevant = (w: Window) => sql`(SELECT * FROM ${interactions(f, w)} WHERE b.relevance='relevant') b`;
  const counts = (w: Window) => sql<{ key: string; raw: string; posts: number; complaints: number }[]>`
    SELECT ht.key,mode() WITHIN GROUP (ORDER BY ht.raw) AS raw,count(*)::int AS posts,
      count(*) FILTER (WHERE ht.intent='complaint')::int AS complaints
    FROM ${hashtagRows(relevant(w))} GROUP BY ht.key`;
  const [cur, prev] = await Promise.all([counts(f.current), f.previous ? counts(f.previous) : null]);
  const prevMap = new Map((prev ?? []).map((p) => [p.key, p.posts]));
  const rows = cur.map((h) => ({ key: h.key, tag: h.raw, posts: h.posts, complaints: h.complaints,
    previous: prev ? prevMap.get(h.key) ?? 0 : null, isNew: prev ? !prevMap.has(h.key) : null }));
  const top = [...rows].sort((a, b) => b.posts - a.posts || a.tag.localeCompare(b.tag)).slice(0, 10);
  const byProgram = top.length ? await sql`WITH agg AS (SELECT ht.key,ht.program_id,count(*)::int AS posts FROM ${hashtagRows(relevant(f.current))}
      WHERE ht.key=ANY(${top.map((t) => t.key)}) AND ht.program_id IS NOT NULL GROUP BY 1,2)
    SELECT agg.key,p.id,p.name_ar,p.color,agg.posts FROM agg JOIN programs p ON p.id=agg.program_id` : [];
  return {
    unique: cur.length, uniquePrevious: prev ? prev.length : null,
    usages: cur.reduce((n, h) => n + h.posts, 0),
    // "New" = not used in the previous equal-length window (null without a comparison window).
    newCount: prev ? rows.filter((r) => r.isNew).length : null,
    top, byProgram,
    newTags: rows.filter((r) => r.isNew).sort((a, b) => b.posts - a.posts).slice(0, 8),
    complaintTags: rows.filter((r) => r.complaints > 0).sort((a, b) => b.complaints - a.complaints).slice(0, 8),
  };
}

/**
 * Drill-down: the posts behind one figure, with the same filters plus the
 * clicked dimension. Keyset-paginated, newest first; text is redacted.
 */
export interface Drill {
  bucket?: string; unit?: 'hour' | 'day' | 'week'; programId?: string; unlinked?: boolean; subtopicId?: string;
  hashtag?: string; influencerId?: string; series?: 'total' | 'relevant' | 'complaints' | 'inquiries' | 'excluded' | 'negative';
  cursor?: string; limit: number;
}
export async function drillInteractions(f: Filters, d: Drill) {
  let w = f.current;
  if (d.bucket) {
    const start = Date.parse(d.bucket);
    if (!Number.isFinite(start)) throw badRequest('بداية الفترة غير صالحة');
    const span = d.unit === 'hour' ? 3_600_000 : d.unit === 'week' ? 7 * DAY : DAY;
    w = { from: new Date(Math.max(start, Date.parse(f.current.from) || start)).toISOString(),
      to: new Date(Math.min(start + span, Date.parse(f.current.to) || start + span)).toISOString() };
  }
  let cursor: { at: string; id: string } | null = null;
  if (d.cursor) {
    try { cursor = JSON.parse(Buffer.from(d.cursor, 'base64url').toString()); } catch { throw badRequest('مؤشر الصفحة غير صالح'); }
    if (!cursor || !Number.isFinite(Date.parse(cursor.at)) || !/^[0-9a-f-]{36}$/i.test(cursor.id)) throw badRequest('مؤشر الصفحة غير صالح');
  }
  const series = d.series ?? null;
  const seriesCond = series === 'relevant' ? sql`b.relevance='relevant'` : series === 'excluded' ? excluded('b')
    : series === 'complaints' ? sql`b.relevance='relevant' AND b.intent='complaint'`
    : series === 'inquiries' ? sql`b.relevance='relevant' AND b.intent='inquiry'`
    : series === 'negative' ? sql`b.relevance='relevant' AND b.sentiment_group='negative'` : null;
  const subset = sql`(SELECT b.* FROM ${interactions(f, w, { skipProgram: Boolean(d.programId || d.unlinked) })}
    WHERE true ${where([
      d.programId && sql`b.program_id=${d.programId}::uuid`,
      d.unlinked && sql`b.program_id IS NULL`,
      d.subtopicId && sql`b.subtopic_id=${d.subtopicId}::uuid`,
      seriesCond,
      d.influencerId && sql`b.author_id IN (SELECT da.id FROM authors da JOIN tracked_influencers dti
        ON lower(dti.username)=lower(da.username) WHERE dti.id=${d.influencerId}::uuid)`,
    ])}) b`;
  const source = d.hashtag
    ? sql`(SELECT b.* FROM ${subset} JOIN ${hashtagRows(subset)} ON ht.id=b.id AND ht.posted_at=b.posted_at
        WHERE ht.key=${d.hashtag} AND b.relevance='relevant') b`
    : subset;
  const [{ total }] = await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM ${source}`;
  // The page is cut first; names are joined to those rows only.
  const rows = await sql<Array<Record<string, unknown> & { posted_at: Date; id: string }>>`
    WITH page AS (SELECT b.id,b.posted_at,b.author_id,b.program_id,b.text,b.intent,b.relevance,b.sentiment_group,b.human_reviewed,b.is_reply,b.is_quote
      FROM ${source} WHERE true ${where([cursor && sql`(b.posted_at,b.id)<(${cursor.at}::timestamptz,${cursor.id}::uuid)`])}
      ORDER BY b.posted_at DESC,b.id DESC LIMIT ${d.limit + 1})
    SELECT pg.id,pg.posted_at,pg.text,pg.intent,pg.relevance,pg.sentiment_group,pg.human_reviewed,pg.is_reply,pg.is_quote,
      p.url,a.username,a.display_name,a.profile_image_url,pr.name_ar AS program_name
    FROM page pg JOIN posts p ON p.id=pg.id AND p.posted_at=pg.posted_at
    LEFT JOIN authors a ON a.id=pg.author_id LEFT JOIN programs pr ON pr.id=pg.program_id
    ORDER BY pg.posted_at DESC,pg.id DESC`;
  const items = rows.slice(0, d.limit).map((r) => ({ ...r, text: typeof r.text === 'string' ? redactSensitiveText(r.text) : r.text }));
  const last = items.at(-1);
  return { total, items, window: w,
    nextCursor: rows.length > d.limit && last ? Buffer.from(JSON.stringify({ at: new Date(last.posted_at).toISOString(), id: last.id })).toString('base64url') : null };
}
export { trunc as bucketExpr, granularityFor };
