/** Cost Center: spend, budgets, per-query analytics, denials and the kill switch. */
import type { FastifyInstance } from 'fastify';
import { sql } from '@mip/db';
import { PERMISSIONS } from '@mip/shared';
import { budgetService, usageService, killSwitchService, getPricing } from '@mip/x-collector';
import { config } from '@mip/config';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';

export default async function costRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requirePermission(PERMISSIONS.COST_READ));

  app.get('/overview', async () => {
    const [overview, pricing, kills] = await Promise.all([
      budgetService.overview(),
      getPricing(),
      killSwitchService.list(),
    ]);

    // Cost per relevant post — the real efficiency measure, not raw spend.
    const [eff] = await sql<{ relevant: number; cost: string; issues: number }[]>`
      SELECT
        COALESCE((SELECT SUM(total_relevant) FROM queries WHERE deleted_at IS NULL), 0)::int AS relevant,
        COALESCE((SELECT SUM(cost_estimate) FROM api_usage WHERE mode = 'live'), 0) AS cost,
        0::int AS issues`;

    const relevant = Number(eff?.relevant ?? 0);
    const cost = Number(eff?.cost ?? 0);

    const [lastUpdate] = await sql<{ occurred_at: Date | string }[]>`
      SELECT occurred_at FROM api_usage WHERE error_code IS NULL ORDER BY occurred_at DESC LIMIT 1`;

    return {
      ...overview,
      pricing,
      costPerRelevantPost: relevant > 0 ? cost / relevant : null,
      totalRelevant: relevant,
      killSwitches: kills,
      collectionMode: config.LIVE_X_API ? (config.X_DRY_RUN ? 'dry_run' : 'live') : 'demo',
      lastUpdatedAt: lastUpdate?.occurred_at ?? null,
    };
  });

  app.get('/usage/timeline', async (req) => {
    const { days } = req.query as { days?: string };
    return { items: await usageService.timeline(Number(days ?? 14)) };
  });

  /** The table that exposes a query burning budget for nothing. */
  app.get('/queries', async (req) => {
    const { days } = req.query as { days?: string };
    const rows = (await usageService.byQuery(Number(days ?? 30))) as Array<Record<string, unknown>>;
    const pricing = await getPricing();

    return {
      unitPrice: pricing.unitPrice,
      items: rows.map((r) => {
        const units = Number(r.units ?? 0);
        const relevant = Number(r.relevant ?? 0);
        const irrelevant = Number(r.irrelevant ?? 0);
        const judged = relevant + irrelevant;
        const cost = Number(r.cost ?? 0);
        const liveRequests = Number(r.live_requests ?? 0);
        const emptyRequests = Number(r.empty_requests ?? 0);
        return {
          ...r,
          units, relevant, irrelevant, cost, liveRequests, emptyRequests,
          emptyRequestPct: liveRequests > 0 ? emptyRequests / liveRequests : null,
          unitsPerRelevant: relevant > 0 ? units / relevant : null,
          precision: judged > 0 ? relevant / judged : null,
          noisePct: judged > 0 ? irrelevant / judged : null,
          costPerRelevant: relevant > 0 ? cost / relevant : null,
          wastedCost: judged > 0 ? cost * (irrelevant / judged) : 0,
        };
      }),
    };
  });

  app.get('/denials', async () => ({ items: await usageService.recentDenials(100) }));

  app.get('/budgets', async () => ({
    items: await sql`
      SELECT b.*, p.name_ar AS program_name, p.color AS program_color,
             c.units_used, c.cost_used::float
      FROM api_budgets b
      LEFT JOIN programs p ON p.id = b.scope_id
      LEFT JOIN budget_counters c
        ON c.scope = b.scope
       AND c.scope_id = COALESCE(b.scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
       AND c.period = b.period
       AND c.period_start = date_trunc(b.period::text, now())
      WHERE b.is_active
      ORDER BY b.scope, b.period`,
  }));

  app.put('/budgets/:id', {
    preHandler: [app.requirePermission(PERMISSIONS.BUDGET_WRITE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { unitLimit?: number; costLimit?: number; isHardLimit?: boolean; isActive?: boolean };

    const [before] = await sql`SELECT * FROM api_budgets WHERE id = ${id}::uuid`;
    if (!before) throw notFound('الميزانية غير موجودة');

    const [after] = await sql`
      UPDATE api_budgets SET
        unit_limit = COALESCE(${body.unitLimit ?? null}, unit_limit),
        cost_limit = COALESCE(${body.costLimit ?? null}, cost_limit),
        is_hard_limit = COALESCE(${body.isHardLimit ?? null}, is_hard_limit),
        is_active = COALESCE(${body.isActive ?? null}, is_active),
        updated_at = now(), updated_by = ${req.user.id}::uuid
      WHERE id = ${id}::uuid RETURNING *`;

    await audit(req, {
      action: 'budget.update', entityType: 'budget', entityId: id,
      entityLabel: `${before.scope}:${before.period}`,
      oldValue: before, newValue: after, severity: 'critical',
    });
    return after;
  });

  // ── Kill switch ─────────────────────────────────────────────────
  app.get('/kill-switch', async () => ({ items: await killSwitchService.list() }));

  app.post('/kill-switch', {
    preHandler: [app.requirePermission(PERMISSIONS.KILLSWITCH_OPERATE)],
  }, async (req) => {
    const body = req.body as { scope?: string; targetId?: string; reason?: string };
    if (!body?.scope || !['global', 'program', 'query', 'source'].includes(body.scope)) {
      throw badRequest('نطاق غير صالح');
    }
    // A reason is mandatory — an unexplained stop is useless in an audit trail.
    if (!body.reason?.trim()) throw badRequest('السبب مطلوب');

    const row = await killSwitchService.activate({
      scope: body.scope,
      targetId: body.targetId ?? null,
      reason: body.reason.trim(),
      userId: req.user.id,
    });

    await audit(req, {
      action: 'killswitch.activate', entityType: 'kill_switch',
      entityId: (row as { id?: string })?.id ?? null,
      entityLabel: `${body.scope}${body.targetId ? ':' + body.targetId : ''}`,
      newValue: { scope: body.scope, targetId: body.targetId },
      reason: body.reason, severity: 'critical',
    });

    return row ?? { alreadyActive: true };
  });

  app.delete('/kill-switch/:id', {
    preHandler: [app.requirePermission(PERMISSIONS.KILLSWITCH_OPERATE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await killSwitchService.deactivate(id, req.user.id);
    if (!row) throw notFound('لا يوجد إيقاف نشط بهذا المعرّف');
    await audit(req, {
      action: 'killswitch.deactivate', entityType: 'kill_switch', entityId: id,
      oldValue: row, severity: 'critical',
    });
    return { ok: true };
  });
}
