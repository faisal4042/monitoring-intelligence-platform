/**
 * Influencer hub figures. Built on the dashboard's interaction source
 * (dashboard/base.ts `interactions`) with influencersOnly forced on, so a
 * number here and the dashboard's influencer section always agree: posts by
 * an actively tracked account (matched to authors by username, case
 * insensitive), not redacted, not duplicates, published inside the window,
 * with the human review's values replacing the AI's where one exists.
 *
 * Read-only: nothing here writes, and nothing reaches X.
 */
import { analyticsSql as sql } from '@mip/db';
import { interactions, type Fragment } from './dashboard/base.js';
import type { Filters, Window } from './dashboard/filters.js';
import { bucketExpr as trunc, granularityFor } from './dashboard/monitoring.js';
import { MIN_SENTIMENT_SAMPLE } from './dashboard/entities.js';

/**
 * "All periods" resolves to ±infinity, which the analytics pool cannot bind
 * as a timestamptz parameter (postgres.js serialises it through Date). Bound
 * it by the data instead: from the earliest collected post to a day ahead.
 */
export async function finiteWindow(f: Filters): Promise<Filters> {
  const open = (v: string) => v === '-infinity' || v === 'infinity';
  if (!open(f.current.from) && !open(f.current.to)) return f;
  const [{ lo }] = await sql<{ lo: string | null }[]>`SELECT min(posted_at)::text AS lo FROM posts`;
  const from = f.current.from === '-infinity' ? new Date(lo ? Date.parse(lo) : Date.now()).toISOString() : f.current.from;
  const to = f.current.to === 'infinity' ? new Date(Date.now() + 86_400_000).toISOString() : f.current.to;
  return { ...f, current: { from, to } };
}

/** Influencer interactions in a window, each row carrying the tracked account id as `inf_id`. */
const activity = (f: Filters, w: Window) => sql`(SELECT b.*,ti.id AS inf_id FROM ${interactions(f, w)}
    JOIN authors a ON a.id=b.author_id
    JOIN tracked_influencers ti ON lower(ti.username)=lower(a.username) AND ti.is_active) x`;

/** Header KPIs: tracked accounts, accounts active in the window, their posts, and what those posts were linked to. */
export async function overview(f: Filters) {
  const counts = (w: Window) => sql<{ active: number; posts: number; relevant: number; programs: number; topics: number;
      with_program: number; with_topic: number; with_sentiment: number; classified: number }[]>`
    SELECT count(DISTINCT x.inf_id)::int AS active,count(*)::int AS posts,
      count(*) FILTER (WHERE x.relevance='relevant')::int AS relevant,
      count(DISTINCT x.program_id)::int AS programs,
      count(DISTINCT x.topic_id)::int AS topics,
      count(*) FILTER (WHERE x.program_id IS NOT NULL)::int AS with_program,
      count(*) FILTER (WHERE x.topic_id IS NOT NULL)::int AS with_topic,
      count(*) FILTER (WHERE x.sentiment_group IS NOT NULL)::int AS with_sentiment,
      count(*) FILTER (WHERE x.classified)::int AS classified
    FROM ${activity(f, w)}`;
  const [[tracked], [cur], prev] = await Promise.all([
    sql<{ n: number; never_seen: number }[]>`SELECT count(*)::int AS n,
        count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM authors a WHERE lower(a.username)=lower(ti.username)))::int AS never_seen
      FROM tracked_influencers ti WHERE ti.is_active`,
    counts(f.current),
    f.previous ? counts(f.previous) : Promise.resolve(null),
  ]);
  return {
    tracked: tracked.n, neverSeen: tracked.never_seen,
    now: cur, before: prev?.[0] ?? null,
  };
}

