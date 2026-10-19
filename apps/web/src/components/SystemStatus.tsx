import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ShieldCheck } from 'lucide-react';
import { fmtRelative } from '../lib/format';
import { collectionModeBadge } from '../lib/collection-mode';
import { Button } from './ui/Button';

type Tone = 'success' | 'warning' | 'info' | 'danger';

/** Arabic number agreement for "unit" (وحدة). */
const units = (n: number) => n === 1 ? 'وحدة واحدة' : n === 2 ? 'وحدتان' : n >= 3 && n <= 10 ? `${n} وحدات` : `${n} وحدة`;

export interface SystemStatusProps {
  mode?: string | null;
  failed: boolean;
  /** Global X kill switch, when active. */
  stop?: { reason: string } | null;
  lastRequestAt?: string | null;
  spentMonthUnits?: number;
  monthUnitLimit?: number | null;
  /** Present only for users allowed to operate the kill switch. */
  onResume?: () => void;
}

/**
 * The one system-status indicator in the top bar (PRODUCT.md principle 3):
 * a single state for X collection, with the details and the resume action
 * one click away. A stop always outranks the run mode.
 */
export default function SystemStatus({ mode, failed, stop, lastRequestAt, spentMonthUnits, monthUnitLimit, onResume }: SystemStatusProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const modeInfo = collectionModeBadge(mode, failed);
  const { tone, state }: { tone: Tone; state: string } = stop
    ? { tone: 'danger', state: 'موقوف' }
    : failed ? { tone: 'warning', state: 'غير معروف' }
    : mode === 'live' ? { tone: 'success', state: 'يعمل' }
    : mode === 'dry_run' ? { tone: 'warning', state: 'تشغيل جاف' }
    : { tone: 'info', state: modeInfo.text === 'وضع تجريبي' ? 'تجريبي' : modeInfo.text };

  return (
    <div className="sys-status" ref={ref}>
      <button type="button" className={`sys-status-button is-${tone}`} aria-expanded={open} aria-controls="sys-status-panel"
        aria-label={`جمع إكس: ${state}. عرض التفاصيل`} onClick={() => setOpen((o) => !o)}>
        <span className={`sys-status-dot ${tone === 'success' ? 'is-live' : ''}`} aria-hidden="true" />
        <span className="sys-status-prefix">جمع إكس</span>
        <span className="sys-status-state">{state}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div id="sys-status-panel" className="card sys-status-panel" role="region" aria-label="حالة جمع إكس">
          <dl className="sys-status-list">
            <div><dt>حالة الجمع</dt><dd className={`is-${tone}`}>{state}</dd></div>
            {stop && <div><dt>سبب الإيقاف</dt><dd>{stop.reason}</dd></div>}
            <div><dt>وضع التشغيل</dt><dd title={modeInfo.title}>{modeInfo.text}</dd></div>
            {lastRequestAt && <div><dt>آخر طلب إلى إكس</dt><dd title={lastRequestAt}>{fmtRelative(lastRequestAt)}</dd></div>}
            {spentMonthUnits !== undefined && (
              <div><dt>استهلاك الشهر</dt><dd>{monthUnitLimit ? `${spentMonthUnits} من ${monthUnitLimit} وحدة` : units(spentMonthUnits)}</dd></div>
            )}
          </dl>
          {stop && onResume && (
            <Button variant="ghost" className="w-full btn-success-text" icon={<ShieldCheck size={17} aria-hidden="true" />}
              onClick={() => { setOpen(false); onResume(); }}>استئناف الجمع</Button>
          )}
        </div>
      )}
    </div>
  );
}
