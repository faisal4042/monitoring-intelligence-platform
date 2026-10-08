import { useMemo, useRef, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import { ChevronLeft, Table2, LineChart, Sparkles } from 'lucide-react';
import { fmtNum, fmtDayShort, fmtHourLabel } from '../../lib/format';
import {
  INTENT_LABELS, KPI_META, SENTIMENT_GROUP_LABELS, TREND_LABELS, TREND_SERIES, change, share,
  type Kpi, type KpiKey, type Layout, type Meta, type TrendSeries,
} from '../../lib/dashboard';
import { Delta, Section, State, Stat, baseChart, pctText, useChartColors, type ChartColors } from './ui';

export interface Drill { title: string; params: Record<string, string> }
type OnDrill = (d: Drill) => void;
type Q<T> = { data?: T & Meta; isLoading: boolean; error: unknown };

/** Horizontal bars that grow right-to-left, labels on the right (RTL). */
function hbar(c: ChartColors, rows: Array<{ name: string; value: number; color?: string; tip?: string }>, onClick?: (i: number) => void) {
  return {
    option: {
      ...baseChart(c),
      grid: { left: 40, right: 8, top: 6, bottom: 6, containLabel: true },
      tooltip: { ...baseChart(c).tooltip, trigger: 'item', formatter: (p: { dataIndex: number }) => rows[p.dataIndex].tip ?? `${rows[p.dataIndex].name}: ${fmtNum(rows[p.dataIndex].value)}` },
      xAxis: { type: 'value', inverse: true, splitLine: { lineStyle: { color: c.grid } }, axisLabel: { color: c.muted, fontSize: 10 } },
      yAxis: { type: 'category', position: 'right', inverse: true, data: rows.map((r) => r.name), axisTick: { show: false },
        axisLine: { lineStyle: { color: c.axis } }, axisLabel: { color: c.ink, fontSize: 11, width: 150, overflow: 'truncate' } },
      series: [{ type: 'bar', barMaxWidth: 16, cursor: onClick ? 'pointer' : 'default',
        data: rows.map((r) => ({ value: r.value, itemStyle: { color: r.color ?? c.series[0], borderRadius: [4, 0, 0, 4] } })),
        label: { show: true, position: 'left', color: c.muted, fontSize: 10, formatter: (p: { value: number }) => fmtNum(p.value) } }],
    },
    height: Math.max(90, rows.length * 30 + 20),
    events: onClick ? { click: (p: { dataIndex: number }) => onClick(p.dataIndex) } : undefined,
  };
}
function HBar(props: { rows: Array<{ name: string; value: number; color?: string; tip?: string }>; onClick?: (i: number) => void; label: string }) {
  const c = useChartColors();
  const h = hbar(c, props.rows, props.onClick);
  return <div role="img" aria-label={props.label}><ReactECharts option={h.option} style={{ height: h.height }} onEvents={h.events} notMerge /></div>;
}

// ── KPIs ────────────────────────────────────────────────────────────────────
const KPI_DRILL: Partial<Record<KpiKey, Record<string, string>>> = {
  total: { series: 'total' }, relevant: { series: 'relevant' }, excluded: { series: 'excluded' },
  inquiries: { series: 'inquiries' }, complaints: { series: 'complaints' }, active_influencers: { influencersOnly: 'true', series: 'total' },
};
export type KpiData = { kpis: Kpi[]; context: { unclassified: number; humanReviewed: number } };
export function KpiCards({ q, layout, onDrill, onJump }: { q: Q<KpiData>; layout: Layout; onDrill: OnDrill; onJump: (s: string) => void }) {
  const [more, setMore] = useState(false);
  const kpis = q.data?.kpis ?? [];
  const shown = layout.kpis.map((k) => kpis.find((x) => x.key === k)).filter(Boolean) as Kpi[];
  const rest = kpis.filter((k) => !layout.kpis.includes(k.key));
  const card = (k: Kpi) => {
    const meta = KPI_META[k.key];
    const action = KPI_DRILL[k.key] ? () => onDrill({ title: meta.label, params: KPI_DRILL[k.key]! })
      : k.key === 'approved_stories' ? () => onJump('stories') : k.key === 'unique_hashtags' ? () => onJump('hashtags') : undefined;
    return <button key={k.key} className="card dash-kpi" onClick={action} disabled={!k.available || !action} title={meta.hint}>
      <span className="dash-kpi-label">{meta.label}</span>
      {k.available ? <><strong className="dash-kpi-value num">{fmtNum(k.value)}</strong><Delta value={k.value} previous={k.previous} attention={meta.attention} /></>
        : <><strong className="dash-kpi-value muted">غير متوفر</strong><span className="text-xs muted">{k.reason}</span></>}
    </button>;
  };
  if (q.isLoading) return <div className="dash-kpis">{layout.kpis.slice(0, 6).map((k) => <div key={k} className="card dash-kpi dash-skeleton" style={{ height: 118 }} />)}</div>;
  if (q.error) return <State loading={false} error={q.error}>{null}</State>;
  return <div className="space-y-2">
    <div className="dash-kpis">{shown.map(card)}</div>
    {rest.length > 0 && <div>
      <button className="btn-ghost text-sm" aria-expanded={more} onClick={() => setMore((m) => !m)}>{more ? 'إخفاء المؤشرات الإضافية' : `مؤشرات إضافية (${rest.length})`}</button>
      {more && <div className="dash-kpis mt-2">{rest.map(card)}</div>}
    </div>}
    {q.data && <p className="dash-basis">التصنيف الفعّال: القيمة المعتمدة من مراجعة الموظف إن وُجدت ({fmtNum(q.data.context.humanReviewed)} منشورًا في هذه الفترة)، وإلا تصنيف الذكاء الاصطناعي. منشورات لم تُصنف بعد: {fmtNum(q.data.context.unclassified)}.</p>}
  </div>;
}

// ── Trend ───────────────────────────────────────────────────────────────────
type TrendRow = { bucket: string; total: number; relevant: number; complaints: number; inquiries: number };
export type TrendData = { granularity: 'hour' | 'day' | 'week'; items: TrendRow[]; previous: TrendRow[] };
export function TrendSection({ q, layout, onDrill, sectionProps }: { q: Q<TrendData>; layout: Layout; onDrill: OnDrill; sectionProps: object }) {
  const c = useChartColors();
  const [series, setSeries] = useState<TrendSeries[]>(layout.trendSeries ?? ['relevant', 'complaints', 'inquiries']);
  const [compare, setCompare] = useState(false);
  const [table, setTable] = useState(false);
  const g = q.data?.granularity ?? 'day';
  const label = (b: string) => g === 'hour' ? fmtHourLabel(b) : g === 'week' ? `أسبوع ${fmtDayShort(b)}` : fmtDayShort(b);
  const items = q.data?.items ?? [];
  const option = useMemo(() => ({
    ...baseChart(c),
    grid: { left: 8, right: 8, top: compare ? 36 : 12, bottom: items.length > 31 ? 54 : 24, containLabel: true },
    tooltip: { ...baseChart(c).tooltip, trigger: 'axis' },
    // The series checkboxes above carry the swatches; a chart legend is only needed to tell the dashed previous-period lines apart.
    legend: { show: compare, top: 0, textStyle: { color: c.muted }, itemWidth: 14, itemHeight: 3 },
    xAxis: { type: 'category', data: items.map((i) => label(i.bucket)), axisLine: { lineStyle: { color: c.axis } }, axisLabel: { color: c.muted, fontSize: 10 }, inverse: true },
    yAxis: { type: 'value', position: 'right', splitLine: { lineStyle: { color: c.grid } }, axisLabel: { color: c.muted, fontSize: 10 }, minInterval: 1 },
    dataZoom: items.length > 31 ? [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 8 }] : [],
    series: TREND_SERIES.filter((s) => series.includes(s)).flatMap((s) => {
      const color = c.series[TREND_SERIES.indexOf(s)];
      const main = { name: TREND_LABELS[s], type: 'line', data: items.map((i) => i[s]), smooth: false, symbolSize: 7, lineStyle: { width: 2 }, itemStyle: { color } };
      if (!compare || !q.data?.previous.length) return [main];
      return [main, { name: `${TREND_LABELS[s]} (الفترة السابقة)`, type: 'line', data: q.data.previous.map((i) => i[s]), symbol: 'none',
        lineStyle: { width: 1.5, type: 'dashed', color }, itemStyle: { color }, silent: true }];
    }),
  }), [c, items, series, compare, q.data, g]);
  const visibleSeries = TREND_SERIES.filter((s) => series.includes(s));
  // The chart's click handler is registered once; it always reads the current data through this ref.
  const latest = useRef({ items, visibleSeries, g, onDrill, label });
  latest.current = { items, visibleSeries, g, onDrill, label };
  // A click anywhere in a day's column opens that day, for the series line nearest the pointer.
  const onReady = (chart: { getZr: () => { on: (e: string, f: (ev: { offsetX: number; offsetY: number }) => void) => void };
    convertFromPixel: (f: object, p: number[]) => number[]; convertToPixel: (f: object, p: number[]) => number[] }) => {
    chart.getZr().on('click', (ev) => {
      const { items, visibleSeries, g, onDrill, label } = latest.current;
      const [idx] = chart.convertFromPixel({ gridIndex: 0 }, [ev.offsetX, ev.offsetY]);
      const row = items[Math.round(idx)];
      if (!row || !visibleSeries.length) return;
      const nearest = visibleSeries.map((s) => ({ s, d: Math.abs(chart.convertToPixel({ gridIndex: 0 }, [Math.round(idx), row[s]])[1] - ev.offsetY) }))
        .sort((x, y) => x.d - y.d)[0].s;
      onDrill({ title: `${TREND_LABELS[nearest]} · ${label(row.bucket)}`, params: { bucket: row.bucket, unit: g, series: nearest } });
    });
  };
  return <Section id="trend" title="اتجاه التفاعلات" eyebrow="حجم الرصد" basis={`حسب تاريخ النشر على X · تجميع ${g === 'hour' ? 'بالساعة' : g === 'week' ? 'أسبوعي (يبدأ الأحد)' : 'يومي'} بتوقيت الرياض · اضغط نقطة لعرض منشوراتها`} {...sectionProps}
    actions={<button className="icon-button" onClick={() => setTable((t) => !t)} aria-pressed={table} aria-label={table ? 'عرض كرسم' : 'عرض كجدول'} title={table ? 'عرض كرسم' : 'عرض كجدول'}>{table ? <LineChart size={16} /> : <Table2 size={16} />}</button>}>
    <div className="flex flex-wrap gap-2 mb-2" role="group" aria-label="السلاسل المعروضة">
      {TREND_SERIES.map((s, i) => <label key={s} className="dash-check"><input type="checkbox" checked={series.includes(s)} disabled={series.length === 1 && series.includes(s)}
        onChange={(e) => setSeries((old) => e.target.checked ? [...old, s] : old.filter((x) => x !== s))} />
        <span className="dash-swatch" style={{ background: c.series[i] }} aria-hidden="true" />{TREND_LABELS[s]}</label>)}
      <label className="dash-check"><input type="checkbox" checked={compare} disabled={!q.data?.previous.length} onChange={(e) => setCompare(e.target.checked)} />مقارنة بالفترة السابقة</label>
    </div>
    <State loading={q.isLoading} error={q.error} empty={!items.length || items.every((i) => i.total === 0)} height={280}>
      {table ? <div className="dash-table-wrap"><table className="dash-table"><thead><tr><th>الفترة</th>{TREND_SERIES.map((s) => <th key={s}>{TREND_LABELS[s]}</th>)}</tr></thead>
        <tbody>{items.map((i) => <tr key={i.bucket}><td>{label(i.bucket)}</td>{TREND_SERIES.map((s) => <td key={s} className="num">{fmtNum(i[s])}</td>)}</tr>)}</tbody></table></div>
        : <ReactECharts option={option} style={{ height: 290 }} onChartReady={onReady} notMerge />}
    </State>
  </Section>;
}

