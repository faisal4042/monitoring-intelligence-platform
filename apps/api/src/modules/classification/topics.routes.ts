/**
 * تصنيف التفاعلات — Stage 2 (docs/AI_PIPELINE.md §4, §7.4): embeds posts and
 * topic centroids with an external Qwen3-Embedding-8B provider, then links a
 * post to a topic only when cosine similarity clears a high-confidence bar.
 * This is not "100% verified truth" — it is a similarity score. Anything
 * below `STAGE2_CONFIDENCE_THRESHOLD` is left unlinked rather than guessed.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '@mip/db';
import { config } from '@mip/config';
import { PERMISSIONS } from '@mip/shared';
import { badRequest, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { embed } from '../ai/client.js';
import { runClassificationBatch } from './service.js';
import { redactRows, redactSensitiveText } from '../../lib/privacy.js';

const toVectorLiteral = (v: number[]) => `[${v.join(',')}]`;

const topicSchema = z.object({
  programId: z.string().uuid(),
  serviceId: z.string().uuid().optional(),
  parentId: z.string().uuid().optional(),
  nameAr: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});

const reviewSchema = z.object({
  note: z.string().max(1000).optional(),
  topicId: z.string().uuid().optional(),
  force: z.boolean().optional(),
  nameAr: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
});

const feedbackSchema = z.object({
  correct: z.boolean(),
  correctTopicId: z.string().uuid().optional(),
  reason: z.string().max(1000).optional(),
});

export default async function topicsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get('/topics', {
    preHandler: [app.requirePermission(PERMISSIONS.TOPICS_READ)],
  }, async (req) => {
    const { programId } = req.query as { programId?: string };
    return {
      items: await sql`
        SELECT t.id, t.program_id, t.parent_id, t.level, t.name_ar, t.description, t.source,
               (SELECT count(*) FROM post_classifications c WHERE c.topic_id = t.id) AS post_count,
               (SELECT count(*) FROM post_classifications c
                  WHERE c.topic_id = t.id AND c.human_corrected) AS human_reviewed_count,
               (SELECT max(c.posted_at) FROM post_classifications c
                  WHERE c.topic_id = t.id) AS last_activity_at,
               (SELECT avg(1 - (pe.embedding <=> t.centroid))
                  FROM post_classifications c
                  JOIN post_embeddings pe ON pe.post_id = c.post_id AND pe.posted_at = c.posted_at
                 WHERE c.topic_id = t.id AND t.centroid IS NOT NULL) AS avg_similarity,
               t.is_active, (t.centroid IS NOT NULL) AS has_centroid,
               p.name_ar AS program_name
        FROM topics t
        JOIN programs p ON p.id = t.program_id
        WHERE t.is_active
          AND (${programId ?? null}::uuid IS NULL OR t.program_id = ${programId ?? null}::uuid)
        ORDER BY post_count DESC, p.name_ar, t.level, t.name_ar`,
    };
  });

  app.post('/topics', {
    preHandler: [app.requirePermission(PERMISSIONS.TOPICS_MANAGE)],
  }, async (req) => {
    const parsed = topicSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const input = parsed.data;

    const level = input.parentId ? 2 : 1;
    if (input.parentId) {
      const [parent] = await sql<{ id: string }[]>`
        SELECT id FROM topics
        WHERE id = ${input.parentId}::uuid AND program_id = ${input.programId}::uuid
          AND is_active AND level = 1`;
      if (!parent) throw badRequest('الموضوع الرئيسي غير موجود ضمن البرنامج المحدد');
    }
    const [duplicate] = await sql<{ name_ar: string }[]>`
      SELECT name_ar FROM topics
      WHERE program_id = ${input.programId}::uuid AND is_active
        AND lower(regexp_replace(btrim(name_ar), '\\s+', ' ', 'g')) =
            lower(regexp_replace(btrim(${input.nameAr}), '\\s+', ' ', 'g'))
      LIMIT 1`;
    if (duplicate) throw badRequest(`يوجد موضوع مطابق بالفعل: ${duplicate.name_ar}`, 'DUPLICATE_TOPIC');
    const [row] = await sql`
      INSERT INTO topics (program_id, service_id, parent_id, level, name_ar, description, source)
      VALUES (${input.programId}::uuid, ${input.serviceId ?? null}::uuid, ${input.parentId ?? null}::uuid,
              ${level}, ${input.nameAr}, ${input.description ?? null}, 'manual')
      RETURNING *`;

    await audit(req, {
      action: 'topic.create', entityType: 'topic', entityId: row.id,
      entityLabel: input.nameAr, newValue: { nameAr: input.nameAr, programId: input.programId },
    });
    return row;
  });

  /**
   * Cold-start centroid: embeds the topic's own name + description. Once real
   * posts are linked, a future recompute can average confirmed member posts
   * instead — the column is the same either way.
   */
  app.post('/topics/:id/centroid', {
    preHandler: [app.requirePermission(PERMISSIONS.TOPICS_MANAGE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const [topic] = await sql<{ name_ar: string; description: string | null; keywords: string | null }[]>`
      SELECT t.name_ar, t.description,
             string_agg(tk.term, '، ' ORDER BY tk.kind, tk.term) AS keywords
      FROM topics t LEFT JOIN topic_keywords tk ON tk.topic_id = t.id
      WHERE t.id = ${id}::uuid
      GROUP BY t.id`;
    if (!topic) throw notFound('الموضوع غير موجود');

    // Human-confirmed examples are the best representation of an established
    // topic. They are already embedded, so averaging them is both more
    // accurate for this taxonomy and avoids another external API charge.
    const [confirmed] = await sql<{ centroid: string | null; member_count: string }[]>`
      SELECT avg(pe.embedding)::text AS centroid, count(pe.post_id)::text AS member_count
      FROM post_classifications c
      JOIN post_embeddings pe ON pe.post_id = c.post_id AND pe.posted_at = c.posted_at
      WHERE c.topic_id = ${id}::uuid AND c.human_corrected`;
    if (confirmed?.centroid && Number(confirmed.member_count) > 0) {
      await sql`
        UPDATE topics SET centroid = ${confirmed.centroid}::vector,
          post_count = ${Number(confirmed.member_count)}, updated_at = now()
        WHERE id = ${id}::uuid`;
      await audit(req, {
        action: 'topic.centroid_update', entityType: 'topic', entityId: id,
        entityLabel: topic.name_ar,
        newValue: { model: 'confirmed_members_average', members: Number(confirmed.member_count) },
      });
      return {
        ok: true, model: 'confirmed_members_average',
        dimensions: 1024, members: Number(confirmed.member_count), externalCall: false,
      };
    }

    if (!config.ALLOW_INTERNAL_DATA_TO_EXTERNAL_AI) {
      throw badRequest(
        'استخدام مزوّد Embeddings خارجي معطّل — فعّل ALLOW_INTERNAL_DATA_TO_EXTERNAL_AI=true في .env أولاً (docs/AI_PIPELINE.md §7.5).',
        'EXTERNAL_AI_DISABLED',
      );
    }

    const text = [topic.name_ar, topic.description, topic.keywords ? `الكلمات المرتبطة: ${topic.keywords}` : null]
      .filter(Boolean).join(' — ');
    const { embeddings, model } = await embed([text]);

    await sql`
      UPDATE topics SET centroid = ${toVectorLiteral(embeddings[0])}::vector, updated_at = now()
      WHERE id = ${id}::uuid`;

    await audit(req, {
      action: 'topic.centroid_update', entityType: 'topic', entityId: id,
      entityLabel: topic.name_ar, newValue: { model },
    });
    return { ok: true, model, dimensions: embeddings[0].length };
  });

  /** Model-created candidates stay here until a human approves, merges or rejects them. */
  app.get('/topic-suggestions', {
    preHandler: [app.requirePermission(PERMISSIONS.TOPICS_READ)],
  }, async (req) => {
    const q = req.query as { programId?: string; status?: string };
    const status = q.status ?? 'pending';
    return {
      minSupport: config.TOPIC_SUGGESTION_MIN_SUPPORT,
      items: await sql`
        SELECT s.id, s.program_id, s.service_id, s.name_ar, s.description,
               s.support_count, s.status, s.source_model, s.created_at, s.updated_at,
               p.name_ar AS program_name, p.color AS program_color,
               sv.name_ar AS service_name,
               (s.support_count >= ${config.TOPIC_SUGGESTION_MIN_SUPPORT}) AS eligible,
               coalesce((
                 SELECT jsonb_agg(jsonb_build_object(
                   'id', nearest.id, 'name_ar', nearest.name_ar,
                   'similarity', nearest.similarity
                 ) ORDER BY nearest.similarity DESC)
                 FROM (
                   SELECT t.id, t.name_ar,
                          (1 - (t.centroid <=> s.centroid))::float AS similarity
                   FROM topics t
                   WHERE t.is_active AND t.centroid IS NOT NULL
                     AND t.program_id = s.program_id
                   ORDER BY t.centroid <=> s.centroid
                   LIMIT 3
                 ) nearest
               ), '[]'::jsonb) AS similar_topics,
               coalesce(
                 jsonb_agg(jsonb_build_object(
                   'id', po.id, 'text', po.text, 'posted_at', po.posted_at,
                   'url', po.url, 'similarity', sm.similarity,
                   'username', a.username, 'display_name', a.display_name
                 ) ORDER BY po.posted_at DESC) FILTER (WHERE po.id IS NOT NULL),
                 '[]'::jsonb
               ) AS members
        FROM topic_suggestions s
        JOIN programs p ON p.id = s.program_id
        LEFT JOIN services sv ON sv.id = s.service_id
        LEFT JOIN topic_suggestion_members sm ON sm.suggestion_id = s.id
        LEFT JOIN posts po ON po.id = sm.post_id AND po.posted_at = sm.posted_at
        LEFT JOIN authors a ON a.id = po.author_id
        WHERE s.status = ${status}
          AND (${q.programId ?? null}::uuid IS NULL OR s.program_id = ${q.programId ?? null}::uuid)
        GROUP BY s.id, p.id, sv.id
        ORDER BY s.support_count DESC, s.updated_at DESC
        LIMIT 200`,
    };
  });

  app.post('/topic-suggestions/:id/approve', {
    preHandler: [app.requirePermission(PERMISSIONS.TOPICS_MANAGE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = reviewSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    const [suggestion] = await sql<{
      id: string; program_id: string; service_id: string | null; name_ar: string;
      description: string | null; centroid: string; support_count: number; status: string;
    }[]>`SELECT id, program_id, service_id, name_ar, description, centroid::text,
                support_count, status
         FROM topic_suggestions WHERE id = ${id}::uuid FOR UPDATE`;
    if (!suggestion) throw notFound('المقترح غير موجود');
    if (suggestion.status !== 'pending') throw badRequest('تمت مراجعة هذا المقترح مسبقاً');
    if (suggestion.support_count < config.TOPIC_SUGGESTION_MIN_SUPPORT && !parsed.data.force) {
      throw badRequest(`يحتاج الموضوع إلى ${config.TOPIC_SUGGESTION_MIN_SUPPORT} تفاعلات داعمة على الأقل قبل الاعتماد`);
    }

    const approvedName = parsed.data.nameAr ?? suggestion.name_ar;
    const approvedDescription = parsed.data.description === undefined
      ? suggestion.description
      : parsed.data.description;

    const [topic] = await sql<{ id: string }[]>`
      INSERT INTO topics (program_id, service_id, parent_id, level, name_ar, description, source, centroid)
      VALUES (${suggestion.program_id}::uuid, ${suggestion.service_id}::uuid, NULL, 1,
              ${approvedName}, ${approvedDescription}, 'human_approved',
              ${suggestion.centroid}::vector)
      RETURNING id`;

    await sql`
      UPDATE post_classifications c SET
        topic_id = ${topic.id}::uuid, stage = 3, model = 'human_approved',
        human_corrected = true, corrected_by = ${req.user.id}::uuid, corrected_at = now()
      FROM topic_suggestion_members sm
      WHERE sm.suggestion_id = ${id}::uuid
        AND c.post_id = sm.post_id AND c.posted_at = sm.posted_at
        AND NOT c.human_corrected`;
    await sql`
      UPDATE topic_suggestions SET status = 'approved', approved_topic_id = ${topic.id}::uuid,
        name_ar = ${approvedName}, description = ${approvedDescription},
        reviewed_by = ${req.user.id}::uuid, reviewed_at = now(),
        review_note = ${parsed.data.note ?? (parsed.data.force ? 'اعتماد يدوي استثنائي بأقل من الحد الأدنى للدعم' : null)}, updated_at = now()
      WHERE id = ${id}::uuid`;
    await sql`UPDATE topics SET post_count = ${suggestion.support_count} WHERE id = ${topic.id}::uuid`;
    await audit(req, {
      action: 'topic_suggestion.approve', entityType: 'topic', entityId: topic.id,
      entityLabel: approvedName,
      newValue: {
        suggestionId: id, supportCount: suggestion.support_count,
        manualOverride: parsed.data.force ?? false,
        originalName: suggestion.name_ar, approvedName,
      },
    });
    return { ok: true, topicId: topic.id };
  });

  app.post('/topic-suggestions/:id/merge', {
    preHandler: [app.requirePermission(PERMISSIONS.TOPICS_MANAGE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = reviewSchema.safeParse(req.body ?? {});
    if (!parsed.success || !parsed.data.topicId) throw badRequest('اختر الموضوع المراد الدمج معه');
    const [pair] = await sql<{ suggestion_name: string; suggestion_program: string; topic_program: string }[]>`
      SELECT s.name_ar AS suggestion_name, s.program_id AS suggestion_program,
             t.program_id AS topic_program
      FROM topic_suggestions s JOIN topics t ON t.id = ${parsed.data.topicId}::uuid AND t.is_active
      WHERE s.id = ${id}::uuid AND s.status = 'pending'`;
    if (!pair) throw notFound('المقترح أو الموضوع غير موجود');
    if (pair.suggestion_program !== pair.topic_program) throw badRequest('لا يمكن الدمج بين برنامجين مختلفين');

    await sql`
      UPDATE post_classifications c SET
        topic_id = ${parsed.data.topicId}::uuid, stage = 3, model = 'human_merged',
        human_corrected = true, corrected_by = ${req.user.id}::uuid, corrected_at = now()
      FROM topic_suggestion_members sm
      WHERE sm.suggestion_id = ${id}::uuid
        AND c.post_id = sm.post_id AND c.posted_at = sm.posted_at
        AND NOT c.human_corrected`;
    await sql`
      UPDATE topic_suggestions SET status = 'merged', approved_topic_id = ${parsed.data.topicId}::uuid,
        reviewed_by = ${req.user.id}::uuid, reviewed_at = now(),
        review_note = ${parsed.data.note ?? null}, updated_at = now()
      WHERE id = ${id}::uuid`;
    await sql`
      UPDATE topics t SET
        post_count = (SELECT count(*) FROM post_classifications c WHERE c.topic_id = t.id),
        centroid = coalesce((
          SELECT avg(pe.embedding)
          FROM post_classifications c
          JOIN post_embeddings pe ON pe.post_id = c.post_id AND pe.posted_at = c.posted_at
          WHERE c.topic_id = t.id AND c.human_corrected
        ), t.centroid),
        updated_at = now()
      WHERE t.id = ${parsed.data.topicId}::uuid`;
    await audit(req, { action: 'topic_suggestion.merge', entityType: 'topic', entityId: parsed.data.topicId, entityLabel: pair.suggestion_name });
    return { ok: true };
  });

  app.post('/topic-suggestions/:id/reject', {
    preHandler: [app.requirePermission(PERMISSIONS.TOPICS_MANAGE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = reviewSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const [row] = await sql`
      UPDATE topic_suggestions SET status = 'rejected', reviewed_by = ${req.user.id}::uuid,
        reviewed_at = now(), review_note = ${parsed.data.note ?? null}, updated_at = now()
      WHERE id = ${id}::uuid AND status = 'pending' RETURNING name_ar`;
    if (!row) throw notFound('المقترح غير موجود أو تمت مراجعته');
    await audit(req, { action: 'topic_suggestion.reject', entityType: 'topic', entityLabel: row.name_ar });
    return { ok: true };
  });

  /**
   * Manual batch run (mirrors the manual-collection pattern in posts.routes.ts
   * — the scheduled worker lands with Phase 1.D per docs/IMPLEMENTATION_ROADMAP.md).
   * Embeds relevant, not-yet-embedded posts and links each to its nearest
   * topic centroid only above the confidence threshold.
   */
  app.post('/classification/run', {
    preHandler: [app.requirePermission(PERMISSIONS.TOPICS_MANAGE)],
  }, async (req) => {
    const body = req.body as { programId?: string; limit?: number; threshold?: number; discoverTopics?: boolean; forceRetry?: boolean };
    try {
      const result = await runClassificationBatch({
        programId: body.programId,
        limit: body.limit,
        threshold: body.threshold,
        discoverTopics: body.discoverTopics ?? true,
        forceRetry: body.forceRetry ?? false,
      });
      await audit(req, {
        action: 'classification.run', entityType: 'topic', entityLabel: 'batch', newValue: result,
      });
      return result;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('EXTERNAL_AI_DISABLED')) {
        throw badRequest(
          'استخدام مزوّد AI خارجي معطّل — فعّل ALLOW_INTERNAL_DATA_TO_EXTERNAL_AI=true في .env أولاً (docs/AI_PIPELINE.md §7.5).',
          'EXTERNAL_AI_DISABLED',
        );
      }
      throw err;
    }
  });

  /** The "تصنيف التفاعلات" list — posts already linked to a topic above the confidence bar. */
  app.get('/classification/interactions', {
    preHandler: [app.requirePermission(PERMISSIONS.TOPICS_READ)],
  }, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(Number(q.limit ?? 50), 200);
    const minConfidence = q.minConfidence ? Number(q.minConfidence) : config.STAGE2_CONFIDENCE_THRESHOLD;

    const items = await sql`
      SELECT p.id, p.text, p.posted_at, p.url, p.x_author_id, c.program_id,
             a.username, a.display_name, a.profile_image_url, a.followers_count, a.is_verified,
             t.id AS topic_id, t.name_ar AS topic_name,
             pr.name_ar AS program_name, pr.color AS program_color,
             c.stage, (1 - (pe.embedding <=> t.centroid)) AS confidence
      FROM post_classifications c
      JOIN posts p ON p.id = c.post_id AND p.posted_at = c.posted_at
      JOIN topics t ON t.id = c.topic_id
      LEFT JOIN authors a ON a.id = p.author_id
      LEFT JOIN programs pr ON pr.id = c.program_id
      LEFT JOIN post_embeddings pe ON pe.post_id = p.id AND pe.posted_at = p.posted_at
      WHERE c.topic_id IS NOT NULL
        AND (${q.topicId ?? null}::uuid IS NULL OR c.topic_id = ${q.topicId ?? null}::uuid)
        AND (${q.programId ?? null}::uuid IS NULL OR c.program_id = ${q.programId ?? null}::uuid)
        -- Published assignments are either explicitly human-confirmed, or an
        -- automatic link (embedding-only stage 2, or LLM-picked-and-embedding-
        -- corroborated stage 3) whose similarity to the topic still clears the bar.
        AND (c.human_corrected OR (1 - (pe.embedding <=> t.centroid)) >= ${minConfidence})
        AND (${q.cursor ?? null}::timestamptz IS NULL OR p.posted_at < ${q.cursor ?? null}::timestamptz)
      ORDER BY p.posted_at DESC
      LIMIT ${limit}`;

    const last = items[items.length - 1] as { posted_at?: Date | string } | undefined;
    const nextCursor =
      items.length === limit && last?.posted_at
        ? (last.posted_at instanceof Date ? last.posted_at.toISOString() : String(last.posted_at))
        : null;

    return { items: redactRows([...items]), nextCursor, minConfidence };
  });

  app.get('/classification/unclassified', {
    preHandler: [app.requirePermission(PERMISSIONS.TOPICS_READ)],
  }, async (req) => {
    const q = req.query as { programId?: string };
    const items = await sql`
        SELECT p.id, p.text, p.posted_at, p.url, p.x_author_id, c.program_id,
               a.username, a.display_name, a.profile_image_url,
               pr.name_ar AS program_name, pr.color AS program_color,
               (pe.post_id IS NOT NULL) AS has_embedding,
               s.id AS suggestion_id, s.name_ar AS suggestion_name,
               s.support_count AS suggestion_support
        FROM post_classifications c
        JOIN posts p ON p.id = c.post_id AND p.posted_at = c.posted_at
        LEFT JOIN authors a ON a.id = p.author_id
        LEFT JOIN programs pr ON pr.id = c.program_id
        LEFT JOIN post_embeddings pe ON pe.post_id = p.id AND pe.posted_at = p.posted_at
        LEFT JOIN topic_suggestion_members sm ON sm.post_id = p.id AND sm.posted_at = p.posted_at
        LEFT JOIN topic_suggestions s ON s.id = sm.suggestion_id AND s.status = 'pending'
        WHERE c.relevance = 'relevant' AND c.topic_id IS NULL
          AND p.is_redacted = false AND p.status NOT IN ('filtered_out','duplicate')
          AND (${q.programId ?? null}::uuid IS NULL OR c.program_id = ${q.programId ?? null}::uuid)
        ORDER BY p.posted_at DESC LIMIT 100`;
    return { items: redactRows([...items]) };
  });

  app.post('/classification/interactions/:id/topic-feedback', {
    preHandler: [app.requirePermission(PERMISSIONS.FEEDBACK_WRITE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = feedbackSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    const [current] = await sql<{
      posted_at: Date | string; text: string; topic_id: string | null;
      topic_name: string | null; relevance_confidence: string | null;
      stage: number; program_id: string | null;
    }[]>`
      SELECT p.posted_at, p.text, c.topic_id, t.name_ar AS topic_name,
             c.relevance_confidence, c.stage, c.program_id
      FROM posts p
      JOIN post_classifications c ON c.post_id = p.id AND c.posted_at = p.posted_at
      LEFT JOIN topics t ON t.id = c.topic_id
      WHERE p.id = ${id}::uuid LIMIT 1`;
    if (!current) throw notFound('التفاعل غير موجود');

    let finalTopicId = parsed.data.correct ? current.topic_id : (parsed.data.correctTopicId ?? null);
    if (finalTopicId) {
      const [valid] = await sql<{ id: string }[]>`
        SELECT id FROM topics WHERE id = ${finalTopicId}::uuid AND is_active
          AND (${current.program_id}::uuid IS NULL OR program_id = ${current.program_id}::uuid)`;
      if (!valid) throw badRequest('الموضوع المصحح غير موجود ضمن برنامج التفاعل');
    }

    await sql`
      INSERT INTO ai_feedback (
        post_id, posted_at, feedback_type, ai_value, ai_confidence, ai_stage,
        human_value, reason, post_text_snapshot, created_by
      ) VALUES (
        ${id}::uuid, ${current.posted_at}::timestamptz, 'topic',
        ${current.topic_name ?? 'unclassified'}, ${current.relevance_confidence}, ${current.stage},
        ${parsed.data.correct ? 'correct' : (finalTopicId ?? 'unclassified')},
        ${parsed.data.reason ?? null}, ${redactSensitiveText(current.text)}, ${req.user.id}::uuid
      )`;
    await sql`
      UPDATE post_classifications SET topic_id = ${finalTopicId}::uuid,
        human_corrected = true, corrected_by = ${req.user.id}::uuid, corrected_at = now(),
        model = 'human_feedback', stage = 3
      WHERE post_id = ${id}::uuid AND posted_at = ${current.posted_at}::timestamptz`;

    // A manual decision always wins over a pending model suggestion. Detach
    // the post so a later bulk approval cannot overwrite the human choice.
    const detached = await sql<{ suggestion_id: string }[]>`
      DELETE FROM topic_suggestion_members sm
      USING topic_suggestions s
      WHERE sm.suggestion_id = s.id AND s.status = 'pending'
        AND sm.post_id = ${id}::uuid AND sm.posted_at = ${current.posted_at}::timestamptz
      RETURNING sm.suggestion_id`;
    for (const { suggestion_id: suggestionId } of detached) {
      const [remaining] = await sql<{ member_count: string; average_embedding: string | null }[]>`
        SELECT count(*)::text AS member_count, avg(pe.embedding)::text AS average_embedding
        FROM topic_suggestion_members sm
        LEFT JOIN post_embeddings pe ON pe.post_id = sm.post_id AND pe.posted_at = sm.posted_at
        WHERE sm.suggestion_id = ${suggestionId}::uuid`;
      if (Number(remaining?.member_count ?? 0) === 0) {
        await sql`
          UPDATE topic_suggestions SET status = 'rejected',
            review_note = 'أُغلق تلقائياً بعد نقل آخر تفاعل بقرار بشري',
            reviewed_by = ${req.user.id}::uuid, reviewed_at = now(), updated_at = now()
          WHERE id = ${suggestionId}::uuid AND status = 'pending'`;
      } else {
        await sql`
          UPDATE topic_suggestions SET support_count = ${Number(remaining.member_count)},
            centroid = coalesce(${remaining.average_embedding}::vector, centroid), updated_at = now()
          WHERE id = ${suggestionId}::uuid`;
      }
    }

    // Confirmed members improve the centroid; rejected assignments are never
    // included in the average.
    if (finalTopicId) {
      await sql`
        UPDATE topics t SET centroid = x.average_embedding, updated_at = now()
        FROM (
          SELECT c.topic_id, avg(pe.embedding) AS average_embedding
          FROM post_classifications c
          JOIN post_embeddings pe ON pe.post_id = c.post_id AND pe.posted_at = c.posted_at
          WHERE c.topic_id = ${finalTopicId}::uuid AND c.human_corrected
          GROUP BY c.topic_id
        ) x
        WHERE t.id = x.topic_id`;
    }
    if (current.topic_id && current.topic_id !== finalTopicId) {
      await sql`
        UPDATE topics t SET centroid = x.average_embedding, updated_at = now()
        FROM (
          SELECT c.topic_id, avg(pe.embedding) AS average_embedding
          FROM post_classifications c
          JOIN post_embeddings pe ON pe.post_id = c.post_id AND pe.posted_at = c.posted_at
          WHERE c.topic_id = ${current.topic_id}::uuid AND c.human_corrected
          GROUP BY c.topic_id
        ) x
        WHERE t.id = x.topic_id`;
    }
    await sql`
      UPDATE topics t SET post_count = (
        SELECT count(*) FROM post_classifications c WHERE c.topic_id = t.id
      )
      WHERE t.id = ${current.topic_id}::uuid OR t.id = ${finalTopicId}::uuid`;
    await audit(req, {
      action: 'classification.topic_feedback', entityType: 'post', entityId: id,
      oldValue: { topicId: current.topic_id }, newValue: { correct: parsed.data.correct, topicId: finalTopicId },
    });
    return { ok: true, topicId: finalTopicId };
  });

  /** "لمحة عن المصنف" — where the candidate pool actually went: linked, still pending, or excluded. */
  app.get('/classification/stats', {
    preHandler: [app.requirePermission(PERMISSIONS.TOPICS_READ)],
  }, async (req) => {
    const { programId } = req.query as { programId?: string };

    const [pool] = await sql<{
      total_relevant: string; linked_stage2: string; linked_stage3: string;
      pending: string; excluded: string;
    }[]>`
      SELECT
        count(*) FILTER (WHERE c.relevance = 'relevant')::text AS total_relevant,
        count(*) FILTER (WHERE c.relevance = 'relevant' AND c.topic_id IS NOT NULL AND c.stage = 2)::text AS linked_stage2,
        count(*) FILTER (WHERE c.relevance = 'relevant' AND c.topic_id IS NOT NULL AND c.stage = 3)::text AS linked_stage3,
        count(*) FILTER (WHERE c.relevance = 'relevant' AND c.topic_id IS NULL AND pe.post_id IS NULL)::text AS pending,
        count(*) FILTER (WHERE c.relevance = 'relevant' AND c.topic_id IS NULL AND pe.post_id IS NOT NULL)::text AS excluded
      FROM post_classifications c
      JOIN posts p ON p.id = c.post_id AND p.posted_at = c.posted_at
      LEFT JOIN post_embeddings pe ON pe.post_id = p.id AND pe.posted_at = p.posted_at
      WHERE p.is_redacted = false
        AND (${programId ?? null}::uuid IS NULL OR c.program_id = ${programId ?? null}::uuid)`;

    const [topicCounts] = await sql<{ total: string; manual: string; llm_auto: string }[]>`
      SELECT count(*)::text AS total,
             count(*) FILTER (WHERE source = 'manual')::text AS manual,
             count(*) FILTER (WHERE source = 'llm_auto')::text AS llm_auto
      FROM topics
      WHERE is_active AND (${programId ?? null}::uuid IS NULL OR program_id = ${programId ?? null}::uuid)`;

    return {
      totalRelevant: Number(pool?.total_relevant ?? 0),
      linkedStage2: Number(pool?.linked_stage2 ?? 0),
      linkedStage3: Number(pool?.linked_stage3 ?? 0),
      pending: Number(pool?.pending ?? 0),
      excluded: Number(pool?.excluded ?? 0),
      topics: {
        total: Number(topicCounts?.total ?? 0),
        manual: Number(topicCounts?.manual ?? 0),
        llmAuto: Number(topicCounts?.llm_auto ?? 0),
      },
      suggestions: await (async () => {
        const [row] = await sql<{ pending: string; eligible: string }[]>`
          SELECT count(*) FILTER (WHERE status = 'pending')::text AS pending,
                 count(*) FILTER (WHERE status = 'pending' AND support_count >= ${config.TOPIC_SUGGESTION_MIN_SUPPORT})::text AS eligible
          FROM topic_suggestions
          WHERE (${programId ?? null}::uuid IS NULL OR program_id = ${programId ?? null}::uuid)`;
        return { pending: Number(row?.pending ?? 0), eligible: Number(row?.eligible ?? 0) };
      })(),
    };
  });
}
