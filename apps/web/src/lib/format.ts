import { APP_TIME_ZONE } from '@mip/shared';

export const fmtNum = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : new Intl.NumberFormat('en-US').format(n);

export const fmtCompact = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

/** API cost is often fractions of a cent — show enough digits to be meaningful. */
export const fmtMoney = (n: number | null | undefined, digits = 4) =>
  n === null || n === undefined ? '—' : `$${n.toFixed(digits)}`;

export const fmtPct = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined ? '—' : `${(n * 100).toFixed(digits)}%`;

// ─── Dates ──────────────────────────────────────────────────────────
// Every date in the UI is shown in Asia/Riyadh on the Gregorian calendar with
// Latin digits, whatever the browser's own zone or locale defaults are.

type DateInput = string | Date | null | undefined;

/**
 * Postgres can hand timestamps over as `2026-08-27 21:00:00+00`, which only
 * some browsers parse. Normalise to strict ISO first.
 */
export function parseInstant(value: DateInput): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const iso = value.trim()
    .replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2')
    .replace(/([+-]\d{2})$/, '$1:00');
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

const LOCALE = 'ar-SA-u-ca-gregory-nu-latn';
const dateTimeFmt = new Intl.DateTimeFormat(LOCALE, {
  timeZone: APP_TIME_ZONE, day: '2-digit', month: 'long', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: true,
});
const dateFmt = new Intl.DateTimeFormat(LOCALE, { timeZone: APP_TIME_ZONE, day: '2-digit', month: 'long', year: 'numeric' });
const dayShortFmt = new Intl.DateTimeFormat(LOCALE, { timeZone: APP_TIME_ZONE, day: '2-digit', month: 'short' });
const hourFmt = new Intl.DateTimeFormat(LOCALE, { timeZone: APP_TIME_ZONE, hour: '2-digit', hour12: true });

function partsOf(fmt: Intl.DateTimeFormat, d: Date) {
  const out: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const p of fmt.formatToParts(d)) out[p.type] = p.value;
  return out;
}

/** `07 أكتوبر 2026 - 06:30 م` */
export const fmtDateTime = (value: DateInput) => {
  const d = parseInstant(value);
  if (!d) return '—';
  const p = partsOf(dateTimeFmt, d);
  return `${p.day} ${p.month} ${p.year} - ${p.hour}:${p.minute} ${p.dayPeriod}`;
};

/** `07 أكتوبر 2026` */
export const fmtDate = (value: DateInput) => {
  const d = parseInstant(value);
  return d ? dateFmt.format(d) : '—';
};

/** `07 أكتوبر` — compact chart axis label for a day bucket. */
export const fmtDayShort = (value: DateInput) => {
  const d = parseInstant(value);
  return d ? dayShortFmt.format(d) : '—';
};

/** `07 أكتوبر 06 م` — compact chart axis label for an hour bucket. */
export const fmtHourLabel = (value: DateInput) => {
  const d = parseInstant(value);
  return d ? `${dayShortFmt.format(d)} ${hourFmt.format(d)}` : '—';
};

/** Arabic count phrase with dual and plural forms: دقيقة، دقيقتين، 3 دقائق، 11 دقيقة. */
function countPhrase(n: number, one: string, two: string, few: string, many: string) {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return `${n} ${few}`;
  return `${n} ${many}`;
}

/** `منذ 5 دقائق` up to a month back; older (or future) values show the date. */
export function fmtRelative(value: DateInput, now = Date.now()) {
  const d = parseInstant(value);
  if (!d) return '—';
  const seconds = Math.round((now - d.getTime()) / 1000);
  if (seconds < -60) return fmtDate(d);
  if (seconds < 45) return 'الآن';
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `منذ ${countPhrase(minutes, 'دقيقة', 'دقيقتين', 'دقائق', 'دقيقة')}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `منذ ${countPhrase(hours, 'ساعة', 'ساعتين', 'ساعات', 'ساعة')}`;
  const days = Math.round(hours / 24);
  if (days <= 30) return `منذ ${countPhrase(days, 'يوم', 'يومين', 'أيام', 'يومًا')}`;
  return fmtDate(d);
}