// ── Programs ───────────────────────────────────────────────────────────────
type ProgramRow = { id: string; key: string; name_ar: string; color: string | null; posts: number; relevant: number; complaints: number; inquiries: number;
  negative: number; sentiment_sample: number; active_influencers: number | null; stories: number };
type TopicRow = { id: string; name: string; parentName: string | null; count: number; previous: number | null; complaints: number };
export type ClassData = { sample: { relevant: number; with_intent: number; with_topic: number }; intents: Array<{ intent: string; count: number; previous: number | null }>; topics: TopicRow[]; subtopics: TopicRow[] };
export type ProgramsData = { items: ProgramRow[]; unlinked: number };
export function ProgramsSection({ q, cls, programMode, onPick, onDrill, sectionProps }: { q: Q<ProgramsData>; cls: Q<ClassData>; programMode: boolean; onPick: (key: string) => void; onDrill: OnDrill; sectionProps: object }) {
  if (programMode) {
    const topics = cls.data?.topics ?? [];
    return <Section id="programs" title="تحليل البرنامج: أهم التصنيفات" eyebrow="البرنامج المختار" basis="التصنيفات الرئيسية الأكثر تكرارًا في المنشورات ذات الصلة (التصنيف الفعّال)" {...sectionProps}>
      <State loading={cls.isLoading} error={cls.error} empty={!topics.length} emptyText="لا توجد منشورات مصنفة بتصنيف رئيسي في هذه الفترة.">
        <HBar label="أهم التصنيفات الرئيسية" rows={topics.slice(0, 6).map((t) => ({ name: t.name, value: t.count }))} onClick={(i) => onDrill({ title: topics[i].name, params: { topicId: topics[i].id } })} />
      </State>
    </Section>;
  }
  const items = (q.data?.items ?? []).filter((p) => p.posts > 0 || p.stories > 0);
  return <Section id="programs" title="مقارنة البرامج" eyebrow="جميع البرامج" basis="كل منشور مرتبط ببرنامج واحد على الأكثر، فلا يتكرر بين البرامج. اضغط برنامجًا لعرض لوحته." {...sectionProps}>
    <State loading={q.isLoading} error={q.error} empty={!items.length}>
      <HBar label="المنشورات ذات الصلة لكل برنامج" rows={items.map((p) => ({ name: p.name_ar, value: p.relevant, color: p.color ?? undefined, tip: `${p.name_ar}: ${fmtNum(p.relevant)} ذات صلة من ${fmtNum(p.posts)}` }))} onClick={(i) => onPick(items[i].key)} />
      <div className="dash-table-wrap"><table className="dash-table">
        <thead><tr><th>البرنامج</th><th>المنشورات</th><th>ذات الصلة</th><th>الشكاوى</th><th>الاستفسارات</th><th>نسبة السلبية</th><th>مؤثرون نشطون</th><th>القصص</th></tr></thead>
        <tbody>{items.map((p) => <tr key={p.id}>
          <td><button className="dash-link" onClick={() => onPick(p.key)}><span className="dash-dot" style={{ background: p.color ?? undefined }} />{p.name_ar}</button></td>
          <td className="num">{fmtNum(p.posts)}</td><td className="num">{fmtNum(p.relevant)}</td><td className="num">{fmtNum(p.complaints)}</td><td className="num">{fmtNum(p.inquiries)}</td>
          <td className="num" title={`من ${fmtNum(p.sentiment_sample)} منشورًا مصنف المشاعر`}>{p.sentiment_sample ? pctText(p.negative / p.sentiment_sample) : 'غير متوفر'}</td>
          <td className="num">{p.active_influencers === null ? '—' : fmtNum(p.active_influencers)}</td><td className="num">{fmtNum(p.stories)}</td></tr>)}</tbody>
      </table></div>
      {(q.data?.unlinked ?? 0) > 0 && <p className="dash-basis">منشورات غير مرتبطة ببرنامج (لم تُصنف أو استُبعدت قبل التصنيف): {fmtNum(q.data!.unlinked)} — تدخل في الإجمالي العام فقط.</p>}
    </State>
  </Section>;
}

