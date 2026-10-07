import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  parseDateRangeParams, resolvePreset, zonedDateKey,
  type DateRangePreset, type ResolvedDateRange,
} from '@mip/shared';

export interface DateRangeState {
  preset: DateRangePreset;
  /** Raw custom bounds as typed (YYYY-MM-DD), kept even while invalid. */
  from: string;
  to: string;
  /** The resolved range when valid; the label and the API use this. */
  range: ResolvedDateRange | null;
  error: string | null;
  /** `range=7d` / `from=…&to=…` / '' when invalid — append to an API query string. */
  apiQuery: string;
  /** Changes the range; pushes a history entry so Back/Forward work. */
  set: (preset: DateRangePreset, custom?: { from?: string; to?: string }) => void;
}

/**
 * The page's date range lives in the URL (`?range=7d` or
 * `?from=2026-10-01&to=2026-10-07`), so a refresh keeps it and a link shares
 * it. No params means the page default. Other query params are left alone.
 */
export function useDateRange(defaultPreset: Exclude<DateRangePreset, 'custom'> = 'all'): DateRangeState {
  const [params, setParams] = useSearchParams();
  const rangeParam = params.get('range');
  const fromParam = params.get('from') ?? '';
  const toParam = params.get('to') ?? '';

  const state = useMemo(() => {
    const explicit = Boolean(rangeParam || fromParam || toParam);
    const preset = (explicit ? (rangeParam ?? 'custom') : defaultPreset) as DateRangePreset;
    if (!explicit) {
      return { preset, range: resolvePreset(defaultPreset), error: null, apiQuery: presetQuery(defaultPreset) };
    }
    const parsed = parseDateRangeParams({ range: rangeParam, from: fromParam, to: toParam });
    if (!parsed.ok) return { preset, range: null, error: parsed.error, apiQuery: '' };
    const apiQuery = parsed.range.preset === 'custom'
      ? new URLSearchParams(Object.entries({ from: fromParam, to: toParam }).filter(([, v]) => v)).toString()
      : presetQuery(parsed.range.preset);
    return { preset, range: parsed.range, error: null, apiQuery };
  }, [rangeParam, fromParam, toParam, defaultPreset]);

  const editingCustom = rangeParam === 'custom' || (!rangeParam && Boolean(fromParam || toParam));

  const set = useCallback((preset: DateRangePreset, custom?: { from?: string; to?: string }) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('range'); next.delete('from'); next.delete('to');
      if (preset === 'custom') {
        // Start a fresh custom range from today rather than an empty form.
        const today = zonedDateKey(new Date());
        const from = custom ? custom.from ?? '' : today;
        const to = custom ? custom.to ?? '' : today;
        if (from) next.set('from', from);
        if (to) next.set('to', to);
        if (!from && !to) next.set('range', 'custom');
      } else if (preset !== defaultPreset) {
        next.set('range', preset);
      }
      return next;
    // Typing into the custom dates edits one history entry instead of adding one per keystroke.
    }, { replace: preset === 'custom' && editingCustom });
  }, [setParams, defaultPreset, editingCustom]);

  return { ...state, from: fromParam, to: toParam, set };
}

/** Always explicit — `range=all` too, since some endpoints keep a legacy default window when sent nothing. */
function presetQuery(preset: DateRangePreset) {
  return `range=${preset}`;
}
