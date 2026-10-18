/**
 * The one date-range model for MIP. The API resolves every `range`/`from`/`to`
 * query through `parseDateRangeParams`, and the web app uses the same function
 * to label the filter, so both sides always agree on where a day starts.
 *
 * Rules:
 *  - Timestamps are stored as timestamptz (UTC). Calendar days, weeks and
 *    months are Asia/Riyadh days — "today" means today in Riyadh, not in UTC
 *    and not in the browser's zone.
 *  - A resolved range is half-open: from <= t < to.
 *  - A date-only bound (`2026-10-07`) means that whole Riyadh day, so
 *    `from=2026-10-07&to=2026-10-07` is exactly one day.
 *  - A datetime bound must carry its offset (`Z` or `+03:00`); a bare local
 *    datetime is rejected because its zone would be a guess. A datetime `to`
 *    is exclusive.
 */

export const APP_TIME_ZONE = 'Asia/Riyadh';

export const DATE_RANGE_PRESETS = [
  'today', 'yesterday', '7d', '30d', '90d', 'this_week', 'this_month', 'last_month', 'custom', 'all',
] as const;
export type DateRangePreset = (typeof DATE_RANGE_PRESETS)[number];

export const DATE_RANGE_LABELS: Record<DateRangePreset, string> = {
  today: 'اليوم',
  yesterday: 'أمس',
  '7d': 'آخر 7 أيام',
  '30d': 'آخر 30 يوم',
  '90d': 'آخر 90 يوم',
  this_week: 'هذا الأسبوع',
  this_month: 'هذا الشهر',
  last_month: 'الشهر السابق',
  custom: 'فترة مخصصة',
  all: 'كل الفترات',
};

/** Saudi working week: Sunday is the first day. */
const WEEK_START_DAY = 0;

export interface ResolvedDateRange {
  preset: DateRangePreset;
  /** Inclusive lower bound, or null when unbounded. */
  from: Date | null;
  /** Exclusive upper bound, or null when unbounded. */
  to: Date | null;
  /** First Riyadh calendar day in the range (YYYY-MM-DD), for display and inputs. */
  fromDate: string | null;
  /** Last Riyadh calendar day in the range, inclusive (YYYY-MM-DD). */
  toDate: string | null;
}

export type DateRangeResult =
  | { ok: true; range: ResolvedDateRange }
  | { ok: false; error: string };

export interface DateRangeParams {
  range?: string | null;
  from?: string | null;
  to?: string | null;
}

interface CivilDate { y: number; m: number; d: number }

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
function zonedParts(instant: Date, timeZone: string) {
  let fmt = partsFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', calendar: 'gregory', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    partsFormatters.set(timeZone, fmt);
  }
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(instant)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return { y: out.year!, m: out.month!, d: out.day!, h: out.hour!, mi: out.minute!, s: out.second! };
}

/** Milliseconds the zone is ahead of UTC at that instant (+3h for Riyadh). */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The UTC instant at which the given civil day starts in the zone. */
export function startOfZonedDay(day: CivilDate, timeZone = APP_TIME_ZONE): Date {
  const guess = Date.UTC(day.y, day.m - 1, day.d);
  let result = guess - zoneOffsetMs(new Date(guess), timeZone);
  // Re-check once in case the guess and the answer straddle an offset change.
  const corrected = guess - zoneOffsetMs(new Date(result), timeZone);
  if (corrected !== result) result = corrected;
  return new Date(result);
}

/** The civil (calendar) day an instant falls on in the zone. */
export function zonedCivilDate(instant: Date, timeZone = APP_TIME_ZONE): CivilDate {
  const p = zonedParts(instant, timeZone);
  return { y: p.y, m: p.m, d: p.d };
}

/** `YYYY-MM-DD` of the Riyadh day an instant falls on. */
export function zonedDateKey(instant: Date, timeZone = APP_TIME_ZONE): string {
  return civilKey(zonedCivilDate(instant, timeZone));
}

function civilKey(c: CivilDate): string {
  return `${String(c.y).padStart(4, '0')}-${String(c.m).padStart(2, '0')}-${String(c.d).padStart(2, '0')}`;
}