// ── Classifications ────────────────────────────────────────────────────────
export function ClassificationsSection({ q, onDrill, sectionProps }: { q: Q<ClassData>; onDrill: OnDrill; sectionProps: object }) {
  const c = useChartColors();
  const [topic, setTopic] = useState<string | null>(null);
  const d = q.data;
  const growth = (d?.topics ?? []).filter((t) => t.previous !== null && t.count >= 3).map((t) => ({ ...t, ch: change(t.count, t.previous) }))
    .filter((t) => t.ch && (t.ch.kind === 'up' || t.ch.kind === 'new')).sort((a, b) => (b.ch!.diff) - (a.ch!.diff)).slice(0, 5);
  const complaintTopics = [...(d?.topics ?? [])].filter((t) => t.complaints > 0).sort((a, b) => b.complaints - a.complaints).slice(0, 5);
  const subs = (d?.subtopics ?? []).filter((s) => !topic || d?.topics.find((t) => t.id === topic)?.name === s.parentName);
  return <Section id="classifications" title="التصنيفات وأنواع التفاعلات" eyebrow="التصنيف الفعّال" basis="على المنشورات ذات الصلة · التصنيف الفعّال (المعتمد بشريًا إن وُجد وإلا تصنيف الذكاء الاصطناعي) · التصنيفات من قاعدة المعرفة" {...sectionProps}>
    <State loading={q.isLoading} error={q.error} empty={!d?.sample.relevant} emptyText="لا توجد منشورات ذات صلة في هذه الفترة.">
      {d && <div className="dash-grid-2">
        <div>
          <h3 className="dash-subtitle">أنواع التفاعلات <span className="muted">· {fmtNum(d.sample.with_intent)} منشورًا محدد النوع</span></h3>
          <ul className="dash-list">{d.intents.map((i) => <li key={i.intent}>
            <button className="dash-row" onClick={() => onDrill({ title: INTENT_LABELS[i.intent] ?? i.intent, params: { intent: i.intent, series: 'relevant' } })}>
              <span>{INTENT_LABELS[i.intent] ?? i.intent}</span>
              <span className="dash-bar"><span style={{ width: `${(i.count / Math.max(...d.intents.map((x) => x.count))) * 100}%`, background: c.series[0] }} /></span>
              <span className="num">{fmtNum(i.count)}</span><span className="num muted">{pctText(share(i.count, d.sample.with_intent))}</span>
              <Delta value={i.count} previous={i.previous} attention={i.intent === 'complaint' ? 'up' : undefined} compact />
            </button></li>)}</ul>
        </div>
        <div>
          <h3 className="dash-subtitle">التصنيفات الرئيسية <span className="muted">· {fmtNum(d.sample.with_topic)} من {fmtNum(d.sample.relevant)} مصنفة</span></h3>
          {d.topics.length ? <HBar label="التصنيفات الرئيسية" rows={d.topics.slice(0, 8).map((t) => ({ name: t.name, value: t.count, color: topic === t.id ? c.series[1] : c.series[0],
            tip: `${t.name}: ${fmtNum(t.count)} · شكاوى ${fmtNum(t.complaints)}${t.previous !== null ? ` · السابق ${fmtNum(t.previous)}` : ''}` }))}
            onClick={(i) => setTopic((cur) => cur === d.topics[i].id ? null : d.topics[i].id)} /> : <p className="dash-state">لا توجد تصنيفات رئيسية في هذه الفترة.</p>}
          <p className="dash-basis">اضغط تصنيفًا لعرض تصنيفاته الفرعية.</p>
        </div>
      </div>}
      {d && <div className="dash-grid-3 mt-4">
        <div>
          <h3 className="dash-subtitle">التصنيفات الفرعية{topic ? ` · ${d.topics.find((t) => t.id === topic)?.name}` : ''}
            {topic && <button className="dash-link mr-2" onClick={() => onDrill({ title: d.topics.find((t) => t.id === topic)!.name, params: { topicId: topic } })}>كل منشوراته<ChevronLeft size={12} /></button>}</h3>
          {subs.length ? <table className="dash-table"><thead><tr><th>الفرعي</th><th>العدد</th><th>التغير</th></tr></thead><tbody>
            {subs.slice(0, 8).map((s) => <tr key={s.id}><td><button className="dash-link" onClick={() => onDrill({ title: s.name, params: { subtopicId: s.id } })}>{s.name}</button>
              {!topic && s.parentName && <span className="block text-xs muted">{s.parentName}</span>}</td>
              <td className="num">{fmtNum(s.count)}</td><td><Delta value={s.count} previous={s.previous} compact /></td></tr>)}</tbody></table>
            : <p className="dash-state">لا توجد تصنيفات فرعية.</p>}
        </div>
        <div>
          <h3 className="dash-subtitle">الأعلى نموًا</h3>
          {growth.length ? <ul className="dash-list">{growth.map((t) => <li key={t.id} className="dash-row"><span>{t.name}</span><span className="num">{fmtNum(t.count)}</span><Delta value={t.count} previous={t.previous} compact /></li>)}</ul>
            : <p className="dash-state">لا يوجد نمو بعينة كافية (3 منشورات على الأقل).</p>}
        </div>
        <div>
          <h3 className="dash-subtitle">الأكثر ارتباطًا بالشكاوى</h3>
          {complaintTopics.length ? <ul className="dash-list">{complaintTopics.map((t) => <li key={t.id}>
            <button className="dash-row" onClick={() => onDrill({ title: `شكاوى · ${t.name}`, params: { topicId: t.id, series: 'complaints' } })}><span>{t.name}</span><span className="num">{fmtNum(t.complaints)} شكوى</span></button></li>)}</ul>
            : <p className="dash-state">لا توجد شكاوى مصنفة.</p>}
        </div>
      </div>}
    </State>
  </Section>;
}

