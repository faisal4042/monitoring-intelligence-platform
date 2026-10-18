import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import ReactECharts from 'echarts-for-react';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { api } from '../../lib/api';
import { fmtDayShort, fmtHourLabel, fmtNum } from '../../lib/format';
import { change } from '../../lib/influencers';
import { VALUE_LABELS } from '../../lib/search';
import { Basis, StateBox, useChartPalette } from '../influencers/shared';
import DateTime from '../DateTime';

type Named = { name: string; n: number; color?: string | null };
interface PostsAnalytics {
  entity: 'posts'; total: number; previous: number | null; granularity: 'hour' | 'day' | 'week'; trend: Array<{ bucket: string; n: number }>;
  sentiment: { positive: number; neutral: number; negative: number; unclassified: number; sample: number; reliable: boolean; minSample: number };
  relevant: number; unclassified: number; programs: Named[]; topics: Named[]; intents: Array<{ key: string; n: number }>;
  accounts: Array<{ username: string; display_name: string | null; n: number; followers_count: number | null }>;
  topPosts: Array<{ id: string; text: string; url: string; posted_at: string; username: string | null; engagement: number }>;
  warnings?: string[]; unsupported?: { reason: string };
}
interface NewsAnalytics {
  entity: 'news'; total: number; previous: number | null; granularity: 'hour' | 'day' | 'week'; trend: Array<{ bucket: string; n: number }>;
  sources: Named[]; programs: Named[]; topics: Named[]; relevance: { relevant: number; excluded: number }; unsupported?: { reason: string };
}

/** Figures for exactly the current query, period and permissions (same compiler as the results). */
export default function AnalyticsPanel({ q, tab, period }: { q: string; tab: 'posts' | 'news'; period: Record<string, string> }) {
  const c = useChartPalette();
  const res = useQuery({
    queryKey: ['search-analytics', q, tab, period],
    queryFn: () => api.post<PostsAnalytics | NewsAnalytics>('/search/analytics', { q, tab, ...period }),
  });
  const d = res.data;
  return (
    <section className="as-analytics" aria-label="تحليل نتائج البحث">
      <StateBox loading={res.isLoading} error={res.error} onRetry={() => res.refetch()} height={260}
        empty={!!d && (!!d.unsupported || d.total === 0)} emptyText={d?.unsupported ? d.unsupported.reason : 'لا توجد نتائج لتحليلها.'}>
        {d && !d.unsupported && <>
          <div className="as-an-head">
            <div><span className="as-an-total num">{fmtNum(d.total)}</span> <span className="muted">نتيجة</span></div>
            <Compare now={d.total} before={d.previous} />
          </div>
          <div className="inf-grid-2">
            <Panel title="تطور النتائج زمنيًا"><Trend d={d} color={c.series[0]} palette={c} /></Panel>
            {d.entity === 'posts' ? <Panel title="المشاعر"><Sentiment s={d.sentiment} c={c} /></Panel>
              : <Panel title="الارتباط"><Bars rows={[{ name: 'مرتبطة', n: d.relevance.relevant, color: c.series[0] }, { name: 'غير مرتبطة', n: d.relevance.excluded, color: c.neutral }]} /></Panel>}
            <Panel title="البرامج الأكثر ظهورًا"><Bars rows={d.programs} empty="لا توجد نتائج مرتبطة ببرنامج" /></Panel>
            <Panel title="الموضوعات الأكثر ظهورًا"><Bars rows={d.topics} empty="لم تُصنف النتائج إلى موضوعات" /></Panel>
            {d.entity === 'posts' ? <>
              <Panel title="توزيع التصنيفات (نوع التفاعل)"><Bars rows={d.intents.map((i) => ({ name: VALUE_LABELS[i.key] ?? i.key, n: i.n }))} empty="لا توجد نتائج مصنفة بنوع تفاعل" />
                <Basis><span>{fmtNum(d.unclassified)} نتيجة بلا تصنيف · {fmtNum(d.relevant)} مرتبطة</span></Basis></Panel>
              <Panel title="الحسابات الأكثر نشاطًا"><Bars rows={d.accounts.map((a) => ({ name: `${a.display_name ?? a.username} @${a.username}`, n: a.n }))} /></Panel>
              <Panel title="المنشورات الأعلى تفاعلًا" wide>
                <ol className="as-top-posts">{d.topPosts.map((p) => (
                  <li key={p.id}><a href={p.url} target="_blank" rel="noreferrer" dir="auto">{p.text.slice(0, 160)}</a>
                    <span className="muted text-xs"> · @{p.username} · <span className="num">{fmtNum(p.engagement)}</span> تفاعل · <DateTime value={p.posted_at} /></span></li>
                ))}</ol>
              </Panel>
            </> : <Panel title="المصادر الإخبارية"><Bars rows={d.sources} /></Panel>}
          </div>
        </>}
      </StateBox>
    </section>
  );
}

