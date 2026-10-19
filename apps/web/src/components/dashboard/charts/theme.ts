/**
 * Chart design tokens shared by every dashboard chart: palette per theme,
 * the RTL HTML tooltip, axis and grid defaults, and number formatting.
 * Charts read colours from here and never hard-code their own.
 */
import { useEffect, useState } from 'react';
import { useTheme } from '../../../lib/theme';
import { fmtCompact, fmtNum } from '../../../lib/format';

const LIGHT = {
  dark: false,
  // Categorical order: official teal leads; never the logo indigo (#4A54AE).
  series: ['#1fb5b5', '#e07b39', '#2a6fd1', '#c24d7a'],
  primary: '#1fb5b5', primaryFill: 'rgba(31,181,181,0.16)', compare: '#8e9db1',
  // Semantic sentiment colours, fixed across every chart: blue positive ↔ red negative (DESIGN.md → Charts).
  positive: '#2a6fd1', neutral: '#9aa9bb', negative: '#d03b3b', unclassified: '#e3e9f0',
  ink: '#0e2a47', muted: '#52637a', grid: '#eaf0f5', axis: '#c2cedb', surface: '#ffffff', track: '#eaf0f5',
};
const DARK: typeof LIGHT = {
  dark: true,
  series: ['#18a2a2', '#d17a2e', '#4c82db', '#cc5888'],
  primary: '#1fb5b5', primaryFill: 'rgba(31,181,181,0.22)', compare: '#7f93ab',
  positive: '#4c82db', neutral: '#6c84a1', negative: '#e66767', unclassified: '#23466f',
  ink: '#ffffff', muted: '#c5d1de', grid: '#1d3d61', axis: '#2f5a86', surface: '#12304f', track: '#1a3c66',
};
export type ChartColors = typeof LIGHT;

export function useChartColors(): ChartColors {
  const { theme } = useTheme();
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener('change', on); return () => mq.removeEventListener('change', on);
  }, []);
  return theme === 'dark' || (theme === 'system' && systemDark) ? DARK : LIGHT;
}

/** Compact axis numbers (1.2K); exact numbers stay in tooltips and labels. */
export const axisNum = (v: number) => (Math.abs(v) >= 1000 ? fmtCompact(v) : fmtNum(v));

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Names in tooltips come from the database (topics, programs, hashtags): always escaped. */
export const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ESC[ch]);

export interface TipRow { label: string; value: string; color?: string; dashed?: boolean; muted?: boolean }
/** One tooltip layout for every chart: title, then aligned label/value rows. */
export function tipHtml(title: string, rows: TipRow[], note?: string) {
  const body = rows.map((r) => `<div class="dash-tip-row${r.muted ? ' is-muted' : ''}">`
    + (r.color ? `<i style="background:${r.color}"${r.dashed ? ' class="is-dashed"' : ''}></i>` : '')
    + `<span>${esc(r.label)}</span><b>${esc(r.value)}</b></div>`).join('');
  return `<div class="dash-tip" dir="rtl"><div class="dash-tip-title">${esc(title)}</div>${body}${note ? `<div class="dash-tip-note">${esc(note)}</div>` : ''}</div>`;
}

/** Shared chrome: font, tooltip surface, short animation. */
export function base(c: ChartColors) {
  return {
    textStyle: { fontFamily: 'inherit', color: c.ink },
    animationDuration: 280,
    animationDurationUpdate: 220,
    tooltip: {
      confine: true, backgroundColor: c.surface, borderColor: c.axis, borderWidth: 1, padding: [8, 10],
      textStyle: { color: c.ink, fontFamily: 'inherit', fontSize: 12 },
      extraCssText: 'border-radius:12px;box-shadow:0 8px 24px rgba(14,42,71,.14);',
    },
  };
}

export const axisLabel = (c: ChartColors, extra: object = {}) => ({ color: c.muted, fontSize: 12, fontFamily: 'inherit', ...extra });
export const splitLine = (c: ChartColors) => ({ lineStyle: { color: c.grid } });
