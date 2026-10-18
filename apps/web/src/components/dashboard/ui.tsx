import { useId, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, ChevronDown, Info, Lock, Minus, RotateCw } from 'lucide-react';
import { change, type Change } from '../../lib/dashboard';
import { fmtNum } from '../../lib/format';

/** A small "i" that explains a term or a calculation; works on hover, focus and tap. */
export function InfoTip({ text, label = 'تعريف' }: { text: string; label?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return <span className="dash-info" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
    <button type="button" className="dash-info-btn" aria-label={label} aria-describedby={open ? id : undefined} aria-expanded={open}
      onClick={(e) => { e.stopPropagation(); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
      onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}>
      <Info size={13} aria-hidden="true" /></button>
    {open && <span role="tooltip" id={id} className="dash-info-pop">{text}</span>}
  </span>;
}

/** Change vs the previous period. Counts change in %, shares in percentage points. */
export function Delta({ value, previous, attention, kind = 'count', compact }: {
  value: number | null; previous: number | null; attention?: 'up' | 'down'; kind?: 'count' | 'share'; compact?: boolean;
}) {
  if (kind === 'share') {
    if (value === null || previous === null) return <span className="dash-delta is-none">لا توجد مقارنة</span>;
    const pts = Math.round((value - previous) * 1000) / 10;
    return <DeltaView dir={pts > 0 ? 'up' : pts < 0 ? 'down' : 'same'} text={pts === 0 ? 'دون تغيير' : `${Math.abs(pts)} نقطة`}
      title={`السابق: ${(previous * 100).toFixed(1)}٪`} attention={attention} />;
  }
  const d = change(value, previous);
  if (!d) return <span className="dash-delta is-none">لا توجد مقارنة</span>;
  return <DeltaBadge d={d} previous={previous!} attention={attention} compact={compact} />;
}
export function DeltaBadge({ d, previous, attention, compact }: { d: Change; previous: number; attention?: 'up' | 'down'; compact?: boolean }) {
  if (d.kind === 'none') return <span className="dash-delta is-none">لا توجد مقارنة</span>;
  if (d.kind === 'new') return <span className="dash-delta is-none" title="لم تكن هناك قيمة في الفترة السابقة">لا توجد فترة أساس</span>;
  if (d.kind === 'same') return <DeltaView dir="same" text="دون تغيير" title={`السابق: ${fmtNum(previous)}`} />;
  return <DeltaView dir={d.kind} attention={attention} title={`السابق: ${fmtNum(previous)} (${d.diff > 0 ? '+' : ''}${fmtNum(d.diff)})`}
    text={`${Math.abs(d.pct!)}٪${compact ? '' : ` (${d.diff > 0 ? '+' : ''}${fmtNum(d.diff)})`}`} />;
}
function DeltaView({ dir, text, title, attention }: { dir: 'up' | 'down' | 'same'; text: string; title: string; attention?: 'up' | 'down' }) {
  const watch = attention && dir === attention;
  const good = attention && dir !== 'same' && dir !== attention;
  const Icon = dir === 'up' ? ArrowUp : dir === 'down' ? ArrowDown : Minus;
  return <span className={`dash-delta ${watch ? 'is-watch' : good ? 'is-good' : ''}`} title={title}>
    <Icon size={13} aria-hidden="true" />
    <span className="sr-only">{dir === 'up' ? 'ارتفاع' : dir === 'down' ? 'انخفاض' : ''}</span>{text}
    {watch && <span className="sr-only"> — يستحق الانتباه</span>}
  </span>;
}

/** A dashboard panel: title, optional definition tooltip, actions, collapsible body. */
export function Panel({ id, title, eyebrow, info, actions, children, footer, collapsed, onToggle, className = '' }: {
  id: string; title: string; eyebrow?: string; info?: string; actions?: ReactNode; children: ReactNode; footer?: ReactNode;
  collapsed?: boolean; onToggle?: () => void; className?: string;
}) {
  return <section className={`dash-panel ${className}`} aria-labelledby={`dash-${id}`}>
    <header className="dash-panel-head">
      <div className="min-w-0">
        {eyebrow && <span className="dash-eyebrow">{eyebrow}</span>}
        <h2 id={`dash-${id}`}>{title}{info && <InfoTip text={info} label={`عن ${title}`} />}</h2>
      </div>
      <div className="dash-panel-actions">{actions}
        {onToggle && <button className="icon-button" aria-expanded={!collapsed} aria-label={collapsed ? `إظهار ${title}` : `طي ${title}`} onClick={onToggle}>
          <ChevronDown size={16} style={{ transform: collapsed ? 'rotate(90deg)' : undefined, transition: 'transform .15s' }} /></button>}
      </div>
    </header>
    {!collapsed && <div className="dash-panel-body">{children}</div>}
    {!collapsed && footer && <footer className="dash-panel-foot">{footer}</footer>}
  </section>;
}

/** Loading / error / empty around a panel body; never shows a stale or invented number. */
export function State({ loading, error, empty, emptyText = 'لا توجد بيانات لهذه الفلاتر والفترة.', height = 220, onRetry, children }: {
  loading: boolean; error: unknown; empty?: boolean; emptyText?: string; height?: number; onRetry?: () => void; children: ReactNode;
}) {
  if (loading) return <div className="dash-skeleton" style={{ height }} aria-busy="true" aria-label="جارٍ التحميل" />;
  if (error) return <div className="dash-state is-error" role="alert" style={{ minHeight: Math.min(height, 140) }}>
    <AlertTriangle size={18} aria-hidden="true" /><span>{(error as Error).message || 'تعذر تحميل البيانات'}</span>
    {onRetry && <button className="dash-link" onClick={onRetry}><RotateCw size={13} />إعادة المحاولة</button>}</div>;
  if (empty) return <div className="dash-state" style={{ minHeight: Math.min(height, 140) }}>{emptyText}</div>;
  return <>{children}</>;
}
export function Unavailable({ reason }: { reason: string }) {
  return <div className="dash-state"><Lock size={16} aria-hidden="true" />{reason}</div>;
}

export function Stat({ label, value, sub, tone, info }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'warn' | 'bad' | 'muted'; info?: string }) {
  return <div className={`dash-stat ${tone ? `is-${tone}` : ''}`}>
    <span className="dash-stat-label">{label}{info && <InfoTip text={info} label={`عن ${label}`} />}</span>
    <strong className="dash-stat-value">{value}</strong>{sub && <span className="dash-stat-sub">{sub}</span>}
  </div>;
}

/** Legend entry that names the colour in text, so meaning never rests on colour alone. */
export function LegendItem({ color, label, value, hatch }: { color?: string; label: string; value?: ReactNode; hatch?: boolean }) {
  return <span className="dash-legend-item"><span className={`dash-swatch ${hatch ? 'dash-swatch--hatch' : ''}`} style={hatch ? undefined : { background: color }} aria-hidden="true" />
    <span>{label}</span>{value !== undefined && <strong className="num">{value}</strong>}</span>;
}

export const pctText = (n: number | null | undefined, digits = 0) => (n === null || n === undefined ? 'غير متوفر' : `${(n * 100).toFixed(digits)}٪`);
export const minutesText = (m: number | null | undefined) => m === null || m === undefined ? 'غير متوفر'
  : m < 60 ? `${Math.round(m)} د` : `${Math.floor(m / 60)} س ${Math.round(m % 60)} د`;
