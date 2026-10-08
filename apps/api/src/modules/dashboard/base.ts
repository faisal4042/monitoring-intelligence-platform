/**
 * The interaction source every monitoring figure is computed from.
 *
 * "Effective" classification: when a monitoring agent closed the post's queue
 * item with a review (the review of its current closure), the human-approved
 * values replace the AI's for analytics; otherwise the AI values stand. The
 * AI rows (post_classifications / post_sentiments) are only read, never
 * written. AI-vs-human quality is measured separately from queue_reviews.
 *
 * Counted posts: not redacted and not marked duplicate, published on X inside
 * the window (posted_at — publication time, not collection time). Each
 * partitioned join repeats the window so monthly partitions are pruned.
 */
import { analyticsSql as sql } from '@mip/db';
import type { Filters, Window } from './filters.js';

/** Any SQL fragment, whatever its row type. */
export type Fragment = ReturnType<typeof sql<any>>;

/** Effective values per post inside one window, before the user's narrowing filters. */
function effective(w: Window) {
  return sql`SELECT p.id,p.posted_at,p.author_id,p.text,p.hashtags,p.is_reply,p.is_quote,p.status,
      (rv.id IS NOT NULL) AS human_reviewed,
      (c.post_id IS NOT NULL OR rv.id IS NOT NULL) AS classified,
      CASE WHEN rv.id IS NOT NULL THEN rv.program_id ELSE c.program_id END AS program_id,
      CASE WHEN rv.id IS NOT NULL THEN rv.intent ELSE c.intent::text END AS intent,
      CASE WHEN rv.id IS NOT NULL THEN CASE WHEN rv.relevant THEN 'relevant' ELSE 'irrelevant' END ELSE c.relevance::text END AS relevance,
      CASE WHEN rv.id IS NOT NULL THEN rv.topic_id ELSE CASE WHEN t.level=2 THEN t.parent_id ELSE t.id END END AS topic_id,
      CASE WHEN rv.id IS NOT NULL THEN rv.subtopic_id ELSE CASE WHEN t.level=2 THEN t.id END END AS subtopic_id,
      CASE WHEN rv.id IS NOT NULL THEN rv.sentiment ELSE s.label::text END AS sentiment
    FROM posts p
    LEFT JOIN post_classifications c ON c.post_id=p.id AND c.posted_at=p.posted_at
      AND c.posted_at>=${w.from}::timestamptz AND c.posted_at<${w.to}::timestamptz
    LEFT JOIN topics t ON t.id=c.topic_id
    LEFT JOIN post_sentiments s ON s.post_id=p.id AND s.posted_at=p.posted_at
      AND s.posted_at>=${w.from}::timestamptz AND s.posted_at<${w.to}::timestamptz
    LEFT JOIN LATERAL (SELECT r.id,r.program_id,r.intent,r.relevant,r.topic_id,r.subtopic_id,r.sentiment
        FROM queue_items qi JOIN queue_reviews r ON r.queue_item_id=qi.id AND r.cycle=qi.reopen_count+1
        WHERE qi.interaction_type='post' AND qi.post_id=p.id AND qi.status='completed' LIMIT 1) rv ON true
    WHERE NOT p.is_redacted AND p.status<>'duplicate'
      AND p.posted_at>=${w.from}::timestamptz AND p.posted_at<${w.to}::timestamptz`;
}

/** Positive / neutral / negative from the five platform labels; NULL = not classified. */
export const sentimentGroup = (col: Fragment) => sql`CASE WHEN ${col} IN ('very_positive','positive') THEN 'positive'
  WHEN ${col}='neutral' THEN 'neutral' WHEN ${col} IN ('negative','very_negative') THEN 'negative' END`;

/** A post by an actively tracked influencer (same rule as the queue's influencer section). */
// An uncorrelated IN: PostgreSQL resolves the tracked authors once (hashed subplan), not per post.
export const byInfluencer = (alias: string) => sql`${sql(alias)}.author_id IN (SELECT ia.id FROM authors ia
  JOIN tracked_influencers iti ON lower(iti.username)=lower(ia.username) AND iti.is_active)`;

/** Excluded = dropped by the pre-filter or classified as not relevant / advert / spam. */
export const excluded = (alias: string) => sql`(${sql(alias)}.status='filtered_out' OR ${sql(alias)}.relevance IN ('irrelevant','advertisement','spam'))`;

