/**
 * Monthly partition maintenance for the five range-partitioned tables.
 *
 * Inserts into a month with no partition fail outright (there is no DEFAULT
 * partition, by design), so coverage must always run ahead of the clock. The
 * SQL function ensure_monthly_partitions() (0033) does the work: UTC month
 * bounds, a transaction advisory lock, idempotent. This module calls it at API
 * startup and daily, and reports how far coverage reaches.
 */
import { sql } from '@mip/db';
import { logger } from '@mip/logger';

const log = logger.child({ subsystem: 'partitions' });

export const PARTITIONED_TABLES = ['posts', 'post_classifications', 'post_sentiments', 'post_metrics', 'api_usage'] as const;

/** Keep the current month plus this many future months partitioned. */
export const MONTHS_AHEAD = 6;

/** Below this much remaining coverage the status is 'warning'; below CRITICAL_DAYS, 'critical'. */
export const WARNING_DAYS = 60;
export const CRITICAL_DAYS = 14;

export type CoverageStatus = 'ok' | 'warning' | 'critical';

export interface PartitionCoverage {
  /** The earliest upper bound across all tables: the first instant some insert would fail. */
  coverageUntil: string | null;
  daysRemaining: number | null;
  status: CoverageStatus;
  tables: Array<{ table: string; partitions: number; coverageUntil: string | null }>;
}

export function coverageStatus(daysRemaining: number | null): CoverageStatus {
  if (daysRemaining === null || daysRemaining < CRITICAL_DAYS) return 'critical';
  if (daysRemaining < WARNING_DAYS) return 'warning';
  return 'ok';
}

/** Reads coverage from the catalogue — metadata only, no row data. */
export async function partitionCoverage(now = new Date()): Promise<PartitionCoverage> {
  const rows = await sql<{ table: string; partitions: number; until: Date | string | null }[]>`
    SELECT t.name AS table,
           count(c.oid)::int AS partitions,
           max((regexp_match(pg_get_expr(c.relpartbound, c.oid), 'TO \\(''([^'']+)''\\)'))[1]::timestamptz) AS until
    FROM unnest(${PARTITIONED_TABLES as unknown as string[]}::text[]) AS t(name)
    LEFT JOIN pg_inherits i ON i.inhparent = to_regclass('public.' || t.name)
    LEFT JOIN pg_class c ON c.oid = i.inhrelid
    GROUP BY t.name
    ORDER BY t.name`;

  const tables = rows.map((r) => ({
    table: r.table,
    partitions: r.partitions,
    coverageUntil: r.until ? new Date(r.until).toISOString() : null,
  }));
  const bounds = tables.map((t) => t.coverageUntil);
  const earliest = bounds.includes(null)
    ? null
    : bounds.map((b) => new Date(b!)).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const daysRemaining = earliest ? Math.floor((earliest.getTime() - now.getTime()) / 86_400_000) : null;
  return {
    coverageUntil: earliest ? earliest.toISOString() : null,
    daysRemaining,
    status: coverageStatus(daysRemaining),
    tables,
  };
}

async function partitionNames(): Promise<Set<string>> {
  const rows = await sql<{ name: string }[]>`
    SELECT c.relname AS name
    FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = ANY(${PARTITIONED_TABLES.map((t) => `public.${t}`)}::regclass[])`;
  return new Set(rows.map((r) => r.name));
}

/**
 * Ensures partitions exist from the current month through MONTHS_AHEAD.
 * Idempotent and safe to run concurrently (the function serializes on an
 * advisory lock). Never throws: a failure is logged at error level and
 * reported, because the partitions already in place keep working — crashing
 * the API would not create the missing ones either.
 */
export async function ensurePartitions(trigger: 'startup' | 'daily' | 'manual', monthsAhead = MONTHS_AHEAD) {
  log.info({ event: 'partition_maintenance_started', trigger, monthsAhead }, 'partition_maintenance_started');
  try {
    const before = await partitionNames();
    await sql`SELECT ensure_monthly_partitions(${monthsAhead}::int)`;
    const after = await partitionNames();
    const created = [...after].filter((n) => !before.has(n)).sort();
    const coverage = await partitionCoverage();
    const fields = {
      event: 'partition_maintenance_completed', trigger, created, coverageUntil: coverage.coverageUntil,
      daysRemaining: coverage.daysRemaining, status: coverage.status,
    };
    if (coverage.status === 'ok') log.info(fields, 'partition_maintenance_completed');
    else log.error(fields, 'partition_maintenance_completed but coverage is short');
    return { ok: true as const, created, coverage };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let coverage: PartitionCoverage | null = null;
    try { coverage = await partitionCoverage(); } catch { /* the database itself may be down */ }
    log.error({
      event: 'partition_maintenance_failed', trigger, err: message,
      coverageUntil: coverage?.coverageUntil ?? null, daysRemaining: coverage?.daysRemaining ?? null,
    }, 'partition_maintenance_failed — inserts will fail once current coverage runs out');
    return { ok: false as const, error: message, coverage };
  }
}