// ── Sentiment ──────────────────────────────────────────────────────────────
type Groups = { positive: number; neutral: number; negative: number; unclassified: number };
export type SentData = { granularity: 'hour' | 'day' | 'week'; current: Groups; previous: Groups | null;
  byProgram: Array<{ id: string; name_ar: string; g: string; n: number }>; byTopic: Array<{ id: string; name_ar: string; g: string; n: number }>;
  trend: Array<{ bucket: string; negative: number; sample: number }> };
const GROUPS = ['positive', 'neutral', 'negative'] as const;
/** A trend point is drawn only when that bucket has enough classified posts to mean something. */
const MIN_POINT_SAMPLE = 5;
export function SentimentSection({ q, programMode, onDrill, sectionProps }: { q: Q<SentData>; programMode: boolean; onDrill: OnDrill; sectionProps: object }) {
  const c = useChartColors();
  const d = q.data;
  const classified = d ? d.current.positive + d.current.neutral + d.current.negative : 0;
  const prevClassified = d?.previous ? d.previous.positive + d.previous.neutral + d.previous.negative : 0;
  const color = { positive: c.positive, neutral: c.neutral, negative: c.negative };
  const donut = d && {
    ...baseChart(c),
    tooltip: { ...baseChart(c).tooltip, trigger: 'item', formatter: (p: { name: string; value: number }) => `${p.name}: ${fmtNum(p.value)} (${pctText(share(p.value, classified))} من المصنف)` },
    series: [{ type: 'pie', radius: ['58%', '80%'], padAngle: 2, itemStyle: { borderRadius: 4, borderColor: c.surface, borderWidth: 2 }, label: { show: false }, cursor: 'pointer',
      data: GROUPS.map((g) => ({ name: SENTIMENT_GROUP_LABELS[g], value: d.current[g], itemStyle: { color: color[g] } })) }],
  };
  const stack = (rows: Array<{ id: string; name_ar: string; g: string; n: number }>) => {
    const names = [...new Map(rows.map((r) => [r.id, r.name_ar])).entries()];
    return {
      ...baseChart(c), grid: { left: 8, right: 8, top: 28, bottom: 6, containLabel: true },
      legend: { top: 0, textStyle: { color: c.muted } }, tooltip: { ...baseChart(c).tooltip, trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: { type: 'value', inverse: true, max: 100, axisLabel: { color: c.muted, formatter: '{value}٪', fontSize: 10 }, splitLine: { lineStyle: { color: c.grid } } },
      yAxis: { type: 'category', position: 'right', inverse: true, data: names.map(([, n]) => n), axisLabel: { color: c.ink, width: 140, overflow: 'truncate' }, axisTick: { show: false } },
      series: GROUPS.map((g) => ({ name: SENTIMENT_GROUP_LABELS[g], type: 'bar', stack: 's', barMaxWidth: 16, itemStyle: { color: color[g], borderColor: c.surface, borderWidth: 1 },
        data: names.map(([id]) => { const tot = rows.filter((r) => r.id === id).reduce((n, r) => n + r.n, 0); const v = rows.find((r) => r.id === id && r.g === g)?.n ?? 0;
          return tot ? Math.round((v / tot) * 1000) / 10 : 0; }) })),
    };
  };
  const negTrend = d && d.trend.filter((t) => t.sample >= MIN_POINT_SAMPLE).length > 1 && {
    ...baseChart(c), grid: { left: 8, right: 8, top: 10, bottom: 18, containLabel: true },
    tooltip: { ...baseChart(c).tooltip, trigger: 'axis', formatter: (ps: Array<{ dataIndex: number }>) => { const t = d.trend[ps[0].dataIndex]; return `${fmtDayShort(t.bucket)}: ${pctText(share(t.negative, t.sample))} سلبي من ${fmtNum(t.sample)}`; } },
    xAxis: { type: 'category', inverse: true, data: d.trend.map((t) => fmtDayShort(t.bucket)), axisLabel: { color: c.muted, fontSize: 9 }, axisLine: { lineStyle: { color: c.axis } } },
    yAxis: { type: 'value', position: 'right', max: 100, axisLabel: { color: c.muted, fontSize: 9, formatter: '{value}٪' }, splitLine: { lineStyle: { color: c.grid } } },
    series: [{ type: 'line', name: 'نسبة السلبية', data: d.trend.map((t) => (t.sample >= MIN_POINT_SAMPLE ? Math.round((t.negative / t.sample) * 1000) / 10 : null)), connectNulls: false, symbolSize: 6, lineStyle: { width: 2, color: c.negative }, itemStyle: { color: c.negative } }],
  };
  return <Section id="sentiment" title="تحليل المشاعر" eyebrow="منشورات X ذات الصلة" basis="النسب من المنشورات المصنفة المشاعر فقط؛ غير المصنف يُعرض منفصلًا ولا يُحتسب محايدًا · لا تشمل الأخبار" {...sectionProps}>
    <State loading={q.isLoading} error={q.error} empty={!d || classified + d.current.unclassified === 0}>
      {d && <div className="dash-grid-2">
        <div className="dash-donut">
          <div role="img" aria-label="توزيع المشاعر"><ReactECharts option={donut!} style={{ height: 200, width: 200 }} notMerge
            onEvents={{ click: (p: { dataIndex: number }) => onDrill({ title: `مشاعر ${SENTIMENT_GROUP_LABELS[GROUPS[p.dataIndex]]}`, params: { sentiment: GROUPS[p.dataIndex], series: 'relevant' } }) }} /></div>
          <ul className="dash-list flex-1">{GROUPS.map((g) => <li key={g}><button className="dash-row" onClick={() => onDrill({ title: `مشاعر ${SENTIMENT_GROUP_LABELS[g]}`, params: { sentiment: g, series: 'relevant' } })}>
            <span><span className="dash-swatch" style={{ background: color[g] }} />{SENTIMENT_GROUP_LABELS[g]}</span><span className="num">{fmtNum(d.current[g])}</span>
            <span className="num">{pctText(share(d.current[g], classified))}</span>
            {d.previous && prevClassified > 0 ? <span className="text-xs muted">السابق {pctText(share(d.previous[g], prevClassified))}</span> : <span className="text-xs muted">لا توجد فترة أساس</span>}
          </button></li>)}
            <li><button className="dash-row" onClick={() => onDrill({ title: 'مشاعر غير مصنفة', params: { sentiment: 'unclassified', series: 'relevant' } })}>
              <span><span className="dash-swatch dash-swatch--hatch" />غير مصنف</span><span className="num">{fmtNum(d.current.unclassified)}</span><span className="text-xs muted">خارج النسب</span></button></li>
          </ul>
          <p className="dash-basis w-full">حجم العينة: {fmtNum(classified)} منشورًا مصنف المشاعر.</p>
        </div>
        <div>
          <h3 className="dash-subtitle">اتجاه نسبة المشاعر السلبية</h3>
          {negTrend ? <ReactECharts option={negTrend} style={{ height: 170 }} notMerge /> : <p className="dash-state">نقاط غير كافية لرسم الاتجاه.</p>}
          <p className="dash-basis">لا تُرسم الفترات التي فيها أقل من {MIN_POINT_SAMPLE} منشورات مصنفة المشاعر.</p>
        </div>
      </div>}
      {d && <div className="dash-grid-2 mt-4">
        {!programMode && <div><h3 className="dash-subtitle">حسب البرنامج</h3>
          {d.byProgram.length ? <ReactECharts option={stack(d.byProgram)} style={{ height: Math.max(110, new Set(d.byProgram.map((r) => r.id)).size * 32 + 40) }} notMerge /> : <p className="dash-state">لا توجد بيانات.</p>}</div>}
        <div className={programMode ? 'lg:col-span-2' : ''}><h3 className="dash-subtitle">حسب التصنيف الرئيسي (أكثر 8)</h3>
          {d.byTopic.length ? <ReactECharts option={stack(d.byTopic)} style={{ height: Math.max(110, new Set(d.byTopic.map((r) => r.id)).size * 32 + 40) }} notMerge /> : <p className="dash-state">لا توجد منشورات مصنفة بتصنيف ومشاعر.</p>}</div>
      </div>}
    </State>
  </Section>;
}

// ── Hashtags ───────────────────────────────────────────────────────────────
type Tag = { key: string; tag: string; posts: number; previous: number | null; complaints: number; isNew: boolean | null };
export type TagData = { unique: number; uniquePrevious: number | null; usages: number; newCount: number | null; top: Tag[]; newTags: Tag[]; complaintTags: Tag[];
  byProgram: Array<{ key: string; id: string; name_ar: string; color: string | null; posts: number }> };
export function HashtagsSection({ q, programMode, onDrill, sectionProps }: { q: Q<TagData>; programMode: boolean; onDrill: OnDrill; sectionProps: object }) {
  const c = useChartColors();
  const d = q.data;
  const drill = (t: Tag) => onDrill({ title: `#${t.tag}`, params: { hashtag: t.key } });
  return <Section id="hashtags" title="الهاشتاقات" eyebrow="من نصوص المنشورات" basis="من هاشتاقات المنشورات ذات الصلة (حقل X المستخرج أو النص) · كل هاشتاق مرة واحدة لكل منشور · تطبيع عربي/إنجليزي للمطابقة مع إبقاء الكتابة الأصلية · ليست كلمات الاستعلام" {...sectionProps}>
    <State loading={q.isLoading} error={q.error} empty={!d?.unique} emptyText="لا توجد هاشتاقات في المنشورات ذات الصلة لهذه الفترة.">
      {d && <>
        <div className="dash-stats">
          <Stat label="هاشتاقات فريدة" value={fmtNum(d.unique)} sub={<Delta value={d.unique} previous={d.uniquePrevious} compact />} />
          <Stat label="إجمالي الاستخدامات" value={fmtNum(d.usages)} sub="منشور × هاشتاق" />
          <Stat label="هاشتاقات جديدة" value={d.newCount === null ? 'غير متوفر' : fmtNum(d.newCount)} sub="لم تظهر في الفترة السابقة المساوية" />
        </div>
        <div className="dash-grid-2 mt-3">
          <div><h3 className="dash-subtitle">الأكثر استخدامًا</h3>
            <HBar label="أكثر الهاشتاقات استخدامًا" rows={d.top.map((t) => ({ name: `#${t.tag}`, value: t.posts, color: c.series[0], tip: `#${t.tag}: ${fmtNum(t.posts)} منشورًا${t.previous !== null ? ` · السابق ${fmtNum(t.previous)}` : ''}` }))} onClick={(i) => drill(d.top[i])} /></div>
          <div className="dash-table-wrap"><table className="dash-table"><thead><tr><th>الهاشتاق</th><th>المنشورات</th><th>النمو</th><th>شكاوى</th></tr></thead><tbody>
            {d.top.map((t) => <tr key={t.key}><td><button className="dash-link" dir="auto" onClick={() => drill(t)}>#{t.tag}</button>{t.isNew && <span className="dash-tag">جديد</span>}</td>
              <td className="num">{fmtNum(t.posts)}</td><td><Delta value={t.posts} previous={t.previous} compact /></td><td className="num">{fmtNum(t.complaints)}</td></tr>)}</tbody></table></div>
        </div>
        <div className="dash-grid-3 mt-3">
          <div><h3 className="dash-subtitle">جديدة خلال الفترة</h3>{d.newTags.length ? <div className="dash-tags">{d.newTags.map((t) => <button key={t.key} className="dash-chip dash-chip--sm" dir="auto" onClick={() => drill(t)}>#{t.tag} · {t.posts}</button>)}</div> : <p className="dash-state">لا توجد.</p>}</div>
          <div><h3 className="dash-subtitle">الأكثر ارتباطًا بالشكاوى</h3>{d.complaintTags.length ? <div className="dash-tags">{d.complaintTags.map((t) => <button key={t.key} className="dash-chip dash-chip--sm" dir="auto" onClick={() => onDrill({ title: `شكاوى #${t.tag}`, params: { hashtag: t.key, series: 'complaints' } })}>#{t.tag} · {t.complaints}</button>)}</div> : <p className="dash-state">لا توجد.</p>}</div>
          {!programMode && <div><h3 className="dash-subtitle">توزيع أهم الهاشتاقات على البرامج</h3>
            {d.byProgram.length ? <ul className="dash-list">{d.top.slice(0, 5).map((t) => <li key={t.key} className="dash-row"><span dir="auto">#{t.tag}</span>
              <span className="text-xs muted">{d.byProgram.filter((b) => b.key === t.key).map((b) => `${b.name_ar} ${b.posts}`).join(' · ') || '—'}</span></li>)}</ul> : <p className="dash-state">لا توجد.</p>}</div>}
        </div>
      </>}
    </State>
  </Section>;
}

export type InsightsData = { items: Array<{ key: string; severity: string; title: string; detail: string; rule: string; drill?: Record<string, string> }>; comparable: boolean };
export function InsightsSection({ q, onDrill, sectionProps }: { q: Q<InsightsData>; onDrill: OnDrill; sectionProps: object }) {
  const [all, setAll] = useState(false);
  const items = q.data?.items ?? [];
  const shown = all ? items : items.slice(0, 4);
  return <Section id="insights" title="مؤشرات تستحق الانتباه" eyebrow="قواعد قابلة للتفسير" basis="تُحسب من الأرقام المعروضة بقواعد ثابتة وحد أدنى للعينة؛ لا تستخدم نموذجًا لغويًا · منفصلة عن تنبيهات الطابور" {...sectionProps}>
    <State loading={q.isLoading} error={q.error} empty={!items.length} height={90}
      emptyText={q.data && !q.data.comparable ? 'لا توجد فترة مقارنة لهذه الفترة الزمنية.' : 'لا توجد تغيرات تتجاوز حدود القواعد في هذه الفترة.'}>
      <ul className="dash-insights">{shown.map((i) => <li key={i.key} className={`dash-insight dash-insight--${i.severity}`}>
        <Sparkles size={16} aria-hidden="true" /><div className="min-w-0 flex-1"><strong>{i.title}</strong><p>{i.detail}</p><p className="dash-basis">القاعدة: {i.rule}</p></div>
        {i.drill && <button className="btn-ghost text-sm" onClick={() => onDrill({ title: i.title, params: i.drill! })}>التفاصيل</button>}</li>)}</ul>
      {items.length > 4 && <button className="btn-ghost text-sm mt-2" aria-expanded={all} onClick={() => setAll((a) => !a)}>{all ? 'عرض أقل' : `عرض الكل (${items.length})`}</button>}
    </State>
  </Section>;
}
