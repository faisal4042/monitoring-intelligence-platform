/**
 * YouTube Data API v3 endpoints used by the MVP, with their documented quota cost and bucket
 * (developers.google.com/youtube/v3/determine_quota_cost, revision history 2026-06-01/06-03; verified 2026-10-16).
 * Only read methods. liveChatMessages (5 units), captions (50 units) and every write method are deliberately absent:
 * the gateway refuses any endpoint that is not in this table.
 */
export type Bucket = 'default' | 'search' | 'batch_stats';
export type EndpointName = 'search.list' | 'videos.list' | 'channels.list' | 'playlistItems.list'
  | 'commentThreads.list' | 'comments.list' | 'videos.batchGetStats';

export const ENDPOINTS: Record<EndpointName, {path: string; bucket: Bucket; units: number}> = {
  'search.list':          {path: 'search',              bucket: 'search',      units: 1},
  'videos.list':          {path: 'videos',              bucket: 'default',     units: 1},
  'channels.list':        {path: 'channels',            bucket: 'default',     units: 1},
  'playlistItems.list':   {path: 'playlistItems',       bucket: 'default',     units: 1},
  'commentThreads.list':  {path: 'commentThreads',      bucket: 'default',     units: 1},
  'comments.list':        {path: 'comments',            bucket: 'default',     units: 1},
  'videos.batchGetStats': {path: 'videos:batchGetStats', bucket: 'batch_stats', units: 1},
};

export const API_BASE = 'https://www.googleapis.com/youtube/v3/';

/** Google's own limits for this project (confirmed by the owner from Cloud Console, 2026-10-16). */
export const GOOGLE_LIMITS = {default: 10_000, search: 100, searchPerMinute: 100, batch_stats: 10_000} as const;

/** MVP internal hard limits (well under Google's). */
export const MVP_DEFAULT_LIMITS: Record<Bucket, number> = {default: 1_000, search: 10, batch_stats: 1_000};

/** YouTube quota resets at midnight Pacific Time, so the ledger is keyed by the PT calendar day. */
export function quotaDayPT(at: Date = new Date()): string {
  const p = new Intl.DateTimeFormat('en-CA', {timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'})
    .formatToParts(at);
  const v = (t: string) => p.find(x => x.type === t)!.value;
  return `${v('year')}-${v('month')}-${v('day')}`;
}

/** Next PT midnight as an absolute instant (for "resets at" in the UI). */
export function nextQuotaReset(at: Date = new Date()): Date {
  const today = quotaDayPT(at);
  let t = new Date(at.getTime());
  // Step forward in 15-minute increments until the PT day changes (DST-safe, ≤ 25 h).
  while (quotaDayPT(t) === today) t = new Date(t.getTime() + 15 * 60_000);
  // Refine back to the exact minute.
  let lo = t.getTime() - 15 * 60_000, hi = t.getTime();
  while (hi - lo > 60_000) { const mid = lo + Math.floor((hi - lo) / 2); if (quotaDayPT(new Date(mid)) === today) lo = mid; else hi = mid; }
  const floor = Math.floor(hi / 60_000) * 60_000;
  return new Date(quotaDayPT(new Date(floor)) !== today ? floor : floor + 60_000);
}

/** ISO 8601 duration (PT#H#M#S, optional days) → seconds; null when unparseable. */
export function parseIsoDuration(d: string | null | undefined): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(d ?? '');
  if (!m || d === 'P' || d === 'PT') return null;
  const [, D, H, M, S] = m.map(x => Number(x ?? 0));
  return D * 86400 + H * 3600 + M * 60 + S;
}

/** Shorts have no official API flag; ≤ 180 s is an ESTIMATE and is always labelled as such. */
export const SHORT_MAX_SECONDS = 180;
export const isShortCandidate = (seconds: number | null) => seconds !== null && seconds > 0 && seconds <= SHORT_MAX_SECONDS;

/** Errors that must NOT be retried (each retry costs quota and cannot succeed). */
export type ErrorClass = 'retry' | 'quota' | 'forbidden' | 'comments_disabled' | 'not_found' | 'bad_request';
export function classifyError(status: number | null, reason: string | null): ErrorClass {
  if (status === null) return 'retry';                                  // network / timeout
  if (status >= 500 || status === 429) return 'retry';
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') return 'quota';
  if (reason === 'commentsDisabled') return 'comments_disabled';
  if (status === 404) return 'not_found';
  if (status === 403 || status === 401) return 'forbidden';             // key, IP restriction, API not enabled
  return 'bad_request';
}

/** Exponential backoff with full jitter: attempt 1 → ≤2 s, 2 → ≤8 s (3 attempts total). */
export function backoffMs(attempt: number, random = Math.random): number {
  const cap = [0, 2_000, 8_000, 30_000][Math.min(attempt, 3)];
  return Math.floor(cap / 2 + random() * (cap / 2));
}
export const MAX_ATTEMPTS = 3;

/** Search `q`: OR-joined include terms, `-` excludes; quoted when a term has spaces. */
export function buildSearchQ(include: string[], exclude: string[] = []): string {
  const term = (t: string) => { const s = t.trim().replace(/["|]/g, ''); return /\s/.test(s) ? `"${s}"` : s; };
  const inc = include.map(term).filter(Boolean);
  if (!inc.length) throw new Error('search query needs at least one include term');
  const exc = exclude.map(term).filter(Boolean).map(t => `-${t}`);
  return [inc.join('|'), ...exc].join(' ');
}

/** Replace any API key in a string (URL, message) before it can reach a log or the database. */
export function redactKey(s: string): string {
  return s.replace(/([?&]key=)[^&\s]+/gi, '$1[REDACTED]').replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]');
}
