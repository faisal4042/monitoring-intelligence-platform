import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  parseDateRangeParams, resolvePreset, zonedDateKey,
  type DateRangePreset, type ResolvedDateRange,
} from '@mip/shared';

/** The default every monitoring page opens with; "كل الفترات" stays one click away. */
export const DEFAULT_DATE_RANGE = '30d' satisfies DateRangePreset;

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
  /** Changes the range. */
  set: (preset: DateRangePreset, custom?: { from?: string; to?: string }) => void;
}

type DefaultPreset = Exclude<DateRangePreset, 'custom'>;
interface RawRange { range: string | null; from: string; to: string }

function resolveState(raw: RawRange, defaultPreset: DefaultPreset) {
  const explicit = Boolean(raw.range || raw.from || raw.to);
  const preset = (explicit ? (raw.range ?? 'custom') : defaultPreset) as DateRangePreset;
  if (!explicit) {
    return { preset, range: resolvePreset(defaultPreset), error: null, apiQuery: presetQuery(defaultPreset) };
  }
  const parsed = parseDateRangeParams(raw);
  if (!parsed.ok) return { preset, range: null, error: parsed.error, apiQuery: '' };
  const apiQuery = parsed.range.preset === 'custom'
    ? new URLSearchParams(Object.entries({ from: raw.from, to: raw.to }).filter(([, v]) => v)).toString()
    : presetQuery(parsed.range.preset);
  return { preset, range: parsed.range, error: null, apiQuery };
}

/** The raw params a change produces; a preset equal to the default leaves none. */
function nextRaw(preset: DateRangePreset, defaultPreset: DefaultPreset, custom?: { from?: string; to?: string }): RawRange {
  if (preset !== 'custom') return { range: preset === defaultPreset ? null : preset, from: '', to: '' };
  // Start a fresh custom range from today rather than an empty form.
  const today = zonedDateKey(new Date());
  const from = custom ? custom.from ?? '' : today;
  const to = custom ? custom.to ?? '' : today;
  return { range: !from && !to ? 'custom' : null, from, to };
}

/**
 * A page's date range, kept in the URL (`?range=7d` or
 * `?from=2026-10-01&to=2026-10-07`) so a refresh keeps it, a link shares it and
 * Back/Forward step through it. No params means the page default. Other query
 * params are left alone.
 */
export function useDateRange(defaultPreset: DefaultPreset = DEFAULT_DATE_RANGE): DateRangeState {
  const [params, setParams] = useSearchParams();
  const raw: RawRange = { range: params.get('range'), from: params.get('from') ?? '', to: params.get('to') ?? '' };
  const state = useMemo(() => resolveState(raw, defaultPreset),
    [raw.range, raw.from, raw.to, defaultPreset]);
  const editingCustom = raw.range === 'custom' || (!raw.range && Boolean(raw.from || raw.to));

  const set = useCallback((preset: DateRangePreset, custom?: { from?: string; to?: string }) => {
    const n = nextRaw(preset, defaultPreset, custom);
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('range'); next.delete('from'); next.delete('to');
      if (n.range) next.set('range', n.range);
      if (n.from) next.set('from', n.from);
      if (n.to) next.set('to', n.to);
      return next;
    // Typing into the custom dates edits one history entry instead of adding one per keystroke.
    }, { replace: preset === 'custom' && editingCustom });
  }, [setParams, defaultPreset, editingCustom]);

  return { ...state, from: raw.from, to: raw.to, set };
}

/**
 * Same model held in component state — for a modal that opens on top of a page
 * whose own range already owns the URL.
 */
export function useLocalDateRange(defaultPreset: DefaultPreset = DEFAULT_DATE_RANGE): DateRangeState {
  const [raw, setRaw] = useState<RawRange>({ range: null, from: '', to: '' });
  const state = useMemo(() => resolveState(raw, defaultPreset), [raw, defaultPreset]);
  const set = useCallback((preset: DateRangePreset, custom?: { from?: string; to?: string }) => {
    setRaw(nextRaw(preset, defaultPreset, custom));
  }, [defaultPreset]);
  return { ...state, from: raw.from, to: raw.to, set };
}

/** Always explicit — `range=all` too, since some endpoints keep a legacy default window when sent nothing. */
function presetQuery(preset: DateRangePreset) {
  return `range=${preset}`;
}
