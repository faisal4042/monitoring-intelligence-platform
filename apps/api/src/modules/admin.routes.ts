/** Developer Console and audit log. */
import type { FastifyInstance } from 'fastify';
import { sql } from '@mip/db';
import { config, collectionMode } from '@mip/config';
import { PERMISSIONS } from '@mip/shared';

export default async function adminRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get('/system-health', {
    preHandler: [app.requirePermission(PERMISSIONS.ADMIN_SYSTEM)],
  }, async () => {
    const started = Date.now();
    let dbOk = true;
    try { await sql`SELECT 1`; } catch { dbOk = false; }

    const [lastOk] = await sql`
      SELECT occurred_at, endpoint, units_consumed, mode FROM api_usage
      WHERE error_code IS NULL ORDER BY occurred_at DESC LIMIT 1`;
    const [lastFail] = await sql`
      SELECT occurred_at, endpoint, error_code, error_message FROM api_usage
      WHERE error_code IS NOT NULL ORDER BY occurred_at DESC LIMIT 1`;

    // A row in api_denials only proves collection WAS blocked at that moment —
    // the budget could since have been raised or deactivated. What actually
    // matters is whether an active, hard-limit budget is exceeded right now.
    // Mirrors BudgetService's own periodStart() so this checks the same
    // counter row the gate itself would.
    const periodStart = (period: 'hour' | 'day' | 'month') => {
      const d = new Date();
      d.setUTCMilliseconds(0); d.setUTCSeconds(0);
      if (period === 'hour') { d.setUTCMinutes(0); return d; }
      d.setUTCMinutes(0); d.setUTCHours(0);
      if (period === 'day') return d;
      d.setUTCDate(1);
      return d;
    };
    const NIL_UUID = '00000000-0000-0000-0000-000000000000';
    const activeDenial = await sql<{
      scope: string; period: string; unit_limit: number | null; cost_limit: string | null;
      units_used: number; cost_used: string;
    }[]>`
      SELECT b.scope::text, b.period::text, b.unit_limit, b.cost_limit, c.units_used, c.cost_used
      FROM api_budgets b
      JOIN budget_counters c
        ON c.scope = b.scope AND c.scope_id = COALESCE(b.scope_id, ${NIL_UUID}::uuid) AND c.period = b.period
      WHERE b.is_active AND b.is_hard_limit
        AND ((b.period = 'hour' AND c.period_start = ${periodStart('hour').toISOString()}::timestamptz)
          OR (b.period = 'day'  AND c.period_start = ${periodStart('day').toISOString()}::timestamptz)
          OR (b.period = 'month' AND c.period_start = ${periodStart('month').toISOString()}::timestamptz))
        AND ((b.unit_limit IS NOT NULL AND c.units_used >= b.unit_limit)
          OR (b.cost_limit IS NOT NULL AND c.cost_used >= b.cost_limit::numeric))
      ORDER BY b.period LIMIT 1`;
    const lastDenial = activeDenial[0]
      ? {
          occurred_at: new Date().toISOString(),
          reason: activeDenial[0].period.toUpperCase(),
          scope: `${activeDenial[0].scope}:${activeDenial[0].period}`,
          current_usage: activeDenial[0].units_used,
          limit_value: activeDenial[0].unit_limit,
        }
      : null;
    const [counts] = await sql<Record<string, string>[]>`
      SELECT
        (SELECT count(*) FROM posts)                                   AS posts,
        (SELECT count(*) FROM authors)                                 AS authors,
        (SELECT count(*) FROM queries WHERE deleted_at IS NULL)        AS queries,
        (SELECT count(*) FROM queries WHERE status = 'active')         AS active_queries,
        (SELECT count(*) FROM keywords WHERE is_active)                AS keywords,
        (SELECT count(*) FROM api_usage)                               AS api_calls,
        (SELECT count(*) FROM api_denials)                             AS denials,
        (SELECT count(*) FROM kill_switches WHERE is_active)           AS active_kills`;

    // Stage distribution: the cost pyramid must stay measurable.
    const stages = await sql`
      SELECT stage, count(*)::int AS n FROM post_classifications GROUP BY stage ORDER BY stage`;

    return {
      database: { ok: dbOk, latencyMs: Date.now() - started },
      collection: {
        mode: collectionMode,
        liveXApi: config.LIVE_X_API,
        dryRun: config.X_DRY_RUN,
        hasToken: Boolean(config.X_BEARER_TOKEN),
      },
      ai: { serviceUrl: config.AI_SERVICE_URL, allowInternalToExternal: config.ALLOW_INTERNAL_DATA_TO_EXTERNAL_AI },
      lastSuccessfulRequest: lastOk ?? null,
      lastFailedRequest: lastFail ?? null,
      lastBudgetDenial: lastDenial ?? null,
      counts,
      classificationStages: stages,
      // Redis + BullMQ arrive with the worker in Phase 1.D.
      queue: { status: 'not_started', note: 'Worker service scheduled for Phase 1.D' },
    };
  });

  app.get('/audit-log', {
    preHandler: [app.requirePermission(PERMISSIONS.AUDIT_READ)],
  }, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(Number(q.limit ?? 100), 300);
    return {
      items: await sql`
        SELECT * FROM audit_log
        WHERE (${q.action ?? null}::text IS NULL OR action = ${q.action ?? null})
          AND (${q.severity ?? null}::text IS NULL OR severity = ${q.severity ?? null})
        ORDER BY occurred_at DESC LIMIT ${limit}`,
    };
  });

  app.get('/users', {
    preHandler: [app.requirePermission(PERMISSIONS.USERS_WRITE)],
  }, async () => ({
    items: await sql`
      SELECT u.id, u.email, u.full_name, u.is_active, u.last_login_at, u.created_at,
             r.key AS role_key, r.name_ar AS role_name,
             ARRAY(SELECT permission_key FROM user_permissions WHERE user_id = u.id) AS extra_permissions
      FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.deleted_at IS NULL ORDER BY u.created_at`,
  }));

  app.get('/roles', async () => ({
    items: await sql`
      SELECT r.*, ARRAY(SELECT permission_key FROM role_permissions WHERE role_id = r.id) AS permissions
      FROM roles r ORDER BY r.key`,
  }));
}
