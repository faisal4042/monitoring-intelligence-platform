import { CalendarRange } from 'lucide-react';
import { DATE_RANGE_LABELS, zonedDateKey, type DateRangePreset } from '@mip/shared';
import type { DateRangeState } from '../lib/useDateRange';
import { fmtDate } from '../lib/format';

const PRESET_ORDER: DateRangePreset[] = [
  'today', 'yesterday', '7d', '30d', '90d', 'this_week', 'this_month', 'last_month', 'custom',
];

/** A Riyadh calendar day (YYYY-MM-DD) as `07 أكتوبر 2026`, independent of the browser zone. */
const fmtDayKey = (key: string) => fmtDate(`${key}T12:00:00+03:00`);

/**
 * Shared period picker. Pair it with `useDateRange()`; the page passes
 * `state.apiQuery` to its API call. `allowAll` adds a "كل الفترات" option for
 * pages that were unbounded before this filter existed.
 */
export default function DateRangeFilter({ state, allowAll = true }: { state: DateRangeState; allowAll?: boolean }) {
  const presets = allowAll ? (['all', ...PRESET_ORDER] as DateRangePreset[]) : PRESET_ORDER;
  const today = zonedDateKey(new Date());
  const { range } = state;

  const label = !range || range.preset === 'all'
    ? null
    : range.fromDate && range.toDate
      ? range.fromDate === range.toDate
        ? fmtDayKey(range.fromDate)
        : `${fmtDayKey(range.fromDate)} – ${fmtDayKey(range.toDate)}`
      : range.fromDate ? `من ${fmtDayKey(range.fromDate)}` : range.toDate ? `حتى ${fmtDayKey(range.toDate)}` : null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1.5">
        <CalendarRange size={16} className="muted" aria-hidden="true" />
        <select
          className="input max-w-44"
          aria-label="الفترة الزمنية"
          value={state.preset}
          onChange={(e) => state.set(e.target.value as DateRangePreset)}
        >
          {presets.map((p) => <option key={p} value={p}>{DATE_RANGE_LABELS[p]}</option>)}
        </select>
      </label>

      {state.preset === 'custom' && (
        <>
          <label className="flex items-center gap-1.5 text-xs muted">
            من
            <input
              type="date" className="input !w-auto num" value={state.from} max={state.to || today}
              onChange={(e) => state.set('custom', { from: e.target.value, to: state.to })}
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs muted">
            إلى
            <input
              type="date" className="input !w-auto num" value={state.to} min={state.from || undefined} max={today}
              onChange={(e) => state.set('custom', { from: state.from, to: e.target.value })}
            />
          </label>
        </>
      )}

      {state.error
        ? <span className="text-xs text-red-600" role="alert">{state.error}</span>
        : label && <span className="text-xs muted tabular-nums" title="بتوقيت الرياض">{label}</span>}
    </div>
  );
}
