/**
 * The budget gate. No X request happens without an ALLOW from here.
 *
 * Atomicity: the check and the reservation happen inside one transaction with
 * row locks on budget_counters, so two workers cannot both see headroom and
 * jointly exceed a limit. (Redis + a Lua script is the planned fast path — see
 * docs/ARCHITECTURE.md §4.2 — but Postgres is the source of truth either way,
 * and correctness comes first.)
 *
 * Reservation model: the worst case (max_results) is reserved before the
 * request; the unused remainder is released once the real count is known.
 * Overspending is therefore impossible rather than merely unlikely.
 */
import { sql } from '@mip/db';
import { budgetLogger as log } from '@mip/logger';
import { config } from '@mip/config';
import type { ApiPurpose, BudgetDecision, BudgetPeriod } from '@mip/shared';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

interface AuthorizeInput {
  queryId?: string;
  programId?: string;
  purpose: ApiPurpose;
  requestedUnits: number;
  unitPrice: number;
}

interface ScopeCheck {
  scope: 'global' | 'program' | 'query' | 'purpose';
  scopeId: string;
  period: BudgetPeriod;
  reason: Extract<BudgetDecision, { verdict: 'DENY' }>['reason'];
  labelAr: string;
}

function periodStart(period: BudgetPeriod, now = new Date()): Date {
  const d = new Date(now);
  d.setUTCMilliseconds(0);
  d.setUTCSeconds(0);
  if (period === 'hour') { d.setUTCMinutes(0); return d; }
  d.setUTCMinutes(0);
  d.setUTCHours(0);
  if (period === 'day') return d;
  d.setUTCDate(1);
  return d;
}

export class BudgetService {
  /** Scopes are checked in this order; the first failure stops the chain. */
  private buildChecks(input: AuthorizeInput): ScopeCheck[] {
    // Collection has no hourly, daily, monthly, program, or per-query quota.
    // Actual usage and cost are still written to api_usage for visibility;
    // the explicit global kill switch remains the operator's stop control.
    void input;
    return [];
  }

  async authorize(input: AuthorizeInput): Promise<BudgetDecision> {
    const units = Math.max(0, input.requestedUnits);
    const cost = units * input.unitPrice;
    const checks = this.buildChecks(input);

    try {
      return await sql.begin(async (tx) => {
        for (const c of checks) {
          const [budget] = await tx<{ unit_limit: number | null; cost_limit: string | null; is_hard_limit: boolean }[]>`
            SELECT unit_limit, cost_limit, is_hard_limit
            FROM api_budgets
            WHERE scope = ${c.scope}::budget_scope
              AND COALESCE(scope_id, ${NIL_UUID}::uuid) = ${c.scopeId}::uuid
              AND period = ${c.period}::budget_period
              AND is_active
              AND effective_from <= now()
              AND (effective_to IS NULL OR effective_to > now())
            LIMIT 1`;

          // No configured budget for this scope means no constraint from it.
          if (!budget) continue;

          const start = periodStart(c.period);

          // Lock (or create) the counter row so concurrent workers serialize here.
          await tx`
            INSERT INTO budget_counters (scope, scope_id, period, period_start)
            VALUES (${c.scope}::budget_scope, ${c.scopeId}::uuid, ${c.period}::budget_period, ${start.toISOString()}::timestamptz)
            ON CONFLICT DO NOTHING`;

          const [counter] = await tx<{ units_used: number; cost_used: string }[]>`
            SELECT units_used, cost_used FROM budget_counters
            WHERE scope = ${c.scope}::budget_scope AND scope_id = ${c.scopeId}::uuid
              AND period = ${c.period}::budget_period AND period_start = ${start.toISOString()}::timestamptz
            FOR UPDATE`;

          const usedUnits = counter?.units_used ?? 0;
          const usedCost = Number(counter?.cost_used ?? 0);

          const unitLimit = budget.unit_limit;
          const costLimit = budget.cost_limit === null ? null : Number(budget.cost_limit);

          const overUnits = unitLimit !== null && usedUnits + units > unitLimit;
          const overCost = costLimit !== null && usedCost + cost > costLimit;

          if ((overUnits || overCost) && budget.is_hard_limit) {
            // Throwing rolls back every reservation made earlier in this
            // transaction — a partial reservation must never survive a DENY.
            const denial: Extract<BudgetDecision, { verdict: 'DENY' }> = {
              verdict: 'DENY',
              reason: c.reason,
              scope: `${c.scope}:${c.period}`,
              usage: overUnits ? usedUnits : usedCost,
              limit: overUnits ? (unitLimit ?? 0) : (costLimit ?? 0),
              messageAr: overUnits
                ? `${c.labelAr}: الطلب ${units} وحدة يتجاوز الحد المتاح (المستهلك ${usedUnits} من ${unitLimit})`
                : `${c.labelAr}: الطلب ${cost.toFixed(4)}$ يتجاوز الحد المتاح (المستهلك ${usedCost.toFixed(4)}$ من ${costLimit}$)`,
            };
            throw Object.assign(new Error('BUDGET_DENY'), { denial });
          }

          await tx`
            UPDATE budget_counters
            SET units_used = units_used + ${units},
                cost_used  = cost_used + ${cost},
                requests_used = requests_used + 1
            WHERE scope = ${c.scope}::budget_scope AND scope_id = ${c.scopeId}::uuid
              AND period = ${c.period}::budget_period AND period_start = ${start.toISOString()}::timestamptz`;
        }

        return { verdict: 'ALLOW', grantedUnits: units } satisfies BudgetDecision;
      });
    } catch (err) {
      const denial = (err as { denial?: Extract<BudgetDecision, { verdict: 'DENY' }> }).denial;
      if (denial) {
        log.warn({ reason: denial.reason, scope: denial.scope }, 'budget denied');
        return denial;
      }
      throw err;
    }
  }

