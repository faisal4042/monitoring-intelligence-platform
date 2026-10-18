/**
 * Reads `range` / `from` / `to` from a query string into SQL-ready bounds.
 * The resolution itself lives in @mip/shared so the web app labels a range
 * exactly the way the API filters it.
 */
import { parseDateRangeParams, type ResolvedDateRange } from '@mip/shared';
import { badRequest } from './errors.js';

type Query = Record<string, string | undefined>;

export interface DateBounds {
  range: ResolvedDateRange;
  /**
   * Always real timestamptz literals — unbounded sides become ±infinity — so a
   * filter stays a plain `col >= $from AND col < $to` that can use the
   * time index and prune monthly partitions.
   */
  from: string;
  to: string;
}

/** True when the request asked for a date range at all. */
export function hasDateRange(q: Query): boolean {
  return Boolean(q.range || q.from || q.to);
}

/** Throws a 400 for an unknown preset, a malformed date, or from >= to. */
export function dateBoundsFromQuery(q: Query, now = new Date()): DateBounds {
  const result = parseDateRangeParams({ range: q.range, from: q.from, to: q.to }, now);
  if (!result.ok) throw badRequest(result.error, 'INVALID_DATE_RANGE');
  const { range } = result;
  return {
    range,
    from: range.from?.toISOString() ?? '-infinity',
    to: range.to?.toISOString() ?? 'infinity',
  };
}

/** The resolved range as echoed back to the client. */
export function rangeMeta(range: ResolvedDateRange) {
  return {
    preset: range.preset,
    from: range.from?.toISOString() ?? null,
    to: range.to?.toISOString() ?? null,
    fromDate: range.fromDate,
    toDate: range.toDate,
  };
}
