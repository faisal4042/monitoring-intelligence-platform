/**
 * ECharts option builders. Pure functions of (colours, data) so components can
 * memoise them; every chart on the dashboard is built from one of these.
 *
 * RTL: time runs right-to-left (oldest at the right, as the page reads), the
 * value axis sits on the right, and horizontal bars grow from the right edge.
 */
import { fmtNum } from '../../../lib/format';
import { axisLabel, axisNum, base, splitLine, tipHtml, type ChartColors, type TipRow } from './theme';

/** Keep the first and last time labels inside the chart (time runs right-to-left). */
const EDGE = { alignMinLabel: 'right', alignMaxLabel: 'left' } as const;

// ── Main trend ─────────────────────────────────────────────────────────────
export interface TrendInput {
  labels: string[];
  /** Full bucket titles for the tooltip (e.g. a weekday and date). */
  titles: string[];
  name: string;
  current: number[];
  previous?: { name: string; values: number[]; titles: string[] } | null;
}
export function trendOption(c: ChartColors, t: TrendInput) {
  const n = t.labels.length;
  // Up to a 90-day period fits without a zoom slider.
  const zoom = n > 95;
  const showSymbols = n <= 21;
  return {
    ...base(c),
    grid: { left: 8, right: 8, top: 14, bottom: zoom ? 44 : 6, containLabel: true },
    tooltip: {
      ...base(c).tooltip, trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: c.axis, width: 1 } },
      formatter: (ps: Array<{ dataIndex: number }>) => {
        const i = ps[0]?.dataIndex ?? 0;
        const rows: TipRow[] = [{ label: t.name, value: fmtNum(t.current[i]), color: c.primary }];
        if (t.previous && t.previous.values[i] !== undefined) {
          rows.push({ label: `${t.previous.name} · ${t.previous.titles[i] ?? ''}`, value: fmtNum(t.previous.values[i]), color: c.compare, dashed: true, muted: true });
        }
        return tipHtml(t.titles[i] ?? '', rows);
      },
    },
    xAxis: {
      type: 'category', inverse: true, boundaryGap: false, data: t.labels,
      axisLine: { lineStyle: { color: c.axis } }, axisTick: { show: false },
      axisLabel: axisLabel(c, { hideOverlap: true, margin: 10, ...EDGE }),
    },
    yAxis: {
      type: 'value', position: 'right', minInterval: 1, splitNumber: 4,
      axisLabel: axisLabel(c, { formatter: axisNum }), splitLine: splitLine(c),
    },
    dataZoom: zoom ? [{ type: 'inside', zoomOnMouseWheel: 'shift' }, { type: 'slider', height: 18, bottom: 8, borderColor: c.axis, fillerColor: c.primaryFill, textStyle: { color: c.muted } }] : [],
    series: [
      {
        name: t.name, type: 'line', data: t.current, smooth: 0.2,
        symbol: 'circle', symbolSize: 6, showSymbol: showSymbols,
        lineStyle: { width: 2.5, color: c.primary }, itemStyle: { color: c.primary, borderColor: c.surface, borderWidth: 1.5 },
        areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: c.primaryFill }, { offset: 1, color: 'rgba(31,181,181,0)' }] } },
        emphasis: { focus: 'none', scale: 1.4 },
        cursor: 'pointer', z: 3,
      },
      ...(t.previous ? [{
        name: t.previous.name, type: 'line', data: t.previous.values, smooth: 0.2, symbol: 'none',
        lineStyle: { width: 1.5, type: 'dashed', color: c.compare }, itemStyle: { color: c.compare }, silent: true, z: 2,
      }] : []),
    ],
  };
}

// ── Ranked horizontal bars ─────────────────────────────────────────────────
export interface RankRow { name: string; value: number | null; tip?: TipRow[]; tipTitle?: string; note?: string }
export function rankOption(c: ChartColors, rows: RankRow[], opts: { color?: string; max?: number; format?: (v: number) => string; clickable?: boolean } = {}) {
  const fmt = opts.format ?? fmtNum;
  return {
    ...base(c),
    grid: { left: 8, right: 8, top: 4, bottom: 4, containLabel: true },
    tooltip: {
      ...base(c).tooltip, trigger: 'item',
      formatter: (p: { dataIndex: number }) => {
        const r = rows[p.dataIndex];
        return tipHtml(r.tipTitle ?? r.name, r.tip ?? [{ label: 'العدد', value: r.value === null ? 'غير متوفر' : fmt(r.value) }], r.note);
      },
    },
    xAxis: { type: 'value', inverse: true, max: opts.max, show: false },
    yAxis: {
      type: 'category', position: 'right', inverse: true, data: rows.map((r) => r.name),
      axisTick: { show: false }, axisLine: { show: false },
      axisLabel: axisLabel(c, { color: c.ink, fontSize: 12, width: 150, overflow: 'truncate', margin: 10 }),
    },
    series: [{
      type: 'bar', barWidth: 14, showBackground: true, backgroundStyle: { color: c.track, borderRadius: 7 },
      cursor: opts.clickable ? 'pointer' : 'default',
      itemStyle: { color: opts.color ?? c.primary, borderRadius: 7 },
      label: { show: true, position: 'left', distance: 6, color: c.ink, fontSize: 11, fontWeight: 600,
        formatter: (p: { value: number | null }) => (p.value === null ? 'غير متوفر' : fmt(p.value)) },
      data: rows.map((r) => r.value),
    }],
  };
}
/** Bar chart height for n rows, so a ranking never stretches the page. */
export const rankHeight = (n: number) => Math.max(64, n * 34 + 8);

