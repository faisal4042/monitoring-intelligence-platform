/**
 * Influencer card data: one tracked account's figures and latest posts for a
 * window, read from the platform's database only (never X).
 *
 * The posts are the influencer hub's activity rows (influencers.analytics.ts
 * `activity`): the dashboard interaction source with the human review
 * replacing the AI where one exists, not redacted, not duplicates, published
 * inside the window, by any author row whose username matches the tracked
 * handle case-insensitively. So the card's numbers agree with the hub's
 * overview and analytics for the same account, window and program.
 *
 * The figures are separate indicators and must not be added together:
 *   posts                         every counted post in the window
 *   relevant                      the subset classified as relevant (a subset of posts)
 *   sentiment positive/neutral/negative/unclassified
 *                                 a partition of posts by sentiment group; sums to posts
 *
 * Read-only: nothing here writes.
 */
import { analyticsSql as sql } from '@mip/db';
import { interactions } from './dashboard/base.js';
import type { Filters } from './dashboard/filters.js';
import { MIN_SENTIMENT_SAMPLE } from './dashboard/entities.js';
import { redactSensitiveText } from '../lib/privacy.js';

export const CARD_RECENT_DEFAULT = 5;
export const CARD_RECENT_MAX = 50;

export interface CardAccount {
  id: string; username: string; notes: string | null;
  x_author_id: string | null; display_name: string | null; author_bio: string | null;
  followers_count: number | null; is_verified: boolean | null;
  has_profile_image: boolean; profile_updated_at: string | null;
}

/** The tracked account and its most recently updated author row (the same pick as the accounts tab), or null. */
export async function cardAccount(id: string): Promise<CardAccount | null> {
  const [row] = await sql<CardAccount[]>`
    SELECT ti.id,ti.username,ti.notes,a.x_author_id,a.display_name,a.description AS author_bio,
      a.followers_count,a.is_verified,(a.profile_image_url IS NOT NULL) AS has_profile_image,
      a.updated_at AS profile_updated_at
    FROM tracked_influencers ti
    LEFT JOIN LATERAL (SELECT * FROM authors a WHERE lower(a.username)=lower(ti.username)
      ORDER BY a.updated_at DESC NULLS LAST LIMIT 1) a ON true
    WHERE ti.id=${id}::uuid AND ti.is_active`;
  return row ?? null;
}

/** This account's activity rows in the window: the hub's `activity`, narrowed to one tracked account. */
const accountActivity = (f: Filters, influencerId: string) => sql`(SELECT b.* FROM ${interactions(f, f.current)}
    JOIN authors a ON a.id=b.author_id
    JOIN tracked_influencers ti ON lower(ti.username)=lower(a.username) AND ti.is_active
    WHERE ti.id=${influencerId}::uuid) x`;

/** X post ids are numeric; anything else gets no link rather than an untrusted one. */
export const postUrl = (xPostId: string) => (/^\d{1,25}$/.test(xPostId) ? `https://x.com/i/status/${xPostId}` : null);

/** Which posts the card lists: every counted post, or only those classified as relevant. The figures never change with it. */
export const CARD_SCOPES = ['all', 'relevant'] as const;
export type CardScope = (typeof CARD_SCOPES)[number];

export async function cardData(f: Filters, account: CardAccount, limit: number, scope: CardScope = 'all') {
  const [[figures], [program], recent] = await Promise.all([
    sql<{ posts: number; relevant: number; classified: number; human_reviewed: number;
        positive: number; neutral: number; negative: number; unclassified: number }[]>`
      SELECT count(*)::int AS posts,
        count(*) FILTER (WHERE x.relevance='relevant')::int AS relevant,
        count(*) FILTER (WHERE x.classified)::int AS classified,
        count(*) FILTER (WHERE x.human_reviewed)::int AS human_reviewed,
        count(*) FILTER (WHERE x.sentiment_group='positive')::int AS positive,
        count(*) FILTER (WHERE x.sentiment_group='neutral')::int AS neutral,
        count(*) FILTER (WHERE x.sentiment_group='negative')::int AS negative,
        count(*) FILTER (WHERE x.sentiment_group IS NULL)::int AS unclassified
      FROM ${accountActivity(f, account.id)}`,
    // The program its posts were linked to most often in the window (ties: the program name), as in analytics `top`.
    sql<{ id: string; key: string; name_ar: string; color: string | null; posts: number }[]>`
      SELECT p.id,p.key,p.name_ar,p.color,count(*)::int AS posts
      FROM ${accountActivity(f, account.id)} JOIN programs p ON p.id=x.program_id
      GROUP BY p.id,p.key,p.name_ar,p.color ORDER BY count(*) DESC,p.name_ar LIMIT 1`,
    sql<{ id: string; x_post_id: string; posted_at: string; text: string; is_reply: boolean; is_quote: boolean;
        relevance: string | null; sentiment: string | null; sentiment_group: string | null; human_reviewed: boolean;
        program_id: string | null; program_name: string | null }[]>`
      SELECT x.id,po.x_post_id,x.posted_at,x.text,x.is_reply,x.is_quote,x.relevance,x.sentiment,x.sentiment_group,
        x.human_reviewed,x.program_id,pr.name_ar AS program_name
      FROM ${accountActivity(f, account.id)}
      JOIN posts po ON po.id=x.id AND po.posted_at=x.posted_at
        AND po.posted_at>=${f.current.from}::timestamptz AND po.posted_at<${f.current.to}::timestamptz
      LEFT JOIN programs pr ON pr.id=x.program_id
      WHERE ${scope === 'relevant' ? sql`x.relevance='relevant'` : sql`true`}
      ORDER BY x.posted_at DESC,x.id LIMIT ${limit}`,
  ]);

  const sample = figures.positive + figures.neutral + figures.negative;
  return {
    figures: {
      posts: figures.posts,
      relevant: figures.relevant,
      classified: figures.classified,
      humanReviewed: figures.human_reviewed,
      sentiment: {
        positive: figures.positive, neutral: figures.neutral, negative: figures.negative, unclassified: figures.unclassified,
        sample, reliable: sample >= MIN_SENTIMENT_SAMPLE,
      },
      minSentimentSample: MIN_SENTIMENT_SAMPLE,
    },
    program: program ?? null,
    recent: recent.map(({ x_post_id, text, ...r }) => ({
      ...r, x_post_id, url: postUrl(x_post_id),
      // Monitored text is untrusted and may carry personal data: the platform's masking, as on the live feed.
      text: redactSensitiveText(text),
    })),
    recentLimit: limit,
    recentScope: scope,
    // How many posts the scope holds in the window; `recent` shows at most `recentLimit` of them.
    recentAvailable: scope === 'relevant' ? figures.relevant : figures.posts,
  };
}
