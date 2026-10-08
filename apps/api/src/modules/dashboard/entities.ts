/**
 * Influencers, stories and news. Each keeps its own definition and date basis;
 * news is never added to X post totals.
 */
import { analyticsSql as sql } from '@mip/db';
import { interactions } from './base.js';
import type { Filters, Window } from './filters.js';

/** Minimum classified posts before a "dominant sentiment" is shown for an account. */
export const MIN_SENTIMENT_SAMPLE = 5;

/**
 * Tracked accounts (tracked_influencers, active) vs accounts with observed
 * activity: posts in the window that pass the filters. Accounts are matched
 * to authors by username, as in the queue. Each account counts once.
 */
export async function influencers(f: Filters) {
  const activity = (w: Window) => sql`SELECT ti.id,a.id AS author_id,b.id AS post_id,b.posted_at,b.relevance,b.intent,b.sentiment_group,b.program_id
    FROM ${interactions(f, w)} JOIN authors a ON a.id=b.author_id
    JOIN tracked_influencers ti ON lower(ti.username)=lower(a.username) AND ti.is_active`;
  const [[tracked], [cur], [prev], top, byProgram] = await Promise.all([
    sql<{ n: number }[]>`SELECT count(*)::int AS n FROM tracked_influencers WHERE is_active`,
    sql<{ active: number; posts: number; relevant: number }[]>`SELECT count(DISTINCT x.id)::int AS active,count(*)::int AS posts,
      count(*) FILTER (WHERE x.relevance='relevant')::int AS relevant FROM (${activity(f.current)}) x`,
    f.previous ? sql<{ active: number; posts: number; relevant: number }[]>`SELECT count(DISTINCT x.id)::int AS active,count(*)::int AS posts,
      count(*) FILTER (WHERE x.relevance='relevant')::int AS relevant FROM (${activity(f.previous)}) x` : Promise.resolve([null]),
    sql`WITH x AS (${activity(f.current)}),
      per AS (SELECT x.id,count(*)::int AS posts,count(*) FILTER (WHERE x.relevance='relevant')::int AS relevant,
          count(*) FILTER (WHERE x.relevance='relevant' AND x.intent='complaint')::int AS complaints,
          count(*) FILTER (WHERE x.sentiment_group IS NOT NULL)::int AS sentiment_sample,
          mode() WITHIN GROUP (ORDER BY x.sentiment_group) FILTER (WHERE x.sentiment_group IS NOT NULL) AS dominant_sentiment,
          mode() WITHIN GROUP (ORDER BY x.program_id) FILTER (WHERE x.program_id IS NOT NULL) AS program_id,
          max(x.posted_at) AS last_in_period
        FROM x GROUP BY x.id)
      SELECT per.*,ti.username,a.display_name,a.profile_image_url,a.followers_count,pr.name_ar AS program_name,
        (SELECT max(lp.posted_at) FROM posts lp WHERE lp.author_id=a.id) AS last_seen_at
      FROM per JOIN tracked_influencers ti ON ti.id=per.id
      LEFT JOIN authors a ON lower(a.username)=lower(ti.username)
      LEFT JOIN programs pr ON pr.id=per.program_id
      ORDER BY per.posts DESC,ti.username LIMIT 10`,
    sql`WITH agg AS (SELECT x.program_id,count(DISTINCT x.id)::int AS accounts,count(*)::int AS posts
        FROM (${activity(f.current)}) x WHERE x.program_id IS NOT NULL GROUP BY 1)
      SELECT agg.program_id AS id,p.name_ar,p.color,agg.accounts,agg.posts FROM agg JOIN programs p ON p.id=agg.program_id ORDER BY agg.accounts DESC`,
  ]);
  const complaintTop = await sql`WITH x AS (${activity(f.current)})
    SELECT x.id,ti.username,count(*)::int AS complaints FROM x JOIN tracked_influencers ti ON ti.id=x.id
    WHERE x.relevance='relevant' AND x.intent='complaint' GROUP BY 1,2 ORDER BY complaints DESC,ti.username LIMIT 5`;
  return {
    tracked: tracked.n, active: cur.active, activePrevious: prev?.active ?? null,
    posts: cur.posts, relevantPosts: cur.relevant, relevantPostsPrevious: prev?.relevant ?? null,
    // The dominant sentiment is withheld below the minimum sample; followers are X's own figure or null.
    top: top.map((r) => ({ ...r, dominant_sentiment: r.sentiment_sample >= MIN_SENTIMENT_SAMPLE ? r.dominant_sentiment : null })),
    complaintTop, byProgram, minSentimentSample: MIN_SENTIMENT_SAMPLE,
  };
}