// ── 100% stacked bars (sentiment by program/topic) ─────────────────────────
export interface StackGroup { key: string; label: string; color: string }
export interface StackCat { name: string; counts: Record<string, number>; total: number }
export function stackOption(c: ChartColors, cats: StackCat[], groups: StackGroup[]) {
  const pct = (cat: StackCat, g: string) => (cat.total ? Math.round(((cat.counts[g] ?? 0) / cat.total) * 1000) / 10 : 0);
  return {
    ...base(c),
    grid: { left: 8, right: 8, top: 4, bottom: 4, containLabel: true },
    tooltip: {
      ...base(c).tooltip, trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: c.dark ? 'rgba(255,255,255,.04)' : 'rgba(14,42,71,.04)' } },
      formatter: (ps: Array<{ dataIndex: number }>) => {
        const cat = cats[ps[0]?.dataIndex ?? 0];
        return tipHtml(cat.name, groups.map((g) => ({ label: g.label, value: `${fmtNum(cat.counts[g.key] ?? 0)} · ${pct(cat, g.key)}٪`, color: g.color })),
          `العينة: ${fmtNum(cat.total)} منشورًا مصنف المشاعر`);
      },
    },
    xAxis: { type: 'value', inverse: true, max: 100, show: false },
    yAxis: {
      type: 'category', position: 'right', inverse: true, data: cats.map((x) => x.name),
      axisTick: { show: false }, axisLine: { show: false },
      axisLabel: axisLabel(c, { color: c.ink, fontSize: 12, width: 140, overflow: 'truncate', margin: 10 }),
    },
    series: groups.map((g, gi) => ({
      name: g.label, type: 'bar', stack: 'share', barWidth: 16,
      itemStyle: { color: g.color, borderColor: c.surface, borderWidth: 1,
        borderRadius: gi === 0 ? [0, 8, 8, 0] : gi === groups.length - 1 ? [8, 0, 0, 8] : 0 },
      label: { show: true, color: '#ffffff', fontSize: 10, fontWeight: 600,
        formatter: (p: { value: number }) => (p.value >= 14 ? `${Math.round(p.value)}٪` : '') },
      data: cats.map((cat) => pct(cat, g.key)),
    })),
  };
}

// ── Sparkline ──────────────────────────────────────────────────────────────
export function sparkOption(c: ChartColors, values: Array<number | null>, color: string, fill = true) {
  return {
    animation: false,
    grid: { left: 2, right: 2, top: 3, bottom: 3 },
    xAxis: { type: 'category', inverse: true, show: false, boundaryGap: false, data: values.map((_, i) => i) },
    yAxis: { type: 'value', show: false, min: (v: { min: number }) => Math.min(0, v.min) },
    series: [{ type: 'line', data: values, symbol: 'none', smooth: 0.3, connectNulls: false, silent: true,
      lineStyle: { width: 1.6, color }, ...(fill && { areaStyle: { color, opacity: 0.12 } }) }],
  };
}

// ── Small line for a ratio over time (negative share) ──────────────────────
export function ratioOption(c: ChartColors, labels: string[], titles: string[], values: Array<number | null>, samples: number[], color: string) {
  return {
    ...base(c),
    grid: { left: 8, right: 8, top: 10, bottom: 4, containLabel: true },
    tooltip: { ...base(c).tooltip, trigger: 'axis',
      formatter: (ps: Array<{ dataIndex: number }>) => { const i = ps[0]?.dataIndex ?? 0;
        return tipHtml(titles[i], [{ label: 'نسبة السلبية', value: values[i] === null ? 'عينة غير كافية' : `${values[i]}٪`, color }], `من ${fmtNum(samples[i])} منشورًا مصنف المشاعر`); } },
    xAxis: { type: 'category', inverse: true, boundaryGap: false, data: labels, axisTick: { show: false }, axisLine: { lineStyle: { color: c.axis } }, axisLabel: axisLabel(c, { hideOverlap: true, fontSize: 10, ...EDGE }) },
    yAxis: { type: 'value', position: 'right', min: 0, max: 100, splitNumber: 2, axisLabel: axisLabel(c, { fontSize: 10, formatter: '{value}٪' }), splitLine: splitLine(c) },
    series: [{ type: 'line', data: values, connectNulls: false, smooth: 0.2, symbol: 'circle', symbolSize: 5, showSymbol: labels.length <= 31,
      lineStyle: { width: 2, color }, itemStyle: { color } }],
  };
}