function addDays(c: CivilDate, n: number): CivilDate {
  const t = new Date(Date.UTC(c.y, c.m - 1, c.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function weekday(c: CivilDate): number {
  return new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay();
}

function parseCivilDate(value: string): CivilDate | null {
  const m = DATE_ONLY.exec(value);
  if (!m) return null;
  const c = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  if (c.y < 2000 || c.y > 2100) return null;
  // Reject 2026-02-30 and friends: the day must survive a round trip.
  const t = new Date(Date.UTC(c.y, c.m - 1, c.d));
  if (t.getUTCFullYear() !== c.y || t.getUTCMonth() + 1 !== c.m || t.getUTCDate() !== c.d) return null;
  return c;
}

type Bound = { kind: 'day'; day: CivilDate } | { kind: 'instant'; at: Date };

function parseBound(value: string): Bound | null {
  const day = parseCivilDate(value);
  if (day) return { kind: 'day', day };
  if (!DATETIME_WITH_OFFSET.test(value)) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  const year = at.getUTCFullYear();
  if (year < 2000 || year > 2100) return null;
  return { kind: 'instant', at };
}

function dayRange(preset: DateRangePreset, first: CivilDate, lastInclusive: CivilDate, timeZone: string): ResolvedDateRange {
  return {
    preset,
    from: startOfZonedDay(first, timeZone),
    to: startOfZonedDay(addDays(lastInclusive, 1), timeZone),
    fromDate: civilKey(first),
    toDate: civilKey(lastInclusive),
  };
}

/** Resolves a named preset against `now`. */
export function resolvePreset(
  preset: Exclude<DateRangePreset, 'custom'>, now = new Date(), timeZone = APP_TIME_ZONE,
): ResolvedDateRange {
  const today = zonedCivilDate(now, timeZone);
  switch (preset) {
    case 'today': return dayRange(preset, today, today, timeZone);
    case 'yesterday': { const y = addDays(today, -1); return dayRange(preset, y, y, timeZone); }
    case '7d': return dayRange(preset, addDays(today, -6), today, timeZone);
    case '30d': return dayRange(preset, addDays(today, -29), today, timeZone);
    case '90d': return dayRange(preset, addDays(today, -89), today, timeZone);
    case 'this_week': {
      const back = (weekday(today) - WEEK_START_DAY + 7) % 7;
      return dayRange(preset, addDays(today, -back), today, timeZone);
    }
    case 'this_month': return dayRange(preset, { y: today.y, m: today.m, d: 1 }, today, timeZone);
    case 'last_month': {
      const firstThis = { y: today.y, m: today.m, d: 1 };
      const lastPrev = addDays(firstThis, -1);
      return dayRange(preset, { y: lastPrev.y, m: lastPrev.m, d: 1 }, lastPrev, timeZone);
    }
    case 'all': return { preset, from: null, to: null, fromDate: null, toDate: null };
  }
}

/**
 * Validates and resolves `range` / `from` / `to` exactly as they arrive in a
 * query string. Nothing given resolves to `all` (no bounds), which keeps
 * every endpoint backward compatible.
 */
export function parseDateRangeParams(
  params: DateRangeParams, now = new Date(), timeZone = APP_TIME_ZONE,
): DateRangeResult {
  const range = params.range?.trim() || null;
  const fromRaw = params.from?.trim() || null;
  const toRaw = params.to?.trim() || null;

  if (range && !(DATE_RANGE_PRESETS as readonly string[]).includes(range)) {
    return { ok: false, error: `الفترة الزمنية غير معروفة: ${range}` };
  }
  if (range && range !== 'custom') {
    if (fromRaw || toRaw) return { ok: false, error: 'لا يمكن الجمع بين فترة محددة مسبقًا وتاريخي من/إلى' };
    return { ok: true, range: resolvePreset(range as Exclude<DateRangePreset, 'custom'>, now, timeZone) };
  }
  if (!fromRaw && !toRaw) {
    if (range === 'custom') return { ok: false, error: 'الفترة المخصصة تتطلب تاريخ البداية أو النهاية' };
    return { ok: true, range: resolvePreset('all', now, timeZone) };
  }

  const fromBound = fromRaw ? parseBound(fromRaw) : null;
  if (fromRaw && !fromBound) return { ok: false, error: 'تاريخ البداية غير صالح — استخدم YYYY-MM-DD' };
  const toBound = toRaw ? parseBound(toRaw) : null;
  if (toRaw && !toBound) return { ok: false, error: 'تاريخ النهاية غير صالح — استخدم YYYY-MM-DD' };

  const from = fromBound ? (fromBound.kind === 'day' ? startOfZonedDay(fromBound.day, timeZone) : fromBound.at) : null;
  const to = toBound ? (toBound.kind === 'day' ? startOfZonedDay(addDays(toBound.day, 1), timeZone) : toBound.at) : null;
  if (from && to && from.getTime() >= to.getTime()) {
    return { ok: false, error: 'تاريخ البداية يجب أن يسبق تاريخ النهاية' };
  }

  return {
    ok: true,
    range: {
      preset: 'custom',
      from,
      to,
      fromDate: from ? zonedDateKey(from, timeZone) : null,
      // An exclusive instant at midnight belongs to the previous day.
      toDate: to ? zonedDateKey(new Date(to.getTime() - 1), timeZone) : null,
    },
  };
}

export interface ComparisonWindows {
  /** The selected range, its end capped at `now` so a running day compares fairly. */
  current: { from: Date; to: Date };
  /** The equally long window that ends where the current one starts. */
  previous: { from: Date; to: Date };
}

/**
 * The previous-period comparison for a resolved range: the same duration
 * immediately before it. "Today until 14:00" compares with "yesterday until
 * 14:00", never with a whole day. Unbounded or future-only ranges have no
 * comparison (null).
 */
export function comparisonWindows(range: ResolvedDateRange, now = new Date()): ComparisonWindows | null {
  if (!range.from || !range.to) return null;
  const end = Math.min(range.to.getTime(), now.getTime());
  const span = end - range.from.getTime();
  if (span <= 0) return null;
  return {
    current: { from: range.from, to: new Date(end) },
    previous: { from: new Date(range.from.getTime() - span), to: range.from },
  };
}
