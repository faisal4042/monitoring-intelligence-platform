/** Programs, services and the keyword dictionary. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, normalizeArabic } from '@mip/db';
import { PERMISSIONS, KEYWORD_TYPES } from '@mip/shared';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';

const MATCH_MODES = ['term', 'phrase', 'hashtag', 'mention', 'from'] as const;

const keywordSchema = z.object({
  groupId: z.string().uuid(),
  term: z.string().min(1).max(120),
  matchMode: z.enum(MATCH_MODES).default('term'),
  weight: z.number().min(0).max(10).default(1),
  notes: z.string().max(500).optional(),
});

const keywordPatchSchema = z.object({
  term: z.string().trim().min(1).max(120).optional(),
  matchMode: z.enum(MATCH_MODES).optional(),
  weight: z.number().min(0).max(10).optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
}).strict().refine((b) => Object.keys(b).length > 0, 'لا يوجد ما يُعدَّل');

const groupCreateSchema = z.object({
  programId: z.string().uuid(),
  nameAr: z.string().trim().min(1).max(120),
  type: z.enum(KEYWORD_TYPES),
  description: z.string().trim().max(500).optional(),
}).strict();

const groupPatchSchema = z.object({
  nameAr: z.string().trim().min(1).max(120).optional(),
  type: z.enum(KEYWORD_TYPES).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
}).strict().refine((b) => Object.keys(b).length > 0, 'لا يوجد ما يُعدَّل');

const programPatchSchema = z.object({
  nameAr: z.string().trim().min(1).max(120).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  isActive: z.boolean().optional(),
  budgetSharePct: z.number().min(0).max(100).optional(),
}).strict().refine((b) => Object.keys(b).length > 0, 'لا يوجد ما يُعدَّل');

/** Single words stay `term`; a multi-word entry is matched as an exact phrase. */
const effectiveMode = (term: string, mode: string) => (mode === 'term' && term.trim().includes(' ') ? 'phrase' : mode);