function Panel({ title, children, wide }: { title: string; children: ReactNode; wide?: boolean }) {
  return <div className={`card inf-panel ${wide ? 'as-wide' : ''}`}><h3 className="as-an-title">{title}</h3>{children}</div>;
}

function Compare({ now, before }: { now: number; before: number | null }) {
  const d = change(now, before);
  if (!d) return <span className="muted text-xs">لا مقارنة — الفترة غير محددة («كل الفترات»)</span>;
  if (d.kind === 'new') return <span className="text-xs">لم تكن هناك نتائج في الفترة السابقة المساوية</span>;
  const Icon = d.kind === 'down' ? TrendingDown : TrendingUp;
  return <span className={`inf-delta inf-delta--${d.kind === 'same' ? 'up' : d.kind}`}><Icon size={13} aria-hidden="true" />
    {d.kind === 'same' ? 'دون تغيير' : `${d.kind === 'up' ? 'ارتفاع' : 'انخفاض'} ${Math.abs(d.pct!)}%`} عن الفترة السابقة المساوية (<span className="num">{fmtNum(before)}</span>)</span>;
}

function Bars({ rows, empty = 'لا توجد بيانات' }: { rows: Named[]; empty?: string }) {
  if (!rows.length) return <div className="inf-state">{empty}</div>;
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <ul className="inf-bars">{rows.map((r) => (
      <li key={r.name} className="inf-bar-row">
        <span className="inf-bar-label"><span>{r.name}</span></span>
        <span className="inf-bar" aria-hidden="true"><span style={{ width: `${(r.n / max) * 100}%`, background: r.color ?? 'var(--accent)' }} /></span>
        <span className="inf-bar-value">{fmtNum(r.n)}</span>
      </li>
    ))}</ul>
  );
}

function Trend({ d, color, palette }: { d: { granularity: string; trend: Array<{ bucket: string; n: number }> }; color: string; palette: ReturnType<typeof useChartPalette> }) {
  const option = useMemo(() => ({
    textStyle: { fontFamily: 'inherit', color: palette.ink },
    tooltip: { trigger: 'axis', backgroundColor: palette.surface, borderColor: palette.axis, textStyle: { color: palette.ink }, confine: true },
    grid: { top: 12, left: 8, right: 8, bottom: 8, containLabel: true },
    xAxis: { type: 'category', inverse: true, data: d.trend.map((t) => (d.granularity === 'hour' ? fmtHourLabel(t.bucket) : fmtDayShort(t.bucket))),
      axisLabel: { color: palette.muted, hideOverlap: true }, axisLine: { lineStyle: { color: palette.axis } } },
    yAxis: { type: 'value', position: 'right', minInterval: 1, splitLine: { lineStyle: { color: palette.grid } }, axisLabel: { color: palette.muted } },
    series: [{ type: 'bar', name: 'النتائج', data: d.trend.map((t) => t.n), itemStyle: { color, borderRadius: [3, 3, 0, 0] }, barMaxWidth: 18 }],
    animationDuration: 300,
  }), [d, color, palette]);
  if (!d.trend.length) return <div className="inf-state">لا توجد بيانات زمنية</div>;
  return <div role="img" aria-label="تطور النتائج زمنيًا"><ReactECharts option={option} style={{ height: 220 }} notMerge /></div>;
}

function Sentiment({ s, c }: { s: PostsAnalytics['sentiment']; c: ReturnType<typeof useChartPalette> }) {
  if (!s.reliable) return <div className="inf-state">البيانات غير كافية: {fmtNum(s.sample)} نتيجة فقط تحمل تصنيف مشاعر (الحد الأدنى {s.minSample}).<br />غير المصنف: {fmtNum(s.unclassified)}</div>;
  const parts = [{ k: 'إيجابي', v: s.positive, col: c.positive }, { k: 'محايد', v: s.neutral, col: c.neutral }, { k: 'سلبي', v: s.negative, col: c.negative }];
  return <>
    <div className="inf-stack" role="img" aria-label={parts.map((p) => `${p.k} ${Math.round((p.v / s.sample) * 100)}%`).join('، ')}>
      {parts.map((p) => p.v > 0 && <span key={p.k} style={{ width: `${(p.v / s.sample) * 100}%`, background: p.col }} />)}
    </div>
    <div className="inf-legend">{parts.map((p) => <span key={p.k}><span className="inf-dot" style={{ background: p.col }} />{p.k} <span className="num">{Math.round((p.v / s.sample) * 100)}%</span> <span className="muted num">({fmtNum(p.v)})</span></span>)}</div>
    <Basis><span>من {fmtNum(s.sample)} نتيجة مصنفة؛ {fmtNum(s.unclassified)} غير مصنفة — لا تُحسب ضمن المحايد.</span></Basis>
  </>;
}
