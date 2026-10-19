import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import ReactECharts from 'echarts-for-react';
import { api } from '../../lib/api';
import type { DateRangeState } from '../../lib/useDateRange';
import { fmtCompact, fmtDayShort, fmtHourLabel, fmtNum } from '../../lib/format';
import type { HubAnalytics } from '../../lib/influencers';
import Avatar from '../Avatar';
import DateTime from '../DateTime';
import { Basis, StateBox, useChartPalette, type ChartPalette } from './shared';

const GRANULARITY: Record<HubAnalytics['granularity'], string> = { hour: 'بالساعة', day: 'باليوم', week: 'بالأسبوع (يبدأ الأحد)' };

export default function AnalyticsTab({ date, onShowPosts }: { date: DateRangeState; onShowPosts: (username: string) => void }) {
  const c = useChartPalette();
  const q = useQuery({
    queryKey: ['influencer-analytics', date.apiQuery],
    enabled: Boolean(date.apiQuery),
    queryFn: ({ signal }) => api.get<HubAnalytics>(`/influencers/analytics?${date.apiQuery}`, signal),
  });
  const d = q.data;
  const loading = q.isLoading || (!date.apiQuery && !date.error);
  const error = date.error ? new Error(date.error) : q.error;
  const box = { loading, error, onRetry: () => q.refetch() };
  const noActivity = !!d && d.trend.every((t) => t.posts === 0) && d.top.length === 0;

  return (
    <div className="space-y-3" role="tabpanel" id="inf-panel-analytics" aria-labelledby="inf-tab-analytics">
      <Panel title="اتجاه نشاط المؤثرين" basis={d ? `منشورات الحسابات المتابَعة وعدد الحسابات النشطة ${GRANULARITY[d.granularity]}، حسب وقت النشر على إكس. لا تشمل المكرر.` : undefined}>
        <StateBox {...box} height={300} empty={noActivity} emptyText="لا يوجد نشاط من الحسابات المتابَعة في هذه الفترة.">
          {d && <TrendChart d={d} c={c} />}
        </StateBox>
      </Panel>

      <div className="inf-grid-2">
        <Panel title="أكثر الحسابات نشاطاً" basis="أعلى ١٠ حسابات بعدد المنشورات في الفترة؛ البرنامج المعروض هو الأكثر ارتباطاً بمنشوراتها.">
          <StateBox {...box} height={260} empty={!d?.top.length} emptyText="لا يوجد حساب نشط في هذه الفترة.">
            <Bars rows={(d?.top ?? []).map((t) => ({
              key: t.id, value: t.posts, color: c.series[0],
              label: <button type="button" className="inf-bar-label hover:underline text-start" onClick={() => onShowPosts(t.username)}
                title={`عرض منشورات @${t.username}`}>
                <Avatar src={t.profile_image_url} name={t.display_name} username={t.username} size={22} />
                <span>{t.display_name ?? t.username} <span className="muted num text-xs">@{t.username}</span></span>
              </button>,
              hint: <>{t.followers_count !== null && <><span className="num">{fmtCompact(t.followers_count)}</span> متابع · </>}
                آخر منشور <DateTime value={t.last_post_at} />{t.program_name && <> · {t.program_name}</>}</>,
            }))} />
          </StateBox>
        </Panel>

        <Panel title="البرامج المرتبطة" basis="منشورات المؤثرين حسب البرنامج المصنَّف (تصنيف المراجع البشري يتقدم على الآلي إن وُجد).">
          <StateBox {...box} height={260} empty={!d?.programs.length && !d?.unlinkedPosts} emptyText="لا توجد منشورات في هذه الفترة.">
            {d && <>
              {d.programs.length
                ? <Bars rows={d.programs.map((p) => ({
                    key: p.id, value: p.posts, color: p.color ?? c.series[0],
                    label: <span className="inf-bar-label"><span className="inf-dot" style={{ background: p.color ?? c.series[0] }} /><span>{p.name_ar}</span></span>,
                    hint: <><span className="num">{fmtNum(p.accounts)}</span> حساب</>,
                  }))} />
                : <div className="inf-state">لم يُربط أي منشور ببرنامج في هذه الفترة.</div>}
              {d.unlinkedPosts > 0 && <Basis><span><span className="num">{fmtNum(d.unlinkedPosts)}</span> منشوراً غير مرتبط بأي برنامج (لم يُصنَّف بعد أو استُبعد).</span></Basis>}
            </>}
          </StateBox>
        </Panel>

        <Panel title="الموضوعات" basis="الموضوعات المصنَّفة للمنشورات المرتبطة فقط.">
          <StateBox {...box} height={220} empty={false}>
            {d && (d.topics.length
              ? <>
                  <Bars rows={d.topics.map((t) => ({
                    key: t.id, value: t.posts, color: c.series[2],
                    label: <span className="inf-bar-label"><span>{t.name}{t.program_name && <span className="muted text-xs"> · {t.program_name}</span>}</span></span>,
                    hint: <><span className="num">{fmtNum(t.accounts)}</span> حساب</>,
                  }))} />
                  <Basis><span>مصنَّف موضوعياً: <span className="num">{fmtNum(d.topicSample.withTopic)}</span> من <span className="num">{fmtNum(d.topicSample.relevant)}</span> منشوراً مرتبطاً.</span></Basis>
                </>
              : <div className="inf-state">
                  {d.topicSample.relevant
                    ? <>البيانات غير متوفرة: لم يُصنَّف أي من <span className="num">{fmtNum(d.topicSample.relevant)}</span> منشوراً مرتبطاً إلى موضوع في هذه الفترة.</>
                    : 'لا توجد منشورات مرتبطة في هذه الفترة لعرض موضوعاتها.'}
                </div>)}
          </StateBox>
        </Panel>

        <Panel title="المشاعر" basis={d ? `تُعرض النسب فقط عند توفر ${d.minSentimentSample} منشورات مصنَّفة على الأقل.` : undefined}>
          <StateBox {...box} height={220} empty={false}>
            {d && <Sentiment d={d} c={c} />}
          </StateBox>
        </Panel>
      </div>
    </div>
  );
}

