/**
 * Every request and every denial is recorded. Denials are as analytically
 * valuable as successes: they show where the budget actually binds.
 *
 * unit_price is stored per row, never computed at read time — otherwise a
 * future price change would silently rewrite history.
 */
import { sql } from '@mip/db';
import type { ApiPurpose } from '@mip/shared';

interface RecordInput {
  endpoint: string;
  purpose: ApiPurpose;
  queryId?: string;
  queryVersionId?: string;
  programId?: string;
  testId?: string;
  unitsConsumed: number;
  postsNew?: number;
  postsDuplicate?: number;
  unitPrice: number;
  costEstimate: number;
  httpStatus?: number | null;
  errorCode?: string;
  errorMessage?: string;
  latencyMs?: number;
  rateLimitRemaining?: number;
  mode: string;
  triggeredBy?: string;
}

interface DenialInput {
  queryId?: string;
  programId?: string;
  purpose: ApiPurpose;
  reason: string;
  scope?: string;
  currentUsage?: number;
  limitValue?: number;
  requestedUnits: number;
}

class UsageService {
  async record(i: RecordInput) {
    await sql`
      INSERT INTO api_usage (
        endpoint, purpose, query_id, query_version_id, program_id, test_id,
        units_consumed, posts_new, posts_duplicate, unit_price, cost_estimate,
        http_status, error_code, error_message, latency_ms, rate_limit_remaining,
        mode, triggered_by
      ) VALUES (
        ${i.endpoint}, ${i.purpose}::api_purpose, ${i.queryId ?? null}, ${i.queryVersionId ?? null},
        ${i.programId ?? null}, ${i.testId ?? null},
        ${i.unitsConsumed}, ${i.postsNew ?? 0}, ${i.postsDuplicate ?? 0},
        ${i.unitPrice}, ${i.costEstimate},
        ${i.httpStatus ?? null}, ${i.errorCode ?? null}, ${i.errorMessage ?? null},
        ${i.latencyMs ?? null}, ${i.rateLimitRemaining ?? null},
        ${i.mode}, ${i.triggeredBy ?? null}
      )`;

    if (i.queryId && i.unitsConsumed > 0) {
      await sql`
        UPDATE queries
        SET total_requests = total_requests + 1,
            total_units = total_units + ${i.unitsConsumed},
            last_run_at = now(), last_success_at = now()
        WHERE id = ${i.queryId}::uuid`;
    }
  }

  async recordDenial(i: DenialInput) {
    await sql`
      INSERT INTO api_denials (query_id, program_id, purpose, reason, scope,
                               current_usage, limit_value, requested_units)
      VALUES (${i.queryId ?? null}, ${i.programId ?? null}, ${i.purpose}::api_purpose,
              ${i.reason}, ${i.scope ?? null}, ${i.currentUsage ?? null},
              ${i.limitValue ?? null}, ${i.requestedUnits})`;
  }

  /** Per-query consumption analytics — the table that exposes a bad query. */
  async byQuery(days = 30) {
    return sql`
      SELECT
        q.id, q.name, q.status, p.name_ar AS program_name, p.color AS program_color,
        COALESCE(SUM(u.requests_count), 0)::int  AS requests,
        COALESCE(SUM(u.requests_count) FILTER (WHERE u.mode = 'live'), 0)::int AS live_requests,
        COALESCE(SUM(u.requests_count) FILTER (WHERE u.mode = 'live' AND u.units_consumed = 0), 0)::int AS empty_requests,
        COALESCE(SUM(u.units_consumed), 0)::int  AS units,
        COALESCE(SUM(u.cost_estimate), 0)::float AS cost,
        q.total_relevant::int   AS relevant,
        q.total_irrelevant::int AS irrelevant,
        q.precision_rate::float AS precision,
        max(u.occurred_at) FILTER (WHERE u.mode = 'live') AS last_live_at
      FROM queries q
      JOIN programs p ON p.id = q.program_id
      LEFT JOIN api_usage u
        ON u.query_id = q.id AND u.occurred_at > now() - (${days} || ' days')::interval
      WHERE q.deleted_at IS NULL
      GROUP BY q.id, q.name, q.status, p.name_ar, p.color
      ORDER BY units DESC`;
  }

  /**
   * byQuery for an explicit window. Unlike byQuery — whose relevant/irrelevant
   * are the queries' lifetime counters — every figure here belongs to the
   * window, so cost per relevant post divides like by like. Spend is dated by
   * when the request ran and posts by when they were collected, i.e. the
   * moment the units were paid for. `from`/`to` are timestamptz literals.
   */
  async byQueryBetween(from: string, to: string) {
    return sql`
      SELECT
        q.id, q.name, q.status, p.name_ar AS program_name, p.color AS program_color,
        COALESCE(u.requests, 0)::int       AS requests,
        COALESCE(u.live_requests, 0)::int  AS live_requests,
        COALESCE(u.empty_requests, 0)::int AS empty_requests,
        COALESCE(u.units, 0)::int          AS units,
        COALESCE(u.cost, 0)::float         AS cost,
        COALESCE(po.relevant, 0)::int      AS relevant,
        COALESCE(po.irrelevant, 0)::int    AS irrelevant,
        u.last_live_at
      FROM queries q
      JOIN programs p ON p.id = q.program_id
      LEFT JOIN LATERAL (
        SELECT SUM(requests_count) AS requests,
               SUM(requests_count) FILTER (WHERE mode = 'live') AS live_requests,
               SUM(requests_count) FILTER (WHERE mode = 'live' AND units_consumed = 0) AS empty_requests,
               SUM(units_consumed) AS units,
               SUM(cost_estimate) AS cost,
               max(occurred_at) FILTER (WHERE mode = 'live') AS last_live_at
        FROM api_usage
        WHERE query_id = q.id AND occurred_at >= ${from}::timestamptz AND occurred_at < ${to}::timestamptz
      ) u ON true
      LEFT JOIN LATERAL (
        -- Same split the collector adds to queries.total_relevant/total_irrelevant.
        SELECT count(*) FILTER (WHERE status <> 'filtered_out') AS relevant,
               count(*) FILTER (WHERE status = 'filtered_out') AS irrelevant
        FROM posts
        WHERE query_id = q.id AND collected_at >= ${from}::timestamptz AND collected_at < ${to}::timestamptz
      ) po ON true
      WHERE q.deleted_at IS NULL
      ORDER BY units DESC`;
  }

  async recentDenials(limit = 50) {
    return sql`
      SELECT d.*, q.name AS query_name, p.name_ar AS program_name
      FROM api_denials d
      LEFT JOIN queries q ON q.id = d.query_id
      LEFT JOIN programs p ON p.id = d.program_id
      ORDER BY d.occurred_at DESC
      LIMIT ${limit}`;
  }

  async timeline(days = 14) {
    return sql`
      SELECT date_trunc('day', occurred_at) AS day,
             SUM(units_consumed)::int  AS units,
             SUM(cost_estimate)::float AS cost
      FROM api_usage
      WHERE occurred_at > now() - (${days} || ' days')::interval
      GROUP BY 1 ORDER BY 1`;
  }
}

export const usageService = new UsageService();
