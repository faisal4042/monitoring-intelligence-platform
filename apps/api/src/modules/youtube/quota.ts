/**
 * Quota manager. No call is attempted without a successful reserve(); over-spend is prevented inside one
 * transaction with a row lock (concurrent reservations serialize on the ledger row).
 * Ledger key: (bucket, PT quota day, mode) — mock/dry-run use their own rows with the same limits, so they exercise
 * enforcement without hiding or consuming live quota. A Google `quotaExceeded` marks the bucket exhausted for the day
 * regardless of our own numbers.
 */
import type {YouTubeSql} from '@mip/db/src/youtube-test-client.js';
import {GOOGLE_LIMITS, MVP_DEFAULT_LIMITS, nextQuotaReset, quotaDayPT, type Bucket} from './endpoints.js';

export type Mode = 'mock' | 'dry_run' | 'live';
export type Denial = 'LIMIT_REACHED' | 'GOOGLE_QUOTA_EXHAUSTED' | 'SEARCH_RATE_PER_MINUTE';
export interface Reservation { bucket: Bucket; day: string; mode: Mode; units: number }

export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): Record<Bucket, number> {
  const pick = (name: string, fallback: number, ceiling: number) => {
    const n = Number(env[name] ?? fallback);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
    if (n > ceiling) throw new Error(`${name}=${n} exceeds the Google limit ${ceiling}`);
    return n;
  };
  return {default: pick('YOUTUBE_DAILY_UNITS_LIMIT', MVP_DEFAULT_LIMITS.default, GOOGLE_LIMITS.default),
    search: pick('YOUTUBE_DAILY_SEARCH_LIMIT', MVP_DEFAULT_LIMITS.search, GOOGLE_LIMITS.search),
    batch_stats: pick('YOUTUBE_DAILY_BATCH_STATS_LIMIT', MVP_DEFAULT_LIMITS.batch_stats, GOOGLE_LIMITS.batch_stats)};
}

export class QuotaManager {
  constructor(private readonly sql: YouTubeSql, private readonly limits: Record<Bucket, number>, private readonly now: () => Date = () => new Date()) {}

  async reserve(bucket: Bucket, units: number, mode: Mode): Promise<{ok: true; reservation: Reservation} | {ok: false; reason: Denial}> {
    const day = quotaDayPT(this.now()), limit = this.limits[bucket];
    return this.sql.begin(async tx => {
      await tx`INSERT INTO youtube_quota_ledger (bucket, quota_day, mode, hard_limit) VALUES (${bucket}, ${day}, ${mode}, ${limit})
               ON CONFLICT (bucket, quota_day, mode) DO UPDATE SET hard_limit = EXCLUDED.hard_limit`;
      const [row] = await tx<{reserved: number; used: number; exhausted_at: Date | null}[]>`
        SELECT reserved, used, exhausted_at FROM youtube_quota_ledger WHERE bucket = ${bucket} AND quota_day = ${day} AND mode = ${mode} FOR UPDATE`;
      if (row.exhausted_at) return {ok: false as const, reason: 'GOOGLE_QUOTA_EXHAUSTED' as const};
      if (row.reserved + row.used + units > limit) return {ok: false as const, reason: 'LIMIT_REACHED' as const};
      if (bucket === 'search') {
        // Google also caps search at 100/minute; enforced even though the daily MVP limit is far lower.
        const [{n}] = await tx<{n: number}[]>`SELECT count(*)::int AS n FROM youtube_api_calls
          WHERE bucket = 'search' AND mode = ${mode} AND outcome <> 'denied' AND occurred_at > now() - interval '1 minute'`;
        if (n + row.reserved + units > GOOGLE_LIMITS.searchPerMinute) return {ok: false as const, reason: 'SEARCH_RATE_PER_MINUTE' as const};
      }
      await tx`UPDATE youtube_quota_ledger SET reserved = reserved + ${units} WHERE bucket = ${bucket} AND quota_day = ${day} AND mode = ${mode}`;
      return {ok: true as const, reservation: {bucket, day, mode, units}};
    });
  }

  /** Converts a reservation into actual use. A request that reached Google counts in full, even if it failed. */
  async settle(r: Reservation, usedUnits: number): Promise<void> {
    await this.sql`UPDATE youtube_quota_ledger SET reserved = greatest(reserved - ${r.units}, 0), used = used + ${usedUnits}
                   WHERE bucket = ${r.bucket} AND quota_day = ${r.day} AND mode = ${r.mode}`;
  }

  async markExhausted(bucket: Bucket, mode: Mode): Promise<void> {
    const day = quotaDayPT(this.now());
    await this.sql`INSERT INTO youtube_quota_ledger (bucket, quota_day, mode, hard_limit, exhausted_at)
                   VALUES (${bucket}, ${day}, ${mode}, ${this.limits[bucket]}, now())
                   ON CONFLICT (bucket, quota_day, mode) DO UPDATE SET exhausted_at = coalesce(youtube_quota_ledger.exhausted_at, now())`;
  }

  async status(mode: Mode) {
    const day = quotaDayPT(this.now());
    const rows = await this.sql<{bucket: Bucket; reserved: number; used: number; exhausted_at: Date | null}[]>`
      SELECT bucket, reserved, used, exhausted_at FROM youtube_quota_ledger WHERE quota_day = ${day} AND mode = ${mode}`;
    return {mode, quotaDayPT: day, resetsAt: nextQuotaReset(this.now()).toISOString(),
      buckets: (['default', 'search', 'batch_stats'] as Bucket[]).map(bucket => {
        const r = rows.find(x => x.bucket === bucket);
        return {bucket, limit: this.limits[bucket], googleLimit: GOOGLE_LIMITS[bucket], used: r?.used ?? 0, reserved: r?.reserved ?? 0,
          exhausted: !!r?.exhausted_at};
      })};
  }
}
