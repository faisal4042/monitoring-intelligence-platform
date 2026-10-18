import { useMemo, useRef, useState } from 'react';
import { LineChart, Table2 } from 'lucide-react';
import { fmtNum } from '../../../lib/format';
import { TREND_LABELS, TREND_SERIES, change, type TrendSeries } from '../../../lib/dashboard';
import EChart, { type ChartInstance } from '../charts/EChart';
import { trendOption } from '../charts/options';
import { useChartColors } from '../charts/theme';
import { bucketLabel, bucketTitle, granularityText } from '../transforms';
import type { OnDrill, Q, TrendData } from '../types';
import { DeltaBadge, Panel, State } from '../ui';

/** The dashboard's main visual: one metric at a time on one axis, optionally against the previous period. */
export default function TrendPanel({ q, initial, onDrill, panel }: { q: Q<TrendData>; initial: TrendSeries; onDrill: OnDrill; panel: object }) {
  const c = useChartColors();
  const [metric, setMetric] = useState<TrendSeries>(initial);
  const [compare, setCompare] = useState(false);
  const [table, setTable] = useState(false);
  const d = q.data;
  const g = d?.granularity ?? 'day';
  const items = d?.items ?? [];
  const prev = d?.previous ?? [];
  const canCompare = prev.length > 0;

  const option = useMemo(() => trendOption(c, {
    labels: items.map((i) => bucketLabel(g, i.bucket)),
    titles: items.map((i) => bucketTitle(g, i.bucket)),
    name: TREND_LABELS[metric],
    current: items.map((i) => i[metric]),
    previous: compare && canCompare ? { name: 'الفترة السابقة', values: prev.map((i) => i[metric]), titles: prev.map((i) => bucketTitle(g, i.bucket)) } : null,
  }), [c, items, prev, g, metric, compare, canCompare]);

  const summary = useMemo(() => {
    if (!items.length) return null;
    const sum = items.reduce((n, i) => n + i[metric], 0);
    const prevSum = canCompare ? prev.reduce((n, i) => n + i[metric], 0) : null;
    const peak = items.reduce((m, i) => (i[metric] > m[metric] ? i : m), items[0]);
    return { sum, prevSum, avg: sum / items.length, peak };
  }, [items, prev, metric, canCompare]);

  // Clicking anywhere in a bucket's column opens that bucket's posts. Handler reads current state through a ref.
  const latest = useRef({ items, g, metric, onDrill });
  latest.current = { items, g, metric, onDrill };
  const onReady = (chart: ChartInstance) => {
    const zr = chart.getZr();
    const handler = (ev: { offsetX: number; offsetY: number }) => {
      const { items, g, metric, onDrill } = latest.current;
      if (!chart.containPixel({ gridIndex: 0 }, [ev.offsetX, ev.offsetY])) return;
      const [idx] = chart.convertFromPixel({ gridIndex: 0 }, [ev.offsetX, ev.offsetY]) as number[];
      const row = items[Math.round(idx)];
      if (row) onDrill({ title: `${TREND_LABELS[metric]} · ${bucketTitle(g, row.bucket)}`, params: { bucket: row.bucket, unit: g, series: metric } });
    };
    zr.on('click', handler);
    return () => zr.off('click', handler);
  };

  const unit = g === 'hour' ? 'ساعة' : g === 'week' ? 'أسبوع' : 'يوم';
  const delta = summary && summary.prevSum !== null ? change(summary.sum, summary.prevSum) : null;
  return <Panel id="trend" title="اتجاه النشاط" eyebrow="الاتجاهات والنشاط" className="dash-panel--hero" {...panel}
    info={`منشورات X حسب تاريخ النشر، تجميع ${granularityText(g)} بتوقيت الرياض. اضغط على أي نقطة لعرض منشوراتها. الأخبار لا تدخل في هذا الرسم.`}
    actions={<button className="icon-button" onClick={() => setTable((t) => !t)} aria-pressed={table} aria-label={table ? 'عرض كرسم' : 'عرض كجدول'} title={table ? 'عرض كرسم' : 'عرض كجدول'}>
      {table ? <LineChart size={16} /> : <Table2 size={16} />}</button>}>
    <div className="dash-trend-bar">
      <div className="dash-segment" role="radiogroup" aria-label="المؤشر المعروض">
        {TREND_SERIES.map((s) => <button key={s} role="radio" aria-checked={metric === s} onClick={() => setMetric(s)}>{TREND_LABELS[s]}</button>)}
      </div>
      <label className={`dash-switch ${canCompare ? '' : 'is-disabled'}`} title={canCompare ? undefined : 'لا توجد فترة سابقة مساوية لهذه الفترة'}>
        <input type="checkbox" checked={compare && canCompare} disabled={!canCompare} onChange={(e) => setCompare(e.target.checked)} />
        <span className="dash-switch-track" aria-hidden="true" /><span>مقارنة بالفترة السابقة</span>
      </label>
    </div>
    <State loading={q.isLoading} error={q.error} empty={!items.length || items.every((i) => i.total === 0)} height={320}
      emptyText="لا توجد منشورات في هذه الفترة والفلاتر.">
      {summary && <dl className="dash-trend-summary">
        <div><dt>الإجمالي في الفترة</dt><dd className="num">{fmtNum(summary.sum)}</dd>
          {delta && summary.prevSum !== null && <DeltaBadge d={delta} previous={summary.prevSum} attention={metric === 'complaints' ? 'up' : undefined} compact />}</div>
        <div><dt>المتوسط لكل {unit}</dt><dd className="num">{fmtNum(Math.round(summary.avg * 10) / 10)}</dd></div>
        <div><dt>الذروة</dt><dd className="num">{fmtNum(summary.peak[metric])}</dd><span className="dash-muted-sm">{bucketTitle(g, summary.peak.bucket)}</span></div>
      </dl>}
      {table ? <div className="dash-table-wrap dash-table-scroll"><table className="dash-table">
        <thead><tr><th>الفترة</th>{TREND_SERIES.map((s) => <th key={s}>{TREND_LABELS[s]}</th>)}</tr></thead>
        <tbody>{items.map((i) => <tr key={i.bucket}><td>{bucketTitle(g, i.bucket)}</td>{TREND_SERIES.map((s) => <td key={s} className="num">{fmtNum(i[s])}</td>)}</tr>)}</tbody>
      </table></div>
        : <>
          <EChart option={option} height={300} label={`${TREND_LABELS[metric]} حسب ${unit}`} onReady={onReady} />
          {compare && canCompare && <div className="dash-legend">
            <span className="dash-legend-item"><span className="dash-line-swatch" style={{ borderColor: c.primary }} aria-hidden="true" />الفترة الحالية</span>
            <span className="dash-legend-item"><span className="dash-line-swatch is-dashed" style={{ borderColor: c.compare }} aria-hidden="true" />الفترة السابقة المساوية</span>
          </div>}
        </>}
    </State>
  </Panel>;
}