/**
 * Approved stories only (state <> 'candidate' = at least two independent
 * source families). A merged story is deleted into its target, so each story
 * row is a final entity. Counts are stories, never their posts.
 */
export async function stories(f: Filters) {
  const program = sql`(${f.program?.id ?? null}::uuid IS NULL OR s.program_id=${f.program?.id ?? null}::uuid)`;
  const counts = (w: Window) => sql<{ active: number; created: number }[]>`SELECT
      count(*) FILTER (WHERE s.last_seen_at>=${w.from}::timestamptz AND s.last_seen_at<${w.to}::timestamptz)::int AS active,
      count(*) FILTER (WHERE s.first_seen_at>=${w.from}::timestamptz AND s.first_seen_at<${w.to}::timestamptz)::int AS created
    FROM signal_stories s WHERE s.state<>'candidate' AND ${program}`;
  const [[total], [cur], prev, list] = await Promise.all([
    sql<{ n: number; live: number }[]>`SELECT count(*)::int AS n,count(*) FILTER (WHERE s.state IN ('new','rising','steady'))::int AS live
      FROM signal_stories s WHERE s.state<>'candidate' AND ${program}`,
    counts(f.current), f.previous ? counts(f.previous) : Promise.resolve(null),
    sql`SELECT s.id,s.title_ar,coalesce(s.summary_ar,s.why_ar) AS summary,s.state,s.post_count,s.family_count,s.influencer_count,
        s.first_seen_at,s.last_seen_at,s.updated_at,p.name_ar AS program_name,p.color
      FROM signal_stories s JOIN programs p ON p.id=s.program_id
      WHERE s.state<>'candidate' AND ${program}
        AND s.last_seen_at>=${f.current.from}::timestamptz AND s.last_seen_at<${f.current.to}::timestamptz
      ORDER BY s.post_count DESC,s.last_seen_at DESC LIMIT 8`,
  ]);
  return { approvedTotal: total.n, liveNow: total.live, active: cur.active, created: cur.created,
    activePrevious: prev?.[0]?.active ?? null, createdPrevious: prev?.[0]?.created ?? null, items: list };
}

/** News articles: publication time when known, otherwise discovery time. Program = article's program or its source's. */
export async function news(f: Filters) {
  const at = sql`coalesce(na.published_at,na.discovered_at)`;
  const from = sql`FROM news_articles na JOIN news_sources ns ON ns.id=na.source_id
    LEFT JOIN programs np ON np.id=coalesce(na.program_id,ns.program_id)`;
  const where = (w: Window) => sql`${at}>=${w.from}::timestamptz AND ${at}<${w.to}::timestamptz
    AND (${f.program?.id ?? null}::uuid IS NULL OR coalesce(na.program_id,ns.program_id)=${f.program?.id ?? null}::uuid)`;
  const counts = (w: Window) => sql<{ total: number; relevant: number }[]>`SELECT count(*)::int AS total,
    count(*) FILTER (WHERE na.is_relevant)::int AS relevant ${from} WHERE ${where(w)}`;
  const [[cur], prev, bySource, latest, topics] = await Promise.all([
    counts(f.current), f.previous ? counts(f.previous) : Promise.resolve(null),
    sql`SELECT coalesce(na.publisher_name,ns.name_ar) AS source,count(*)::int AS articles,count(*) FILTER (WHERE na.is_relevant)::int AS relevant
      ${from} WHERE ${where(f.current)} GROUP BY 1 ORDER BY relevant DESC,articles DESC LIMIT 8`,
    sql`SELECT na.id,na.title,na.url,${at} AS published_at,coalesce(na.publisher_name,ns.name_ar) AS source,np.name_ar AS program_name
      ${from} WHERE ${where(f.current)} AND na.is_relevant ORDER BY ${at} DESC LIMIT 6`,
    sql`SELECT t.id,t.name_ar,count(*)::int AS articles ${from} JOIN topics t ON t.id=na.topic_id
      WHERE ${where(f.current)} AND na.is_relevant GROUP BY 1,2 ORDER BY articles DESC LIMIT 6`,
  ]);
  return { total: cur.total, relevant: cur.relevant, totalPrevious: prev?.[0]?.total ?? null, relevantPrevious: prev?.[0]?.relevant ?? null,
    bySource, latest, topics };
}
