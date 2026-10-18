/** Query CRUD, compilation, estimation, versioning, the Sandbox and promotion. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, normalizeArabic, contentHash, type Transaction } from '@mip/db';
import { PERMISSIONS, queryNodeSchema, type QueryNode } from '@mip/shared';
import { xApiGateway, getPricing } from '@mip/x-collector';
import { compileQuery, estimateQuery } from './compiler.js';
import { loadDictionary, classify, keywordContribution, buildRecommendations } from '../classification/classifier.js';
import { badRequest, notFound, conflict, forbidden } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';

/** System queries are owned by the dictionary sync: pausable, never edited or deleted by hand. */
const IS_SYSTEM = sql`(q.description LIKE '[system:auto-%')`;
const isSystemQuery = (description: string | null) => (description ?? '').startsWith('[system:auto-');

const createSchema = z.object({
  programId: z.string().uuid(),
  serviceId: z.string().uuid().nullable().optional(),
  name: z.string().min(2).max(120),
  description: z.string().max(500).optional(),
  ast: queryNodeSchema,
  maxResultsPerCall: z.number().int().min(10).max(100).default(50),
  maxPagesPerRun: z.number().int().min(1).max(5).default(1),
  pollIntervalMinutes: z.number().int().min(5).max(1440).default(5),
});

async function minPrecision(): Promise<number> {
  const [row] = await sql<{ value: number }[]>`
    SELECT value::text::float AS value FROM settings WHERE key = 'classification.min_precision_to_promote'`;
  return row?.value ?? 0.7;
}

async function createVersion(queryId: string, ast: QueryNode, userId: string, summary: string, executor: typeof sql | Transaction = sql) {
  const compiled = await compileQuery(ast, executor);
  const estimate = await estimateQuery(ast, 50, executor);
  const [{ next }] = await executor<{ next: number }[]>`
    SELECT COALESCE(MAX(version), 0) + 1 AS next FROM query_versions WHERE query_id = ${queryId}::uuid`;

  const [version] = await executor`
    INSERT INTO query_versions (query_id, version, ast, compiled, compiled_length,
                                breadth_score, noise_risk_score, estimated_units_per_run,
                                change_summary, created_by)
    VALUES (${queryId}::uuid, ${next}, ${JSON.stringify(ast)}::jsonb, ${compiled}, ${compiled.length},
            ${estimate.breadthScore}, ${estimate.noiseRiskScore}, ${estimate.estimatedUnitsPerRun},
            ${summary}, ${userId}::uuid)
    RETURNING *`;

  await executor`UPDATE queries SET current_version_id = ${version.id}::uuid, updated_at = now()
            WHERE id = ${queryId}::uuid`;
  return { version, compiled, estimate };
}