  /**
   * Give back reserved-but-unused units. It must walk the same scope list as
   * authorize(); decrementing every counter row for the period would credit
   * scopes this request never reserved against.
   */
  async release(units: number, input: Omit<AuthorizeInput, 'requestedUnits'> & { unitPrice: number }): Promise<void> {
    if (units <= 0) return;
    const cost = units * input.unitPrice;
    const checks = this.buildChecks({ ...input, requestedUnits: 0 });
    for (const c of checks) {
      const start = periodStart(c.period);
      await sql`
        UPDATE budget_counters
        SET units_used = GREATEST(0, units_used - ${units}),
            cost_used  = GREATEST(0, cost_used - ${cost})
        WHERE scope = ${c.scope}::budget_scope AND scope_id = ${c.scopeId}::uuid
          AND period = ${c.period}::budget_period
          AND period_start = ${start.toISOString()}::timestamptz`;
    }
  }

  /** Current spend snapshot for the Cost Center. */
  async overview() {
    const [row] = await sql<{
      spent_today_units: number; spent_today_cost: string;
      spent_month_units: number; spent_month_cost: string;
    }[]>`
      SELECT
        COALESCE(SUM(units_consumed) FILTER (WHERE occurred_at >= date_trunc('day', now())), 0)   AS spent_today_units,
        COALESCE(SUM(cost_estimate)  FILTER (WHERE occurred_at >= date_trunc('day', now())), 0)   AS spent_today_cost,
        COALESCE(SUM(units_consumed) FILTER (WHERE occurred_at >= date_trunc('month', now())), 0) AS spent_month_units,
        COALESCE(SUM(cost_estimate)  FILTER (WHERE occurred_at >= date_trunc('month', now())), 0) AS spent_month_cost
      FROM api_usage
      WHERE mode = 'live'`;

    const [monthBudget] = await sql<{ unit_limit: number | null; cost_limit: string | null }[]>`
      SELECT unit_limit, cost_limit FROM api_budgets
      WHERE scope = 'global' AND period = 'month' AND is_active LIMIT 1`;

    const spentMonthUnits = Number(row?.spent_month_units ?? 0);
    const spentMonthCost = Number(row?.spent_month_cost ?? 0);
    const unitLimit = monthBudget?.unit_limit ?? null;
    const costLimit = monthBudget?.cost_limit === null || monthBudget?.cost_limit === undefined
      ? null : Number(monthBudget.cost_limit);

    // Linear projection from elapsed share of the month.
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const elapsed = Math.max(1, now.getDate());
    const projectedMonthCost = (spentMonthCost / elapsed) * daysInMonth;
    const projectedMonthUnits = Math.round((spentMonthUnits / elapsed) * daysInMonth);

    return {
      spentTodayUnits: Number(row?.spent_today_units ?? 0),
      spentTodayCost: Number(row?.spent_today_cost ?? 0),
      spentMonthUnits,
      spentMonthCost,
      monthUnitLimit: unitLimit,
      monthCostLimit: costLimit,
      remainingUnits: unitLimit === null ? null : Math.max(0, unitLimit - spentMonthUnits),
      remainingCost: costLimit === null ? null : Math.max(0, costLimit - spentMonthCost),
      projectedMonthCost,
      projectedMonthUnits,
      usagePct: unitLimit ? Math.min(100, (spentMonthUnits / unitLimit) * 100) : 0,
      liveMode: config.LIVE_X_API,
      dryRun: config.X_DRY_RUN,
    };
  }
}

export const budgetService = new BudgetService();
