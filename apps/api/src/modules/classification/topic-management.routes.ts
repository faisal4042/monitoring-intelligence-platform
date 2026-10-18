import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '@mip/db';
import { PERMISSIONS } from '@mip/shared';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { redactRows } from '../../lib/privacy.js';

const updateTopicSchema = z.object({
  nameAr: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  serviceId: z.string().uuid().nullable().optional(),
});

const mergeSchema = z.object({
  targetTopicId: z.string().uuid(),
  note: z.string().trim().max(1000).optional(),
});

const keywordSchema = z.object({
  term: z.string().trim().min(2).max(200),
  kind: z.enum(['alias', 'include', 'exclude']).default('alias'),
});

export default async function topicManagementRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get('/topic-management', {
    preHandler: [app.requirePermission(PERMISSIONS.TOPICS_READ)],
  }, async (req) => {
    const q = req.query as { programId?: string; includeArchived?: string; reviewOnly?: string };
    const includeArchived = q.includeArchived !== 'false';
    const reviewOnly = q.reviewOnly === 'true';
    return {
      items: await sql`
        SELECT t.id, t.program_id, t.service_id, t.parent_id, t.level,
               t.name_ar, t.description, t.source, t.is_active,
               t.created_at, t.updated_at, (t.centroid IS NOT NULL) AS has_centroid,
               p.name_ar AS program_name, p.color AS program_color,
               sv.name_ar AS service_name, parent.name_ar AS parent_name,
               count(c.post_id)::int AS post_count,
               count(c.post_id) FILTER (WHERE c.human_corrected)::int AS human_reviewed_count,
               count(c.post_id) FILTER (WHERE NOT c.human_corrected)::int AS automatic_count,
               max(c.posted_at) AS last_activity_at,
               avg(1 - (pe.embedding <=> t.centroid))::float AS avg_similarity,
               (SELECT count(*)::int FROM topics child WHERE child.parent_id = t.id AND child.is_active) AS children_count,
               coalesce((
                 SELECT jsonb_agg(jsonb_build_object(
                   'id', tk.id, 'term', tk.term, 'kind', tk.kind
                 ) ORDER BY tk.kind, tk.term)
                 FROM topic_keywords tk WHERE tk.topic_id = t.id
               ), '[]'::jsonb) AS keywords,
               latest_merge.target_topic_id AS merged_into_id,
               merged_target.name_ar AS merged_into_name
        FROM topics t
        JOIN programs p ON p.id = t.program_id
        LEFT JOIN services sv ON sv.id = t.service_id
        LEFT JOIN topics parent ON parent.id = t.parent_id
        LEFT JOIN post_classifications c ON c.topic_id = t.id
        LEFT JOIN post_embeddings pe ON pe.post_id = c.post_id AND pe.posted_at = c.posted_at
        LEFT JOIN LATERAL (
          SELECT mh.target_topic_id
          FROM topic_merge_history mh
          WHERE mh.source_topic_id = t.id
          ORDER BY mh.merged_at DESC LIMIT 1
        ) latest_merge ON true
        LEFT JOIN topics merged_target ON merged_target.id = latest_merge.target_topic_id
        WHERE (${q.programId ?? null}::uuid IS NULL OR t.program_id = ${q.programId ?? null}::uuid)
          AND (${includeArchived} OR t.is_active)
        GROUP BY t.id, p.id, sv.id, parent.id, latest_merge.target_topic_id, merged_target.id
        HAVING (NOT ${reviewOnly}) OR (
          t.is_active AND (count(c.post_id) < 3 OR max(c.posted_at) < now() - interval '30 days')
        )
        ORDER BY t.is_active DESC, t.level, coalesce(parent.name_ar, t.name_ar), t.name_ar`,
    };
  });

  app.get('/topics/:id/similar', {
    preHandler: [app.requirePermission(PERMISSIONS.TOPICS_READ)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const [topic] = await sql<{ id: string }[]>`SELECT id FROM topics WHERE id = ${id}::uuid`;
    if (!topic) throw notFound('الموضوع غير موجود');
    return {
      items: await sql`
        SELECT other.id, other.name_ar, other.is_active,
               (1 - (other.centroid <=> current.centroid))::float AS similarity
        FROM topics current
        JOIN topics other ON other.program_id = current.program_id
          AND other.id <> current.id AND other.centroid IS NOT NULL
        WHERE current.id = ${id}::uuid AND current.centroid IS NOT NULL
        ORDER BY other.centroid <=> current.centroid
        LIMIT 5`,
    };
  });

  app.patch('/topics/:id/manage', {
    preHandler: [app.requirePermission(PERMISSIONS.TOPICS_MANAGE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = updateTopicSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const input = parsed.data;
    const [current] = await sql<{
      id: string; program_id: string; name_ar: string; description: string | null;
      parent_id: string | null; service_id: string | null; level: number;
    }[]>`
      SELECT id, program_id, name_ar, description, parent_id, service_id, level
      FROM topics WHERE id = ${id}::uuid`;
    if (!current) throw notFound('الموضوع غير موجود');

    const [duplicate] = await sql<{ id: string; name_ar: string }[]>`
      SELECT id, name_ar FROM topics
      WHERE program_id = ${current.program_id}::uuid AND id <> ${id}::uuid AND is_active
        AND lower(regexp_replace(btrim(name_ar), '\\s+', ' ', 'g')) =
            lower(regexp_replace(btrim(${input.nameAr}), '\\s+', ' ', 'g'))
      LIMIT 1`;
    if (duplicate) throw badRequest(`يوجد موضوع مطابق بالفعل: ${duplicate.name_ar}`, 'DUPLICATE_TOPIC');

    if (input.parentId === id) throw badRequest('لا يمكن جعل الموضوع تابعًا لنفسه');
    if (input.parentId) {
      const [parent] = await sql<{ id: string }[]>`
        SELECT id FROM topics WHERE id = ${input.parentId}::uuid
          AND program_id = ${current.program_id}::uuid AND is_active AND level = 1`;
      if (!parent) throw badRequest('الموضوع الرئيسي غير صالح أو من برنامج مختلف');
      const [hasChildren] = await sql<{ exists: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM topics WHERE parent_id = ${id}::uuid AND is_active) AS exists`;
      if (hasChildren?.exists) throw badRequest('انقل المواضيع الفرعية أولاً قبل تحويل هذا الموضوع إلى فرعي');
    }

    const semanticChanged = current.name_ar !== input.nameAr || current.description !== (input.description ?? null);
    const parentId = input.parentId === undefined ? current.parent_id : input.parentId;
    const serviceId = input.serviceId === undefined ? current.service_id : input.serviceId;
    const [updated] = await sql`
      UPDATE topics SET name_ar = ${input.nameAr}, description = ${input.description ?? null},
        parent_id = ${parentId}::uuid, service_id = ${serviceId}::uuid,
        level = ${parentId ? 2 : 1},
        centroid = CASE WHEN ${semanticChanged} THEN NULL ELSE centroid END,
        updated_at = now()
      WHERE id = ${id}::uuid RETURNING *`;
    await audit(req, {
      action: 'topic.update', entityType: 'topic', entityId: id, entityLabel: input.nameAr,
      oldValue: current, newValue: input,
    });
    return { ...updated, needsCentroid: semanticChanged };
  });

  app.post('/topics/:id/archive', {
    preHandler: [app.requirePermission(PERMISSIONS.TOPICS_MANAGE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const rows = await sql<{ id: string; name_ar: string }[]>`
      WITH RECURSIVE tree AS (
        SELECT id FROM topics WHERE id = ${id}::uuid AND is_active
        UNION ALL
        SELECT child.id FROM topics child JOIN tree parent ON child.parent_id = parent.id
        WHERE child.is_active
      )
      UPDATE topics SET is_active = false, updated_at = now()
      WHERE id IN (SELECT id FROM tree)
      RETURNING id, name_ar`;
    if (!rows.length) throw notFound('الموضوع غير موجود أو مؤرشف مسبقًا');
    await audit(req, {
      action: 'topic.archive', entityType: 'topic', entityId: id,
      entityLabel: rows[0].name_ar, newValue: { archivedTopicIds: rows.map((row) => row.id) },
    });
    return { ok: true, archived: rows.length };
  });

  app.post('/topics/:id/restore', {
    preHandler: [app.requirePermission(PERMISSIONS.TOPICS_MANAGE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const [merged] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM topic_merge_history WHERE source_topic_id = ${id}::uuid) AS exists`;
    if (merged?.exists) throw badRequest('هذا الموضوع دُمج في موضوع آخر؛ لا يمكن استعادته كموضوع مستقل');
    const rows = await sql<{ id: string; name_ar: string }[]>`
      WITH RECURSIVE ancestors AS (
        SELECT id, parent_id FROM topics WHERE id = ${id}::uuid
        UNION ALL
        SELECT parent.id, parent.parent_id FROM topics parent
        JOIN ancestors child ON child.parent_id = parent.id
      ), descendants AS (
        SELECT id FROM topics WHERE id = ${id}::uuid
        UNION ALL
        SELECT child.id FROM topics child JOIN descendants parent ON child.parent_id = parent.id
      )
      UPDATE topics SET is_active = true, updated_at = now()
      WHERE id IN (SELECT id FROM ancestors UNION SELECT id FROM descendants)
      RETURNING id, name_ar`;
    if (!rows.length) throw notFound('الموضوع غير موجود');
    await audit(req, {
      action: 'topic.restore', entityType: 'topic', entityId: id,
      entityLabel: rows[0].name_ar, newValue: { restoredTopicIds: rows.map((row) => row.id) },
    });
    return { ok: true, restored: rows.length };
  });

  app.post('/topics/:id/merge', {
    preHandler: [app.requirePermission(PERMISSIONS.TOPICS_MANAGE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = mergeSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    if (id === parsed.data.targetTopicId) throw badRequest('اختر موضوعًا مختلفًا للدمج');

    const [pair] = await sql<{
      source_name: string; source_program: string; source_level: number;
      target_name: string; target_program: string; target_level: number;
    }[]>`
      SELECT source.name_ar AS source_name, source.program_id AS source_program, source.level AS source_level,
             target.name_ar AS target_name, target.program_id AS target_program, target.level AS target_level
      FROM topics source JOIN topics target ON target.id = ${parsed.data.targetTopicId}::uuid AND target.is_active
      WHERE source.id = ${id}::uuid AND source.is_active`;
    if (!pair) throw notFound('موضوع المصدر أو الهدف غير موجود');
    if (pair.source_program !== pair.target_program) throw badRequest('لا يمكن الدمج بين برنامجين مختلفين');

    const [relation] = await sql<{ target_is_descendant: boolean; child_count: string }[]>`
      WITH RECURSIVE descendants AS (
        SELECT id FROM topics WHERE parent_id = ${id}::uuid
        UNION ALL SELECT child.id FROM topics child JOIN descendants d ON child.parent_id = d.id
      )
      SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ${parsed.data.targetTopicId}::uuid) AS target_is_descendant,
             (SELECT count(*)::text FROM topics WHERE parent_id = ${id}::uuid AND is_active) AS child_count`;
    if (relation?.target_is_descendant) throw badRequest('لا يمكن دمج موضوع رئيسي داخل أحد فروعه');
    if (Number(relation?.child_count ?? 0) > 0 && pair.target_level !== 1) {
      throw badRequest('الموضوع له فروع؛ يجب الدمج في موضوع رئيسي');
    }

    const moved = await sql`
      UPDATE post_classifications SET topic_id = ${parsed.data.targetTopicId}::uuid,
        stage = 3, model = 'human_topic_merge', human_corrected = true,
        corrected_by = ${req.user.id}::uuid, corrected_at = now()
      WHERE topic_id = ${id}::uuid RETURNING post_id`;
    const children = await sql`
      UPDATE topics SET parent_id = ${parsed.data.targetTopicId}::uuid, level = 2, updated_at = now()
      WHERE parent_id = ${id}::uuid RETURNING id`;
    await sql`
      INSERT INTO topic_keywords (topic_id, term, kind, created_by)
      SELECT ${parsed.data.targetTopicId}::uuid, term, kind, ${req.user.id}::uuid
      FROM topic_keywords WHERE topic_id = ${id}::uuid
      ON CONFLICT DO NOTHING`;
    await sql`DELETE FROM topic_keywords WHERE topic_id = ${id}::uuid`;
    await sql`UPDATE topics SET is_active = false, updated_at = now() WHERE id = ${id}::uuid`;
    await sql`
      UPDATE topics target SET
        post_count = (SELECT count(*) FROM post_classifications c WHERE c.topic_id = target.id),
        centroid = coalesce((
          SELECT avg(pe.embedding) FROM post_classifications c
          JOIN post_embeddings pe ON pe.post_id = c.post_id AND pe.posted_at = c.posted_at
          WHERE c.topic_id = target.id AND c.human_corrected
        ), target.centroid), updated_at = now()
      WHERE target.id = ${parsed.data.targetTopicId}::uuid`;
    await sql`
      INSERT INTO topic_merge_history (
        source_topic_id, target_topic_id, moved_posts, moved_children, merged_by, note
      ) VALUES (
        ${id}::uuid, ${parsed.data.targetTopicId}::uuid, ${moved.length}, ${children.length},
        ${req.user.id}::uuid, ${parsed.data.note ?? null}
      )`;
    await audit(req, {
      action: 'topic.merge', entityType: 'topic', entityId: parsed.data.targetTopicId,
      entityLabel: pair.target_name,
      oldValue: { sourceTopicId: id, sourceName: pair.source_name },
      newValue: { targetTopicId: parsed.data.targetTopicId, movedPosts: moved.length, movedChildren: children.length },
      reason: parsed.data.note,
    });
    return { ok: true, movedPosts: moved.length, movedChildren: children.length };
  });

  app.post('/topics/:id/keywords', {
    preHandler: [app.requirePermission(PERMISSIONS.TOPICS_MANAGE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = keywordSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const [topic] = await sql<{ name_ar: string }[]>`SELECT name_ar FROM topics WHERE id = ${id}::uuid`;
    if (!topic) throw notFound('الموضوع غير موجود');
    try {
      const [row] = await sql`
        INSERT INTO topic_keywords (topic_id, term, kind, created_by)
        VALUES (${id}::uuid, ${parsed.data.term}, ${parsed.data.kind}, ${req.user.id}::uuid)
        RETURNING id, term, kind`;
      await sql`UPDATE topics SET centroid = NULL, updated_at = now() WHERE id = ${id}::uuid`;
      await audit(req, {
        action: 'topic.keyword_add', entityType: 'topic', entityId: id,
        entityLabel: topic.name_ar, newValue: row,
      });
      return row;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw badRequest('الكلمة مضافة لهذا الموضوع مسبقًا');
      throw error;
    }
  });

  app.delete('/topics/:id/keywords/:keywordId', {
    preHandler: [app.requirePermission(PERMISSIONS.TOPICS_MANAGE)],
  }, async (req) => {
    const { id, keywordId } = req.params as { id: string; keywordId: string };
    const [row] = await sql<{ term: string }[]>`
      DELETE FROM topic_keywords WHERE id = ${keywordId}::uuid AND topic_id = ${id}::uuid
      RETURNING term`;
    if (!row) throw notFound('الكلمة غير موجودة');
    await sql`UPDATE topics SET centroid = NULL, updated_at = now() WHERE id = ${id}::uuid`;
    await audit(req, {
      action: 'topic.keyword_remove', entityType: 'topic', entityId: id,
      newValue: { term: row.term },
    });
    return { ok: true };
  });

  app.get('/topics/:id/interactions', {
    preHandler: [app.requirePermission(PERMISSIONS.TOPICS_READ)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const items = await sql`
        SELECT p.id, p.text, p.posted_at, p.url, p.x_author_id,
               a.username, a.display_name, a.profile_image_url,
               c.program_id, c.human_corrected, c.model,
               (1 - (pe.embedding <=> t.centroid))::float AS similarity
        FROM post_classifications c
        JOIN posts p ON p.id = c.post_id AND p.posted_at = c.posted_at
        JOIN topics t ON t.id = c.topic_id
        LEFT JOIN authors a ON a.id = p.author_id
        LEFT JOIN post_embeddings pe ON pe.post_id = p.id AND pe.posted_at = p.posted_at
        WHERE c.topic_id = ${id}::uuid
        ORDER BY p.posted_at DESC LIMIT 200`;
    return { items: redactRows([...items]) };
  });

  app.get('/topics/:id/audit', {
    preHandler: [app.requirePermission(PERMISSIONS.TOPICS_READ)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    return {
      items: await sql`
        SELECT id, occurred_at, user_email, action, entity_label,
               old_value, new_value, reason, severity
        FROM audit_log
        WHERE entity_type = 'topic'
          AND (entity_id = ${id}::uuid
            OR old_value->>'sourceTopicId' = ${id}
            OR new_value->>'targetTopicId' = ${id})
        ORDER BY occurred_at DESC LIMIT 100`,
    };
  });
}