export default async function queryRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  // ── Free tools: compile & estimate cost nothing and touch no API ──
  app.post('/compile', { preHandler: [app.requirePermission(PERMISSIONS.QUERIES_READ)] }, async (req) => {
    const parsed = queryNodeSchema.safeParse((req.body as { ast: unknown }).ast);
    if (!parsed.success) throw badRequest('بنية الاستعلام غير صالحة');
    return { compiled: await compileQuery(parsed.data) };
  });

  app.post('/estimate', { preHandler: [app.requirePermission(PERMISSIONS.QUERIES_READ)] }, async (req) => {
    const body = req.body as { ast: unknown; maxResults?: number };
    const parsed = queryNodeSchema.safeParse(body.ast);
    if (!parsed.success) throw badRequest('بنية الاستعلام غير صالحة');
    const [compiled, estimate, pricing] = await Promise.all([
      compileQuery(parsed.data),
      estimateQuery(parsed.data, body.maxResults ?? 50),
      getPricing(),
    ]);
    return {
      compiled,
      ...estimate,
      estimatedCostPerRun: estimate.estimatedUnitsPerRun * pricing.unitPrice,
      unitPrice: pricing.unitPrice,
    };
  });

  // ── List / read ─────────────────────────────────────────────────
  app.get('/', { preHandler: [app.requirePermission(PERMISSIONS.QUERIES_READ)] }, async (req) => {
    const { programId, status, includeDeleted } = req.query as Record<string, string | undefined>;
    const withDeleted = includeDeleted === '1' || includeDeleted === 'true';
    const threshold = await minPrecision();
    const rows = await sql`
      SELECT q.*, p.name_ar AS program_name, p.color AS program_color,
             v.compiled, v.version, v.breadth_score::float, v.noise_risk_score::float,
             ${IS_SYSTEM} AS is_system,
             (SELECT count(*) FROM query_versions qv WHERE qv.query_id = q.id)::int AS version_count,
             (SELECT count(*) FROM query_tests t WHERE t.query_id = q.id)::int AS test_count,
             (SELECT max(precision_score)::float FROM query_tests t WHERE t.query_id = q.id AND t.passed) AS best_precision,
             CASE WHEN ${IS_SYSTEM} THEN 'active'
                  WHEN (SELECT max(precision_score) FROM query_tests t
                        WHERE t.query_version_id = q.current_version_id AND t.status = 'completed') >= ${threshold} THEN 'active'
                  ELSE 'draft' END AS resume_to
      FROM queries q
      JOIN programs p ON p.id = q.program_id
      LEFT JOIN query_versions v ON v.id = q.current_version_id
      WHERE (q.deleted_at IS NULL OR ${withDeleted})
        AND (${programId ?? null}::uuid IS NULL OR q.program_id = ${programId ?? null}::uuid)
        AND (${status ?? null}::text IS NULL OR q.status::text = ${status ?? null})
      ORDER BY q.updated_at DESC`;
    return { items: rows };
  });

  app.get('/:id', { preHandler: [app.requirePermission(PERMISSIONS.QUERIES_READ)] }, async (req) => {
    const { id } = req.params as { id: string };
    const [row] = await sql`
      SELECT q.*, p.name_ar AS program_name, p.color AS program_color,
             v.ast, v.compiled, v.version, v.breadth_score::float, v.noise_risk_score::float,
             ${IS_SYSTEM} AS is_system
      FROM queries q
      JOIN programs p ON p.id = q.program_id
      LEFT JOIN query_versions v ON v.id = q.current_version_id
      WHERE q.id = ${id}::uuid AND q.deleted_at IS NULL`;
    if (!row) throw notFound('الاستعلام غير موجود');
    return row;
  });

  app.get('/:id/versions', { preHandler: [app.requirePermission(PERMISSIONS.QUERIES_READ)] }, async (req) => {
    const { id } = req.params as { id: string };
    return {
      items: await sql`
        SELECT v.*, u.full_name AS created_by_name,
               (SELECT max(precision_score)::float FROM query_tests t WHERE t.query_version_id = v.id) AS tested_precision
        FROM query_versions v
        LEFT JOIN users u ON u.id = v.created_by
        WHERE v.query_id = ${id}::uuid ORDER BY v.version DESC`,
    };
  });

  // ── Create / update — new versions are automatic ─────────────────
  app.post('/', {
    preHandler: [app.requirePermission(PERMISSIONS.QUERIES_WRITE)],
  }, async (req) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const input = parsed.data;

    const [query] = await sql`
      INSERT INTO queries (program_id, service_id, name, description, status,
                           max_results_per_call, max_pages_per_run, poll_interval_minutes, created_by)
      VALUES (${input.programId}::uuid, ${input.serviceId ?? null}, ${input.name},
              ${input.description ?? null}, 'draft',
              ${input.maxResultsPerCall}, ${input.maxPagesPerRun}, 5,
              ${req.user.id}::uuid)
      RETURNING *`;

    const { version, compiled, estimate } = await createVersion(query.id, input.ast, req.user.id, 'الإصدار الأول');

    await audit(req, {
      action: 'query.create', entityType: 'query', entityId: query.id,
      entityLabel: input.name, newValue: { compiled },
    });
    return { ...query, currentVersion: version, compiled, estimate };
  });

  app.patch('/:id', {
    preHandler: [app.requirePermission(PERMISSIONS.QUERIES_WRITE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    return sql.begin(async tx => {
      // Serializes edits/version numbers and re-checks deletion/system ownership under the lock.
      const [before] = await tx`SELECT * FROM queries WHERE id = ${id}::uuid AND deleted_at IS NULL FOR UPDATE`;
      if (!before) throw notFound('الاستعلام غير موجود');
      if (isSystemQuery(before.description)) {
        throw conflict('هذا استعلام تلقائي يُبنى من قاموس الكلمات؛ عدّل القاموس بدلًا منه.');
      }
      const parsed = createSchema.omit({ programId: true, serviceId: true }).partial().extend({
        pollingTier: z.enum(['hot', 'warm', 'cold', 'manual']).optional(),
        changeSummary: z.string().max(500).optional(),
      }).strict().refine(value => Object.keys(value).length > 0).safeParse(req.body);
      if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
      const body = parsed.data;

      await tx`
        UPDATE queries SET
          name = COALESCE(${body.name ?? null}, name),
          description = COALESCE(${body.description ?? null}, description),
          max_results_per_call = COALESCE(${body.maxResultsPerCall ?? null}, max_results_per_call),
          max_pages_per_run = COALESCE(${body.maxPagesPerRun ?? null}, max_pages_per_run),
          poll_interval_minutes = 5,
          polling_tier = COALESCE(${body.pollingTier ?? null}::polling_tier, polling_tier),
          updated_at = now()
        WHERE id = ${id}::uuid RETURNING *`;

      let versionInfo = null;
      if (body.ast !== undefined) {
        versionInfo = await createVersion(id, body.ast, req.user.id, body.changeSummary ?? 'تعديل الاستعلام', tx);

        // Editing the logic invalidates prior testing — back to draft.
        if (['tested', 'approved', 'active'].includes(before.status)) {
          await tx`UPDATE queries SET status = 'draft', is_paused = true,
                    pause_reason = 'تم تعديل الاستعلام — يلزم إعادة الاختبار'
                    WHERE id = ${id}::uuid`;
        }
      }

      // Read after all mutations so response and audit contain the committed version/state.
      const [after] = await tx`SELECT * FROM queries WHERE id = ${id}::uuid`;
      await audit(req, {
        action: 'query.update', entityType: 'query', entityId: id,
        entityLabel: after.name, oldValue: before, newValue: after, severity: 'warning',
      }, tx);
      return { ...after, versionInfo };
    });
  });

  // ── Sandbox — the only manual API spend, and it IS charged ───────
  app.post('/:id/test', {
    preHandler: [app.requirePermission(PERMISSIONS.QUERY_TEST)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { sampleSize?: number };
    const sampleSize = [10, 25, 50, 100].includes(body?.sampleSize ?? 0) ? body.sampleSize! : 25;

    const [query] = await sql<{
      id: string; program_id: string; current_version_id: string; name: string;
    }[]>`SELECT id, program_id, current_version_id, name FROM queries
         WHERE id = ${id}::uuid AND deleted_at IS NULL`;
    if (!query) throw notFound('الاستعلام غير موجود');
    if (!query.current_version_id) throw badRequest('لا يوجد إصدار للاستعلام');

    const [version] = await sql<{ id: string; compiled: string }[]>`
      SELECT id, compiled FROM query_versions WHERE id = ${query.current_version_id}::uuid`;

    const [test] = await sql`
      INSERT INTO query_tests (query_id, query_version_id, sample_size, status, created_by)
      VALUES (${id}::uuid, ${version.id}::uuid, ${sampleSize}, 'running', ${req.user.id}::uuid)
      RETURNING *`;

    const result = await xApiGateway.searchRecent({
      query: version.compiled,
      maxResults: sampleSize,
      purpose: 'test',
      queryId: query.id,
      queryVersionId: version.id,
      programId: query.program_id,
      testId: test.id,
      triggeredBy: req.user.id,
    });

    if (!result.ok) {
      const message = result.denied ? result.denied.messageAr : result.error;
      await sql`UPDATE query_tests SET status = 'failed', error_message = ${message} WHERE id = ${test.id}::uuid`;
      throw badRequest(message ?? 'فشل الاختبار', result.denied?.reason);
    }

    // Full classification of the sample — it is small, so accuracy beats cost.
    const dict = await loadDictionary(query.program_id);
    const classified = result.data.map((p) => ({ post: p, ...classify(p.text, dict) }));

    const counts = {
      relevant: classified.filter((c) => c.relevance === 'relevant').length,
      irrelevant: classified.filter((c) => c.relevance === 'irrelevant').length,
      advertisement: classified.filter((c) => c.relevance === 'advertisement').length,
      spam: classified.filter((c) => c.relevance === 'spam').length,
      unknown: classified.filter((c) => c.relevance === 'unknown').length,
    };

    const judged = classified.length - counts.unknown;
    const precision = judged > 0 ? counts.relevant / judged : 0;
    const contribution = keywordContribution(classified);
    const recommendations = buildRecommendations(
      classified.map((c) => ({ matchedTerms: c.matchedTerms, relevance: c.relevance, text: c.post.text })),
      contribution,
      precision,
    );

    for (const c of classified) {
      await sql`
        INSERT INTO query_test_posts (test_id, x_post_id, text, author_username,
                                      ai_label, ai_confidence, ai_reason_ar, matched_terms)
        VALUES (${test.id}::uuid, ${c.post.id}, ${c.post.text}, ${c.post.author?.username ?? null},
                ${c.relevance}, ${c.confidence}, ${c.reasonAr}, ${c.matchedTerms})`;
    }

    const pricing = await getPricing();
    const cost = result.unitsConsumed * pricing.unitPrice;
    const threshold = await minPrecision();
    const passed = precision >= threshold;

    const [updated] = await sql`
      UPDATE query_tests SET
        posts_returned = ${classified.length},
        count_relevant = ${counts.relevant}, count_irrelevant = ${counts.irrelevant},
        count_advertisement = ${counts.advertisement}, count_spam = ${counts.spam},
        count_unknown = ${counts.unknown},
        precision_score = ${precision}, noise_rate = ${1 - precision},
        units_consumed = ${result.unitsConsumed}, cost_estimate = ${cost},
        recommendations = ${JSON.stringify(recommendations)}::jsonb,
        keyword_contribution = ${JSON.stringify(contribution)}::jsonb,
        passed = ${passed}, status = 'completed'
      WHERE id = ${test.id}::uuid RETURNING *`;

    if (passed) {
      await sql`UPDATE queries SET status = 'tested' WHERE id = ${id}::uuid AND status = 'draft'`;
    }

    // Feed observed noise back into the dictionary so future estimates improve.
    for (const [term, stats] of Object.entries(contribution)) {
      await sql`
        UPDATE keywords SET
          match_count = match_count + ${stats.matched},
          irrelevant_count = irrelevant_count + ${stats.noise},
          relevant_count = relevant_count + ${stats.matched - stats.noise},
          noise_rate = CASE WHEN match_count + ${stats.matched} > 0
            THEN (irrelevant_count + ${stats.noise})::numeric / (match_count + ${stats.matched})
            ELSE NULL END
        WHERE term = ${term} AND program_id = ${query.program_id}::uuid`;
    }

    await audit(req, {
      action: 'query.test', entityType: 'query', entityId: id, entityLabel: query.name,
      newValue: { sampleSize, precision, unitsConsumed: result.unitsConsumed, mode: result.mode },
    });

    return {
      test: updated,
      mode: result.mode,
      posts: classified.map((c) => ({
        id: c.post.id, text: c.post.text,
        author: c.post.author?.username, authorName: c.post.author?.name,
        followers: c.post.author?.followersCount,
        label: c.relevance, confidence: c.confidence, reasonAr: c.reasonAr,
        matchedTerms: c.matchedTerms, intent: c.intent, sentiment: c.sentiment,
        metrics: c.post.metrics, createdAt: c.post.createdAt,
      })),
      recommendations,
      contribution,
    };
  });

  app.get('/:id/tests', { preHandler: [app.requirePermission(PERMISSIONS.QUERIES_READ)] }, async (req) => {
    const { id } = req.params as { id: string };
    return {
      items: await sql`
        SELECT t.*, v.version, u.full_name AS created_by_name
        FROM query_tests t
        JOIN query_versions v ON v.id = t.query_version_id
        LEFT JOIN users u ON u.id = t.created_by
        WHERE t.query_id = ${id}::uuid ORDER BY t.created_at DESC LIMIT 50`,
    };
  });

  app.get('/tests/:testId', { preHandler: [app.requirePermission(PERMISSIONS.QUERIES_READ)] }, async (req) => {
    const { testId } = req.params as { testId: string };
    const [test] = await sql`SELECT * FROM query_tests WHERE id = ${testId}::uuid`;
    if (!test) throw notFound('الاختبار غير موجود');
    const posts = await sql`SELECT * FROM query_test_posts WHERE test_id = ${testId}::uuid ORDER BY created_at`;
    return { test, posts };
  });

  /** Human correction on a sample post — feeds ai_feedback for retraining. */
  app.post('/tests/posts/:postId/label', {
    preHandler: [app.requirePermission(PERMISSIONS.FEEDBACK_WRITE)],
  }, async (req) => {
    const { postId } = req.params as { postId: string };
    const body = req.body as { label: string };
    const [row] = await sql`
      UPDATE query_test_posts SET human_label = ${body.label} WHERE id = ${postId}::uuid RETURNING *`;
    if (!row) throw notFound('المنشور غير موجود');

    if (row.ai_label !== body.label) {
      await sql`
        INSERT INTO ai_feedback (test_post_id, feedback_type, ai_value, ai_confidence,
                                 human_value, post_text_snapshot, created_by)
        VALUES (${postId}::uuid, 'relevance', ${row.ai_label}, ${row.ai_confidence},
                ${body.label}, ${row.text}, ${req.user.id}::uuid)`;
    }
    return row;
  });

  // ── Promotion gate ──────────────────────────────────────────────
  app.post('/:id/promote', {
    preHandler: [app.requirePermission(PERMISSIONS.QUERY_PROMOTE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const [query] = await sql`SELECT * FROM queries WHERE id = ${id}::uuid AND deleted_at IS NULL`;
    if (!query) throw notFound('الاستعلام غير موجود');

    const threshold = await minPrecision();
    const [best] = await sql<{ precision_score: string | null }[]>`
      SELECT max(precision_score) AS precision_score FROM query_tests
      WHERE query_version_id = ${query.current_version_id}::uuid AND status = 'completed'`;

    const precision = best?.precision_score === null || best?.precision_score === undefined
      ? null : Number(best.precision_score);

    // The gate that keeps untested queries out of production.
    if (precision === null) {
      throw conflict('لا يمكن ترقية استعلام لم يُختبر. شغّل اختبار Sandbox أولاً.');
    }
    if (precision < threshold) {
      throw conflict(
        `الدقة ${Math.round(precision * 100)}% أقل من الحد الأدنى ${Math.round(threshold * 100)}%. حسّن الاستعلام ثم أعد الاختبار.`,
      );
    }

    const [updated] = await sql`
      UPDATE queries SET status = 'active', is_paused = false, pause_reason = NULL,
                         next_run_at = now(), precision_rate = ${precision}, updated_at = now()
      WHERE id = ${id}::uuid RETURNING *`;

    await audit(req, {
      action: 'query.promote', entityType: 'query', entityId: id, entityLabel: query.name,
      oldValue: { status: query.status }, newValue: { status: 'active', precision },
      severity: 'critical',
    });
    return updated;
  });

  app.post('/:id/pause', {
    preHandler: [app.requirePermission(PERMISSIONS.QUERIES_WRITE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const { reason } = (req.body ?? {}) as { reason?: string };
    const pauseReason = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 300) : 'إيقاف يدوي';
    return sql.begin(async (tx) => {
      const [before] = await tx`SELECT * FROM queries WHERE id = ${id}::uuid AND deleted_at IS NULL FOR UPDATE`;
      if (!before) throw notFound('الاستعلام غير موجود');
      if (before.status === 'paused' && before.is_paused) return before; // already paused: no-op
      if (before.status !== 'active') throw conflict('لا يُوقف إلا استعلام نشط.');
      const [row] = await tx`
        UPDATE queries SET is_paused = true, status = 'paused',
                           pause_reason = ${pauseReason}, updated_at = now()
        WHERE id = ${id}::uuid RETURNING *`;
      await audit(req, {
        action: 'query.pause', entityType: 'query', entityId: id, entityLabel: row.name,
        oldValue: { status: before.status, is_paused: before.is_paused },
        newValue: { status: 'paused', is_paused: true }, reason: pauseReason, severity: 'warning',
      }, tx);
      return row;
    });
  });

  // Resume. System queries return to active; a manual query returns to active only
  // when it already meets the promote gate (best completed test of the current version >= threshold),
  // otherwise to draft so the Sandbox rule is never bypassed. Going active needs
  // query:promote, the same permission that promotes a query.
  app.post('/:id/resume', {
    preHandler: [app.requirePermission(PERMISSIONS.QUERIES_WRITE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const threshold = await minPrecision();
    return sql.begin(async (tx) => {
      const [before] = await tx`SELECT * FROM queries WHERE id = ${id}::uuid AND deleted_at IS NULL FOR UPDATE`;
      if (!before) throw notFound('الاستعلام غير موجود');
      if (before.status !== 'paused') throw conflict('الاستعلام ليس موقوفًا.');
      const system = isSystemQuery(before.description);
      // Same gate as promote: completed tests of the CURRENT version only.
      const [best] = await tx<{ precision: number | null }[]>`
        SELECT max(precision_score)::float AS precision FROM query_tests
        WHERE query_version_id = ${before.current_version_id}::uuid AND status = 'completed'`;
      const target = system || (best?.precision ?? -1) >= threshold ? 'active' : 'draft';
      if (target === 'active' && !req.user.permissions.includes(PERMISSIONS.QUERY_PROMOTE)) {
        throw forbidden('استئناف الجمع يتطلب صلاحية ترقية الاستعلامات.');
      }
      if (target === 'active' && !before.current_version_id) throw conflict('لا توجد نسخة فعالة للاستعلام.');
      const [row] = await tx`
        UPDATE queries SET status = ${target}::query_status, is_paused = false, pause_reason = NULL,
          next_run_at = CASE WHEN ${target} = 'active' THEN now() ELSE next_run_at END, updated_at = now()
        WHERE id = ${id}::uuid RETURNING *`;
      await audit(req, {
        action: 'query.resume', entityType: 'query', entityId: id, entityLabel: row.name,
        oldValue: { status: before.status, is_paused: before.is_paused, pause_reason: before.pause_reason },
        newValue: { status: target, is_paused: false, system }, severity: target === 'active' ? 'critical' : 'info',
      }, tx);
      return row;
    });
  });

  // Soft delete: manual queries only. Versions, tests and every post that points at
  // the query stay untouched; the row is hidden and can never be collected again.
  app.delete('/:id', {
    preHandler: [app.requirePermission(PERMISSIONS.QUERIES_WRITE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    return sql.begin(async (tx) => {
      const [before] = await tx`SELECT * FROM queries WHERE id = ${id}::uuid AND deleted_at IS NULL FOR UPDATE`;
      if (!before) throw notFound('الاستعلام غير موجود');
      if (isSystemQuery(before.description)) {
        throw conflict('الاستعلامات التلقائية لا تُحذف؛ يمكن إيقافها فقط.');
      }
      const [row] = await tx`
        UPDATE queries SET deleted_at = now(), status = 'archived', is_paused = true,
          pause_reason = 'حذف منطقي', updated_at = now()
        WHERE id = ${id}::uuid RETURNING id, name, deleted_at`;
      const [{ versions }] = await tx<{ versions: number }[]>`
        SELECT count(*)::int AS versions FROM query_versions WHERE query_id = ${id}::uuid`;
      await audit(req, {
        action: 'query.delete', entityType: 'query', entityId: id, entityLabel: before.name,
        oldValue: { status: before.status, is_paused: before.is_paused, deleted_at: null },
        newValue: { status: 'archived', deleted_at: row.deleted_at, versionsKept: versions },
        severity: 'warning',
      }, tx);
      return { ok: true, id: row.id, deletedAt: row.deleted_at, versionsKept: versions };
    });
  });
}