function Panel({ title, basis, children }: { title: string; basis?: string; children: ReactNode }) {
  const id = `inf-${title.replace(/\s+/g, '-')}`;
  return (
    <section className="card inf-panel" aria-labelledby={id}>
      <header className="inf-panel-head"><div className="min-w-0"><h2 id={id}>{title}</h2>{basis && <Basis>{basis}</Basis>}</div></header>
      {children}
    </section>
  );
}

function Bars({ rows }: { rows: Array<{ key: string; value: number; color: string; label: ReactNode; hint?: ReactNode }> }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="inf-bars">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="inf-bar-row">
            {r.label}
            <span className="inf-bar" aria-hidden="true"><span style={{ width: `${(r.value / max) * 100}%`, background: r.color }} /></span>
            <span className="inf-bar-value">{fmtNum(r.value)}</span>
          </div>
          {r.hint && <div className="text-xs muted mt-0.5">{r.hint}</div>}
        </li>
      ))}
    </ul>
  );
}

function TrendChart({ d, c }: { d: HubAnalytics; c: ChartPalette }) {
  const label = (b: string) => (d.granularity === 'hour' ? fmtHourLabel(b) : fmtDayShort(b));
  const option = useMemo(() => ({
    textStyle: { fontFamily: 'inherit', color: c.ink },
    tooltip: { trigger: 'axis', backgroundColor: c.surface, borderColor: c.axis, textStyle: { color: c.ink, fontFamily: 'inherit' }, confine: true },
    legend: { top: 0, textStyle: { color: c.muted }, data: ['المنشورات', 'المرتبطة', 'الحسابات النشطة'] },
    grid: { top: 36, left: 8, right: 8, bottom: 8, containLabel: true },
    xAxis: { type: 'category', inverse: true, data: d.trend.map((t) => label(t.bucket)),
      axisLine: { lineStyle: { color: c.axis } }, axisLabel: { color: c.muted, hideOverlap: true } },
    // One count axis on the reading side (right in RTL): posts and active accounts share a scale.
    yAxis: { type: 'value', position: 'right', minInterval: 1, splitLine: { lineStyle: { color: c.grid } }, axisLabel: { color: c.muted } },
    series: [
      { name: 'المنشورات', type: 'bar', data: d.trend.map((t) => t.posts), itemStyle: { color: c.series[0], borderRadius: [3, 3, 0, 0] }, barMaxWidth: 18 },
      { name: 'المرتبطة', type: 'bar', data: d.trend.map((t) => t.relevant), itemStyle: { color: c.series[2], borderRadius: [3, 3, 0, 0] }, barMaxWidth: 18 },
      { name: 'الحسابات النشطة', type: 'line', data: d.trend.map((t) => t.accounts), symbolSize: 5,
        itemStyle: { color: c.series[1] }, lineStyle: { width: 2 } },
    ],
    animationDuration: 300,
  }), [d, c]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = d.trend.reduce((s, t) => s + t.posts, 0);
  return (
    <div role="img" aria-label={`اتجاه النشاط: ${fmtNum(total)} منشوراً خلال الفترة`}>
      <ReactECharts option={option} style={{ height: 300 }} notMerge />
    </div>
  );
}

function Sentiment({ d, c }: { d: HubAnalytics; c: ChartPalette }) {
  const s = d.sentiment;
  if (!s.reliable) return (
    <div className="inf-state">
      البيانات غير كافية: <span className="num">{fmtNum(s.sample)}</span> منشوراً فقط يحمل تصنيف مشاعر من أصل
      {' '}<span className="num">{fmtNum(s.sample + s.unclassified)}</span>.
    </div>
  );
  const parts = [
    { key: 'positive', label: 'إيجابي', value: s.positive, color: c.positive },
    { key: 'neutral', label: 'محايد', value: s.neutral, color: c.neutral },
    { key: 'negative', label: 'سلبي', value: s.negative, color: c.negative },
  ];
  const pct = (n: number) => Math.round((n / s.sample) * 100);
  return (
    <>
      <div className="inf-stack" role="img" aria-label={parts.map((p) => `${p.label} ${pct(p.value)}%`).join('، ')}>
        {parts.map((p) => p.value > 0 && <span key={p.key} style={{ width: `${(p.value / s.sample) * 100}%`, background: p.color }} />)}
      </div>
      <div className="inf-legend">
        {parts.map((p) => (
          <span key={p.key}><span className="inf-dot" style={{ background: p.color }} />{p.label} <span className="num">{pct(p.value)}%</span>
            <span className="muted num">({fmtNum(p.value)})</span></span>
        ))}
      </div>
      <Basis><span>من <span className="num">{fmtNum(s.sample)}</span> منشوراً مصنَّفاً؛ <span className="num">{fmtNum(s.unclassified)}</span> بلا تصنيف مشاعر ولم تُحتسب.</span></Basis>
    </>
  );
}
