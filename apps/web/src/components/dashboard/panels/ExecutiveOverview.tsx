import { useMemo } from 'react';
import { fmtCompact, fmtNum } from '../../../lib/format';
import EChart from '../charts/EChart';
import { sparkOption } from '../charts/options';
import { useChartColors } from '../charts/theme';
import type { ExecKey, ExecKpi } from '../transforms';
import { Delta, InfoTip } from '../ui';

const valueText = (k: ExecKpi) => k.value === null ? '—'
  : k.kind === 'share' ? `${(k.value * 100).toFixed(1)}٪`
  : k.value >= 100_000 ? fmtCompact(k.value) : fmtNum(k.value);

function Spark({ values, color, fill }: { values: Array<number | null>; color: string; fill: boolean }) {
  const c = useChartColors();
  const option = useMemo(() => sparkOption(c, values, color, fill), [c, values, color, fill]);
  return <EChart option={option} height={34} label="اتجاه المؤشر خلال الفترة" className="dash-kpi-spark" />;
}

/** The executive row: at most six cards, each a real figure with its own definition. */
export default function ExecutiveOverview({ kpis, loading, error, actions }: {
  kpis: ExecKpi[]; loading: (k: ExecKey) => boolean; error?: unknown;
  actions: Partial<Record<ExecKey, { label: string; run: () => void }>>;
}) {
  const c = useChartColors();
  if (error) return <div className="dash-state is-error" role="alert">{(error as Error).message || 'تعذر تحميل المؤشرات'}</div>;
  return <section className="dash-kpis" aria-label="الملخص التنفيذي">
    {kpis.map((k) => {
      const busy = loading(k.key);
      const action = actions[k.key];
      const watchColor = k.key === 'negative_share' ? c.negative : c.primary;
      return <article key={k.key} className="dash-kpi" aria-busy={busy || undefined}>
        <header className="dash-kpi-head"><span className="dash-kpi-label">{k.label}</span><InfoTip text={k.hint} label={`عن ${k.label}`} /></header>
        {k.unavailable ? <><strong className="dash-kpi-value is-muted">غير متوفر</strong><span className="dash-kpi-sub">{k.unavailable}</span></>
          : busy ? <><span className="dash-skeleton" style={{ height: 30, width: '60%' }} /><span className="dash-skeleton" style={{ height: 14, width: '40%' }} /></>
          : <>
            {action && k.value !== null
              ? <button className="dash-kpi-value num" onClick={action.run} title={action.label}>{valueText(k)}</button>
              : <strong className="dash-kpi-value num" title={k.kind === 'count' && k.value !== null && k.value >= 100_000 ? fmtNum(k.value) : undefined}>{valueText(k)}</strong>}
            <div className="dash-kpi-meta">
              {k.key === 'attention' ? <span className="dash-delta is-none">الحالة في الفترة</span>
                : <Delta value={k.value} previous={k.previous} attention={k.attention} kind={k.kind} compact />}
              {k.sub && <span className="dash-kpi-sub">{k.sub}</span>}
            </div>
          </>}
        {!busy && !k.unavailable && k.spark && <Spark values={k.spark} color={watchColor} fill={k.kind === 'count'} />}
      </article>;
    })}
  </section>;
}
