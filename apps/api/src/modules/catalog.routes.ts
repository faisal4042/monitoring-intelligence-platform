/** Programs, services and the keyword dictionary. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, normalizeArabic } from '@mip/db';
import { PERMISSIONS, KEYWORD_TYPES } from '@mip/shared';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';

const keywordSchema = z.object({
  groupId: z.string().uuid(),
  term: z.string().min(1).max(120),
  matchMode: z.enum(['term', 'phrase', 'hashtag', 'mention', 'from']).default('term'),
  weight: z.number().min(0).max(10).default(1),
  notes: z.string().max(500).optional(),
});

export default async function catalogRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  // ── Programs ────────────────────────────────────────────────────
  app.get('/programs', async () => {
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

  app.get('/programs/:id/services', async (req) => {
    const { id } = req.params as { id: string };
    return { items: await sql`SELECT * FROM services WHERE program_id = ${id}::uuid ORDER BY name_ar` };
  });

  app.patch('/programs/:id', {
    preHandler: [app.requirePermission(PERMISSIONS.PROGRAMS_WRITE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { nameAr?: string; color?: string; isActive?: boolean; budgetSharePct?: number };

    const [before] = await sql`SELECT * FROM programs WHERE id = ${id}::uuid`;
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
      action: 'program.update', entityType: 'program', entityId: id,
      entityLabel: after.name_ar, oldValue: before, newValue: after,
    });
    return after;
  });

  // ── Keyword groups & keywords ───────────────────────────────────
  app.get('/keyword-groups', async (req) => {
    const { programId } = req.query as { programId?: string };
    const rows = await sql`
      SELECT g.*, p.name_ar AS program_name, p.color AS program_color,
             (SELECT count(*) FROM keywords k WHERE k.group_id = g.id AND k.is_active)::int AS keyword_count
      FROM keyword_groups g
      LEFT JOIN programs p ON p.id = g.program_id
      WHERE g.is_active AND (${programId ?? null}::uuid IS NULL OR g.program_id = ${programId ?? null}::uuid)
      ORDER BY p.name_ar, array_position(ARRAY['primary','service','related','negative','sensitive']::text[], g.type::text)`;
    return { items: rows };
  });

  app.get('/keywords', async (req) => {
    const { programId, type, groupId, q } = req.query as Record<string, string | undefined>;
    const rows = await sql`
      SELECT k.*, g.name_ar AS group_name, p.name_ar AS program_name,
             (SELECT count(*) FROM keyword_aliases a WHERE a.keyword_id = k.id AND a.is_active)::int AS alias_count
      FROM keywords k
      JOIN keyword_groups g ON g.id = k.group_id
      LEFT JOIN programs p ON p.id = k.program_id
      WHERE k.is_active
        AND (${programId ?? null}::uuid IS NULL OR k.program_id = ${programId ?? null}::uuid)
        AND (${groupId ?? null}::uuid  IS NULL OR k.group_id = ${groupId ?? null}::uuid)
        AND (${type ?? null}::text IS NULL OR k.type::text = ${type ?? null})
        AND (${q ?? null}::text IS NULL OR k.term_normalized LIKE '%' || ${q ? normalizeArabic(q) : ''} || '%')
      ORDER BY k.type, k.term
      LIMIT 500`;
    return { items: rows };
  });

  app.post('/keywords', {
    preHandler: [app.requirePermission(PERMISSIONS.KEYWORDS_WRITE)],
  }, async (req) => {
    const parsed = keywordSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const input = parsed.data;

    const [group] = await sql<{ id: string; type: string; program_id: string | null }[]>`
      SELECT id, type::text, program_id FROM keyword_groups WHERE id = ${input.groupId}::uuid`;
    if (!group) throw notFound('المجموعة غير موجودة');

    const normalized = normalizeArabic(input.term);
    if (!normalized) throw badRequest('الكلمة فارغة بعد التطبيع');

    const mode = input.matchMode === 'term' && input.term.trim().includes(' ') ? 'phrase' : input.matchMode;

    const [row] = await sql`
      INSERT INTO keywords (group_id, program_id, term, term_normalized, type, match_mode, weight, notes, created_by)
      VALUES (${group.id}::uuid, ${group.program_id}, ${input.term}, ${normalized},
              ${group.type}::keyword_type, ${mode}, ${input.weight}, ${input.notes ?? null}, ${req.user.id}::uuid)
      ON CONFLICT (group_id, term_normalized) DO UPDATE SET is_active = true, term = EXCLUDED.term
      RETURNING *`;

    await audit(req, {
      action: 'keyword.create', entityType: 'keyword', entityId: row.id,
      entityLabel: input.term, newValue: { term: input.term, type: group.type },
    });
    return row;
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

  app.get('/keywords/:id/aliases', async (req) => {
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
  app.get('/keywords/performance', async (req) => {
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