/** `AND …` for each condition given; falsy entries are skipped. */
export function where(conds: Array<Fragment | false | null | undefined | ''>) {
  return conds.filter((c): c is Fragment => Boolean(c)).reduce((acc, c) => sql`${acc} AND ${c}`, sql``);
}

/**
 * The filtered interaction set for a window, as a subquery aliased `b`.
 * `skipProgram` lets the programs comparison group by program instead.
 */
export function interactions(f: Filters, w: Window, opts: { skipProgram?: boolean } = {}) {
  const program = opts.skipProgram ? null : f.program?.id ?? null;
  // Only the filters actually set become conditions: optional `$x IS NULL OR …`
  // predicates make PostgreSQL misjudge row counts and choose slow join plans.
  return sql`(SELECT e.*,${sentimentGroup(sql`e.sentiment`)} AS sentiment_group FROM (${effective(w)}) e
    WHERE true ${where([
      program && sql`e.program_id=${program}::uuid`,
      f.intent && sql`e.intent=${f.intent}`,
      f.topicId && sql`(e.topic_id=${f.topicId}::uuid OR e.subtopic_id=${f.topicId}::uuid)`,
      f.sentiment && sql`coalesce(${sentimentGroup(sql`e.sentiment`)},'unclassified')=${f.sentiment}`,
      f.postType === 'reply' && sql`e.is_reply`, f.postType === 'quote' && sql`e.is_quote`,
      f.postType === 'original' && sql`NOT e.is_reply AND NOT e.is_quote`,
      f.relevantOnly && sql`e.relevance='relevant'`,
      f.influencersOnly && byInfluencer('e'),
    ])}) b`;
}

/**
 * Hashtags once per post: X's extracted entities when present, otherwise
 * extracted from the text. The key is normalised (NFKC, lower case, Arabic
 * diacritics/tatweel removed, alef/ya/ta-marbuta/hamza forms and Arabic-Indic
 * digits unified — the same rules as normalizeArabic); `raw` keeps the
 * original spelling for display.
 */
export function hashtagRows(source: Fragment) {
  return sql`(SELECT DISTINCT ON (h.id,h.key) h.id,h.posted_at,h.key,h.raw,h.program_id,h.intent,h.author_id FROM (
      SELECT b.id,b.posted_at,b.program_id,b.intent,b.author_id,ltrim(tag,'#＃') AS raw,
        translate(regexp_replace(lower(normalize(ltrim(tag,'#＃'),NFKC)),'[ً-ٰٟـ]','','g'),
          'أإآٱةىؤئ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹','ااااهيوي01234567890123456789') AS key
      FROM ${source}
      -- The text is only scanned when X gave no hashtags and it actually contains a '#'.
      CROSS JOIN LATERAL unnest(CASE WHEN cardinality(b.hashtags)>0 THEN b.hashtags
        WHEN strpos(b.text,'#')=0 AND strpos(b.text,'＃')=0 THEN '{}'::text[]
        ELSE ARRAY(SELECT m[1] FROM regexp_matches(b.text,'[#＃]([0-9A-Za-z_ء-غـ-ٟ٠-٩ٰ-ۓ۰-۹]+)','g') m) END) tag
    ) h WHERE h.key<>'' ORDER BY h.id,h.key,h.raw) ht`;
}

// ── Short server cache ──────────────────────────────────────────────────────
// Only for figures whose scope is identical for every holder of posts:read
// (interaction analytics, stories, news). Queue and AI-review figures are
// scoped per user and are never cached. Keys carry the section and every
// result-changing filter; the TTL bounds staleness.
const store = new Map<string, { at: number; value: unknown }>();
const TTL_MS = Number(process.env.DASHBOARD_CACHE_TTL_MS ?? (process.env.NODE_ENV === 'test' ? 0 : 60_000));

export async function cached<T>(section: string, f: Filters, compute: () => Promise<T>, ttlMs = TTL_MS): Promise<T> {
  if (ttlMs <= 0 || f.fresh) {
    const value = await compute();
    if (ttlMs > 0) store.set(`${section}|${f.key}`, { at: Date.now(), value });
    return value;
  }
  const key = `${section}|${f.key}`;
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await compute();
  store.set(key, { at: Date.now(), value });
  if (store.size > 500) for (const [k, v] of store) if (Date.now() - v.at >= ttlMs) store.delete(k);
  return value;
}
export const cacheKeyFor = (section: string, f: Filters) => `${section}|${f.key}`;
export const clearDashboardCache = () => store.clear();
