import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, ChevronDown, Info, Lock, TrendingDown, TrendingUp, Minus } from 'lucide-react';
import { useTheme } from '../../lib/theme';
import { change, type Change } from '../../lib/dashboard';
import { fmtNum } from '../../lib/format';

/** Chart colours: the validated categorical order, stepped per theme; sentiment uses the diverging pair. */
export function useChartColors() {
  const { theme } = useTheme();
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener('change', on); return () => mq.removeEventListener('change', on);
  }, []);
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  return dark ? {
    dark, series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
    positive: '#3987e5', neutral: '#5b6b70', negative: '#e66767', unclassified: '#2f3f44',
    ink: '#eef5f4', muted: '#9bacae', grid: '#2a3b40', axis: '#3a4d53', surface: '#142126',
  } : {
    dark, series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
    positive: '#2a78d6', neutral: '#b9c2c6', negative: '#e34948', unclassified: '#e6eaec',
    ink: '#132125', muted: '#687a81', grid: '#e6ebee', axis: '#cdd6dc', surface: '#ffffff',
  };
}
export type ChartColors = ReturnType<typeof useChartColors>;

/** Shared ECharts chrome: RTL-friendly tooltip, recessive grid, system font. */
export function baseChart(c: ChartColors) {
  return {
    textStyle: { fontFamily: 'inherit', color: c.ink },
    tooltip: { backgroundColor: c.surface, borderColor: c.axis, textStyle: { color: c.ink, fontFamily: 'inherit' }, confine: true },
    animationDuration: 300,
  };
}

/** Change vs the previous period. `attention` = the direction that needs a look (e.g. complaints up). */
export function Delta({ value, previous, attention, compact }: { value: number | null; previous: number | null; attention?: 'up' | 'down'; compact?: boolean }) {
  const d = change(value, previous);
  if (!d) return <span className="text-xs muted">لا توجد مقارنة</span>;
  return <DeltaBadge d={d} previous={previous!} attention={attention} compact={compact} />;
}
export function DeltaBadge({ d, previous, attention, compact }: { d: Change; previous: number; attention?: 'up' | 'down'; compact?: boolean }) {
  if (d.kind === 'new') return <span className="dash-delta" title="لم تكن هناك قيمة في الفترة السابقة">جديد · لا توجد فترة أساس</span>;
  if (d.kind === 'same') return <span className="dash-delta"><Minus size={12} aria-hidden="true" />دون تغيير</span>;
  const watch = attention && d.kind === attention;
  const Icon = d.kind === 'up' ? TrendingUp : TrendingDown;
  return <span className={`dash-delta ${watch ? 'dash-delta--watch' : ''}`} title={`السابق: ${fmtNum(previous)}`}>
    <Icon size={12} aria-hidden="true" />{d.kind === 'up' ? 'ارتفاع' : 'انخفاض'} {Math.abs(d.pct!)}٪
    {!compact && <span className="muted"> ({d.diff > 0 ? '+' : ''}{fmtNum(d.diff)})</span>}
    {watch && <span className="sr-only">يستحق الانتباه</span>}
  </span>;
}

export function Section({ id, title, eyebrow, basis, actions, children, collapsed, onToggle }: {
  id: string; title: string; eyebrow?: string; basis?: string; actions?: ReactNode; children: ReactNode; collapsed?: boolean; onToggle?: () => void;
}) {
  return <section className="card dash-section" aria-labelledby={`dash-${id}`}>
    <header className="dash-section-head">
      <div className="min-w-0">
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h2 id={`dash-${id}`}>{title}</h2>
        {basis && <p className="dash-basis"><Info size={12} aria-hidden="true" />{basis}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">{actions}
        {onToggle && <button className="icon-button" aria-expanded={!collapsed} aria-label={collapsed ? `إظهار ${title}` : `طي ${title}`} onClick={onToggle}>
          <ChevronDown size={16} style={{ transform: collapsed ? 'rotate(90deg)' : undefined }} /></button>}
      </div>
    </header>
    {!collapsed && children}
  </section>;
}

/** Loading / error / empty around a section body; never shows a stale or invented number. */
export function State({ loading, error, empty, emptyText = 'لا توجد بيانات لهذه الفلاتر والفترة.', height = 220, children }: {
  loading: boolean; error: unknown; empty?: boolean; emptyText?: string; height?: number; children: ReactNode;
}) {
  if (loading) return <div className="dash-skeleton" style={{ height }} aria-busy="true" aria-label="جارٍ التحميل" />;
  if (error) return <div className="dash-state" role="alert" style={{ minHeight: height / 2 }}><AlertTriangle size={18} />
    {(error as Error).message || 'تعذر تحميل البيانات'}</div>;
  if (empty) return <div className="dash-state" style={{ minHeight: height / 2 }}>{emptyText}</div>;
  return <>{children}</>;
}
export function Unavailable({ reason }: { reason: string }) {
  return <div className="dash-state"><Lock size={16} aria-hidden="true" />{reason}</div>;
}

export function Stat({ label, value, sub, onClick }: { label: string; value: ReactNode; sub?: ReactNode; onClick?: () => void }) {
  const body = <><span className="dash-stat-label">{label}</span><strong className="dash-stat-value">{value}</strong>{sub && <span className="dash-stat-sub">{sub}</span>}</>;
  return onClick ? <button className="dash-stat dash-stat--link" onClick={onClick}>{body}</button> : <div className="dash-stat">{body}</div>;
}

export const pctText = (n: number | null | undefined, digits = 0) => (n === null || n === undefined ? 'غير متوفر' : `${(n * 100).toFixed(digits)}٪`);
export const minutesText = (m: number | null | undefined) => m === null || m === undefined ? 'غير متوفر'
  : m < 60 ? `${Math.round(m)} د` : `${Math.floor(m / 60)} س ${Math.round(m % 60)} د`;
