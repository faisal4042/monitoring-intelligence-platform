/** Value rules shared by every export format. Timestamps are stored UTC and rendered for Asia/Riyadh (UTC+3, no DST). */
import type {ColumnType} from '../definitions.js';

export const TIMEZONE = 'Asia/Riyadh';
const RIYADH_OFFSET_MS = 3 * 3600_000;

export function toDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}
/** "2026-10-15 12:30:05" in Riyadh wall-clock time. */
export function riyadhText(d: Date) {
  return new Date(d.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}
/** ISO 8601 with the Riyadh offset: "2026-10-15T12:30:05+03:00". */
export function riyadhIso(d: Date) {
  return new Date(d.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 19) + '+03:00';
}
/** Excel serial date of the Riyadh wall clock (Excel has no time zones). */
export function excelSerial(d: Date) {
  return (d.getTime() + RIYADH_OFFSET_MS) / 86_400_000 + 25569;
}

/** Typed JSON value: ids/text as strings, numbers as numbers, datetimes as ISO with offset, bool as bool. */
export function jsonValue(v: unknown, type: ColumnType): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'datetime': { const d = toDate(v); return d ? riyadhIso(d) : null; }
    case 'int': case 'number': case 'minutes': { const n = Number(v); return Number.isFinite(n) ? n : null; }
    case 'bool': return v === true || v === 't' || v === 'true';
    default: return String(v);
  }
}

/**
 * Text cell value for CSV/TSV: a cell that a spreadsheet could evaluate (= + - @ tab CR) is prefixed with
 * an apostrophe (OWASP CSV injection guidance). Numbers stay numeric and are never prefixed.
 */
export function textCell(v: unknown, type: ColumnType): string {
  if (v === null || v === undefined) return '';
  if (type === 'datetime') { const d = toDate(v); return d ? riyadhText(d) : ''; }
  if (type === 'int' || type === 'number' || type === 'minutes') { const n = Number(v); return Number.isFinite(n) ? String(n) : ''; }
  if (type === 'bool') return jsonValue(v, 'bool') ? 'نعم' : 'لا';
  return guardFormula(String(v));
}
export function guardFormula(s: string) {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}