/** Everything the analytics tab draws, in one round trip. */
export async function analytics(f: Filters) {
  const g = await granularityFor(f.current);
  const trend = g.from && g.to ? sql<{ bucket: string; posts: number; relevant: number; accounts: number }[]>`
    WITH buckets AS (SELECT generate_series(${trunc(g.unit, sql`${g.from}::timestamptz`)},least(${g.to}::timestamptz,now())-interval '1 millisecond',
        ${'1 ' + g.unit}::interval) AS bucket),
    counts AS (SELECT ${trunc(g.unit, sql`x.posted_at`)} AS bucket,count(*)::int AS posts,
        count(*) FILTER (WHERE x.relevance='relevant')::int AS relevant,count(DISTINCT x.inf_id)::int AS accounts
      FROM ${activity(f, f.current)} GROUP BY 1)
    SELECT bk.bucket,coalesce(c.posts,0) AS posts,coalesce(c.relevant,0) AS relevant,coalesce(c.accounts,0) AS accounts
    FROM buckets bk LEFT JOIN counts c ON c.bucket=bk.bucket ORDER BY bk.bucket LIMIT 800` : Promise.resolve([]);

  const sentimentOf = (col: Fragment) => sql`count(*) FILTER (WHERE ${col}='positive')::int AS positive,
    count(*) FILTER (WHERE ${col}='neutral')::int AS neutral,count(*) FILTER (WHERE ${col}='negative')::int AS negative,
    count(*) FILTER (WHERE ${col} IS NULL)::int AS unclassified`;

  const [items, top, programs, topics, [sentiment]] = await Promise.all([
    trend,
    sql`WITH per AS (SELECT x.inf_id,count(*)::int AS posts,count(*) FILTER (WHERE x.relevance='relevant')::int AS relevant,
          max(x.posted_at) AS last_post_at
        FROM ${activity(f, f.current)} GROUP BY x.inf_id),
      prog AS (SELECT DISTINCT ON (x.inf_id) x.inf_id,x.program_id FROM ${activity(f, f.current)}
        WHERE x.program_id IS NOT NULL GROUP BY x.inf_id,x.program_id ORDER BY x.inf_id,count(*) DESC)
      SELECT per.inf_id AS id,ti.username,a.display_name,a.profile_image_url,a.followers_count,a.is_verified,
        per.posts,per.relevant,per.last_post_at,pr.name_ar AS program_name,pr.color AS program_color
      FROM per JOIN tracked_influencers ti ON ti.id=per.inf_id
      LEFT JOIN LATERAL (SELECT * FROM authors a WHERE lower(a.username)=lower(ti.username) ORDER BY a.updated_at DESC NULLS LAST LIMIT 1) a ON true
      LEFT JOIN prog ON prog.inf_id=per.inf_id LEFT JOIN programs pr ON pr.id=prog.program_id
      ORDER BY per.posts DESC,ti.username LIMIT 10`,
    sql`SELECT x.program_id AS id,p.name_ar,p.color,count(*)::int AS posts,count(DISTINCT x.inf_id)::int AS accounts
      FROM ${activity(f, f.current)} LEFT JOIN programs p ON p.id=x.program_id
      GROUP BY x.program_id,p.name_ar,p.color ORDER BY (x.program_id IS NULL),posts DESC`,
    // Topics belong to a program and names repeat across programs, so the program travels with each row.
    sql`SELECT x.topic_id AS id,t.name_ar AS name,tp.name_ar AS program_name,count(*)::int AS posts,count(DISTINCT x.inf_id)::int AS accounts
      FROM ${activity(f, f.current)} JOIN topics t ON t.id=x.topic_id LEFT JOIN programs tp ON tp.id=t.program_id
      WHERE x.relevance='relevant' GROUP BY x.topic_id,t.name_ar,tp.name_ar ORDER BY posts DESC,t.name_ar LIMIT 10`,
    sql<{ positive: number; neutral: number; negative: number; unclassified: number; relevant: number; with_topic: number }[]>`
      SELECT ${sentimentOf(sql`x.sentiment_group`)},count(*) FILTER (WHERE x.relevance='relevant')::int AS relevant,
        count(*) FILTER (WHERE x.relevance='relevant' AND x.topic_id IS NOT NULL)::int AS with_topic
      FROM ${activity(f, f.current)}`,
  ]);

  const classifiedSentiment = sentiment.positive + sentiment.neutral + sentiment.negative;
  return {
    granularity: g.unit,
    trend: items,
    top,
    programs: programs.filter((p) => p.id !== null),
    unlinkedPosts: programs.find((p) => p.id === null)?.posts ?? 0,
    topics,
    topicSample: { relevant: sentiment.relevant, withTopic: sentiment.with_topic },
    // A distribution is only shown once enough posts carry a sentiment label.
    sentiment: { ...sentiment, sample: classifiedSentiment, reliable: classifiedSentiment >= MIN_SENTIMENT_SAMPLE },
    minSentimentSample: MIN_SENTIMENT_SAMPLE,
  };
}
