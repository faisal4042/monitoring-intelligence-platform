import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, Info, Minus, RotateCcw, TrendingDown, TrendingUp } from 'lucide-react';
import { useTheme } from '../../lib/theme';
import { change } from '../../lib/influencers';
import { fmtNum } from '../../lib/format';

export function Pill({ tone, children, title }: { tone?: 'ok' | 'muted' | 'warn' | 'bad' | 'info'; children: ReactNode; title?: string }) {
  return <span className={`inf-pill ${tone && tone !== 'muted' ? `inf-pill--${tone}` : ''}`} title={title}>{children}</span>;
}

/** Loading / error / empty around a block; never shows a stale or invented number. */
export function StateBox({ loading, error, empty, emptyText, onRetry, height = 160, children }: {
  loading: boolean; error: unknown; empty?: boolean; emptyText?: ReactNode; onRetry?: () => void; height?: number; children: ReactNode;
}) {
  if (loading) return <div className="inf-skeleton" style={{ height }} aria-busy="true" aria-label="جارٍ التحميل" />;
  if (error) return (
    <div className="inf-state inf-state--error" role="alert">
      <span className="flex items-center gap-2"><AlertTriangle size={16} aria-hidden="true" />{(error as Error).message || 'تعذّر تحميل البيانات'}</span>
      {onRetry && <button className="btn-ghost" onClick={onRetry}><RotateCcw size={14} /> إعادة المحاولة</button>}
    </div>
  );
  if (empty) return <div className="inf-state">{emptyText ?? 'لا توجد بيانات لهذه الفلاتر والفترة.'}</div>;
  return <>{children}</>;
}

export function Basis({ children }: { children: ReactNode }) {
  return <p className="inf-basis"><Info size={12} aria-hidden="true" />{children}</p>;
}

export function Delta({ now, before }: { now: number; before: number | null | undefined }) {
  const d = change(now, before);
  if (!d) return null;
  if (d.kind === 'new') return <span className="inf-delta" title="لم تكن هناك قيمة في الفترة السابقة">جديد مقارنة بالفترة السابقة</span>;
  if (d.kind === 'same') return <span className="inf-delta"><Minus size={12} aria-hidden="true" />دون تغيير عن الفترة السابقة</span>;
  const Icon = d.kind === 'up' ? TrendingUp : TrendingDown;
  return (
    <span className={`inf-delta inf-delta--${d.kind}`} title={`الفترة السابقة: ${fmtNum(before)}`}>
      <Icon size={12} aria-hidden="true" />{d.kind === 'up' ? 'ارتفاع' : 'انخفاض'} <span className="num">{Math.abs(d.pct!)}%</span> عن الفترة السابقة
    </span>
  );
}

export function Kpi({ label, value, sub, unavailable }: { label: string; value?: number | null; sub?: ReactNode; unavailable?: string }) {
  return (
    <div className="card inf-kpi">
      <span className="inf-kpi-label">{label}</span>
      {unavailable
        ? <span className="inf-kpi-value inf-kpi-value--na">{unavailable}</span>
        : <strong className="inf-kpi-value num">{fmtNum(value)}</strong>}
      {sub && <span className="inf-kpi-sub">{sub}</span>}
    </div>
  );
}

/**
 * Chart colours for the current theme — the same validated Ithra series the
 * dashboard charts use (teal, orange, blue) and its sentiment pair.
 */
export function useChartPalette() {
  const { theme } = useTheme();
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener('change', on); return () => mq.removeEventListener('change', on);
  }, []);
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  return dark ? {
    series: ['#18a2a2', '#d17a2e', '#4c82db'], positive: '#4c82db', neutral: '#5b7799', negative: '#e66767', unclassified: '#23466f',
    ink: '#ffffff', muted: '#c5d1de', grid: '#23466f', axis: '#2f5a86', surface: '#12304f',
  } : {
    series: ['#1fb5b5', '#e07b39', '#2a6fd1'], positive: '#2a6fd1', neutral: '#c2cedb', negative: '#d03b3b', unclassified: '#eaf0f5',
    ink: '#0e2a47', muted: '#52637a', grid: '#eaf0f5', axis: '#c2cedb', surface: '#ffffff',
  };
}
export type ChartPalette = ReturnType<typeof useChartPalette>;
