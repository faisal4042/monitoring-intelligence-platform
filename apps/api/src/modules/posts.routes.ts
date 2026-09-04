/** Live feed, post detail, "why did we collect this?", and manual collection. */
import type { FastifyInstance } from 'fastify';
import { sql, normalizeArabic } from '@mip/db';
import { PERMISSIONS } from '@mip/shared';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { collectQuery, CollectionError } from './collection.service.js';
import { redactRows, redactSensitiveText } from '../lib/privacy.js';

export default async function postRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  /**
   * Server-side filtering and cursor pagination throughout — the browser never
   * receives a full table (docs/PROJECT_PLAN.md §54).
   */
  app.get('/', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(Number(q.limit ?? 50), 200);
    const search = q.q ? normalizeArabic(q.q) : null;

    const rows = await sql`
      SELECT p.id, p.x_post_id, p.x_author_id, p.text, p.posted_at, p.collected_at, p.lang, p.url, p.hashtags,
             p.matched_keywords, p.status, p.risk_score, p.filter_reason,
             p.duplicate_type, p.duplicate_of_id,
             a.username, a.display_name, a.followers_count, a.is_verified, a.profile_image_url,
             a.description AS author_bio, a.influence_score,
             c.relevance, c.intent, c.relevance_confidence::float, c.reason_ar, c.stage,
             s.label AS sentiment, s.score::float AS sentiment_score,
             pr.name_ar AS program_name, pr.color AS program_color,
             t.id AS topic_id, t.name_ar AS topic_name,
             m.like_count, m.repost_count, m.reply_count,
             media.items AS media,
             (ti.id IS NOT NULL) AS is_influencer
      FROM posts p
      LEFT JOIN authors a ON a.id = p.author_id
      LEFT JOIN post_classifications c ON c.post_id = p.id AND c.posted_at = p.posted_at
      LEFT JOIN post_sentiments s ON s.post_id = p.id AND s.posted_at = p.posted_at
      LEFT JOIN programs pr ON pr.id = c.program_id
      LEFT JOIN topics t ON t.id = c.topic_id
      LEFT JOIN tracked_influencers ti ON ti.username = a.username AND ti.is_active
      LEFT JOIN LATERAL (
        SELECT * FROM post_metrics pm
        WHERE pm.post_id = p.id AND pm.posted_at = p.posted_at
        ORDER BY captured_at DESC LIMIT 1
      ) m ON true
      LEFT JOIN LATERAL (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'url', pmd.url, 'previewImageUrl', pmd.preview_image_url,
          'width', pmd.width, 'height', pmd.height, 'type', pmd.type
        ) ORDER BY pmd.media_key), '[]'::jsonb) AS items
        FROM post_media pmd
        WHERE p.has_media AND pmd.post_id = p.id AND pmd.posted_at = p.posted_at
      ) media ON true
      WHERE p.is_redacted = false
        AND (${q.includeFiltered === 'true'} OR p.status <> 'filtered_out')
        AND (${q.includeDuplicates === 'true'} OR p.status <> 'duplicate')
        AND (${q.programId ?? null}::uuid IS NULL OR c.program_id = ${q.programId ?? null}::uuid)
        AND (${q.queryId ?? null}::uuid   IS NULL OR p.query_id = ${q.queryId ?? null}::uuid)
        AND (${q.relevance ?? null}::text IS NULL OR c.relevance::text = ${q.relevance ?? null})
        AND (${q.sentiment ?? null}::text IS NULL OR s.label::text = ${q.sentiment ?? null})
        AND (${q.intent ?? null}::text    IS NULL OR c.intent::text = ${q.intent ?? null})
        AND (NOT ${q.influencersOnly === 'true'} OR ti.id IS NOT NULL)
        AND (${q.username ?? null}::text IS NULL OR a.username = ${q.username ?? null})
        AND (${q.minRisk ?? null}::int    IS NULL OR p.risk_score >= ${q.minRisk ?? null}::int)
        AND (${search}::text IS NULL OR p.text_normalized LIKE '%' || ${search} || '%')
        AND (${q.cursor ?? null}::timestamptz IS NULL OR p.posted_at < ${q.cursor ?? null}::timestamptz)
      ORDER BY p.posted_at DESC
      LIMIT ${limit}`;

    // The driver may hand back a Date or an ISO string depending on the column
    // and connection settings, so normalise rather than assume.
    const last = rows[rows.length - 1] as { posted_at?: Date | string } | undefined;
    const cursorValue =
      rows.length === limit && last?.posted_at
        ? (last.posted_at instanceof Date ? last.posted_at.toISOString() : String(last.posted_at))
        : null;

    return { items: redactRows([...rows]), nextCursor: cursorValue };
  });

  /**
   * Customer history is assembled exclusively from posts already collected by
   * the platform. Opening a profile never spends X API quota.
   */
  app.get('/authors/:xAuthorId/history', async (req) => {
    const { xAuthorId } = req.params as { xAuthorId: string };
    const query = req.query as { days?: string; limit?: string };
    const parsedDays = query.days === 'all' ? null : Number(query.days ?? 30);
    const days = parsedDays !== null && Number.isFinite(parsedDays)
      ? Math.min(Math.max(Math.trunc(parsedDays), 1), 3650)
      : null;
    const limit = Math.min(Math.max(Number(query.limit ?? 100), 1), 200);

    const [author] = await sql`
      SELECT a.x_author_id, a.username, a.display_name, a.description,
             a.profile_image_url, a.location, a.followers_count,
             a.following_count, a.tweet_count, a.is_verified,
             a.account_created_at, a.first_seen_at, a.last_seen_at
      FROM authors a
      WHERE a.x_author_id = ${xAuthorId}
      LIMIT 1`;
    if (!author) throw notFound('العميل غير موجود');

    const [stats] = await sql`
      SELECT count(*)::int AS interaction_count,
             count(*) FILTER (WHERE c.intent = 'complaint')::int AS complaint_count,
             count(*) FILTER (WHERE c.intent = 'inquiry')::int AS inquiry_count,
             count(*) FILTER (WHERE s.label IN ('negative','very_negative'))::int AS negative_count,
             min(p.posted_at) AS first_interaction_at,
             max(p.posted_at) AS last_interaction_at,
             coalesce(sum(coalesce(m.like_count, 0) + coalesce(m.repost_count, 0) + coalesce(m.reply_count, 0)), 0)::int AS engagement_total
      FROM posts p
      LEFT JOIN post_classifications c ON c.post_id = p.id AND c.posted_at = p.posted_at
      LEFT JOIN post_sentiments s ON s.post_id = p.id AND s.posted_at = p.posted_at
      LEFT JOIN LATERAL (
        SELECT pm.like_count, pm.repost_count, pm.reply_count
        FROM post_metrics pm
        WHERE pm.post_id = p.id AND pm.posted_at = p.posted_at
        ORDER BY pm.captured_at DESC LIMIT 1
      ) m ON true
      WHERE p.x_author_id = ${xAuthorId}
        AND p.is_redacted = false
        AND p.status NOT IN ('filtered_out', 'duplicate')
        AND (${days}::int IS NULL OR p.posted_at >= now() - (${days}::text || ' days')::interval)`;

    const items = await sql`
      SELECT p.id, p.x_post_id, p.text, p.posted_at, p.url, p.is_reply,
             p.is_quote, p.is_repost, p.matched_keywords,
             c.relevance, c.intent, c.reason_ar,
             s.label AS sentiment,
             pr.name_ar AS program_name, pr.color AS program_color,
             m.like_count, m.repost_count, m.reply_count
      FROM posts p
      LEFT JOIN post_classifications c ON c.post_id = p.id AND c.posted_at = p.posted_at
      LEFT JOIN post_sentiments s ON s.post_id = p.id AND s.posted_at = p.posted_at
      LEFT JOIN programs pr ON pr.id = c.program_id
      LEFT JOIN LATERAL (
        SELECT pm.like_count, pm.repost_count, pm.reply_count
        FROM post_metrics pm
        WHERE pm.post_id = p.id AND pm.posted_at = p.posted_at
        ORDER BY pm.captured_at DESC LIMIT 1
      ) m ON true
      WHERE p.x_author_id = ${xAuthorId}
        AND p.is_redacted = false
        AND p.status NOT IN ('filtered_out', 'duplicate')
        AND (${days}::int IS NULL OR p.posted_at >= now() - (${days}::text || ' days')::interval)
      ORDER BY p.posted_at DESC
      LIMIT ${limit}`;

    const safeAuthor = {
      ...author,
      description: typeof author.description === 'string'
        ? redactSensitiveText(author.description)
        : author.description,
    };
    return { author: safeAuthor, stats, items: redactRows([...items]), rangeDays: days };
  });

  app.get('/stats', async () => {
    const [row] = await sql<Record<string, string>[]>`
      SELECT
        count(*) FILTER (WHERE c.relevance = 'relevant')                            AS relevant_total,
        count(*) FILTER (WHERE p.posted_at > now() - interval '24 hours')            AS last_24h,
        count(*) FILTER (WHERE s.label IN ('negative','very_negative'))              AS negative_total,
        count(*) FILTER (WHERE c.relevance IN ('advertisement','spam','irrelevant')) AS noise_total,
        count(*) FILTER (WHERE p.status <> 'duplicate')                              AS total,
        count(*) FILTER (WHERE p.status = 'duplicate')                               AS duplicate_total,
        count(DISTINCT p.author_id)                                                  AS unique_authors
      FROM posts p
      LEFT JOIN post_classifications c ON c.post_id = p.id AND c.posted_at = p.posted_at
      LEFT JOIN post_sentiments s ON s.post_id = p.id AND s.posted_at = p.posted_at
      WHERE p.is_redacted = false`;

    const total = Number(row?.total ?? 0);
    const relevant = Number(row?.relevant_total ?? 0);
    const noise = Number(row?.noise_total ?? 0);

    return {
      total,
      relevant,
      noise,
      negative: Number(row?.negative_total ?? 0),
      duplicates: Number(row?.duplicate_total ?? 0),
      last24h: Number(row?.last_24h ?? 0),
      uniqueAuthors: Number(row?.unique_authors ?? 0),
      precision: relevant + noise > 0 ? relevant / (relevant + noise) : null,
      negativePct: relevant > 0 ? Number(row?.negative_total ?? 0) / relevant : 0,
    };
  });

  app.get('/timeline', async (req) => {
    const { hours } = req.query as { hours?: string };
    return {
      items: await sql`
        SELECT date_trunc('hour', p.posted_at) AS bucket,
               count(*) FILTER (WHERE c.relevance = 'relevant')::int AS relevant,
               count(*) FILTER (WHERE c.relevance <> 'relevant')::int AS noise,
               count(*) FILTER (WHERE s.label IN ('negative','very_negative'))::int AS negative
        FROM posts p
        LEFT JOIN post_classifications c ON c.post_id = p.id AND c.posted_at = p.posted_at
        LEFT JOIN post_sentiments s ON s.post_id = p.id AND s.posted_at = p.posted_at
        WHERE p.posted_at > now() - (${Number(hours ?? 48)} || ' hours')::interval
        GROUP BY 1 ORDER BY 1`,
    };
  });

  /** Answers "why did we collect this?" — query, version and matched keywords. */
  app.get('/:id/why-collected', async (req) => {
    const { id } = req.params as { id: string };
    const [row] = await sql`
      SELECT p.matched_keywords, p.filter_reason, p.status,
             q.id AS query_id, q.name AS query_name,
             v.version, v.compiled,
             c.relevance, c.reason_ar, c.stage
      FROM posts p
      LEFT JOIN queries q ON q.id = p.query_id
      LEFT JOIN query_versions v ON v.id = p.query_version_id
      LEFT JOIN post_classifications c ON c.post_id = p.id AND c.posted_at = p.posted_at
      WHERE p.id = ${id}::uuid`;
    if (!row) throw notFound('المنشور غير موجود');
    return row;
  });

  app.post('/:id/feedback', {
    preHandler: [app.requirePermission(PERMISSIONS.FEEDBACK_WRITE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { type?: string; value?: string; reason?: string };
    if (!body?.value) throw badRequest('القيمة المصححة مطلوبة');

    const [post] = await sql<{ text: string; posted_at: Date | string }[]>`
      SELECT text, posted_at FROM posts WHERE id = ${id}::uuid`;
    if (!post) throw notFound('المنشور غير موجود');
    const postedAt = post.posted_at;

    const [cls] = await sql<{ relevance: string; relevance_confidence: string | null; stage: number }[]>`
      SELECT relevance::text, relevance_confidence, stage FROM post_classifications
      WHERE post_id = ${id}::uuid AND posted_at = ${postedAt}::timestamptz`;

    await sql`
      INSERT INTO ai_feedback (post_id, posted_at, feedback_type, ai_value, ai_confidence,
                               ai_stage, human_value, reason, post_text_snapshot, created_by)
      VALUES (${id}::uuid, ${postedAt}::timestamptz, ${body.type ?? 'relevance'},
              ${cls?.relevance ?? 'unknown'}, ${cls?.relevance_confidence ?? null},
              ${cls?.stage ?? null}, ${body.value}, ${body.reason ?? null},
              ${redactSensitiveText(post.text)}, ${req.user.id}::uuid)`;

    await sql`
      UPDATE post_classifications
      SET relevance = ${body.value}::relevance_label, human_corrected = true,
          corrected_by = ${req.user.id}::uuid, corrected_at = now()
      WHERE post_id = ${id}::uuid AND posted_at = ${postedAt}::timestamptz`;

    return { ok: true };
  });

  /**
   * Manual collection run. The scheduled worker job lands in Phase 1.D; this
   * endpoint exercises the exact same gateway, so the budget gate, kill switch
   * and accounting are identical.
   */
  app.post('/collect/:queryId', {
    preHandler: [app.requirePermission(PERMISSIONS.QUERIES_WRITE)],
  }, async (req) => {
    const { queryId } = req.params as { queryId: string };
    try {
      const result = await collectQuery(queryId, req.user.id);
      await audit(req, {
        action: 'query.collect', entityType: 'query', entityId: result.queryId,
        entityLabel: result.queryName, newValue: result,
      });
      return result;
    } catch (error) {
      if (error instanceof CollectionError) {
        if (error.code === 'NOT_FOUND') throw notFound(error.message);
        throw badRequest(error.message, error.code);
      }
      throw error;
    }
  });
}