export default async function catalogRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  // ── Programs ────────────────────────────────────────────────────
  app.get('/programs', { preHandler: [app.requirePermission(PERMISSIONS.PROGRAMS_READ)] }, async () => {
    const rows = await sql`
      SELECT p.*,
        (SELECT count(*) FROM services s WHERE s.program_id = p.id AND s.is_active)::int AS service_count,
        (SELECT count(*) FROM keywords k WHERE k.program_id = p.id AND k.is_active)::int AS keyword_count,
        (SELECT count(*) FROM queries q WHERE q.program_id = p.id AND q.deleted_at IS NULL)::int AS query_count
      FROM programs p
      WHERE p.deleted_at IS NULL
      ORDER BY p.budget_share_pct DESC NULLS LAST, p.name_ar`;
    return { items: rows };
  });

  app.get('/programs/:id/services', { preHandler: [app.requirePermission(PERMISSIONS.PROGRAMS_READ)] }, async (req) => {
    const { id } = req.params as { id: string };
    return { items: await sql`SELECT * FROM services WHERE program_id = ${id}::uuid ORDER BY name_ar` };
  });

  app.post('/programs', {
    preHandler: [app.requirePermission(PERMISSIONS.ADMIN_SYSTEM)],
  }, async (req, reply) => {
    const parsed = z.object({
      key: z.string().trim().min(2).max(64).regex(/^[a-z][a-z0-9_-]*$/),
      nameAr: z.string().trim().min(1).max(120),
      nameEn: z.string().trim().max(120).optional(),
      description: z.string().trim().max(1000).optional(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#0E2A47'),
      isActive: z.boolean().default(true),
    }).strict().safeParse(req.body);
    if (!parsed.success) throw badRequest('تحقق من اسم البرنامج والمعرّف واللون. المعرّف يبدأ بحرف إنجليزي صغير ويحتوي على أحرف وأرقام وشرطة فقط.');
    const body = parsed.data;
    const program = await sql.begin(async tx => {
      const [created] = await tx`
        INSERT INTO programs (key, name_ar, name_en, description, color, is_active, created_by)
        VALUES (${body.key}, ${body.nameAr}, ${body.nameEn || body.nameAr},
                ${body.description || null}, ${body.color}, ${body.isActive}, ${req.user.id}::uuid)
        ON CONFLICT (key) DO NOTHING RETURNING *`;
      if (!created) throw conflict('معرّف البرنامج مستخدم بالفعل. اختر معرّفًا آخر.');
      await audit(req, {
        action: 'program.create', entityType: 'program', entityId: created.id,
        entityLabel: created.name_ar, newValue: created,
      }, tx);
      return created;
    });
    return reply.code(201).send(program);
  });

  app.patch('/programs/:id', {
    preHandler: [app.requirePermission(PERMISSIONS.PROGRAMS_WRITE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = programPatchSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const body = parsed.data;

    const [before] = await sql`SELECT * FROM programs WHERE id = ${id}::uuid AND deleted_at IS NULL`;
    if (!before) throw notFound('البرنامج غير موجود');

    const [after] = await sql`
      UPDATE programs SET
        name_ar = COALESCE(${body.nameAr ?? null}, name_ar),
        color = COALESCE(${body.color ?? null}, color),
        is_active = COALESCE(${body.isActive ?? null}, is_active),
        budget_share_pct = COALESCE(${body.budgetSharePct ?? null}, budget_share_pct),
        updated_at = now()
      WHERE id = ${id}::uuid RETURNING *`;

    await audit(req, {
      action: body.isActive !== undefined && body.isActive !== before.is_active
        ? (body.isActive ? 'program.activate' : 'program.deactivate') : 'program.update',
      entityType: 'program', entityId: id,
      entityLabel: after.name_ar, oldValue: before, newValue: after,
      severity: body.isActive === false ? 'warning' : 'info',
    });
    return after;
  });

  // ── Keyword groups & keywords ───────────────────────────────────
  app.get('/keyword-groups', { preHandler: [app.requirePermission(PERMISSIONS.KEYWORDS_READ)] }, async (req) => {
    const { programId, includeInactive } = req.query as { programId?: string; includeInactive?: string };
    // Inactive groups are listed only on request (dictionary management); builders keep seeing active ones.
    const withInactive = includeInactive === '1' || includeInactive === 'true';
    const rows = await sql`
      SELECT g.*, p.name_ar AS program_name, p.color AS program_color, p.key AS program_key,
             (SELECT count(*) FROM keywords k WHERE k.group_id = g.id AND k.is_active)::int AS keyword_count
      FROM keyword_groups g
      LEFT JOIN programs p ON p.id = g.program_id
      WHERE (g.is_active OR ${withInactive})
        AND (${programId ?? null}::uuid IS NULL OR g.program_id = ${programId ?? null}::uuid)
      ORDER BY p.name_ar, array_position(ARRAY['primary','service','related','negative','sensitive']::text[], g.type::text), g.created_at`;
    return { items: rows };
  });

  app.post('/keyword-groups', {
    preHandler: [app.requirePermission(PERMISSIONS.KEYWORDS_WRITE)],
  }, async (req, reply) => {
    const parsed = groupCreateSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('تحقق من البرنامج واسم المجموعة ونوعها.');
    const input = parsed.data;
    const group = await sql.begin(async (tx) => {
      const [program] = await tx<{ id: string; key: string }[]>`
        SELECT id, key FROM programs WHERE id = ${input.programId}::uuid AND deleted_at IS NULL`;
      if (!program) throw notFound('البرنامج غير موجود');
      // Serialises group creation per program so the generated key and the name check cannot race.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${'keyword_groups:' + program.id}))`;
      const [sameName] = await tx`
        SELECT 1 FROM keyword_groups
        WHERE program_id = ${program.id}::uuid AND lower(name_ar) = lower(${input.nameAr})`;
      if (sameName) throw conflict('توجد مجموعة بهذا الاسم في البرنامج نفسه.');
      const base = `${program.key}_${input.type}`.replace(/[^a-z0-9_-]/g, '_');
      const taken = new Set((await tx<{ key: string }[]>`
        SELECT key FROM keyword_groups WHERE program_id = ${program.id}::uuid AND key LIKE ${base + '%'}`).map((r) => r.key));
      let key = base;
      for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
      const [created] = await tx`
        INSERT INTO keyword_groups (program_id, key, name_ar, type, description)
        VALUES (${program.id}::uuid, ${key}, ${input.nameAr}, ${input.type}::keyword_type, ${input.description || null})
        RETURNING *`;
      await audit(req, {
        action: 'keyword_group.create', entityType: 'keyword_group', entityId: created.id,
        entityLabel: created.name_ar, newValue: created,
      }, tx);
      return created;
    });
    return reply.code(201).send(group);
  });

  app.patch('/keyword-groups/:id', {
    preHandler: [app.requirePermission(PERMISSIONS.KEYWORDS_WRITE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = groupPatchSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const body = parsed.data;
    return sql.begin(async (tx) => {
      const [before] = await tx`SELECT * FROM keyword_groups WHERE id = ${id}::uuid FOR UPDATE`;
      if (!before) throw notFound('المجموعة غير موجودة');
      if (body.nameAr !== undefined && body.nameAr.toLowerCase() !== String(before.name_ar).toLowerCase()) {
        const [sameName] = await tx`
          SELECT 1 FROM keyword_groups
          WHERE program_id IS NOT DISTINCT FROM ${before.program_id} AND id <> ${id}::uuid
            AND lower(name_ar) = lower(${body.nameAr})`;
        if (sameName) throw conflict('توجد مجموعة بهذا الاسم في البرنامج نفسه.');
      }
      const [after] = await tx`
        UPDATE keyword_groups SET
          name_ar = COALESCE(${body.nameAr ?? null}, name_ar),
          type = COALESCE(${body.type ?? null}::keyword_type, type),
          description = CASE WHEN ${body.description !== undefined} THEN ${body.description ?? null} ELSE description END,
          is_active = COALESCE(${body.isActive ?? null}, is_active),
          updated_at = now()
        WHERE id = ${id}::uuid RETURNING *`;
      // keywords.type mirrors its group's type; keep them consistent in the same transaction.
      let retyped = 0;
      if (body.type && body.type !== before.type) {
        retyped = (await tx`UPDATE keywords SET type = ${body.type}::keyword_type, updated_at = now()
                            WHERE group_id = ${id}::uuid RETURNING id`).length;
      }
      const action = body.isActive !== undefined && body.isActive !== before.is_active
        ? (body.isActive ? 'keyword_group.activate' : 'keyword_group.deactivate') : 'keyword_group.update';
      await audit(req, {
        action, entityType: 'keyword_group', entityId: id, entityLabel: after.name_ar,
        oldValue: before, newValue: { ...after, keywordsRetyped: retyped },
        severity: body.isActive === false || retyped > 0 ? 'warning' : 'info',
      }, tx);
      return after;
    });
  });

  app.get('/keywords', { preHandler: [app.requirePermission(PERMISSIONS.KEYWORDS_READ)] }, async (req) => {
    const { programId, type, groupId, q, includeInactive } = req.query as Record<string, string | undefined>;
    const withInactive = includeInactive === '1' || includeInactive === 'true';
    const rows = await sql`
      SELECT k.*, g.name_ar AS group_name, p.name_ar AS program_name,
             (SELECT count(*) FROM keyword_aliases a WHERE a.keyword_id = k.id AND a.is_active)::int AS alias_count
      FROM keywords k
      JOIN keyword_groups g ON g.id = k.group_id
      LEFT JOIN programs p ON p.id = k.program_id
      WHERE (k.is_active OR ${withInactive})
        AND (${programId ?? null}::uuid IS NULL OR k.program_id = ${programId ?? null}::uuid)
        AND (${groupId ?? null}::uuid  IS NULL OR k.group_id = ${groupId ?? null}::uuid)
        AND (${type ?? null}::text IS NULL OR k.type::text = ${type ?? null})
        AND (${q ?? null}::text IS NULL OR k.term_normalized LIKE '%' || ${q ? normalizeArabic(q) : ''} || '%')
      ORDER BY k.type, k.term
      LIMIT 2000`;
    return { items: rows };
  });

  app.post('/keywords', {
    preHandler: [app.requirePermission(PERMISSIONS.KEYWORDS_WRITE)],
  }, async (req) => {
    const parsed = keywordSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const input = parsed.data;

    const [group] = await sql<{ id: string; type: string; program_id: string | null; is_active: boolean }[]>`
      SELECT id, type::text, program_id, is_active FROM keyword_groups WHERE id = ${input.groupId}::uuid`;
    if (!group) throw notFound('المجموعة غير موجودة');
    if (!group.is_active) throw conflict('المجموعة معطّلة. فعّلها أولًا ثم أضف الكلمات.');

    const term = input.term.trim();
    const normalized = normalizeArabic(term);
    if (!normalized) throw badRequest('الكلمة فارغة بعد التطبيع');
    const mode = effectiveMode(term, input.matchMode);

    const [created] = await sql`
      INSERT INTO keywords (group_id, program_id, term, term_normalized, type, match_mode, weight, notes, created_by)
      VALUES (${group.id}::uuid, ${group.program_id}, ${term}, ${normalized},
              ${group.type}::keyword_type, ${mode}, ${input.weight}, ${input.notes ?? null}, ${req.user.id}::uuid)
      ON CONFLICT (group_id, term_normalized) DO NOTHING
      RETURNING *`;
    if (created) {
      await audit(req, {
        action: 'keyword.create', entityType: 'keyword', entityId: created.id,
        entityLabel: term, newValue: { term, type: group.type, groupId: group.id },
      });
      return created;
    }

    // Same normalized term already in this group: an active one is a duplicate,
    // a disabled one is restored instead of being created twice.
    const [existing] = await sql`
      SELECT * FROM keywords WHERE group_id = ${group.id}::uuid AND term_normalized = ${normalized}`;
    if (!existing) throw conflict('تعذّر حفظ الكلمة. أعد المحاولة.');
    if (existing.is_active) throw conflict(`«${existing.term}» موجودة بالفعل في هذه المجموعة (بعد توحيد الكتابة).`);
    const [restored] = await sql`
      UPDATE keywords SET is_active = true, term = ${term}, updated_at = now()
      WHERE id = ${existing.id}::uuid AND NOT is_active RETURNING *`;
    if (!restored) throw conflict(`«${term}» موجودة بالفعل في هذه المجموعة.`);
    await audit(req, {
      action: 'keyword.reactivate', entityType: 'keyword', entityId: restored.id,
      entityLabel: term, oldValue: { is_active: false, term: existing.term }, newValue: { is_active: true, term },
    });
    return restored;
  });

  app.patch('/keywords/:id', {
    preHandler: [app.requirePermission(PERMISSIONS.KEYWORDS_WRITE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = keywordPatchSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const body = parsed.data;
    return sql.begin(async (tx) => {
      const [before] = await tx`SELECT * FROM keywords WHERE id = ${id}::uuid FOR UPDATE`;
      if (!before) throw notFound('الكلمة غير موجودة');
      const term = body.term ?? before.term;
      const normalized = body.term !== undefined ? normalizeArabic(term) : before.term_normalized;
      if (!normalized) throw badRequest('الكلمة فارغة بعد التطبيع');
      if (normalized !== before.term_normalized) {
        const [dup] = await tx`SELECT term FROM keywords
          WHERE group_id = ${before.group_id}::uuid AND term_normalized = ${normalized} AND id <> ${id}::uuid`;
        if (dup) throw conflict(`«${dup.term}» موجودة بالفعل في هذه المجموعة (بعد توحيد الكتابة).`);
      }
      const mode = effectiveMode(term, body.matchMode ?? before.match_mode);
      const [after] = await tx`
        UPDATE keywords SET
          term = ${term}, term_normalized = ${normalized}, match_mode = ${mode},
          weight = COALESCE(${body.weight ?? null}::numeric, weight),
          notes = CASE WHEN ${body.notes !== undefined} THEN ${body.notes || null} ELSE notes END,
          is_active = COALESCE(${body.isActive ?? null}, is_active),
          updated_at = now()
        WHERE id = ${id}::uuid RETURNING *`;
      const onlyToggle = Object.keys(body).length === 1 && body.isActive !== undefined;
      await audit(req, {
        action: onlyToggle ? (body.isActive ? 'keyword.reactivate' : 'keyword.delete') : 'keyword.update',
        entityType: 'keyword', entityId: id, entityLabel: after.term,
        oldValue: { term: before.term, match_mode: before.match_mode, weight: before.weight, notes: before.notes, is_active: before.is_active },
        newValue: { term: after.term, match_mode: after.match_mode, weight: after.weight, notes: after.notes, is_active: after.is_active },
        severity: body.isActive === false ? 'warning' : 'info',
      }, tx);
      return after;
    });
  });

  app.delete('/keywords/:id', {
    preHandler: [app.requirePermission(PERMISSIONS.KEYWORDS_WRITE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const [row] = await sql`UPDATE keywords SET is_active = false, updated_at = now()
                            WHERE id = ${id}::uuid RETURNING *`;
    if (!row) throw notFound('الكلمة غير موجودة');
    await audit(req, {
      action: 'keyword.delete', entityType: 'keyword', entityId: id,
      entityLabel: row.term, oldValue: { term: row.term }, severity: 'warning',
    });
    return { ok: true };
  });

  app.get('/keywords/:id/aliases', { preHandler: [app.requirePermission(PERMISSIONS.KEYWORDS_READ)] }, async (req) => {
    const { id } = req.params as { id: string };
    return { items: await sql`SELECT * FROM keyword_aliases WHERE keyword_id = ${id}::uuid AND is_active ORDER BY alias_type, alias` };
  });

  app.post('/keywords/:id/aliases', {
    preHandler: [app.requirePermission(PERMISSIONS.KEYWORDS_WRITE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { alias: string; aliasType: string };
    if (!body?.alias) throw badRequest('المرادف مطلوب');
    const [row] = await sql`
      INSERT INTO keyword_aliases (keyword_id, alias, alias_normalized, alias_type)
      VALUES (${id}::uuid, ${body.alias}, ${normalizeArabic(body.alias)}, ${body.aliasType ?? 'synonym'})
      ON CONFLICT (keyword_id, alias_normalized) DO UPDATE SET is_active = true
      RETURNING *`;
    await audit(req, { action: 'keyword.alias_add', entityType: 'keyword', entityId: id, entityLabel: body.alias });
    return row;
  });

  /**
   * Per-keyword performance. noise_rate is what turns the dictionary from a
   * list into a cost-control instrument.
   */
  app.get('/keywords/performance', { preHandler: [app.requirePermission(PERMISSIONS.KEYWORDS_READ)] }, async (req) => {
    const { programId } = req.query as { programId?: string };
    return {
      items: await sql`
        SELECT k.id, k.term, k.type, k.match_count, k.relevant_count, k.irrelevant_count,
               k.noise_rate::float, p.name_ar AS program_name
        FROM keywords k
        LEFT JOIN programs p ON p.id = k.program_id
        WHERE k.is_active AND k.match_count > 0
          AND (${programId ?? null}::uuid IS NULL OR k.program_id = ${programId ?? null}::uuid)
        ORDER BY k.noise_rate DESC NULLS LAST, k.match_count DESC
        LIMIT 100`,
    };
  });

  // ── Settings ────────────────────────────────────────────────────
  app.get('/settings', {
    preHandler: [app.requirePermission(PERMISSIONS.SETTINGS_READ)],
  }, async () => ({
    items: await sql`SELECT key, value, value_type, category, description_ar, updated_at
                     FROM settings WHERE NOT is_sensitive ORDER BY category, key`,
  }));

  app.put('/settings/:key', {
    preHandler: [app.requirePermission(PERMISSIONS.SETTINGS_WRITE)],
  }, async (req) => {
    const { key } = req.params as { key: string };
    const body = req.body as { value: unknown };

    const [before] = await sql`SELECT * FROM settings WHERE key = ${key}`;
    if (!before) throw notFound('الإعداد غير موجود');

    const [after] = await sql`
      UPDATE settings SET value = ${JSON.stringify(body.value)}::jsonb,
                          updated_at = now(), updated_by = ${req.user.id}::uuid
      WHERE key = ${key} RETURNING *`;

    await sql`INSERT INTO settings_history (key, old_value, new_value, changed_by)
              VALUES (${key}, ${JSON.stringify(before.value)}::jsonb,
                      ${JSON.stringify(body.value)}::jsonb, ${req.user.id}::uuid)`;

    await audit(req, {
      action: 'settings.update', entityType: 'setting', entityLabel: key,
      oldValue: before.value, newValue: body.value, severity: 'warning',
    });
    return after;
  });
}
