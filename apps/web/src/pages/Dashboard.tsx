import AsyncState from '../components/AsyncState';
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  apiQuery, normalizeLayout, useDashboardFilters, useFreshFlag, useSection,
  type DashboardMeta, type Layout, type PeriodKey, type SectionId, type TrendSeries,
} from '../lib/dashboard';
import FiltersBar from '../components/dashboard/FiltersBar';
import DrillDrawer from '../components/dashboard/DrillDrawer';
import CustomizeDialog from '../components/dashboard/CustomizeDialog';
import ExecutiveOverview from '../components/dashboard/panels/ExecutiveOverview';
import TrendPanel from '../components/dashboard/panels/TrendPanel';
import SignalsPanel from '../components/dashboard/panels/SignalsPanel';
import ProgramsPanel from '../components/dashboard/panels/ProgramsPanel';
import SentimentPanel from '../components/dashboard/panels/SentimentPanel';
import IssuesPanel from '../components/dashboard/panels/IssuesPanel';
import NewsPanel from '../components/dashboard/panels/NewsPanel';
import YouTubePanel from '../components/dashboard/panels/YouTubePanel';
import { ClassificationsPanel, HashtagsPanel, InfluencersPanel } from '../components/dashboard/panels/DetailPanels';
import { AiQualityPanel, SystemHealthPanel, TeamPanel } from '../components/dashboard/panels/OperationsPanels';
import { execKpis, type ExecKey } from '../components/dashboard/transforms';
import type { Ai, ClassData, Drill, Health, InfData, InsightsData, KpiData, NewsData, NewsSourceHealth, Ops, ProgramsData,
  SentData, StoriesData, TagData, TrendData, YouTubeData } from '../components/dashboard/types';
import SearchLink from '../components/search/SearchLink';

type Prefs = { all: { layout: Layout } | null; program: { layout: Layout } | null };

/** A row of the 12-column grid; a lone panel takes the full width. */
function Row({ cells, className = '' }: { cells: Array<[ReactNode, number] | false | null | undefined>; className?: string }) {
  const shown = cells.filter(Boolean) as Array<[ReactNode, number]>;
  if (!shown.length) return null;
  return <div className={`dash-row ${className}`}>
    {shown.map(([node, span], i) => <div key={i} className="dash-cell" style={{ '--span': shown.length === 1 ? 12 : span } as CSSProperties}>{node}</div>)}
  </div>;
}

/**
 * One intelligence dashboard for all programs or one. Filters live in the URL
 * (/dashboard?program=ejar&period=7d); every figure comes from the API and is
 * scoped there by the user's permissions — this page only arranges and charts it.
 */
export default function Dashboard() {
  const qc = useQueryClient();
  const { program, period: urlPeriod, from, to, advanced, params, set } = useDashboardFilters();
  const metadataRead = useQuery({ queryKey: ['dashboard-meta'], queryFn: () => api.get<DashboardMeta>('/dashboard/meta'), staleTime: 300_000 });
  const { data: meta } = metadataRead;
  const prefsKey = ['dashboard-prefs', program ?? 'all'];
  const prefs = useQuery({ queryKey: prefsKey, queryFn: () => api.get<Prefs>(`/dashboard/preferences${program ? `?program=${program}` : ''}`), staleTime: Infinity });
  const allLayout = prefs.data?.all?.layout;

  // Saved defaults apply only when the URL names neither a program nor a period (a plain visit).
  useEffect(() => {
    if (!prefs.isSuccess || params.has('program') || params.has('period')) return;
    const patch: Record<string, string | null> = {};
    if (allLayout?.defaultProgram && meta?.programs.some((p) => p.key === allLayout.defaultProgram)) patch.program = allLayout.defaultProgram;
    if (allLayout?.defaultPeriod) patch.period = allLayout.defaultPeriod;
    if (Object.keys(patch).length) set(patch, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.isSuccess, meta]);

  const layout = normalizeLayout(prefs.data?.program?.layout ?? allLayout);
  const period: PeriodKey = urlPeriod ?? layout.defaultPeriod ?? '7d';
  const customIncomplete = period === 'custom' && !from && !to;
  const qs = apiQuery({ program, period, from, to, advanced });
  const programMode = Boolean(program);
  const visible = (id: SectionId) => layout.sections.find((s) => s.id === id)?.visible !== false;
  const cap = meta?.capabilities;
  const fresh = useFreshFlag();
  const ready = Boolean(meta) && !customIncomplete;
  const on = (enabled: boolean) => ({ enabled: ready && enabled, fresh: fresh.ref });
  const kpisOn = visible('kpis');

  const overview = useSection<KpiData>('overview', qs, on(kpisOn || visible('operations')));
  const trends = useSection<TrendData>('trends', qs, on(visible('trend') || kpisOn));
  const programs = useSection<ProgramsData>('programs', qs, on(visible('programs') && !programMode));
  // Always loaded: it also feeds the topic filter and the program view's top topics.
  const classifications = useSection<ClassData>('classifications', qs, on(true));
  const sentiments = useSection<SentData>('sentiments', qs, on(visible('sentiment') || kpisOn));
  const hashtags = useSection<TagData>('hashtags', qs, on(visible('hashtags')));
  const influencers = useSection<InfData>('influencers', qs, on(visible('influencers') && Boolean(cap?.influencers)));
  const stories = useSection<StoriesData>('stories', qs, on((visible('stories') || kpisOn) && Boolean(cap?.stories)));
  const news = useSection<NewsData>('news', qs, on((visible('news') || kpisOn) && Boolean(cap?.news)));
  const youtube = useSection<YouTubeData>('youtube', qs, on(visible('youtube') && Boolean(cap?.youtube)));
  const operations = useSection<Ops>('operations', qs, on(visible('operations') && Boolean(cap?.queue)));
  const aiQuality = useSection<Ai>('ai-quality', qs, on(visible('ai_quality') && Boolean(cap?.queue)));
  const insights = useSection<InsightsData>('insights', qs, on(visible('insights') || kpisOn));
  // Pipeline health is independent of the filters: the public health probe and, with news access, source states.
  const health = useQuery({ queryKey: ['dashboard', 'health'], enabled: visible('operations'), staleTime: 30_000, refetchInterval: 60_000,
    queryFn: async ({ signal }) => { const r = await fetch('/health', { signal }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<Health>; } });
  const newsSources = useQuery({ queryKey: ['dashboard', 'news-sources'], enabled: visible('operations') && Boolean(cap?.news), staleTime: 120_000, refetchInterval: 300_000,
    queryFn: ({ signal }) => api.get<{ items: NewsSourceHealth[] }>('/news/sources', signal) });

  const all = [overview, trends, programs, classifications, sentiments, hashtags, influencers, stories, news, youtube, operations, aiQuality, insights];
  const updatedAt = Math.max(0, ...all.filter((x) => x.data).map((x) => x.dataUpdatedAt));
  const refreshing = all.some((x) => x.isFetching);

  const [drill, setDrill] = useState<Drill | null>(null);
  const [customizing, setCustomizing] = useState(false);
  const [collapsed, setCollapsed] = useState<Partial<Record<SectionId, boolean>>>({});
  useEffect(() => { setCollapsed(Object.fromEntries(layout.sections.filter((s) => s.collapsed).map((s) => [s.id, true]))); }, [prefs.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({ mutationFn: (l: Layout) => api.put('/dashboard/preferences', { program: program ?? null, layout: l }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['dashboard-prefs'] }); setCustomizing(false); } });
  const reset = useMutation({ mutationFn: () => api.del(`/dashboard/preferences${program ? `?program=${program}` : ''}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['dashboard-prefs'] }); setCustomizing(false); } });

  const kpis = useMemo(() => execKpis({ overview: overview.data, trends: trends.data, sentiments: sentiments.data, news: news.data,
    stories: stories.data, insights: insights.data, can: { news: Boolean(cap?.news), stories: Boolean(cap?.stories) } }),
  [overview.data, trends.data, sentiments.data, news.data, stories.data, insights.data, cap?.news, cap?.stories]);
  const kpiLoading = (k: ExecKey) => !meta || ({ total: overview, complaints: overview, negative_share: overview, news, issues: stories, attention: insights }[k]).isLoading;

  const scopeName = program ? meta?.programs.find((p) => p.key === program)?.name_ar ?? program : 'جميع البرامج';
  const topicsForFilter = useMemo(() => (classifications.data?.topics ?? []).map((t) => ({ id: t.id, name: t.name })), [classifications.data]);
  const jump = (id: string) => document.getElementById(`dash-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const sp = (id: SectionId) => ({ collapsed: collapsed[id], onToggle: () => setCollapsed((c) => ({ ...c, [id]: !c[id] })) });
  const pick = (key: string) => { set({ program: key, topicId: null }); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const unknownProgram = program && meta && !meta.programs.some((p) => p.key === program);
  const trendInitial: TrendSeries = layout.trendSeries?.[0] ?? 'total';
  const show = (id: SectionId) => visible(id);

  if (metadataRead.isLoading || metadataRead.error) return <AsyncState
    loading={metadataRead.isLoading} error={metadataRead.error}
    errorMessage="تعذر تحميل إعدادات لوحة المعلومات. حاول مرة أخرى."
    onRetry={() => metadataRead.refetch()} />;

  return <div className="dash-page">
    <div className="page-heading dash-heading">
      <div>
        <div className="eyebrow"><span className="status-pulse" /> مركز الرصد والإنذار المبكر</div>
        <h1>لوحة المعلومات{program && meta ? ` · ${scopeName}` : ''}</h1>
        <p>{programMode ? 'كل المؤشرات أدناه تخص البرنامج المختار فقط.' : 'الصورة الكاملة لجميع البرامج: الحجم والاتجاه، المشاعر، القضايا الناشئة، وصحة الرصد.'}</p>
      </div>
      <SearchLink q={program ? `program:${program}` : ''} />
    </div>
    <FiltersBar meta={meta} program={program} period={period} from={from} to={to} advanced={advanced as Record<string, string>} topics={topicsForFilter} set={set}
      resolved={overview.data ? { fromDate: overview.data.range.fromDate, toDate: overview.data.range.toDate, previous: overview.data.previous } : undefined}
      updatedAt={updatedAt} refreshing={refreshing} onRefresh={() => { fresh.arm(); qc.invalidateQueries({ queryKey: ['dashboard'] }); }} onCustomize={() => setCustomizing(true)} />
    {unknownProgram && <div className="dash-state is-error" role="alert">البرنامج المحدد في الرابط غير موجود. <button className="dash-link" onClick={() => set({ program: null })}>عرض جميع البرامج</button></div>}
    {customIncomplete && <div className="dash-state">اختر تاريخ البداية أو النهاية للفترة المخصصة.</div>}
    {!unknownProgram && !customIncomplete && <div className="dash-grid">
      {show('kpis') && <ExecutiveOverview kpis={kpis} loading={kpiLoading} error={overview.error}
        actions={{
          total: { label: 'عرض المنشورات', run: () => setDrill({ title: 'التفاعلات المرصودة', params: { series: 'total' } }) },
          complaints: { label: 'عرض الشكاوى', run: () => setDrill({ title: 'الشكاوى', params: { series: 'complaints' } }) },
          negative_share: { label: 'عرض المنشورات السلبية', run: () => setDrill({ title: 'مشاعر سلبية', params: { sentiment: 'negative', series: 'relevant' } }) },
          ...(show('stories') && { issues: { label: 'الانتقال إلى القضايا', run: () => jump('stories') } }),
          ...(show('news') && { news: { label: 'الانتقال إلى الأخبار', run: () => jump('news') } }),
          ...(show('insights') && { attention: { label: 'الانتقال إلى الإشارات', run: () => jump('insights') } }),
        }} />}

      <Row className="dash-row--activity" cells={[
        show('trend') && [<TrendPanel key={`trend-${trendInitial}`} q={trends} initial={trendInitial} onDrill={setDrill} panel={sp('trend')} />, 8],
        show('insights') && [<SignalsPanel q={insights} onDrill={setDrill} panel={sp('insights')} />, 4],
      ]} />
      <Row cells={[
        show('programs') && [<ProgramsPanel q={programs} cls={classifications} programMode={programMode} onPick={pick} onDrill={setDrill} panel={sp('programs')} />, 5],
        show('sentiment') && [<SentimentPanel q={sentiments} programMode={programMode} onDrill={setDrill} panel={sp('sentiment')} />, 7],
      ]} />
      <Row cells={[
        show('stories') && [<IssuesPanel q={stories} allowed={Boolean(cap?.stories)} onDrill={setDrill} panel={sp('stories')} />, 7],
        show('news') && [<NewsPanel q={news} allowed={Boolean(cap?.news)} panel={sp('news')} />, 5],
      ]} />
      <Row cells={[show('youtube') && cap?.youtube && [<YouTubePanel q={youtube} allowed programMode={programMode} panel={sp('youtube')} />, 12]]} />
      {(show('classifications') || show('hashtags') || show('influencers')) && <h2 className="dash-band-title">التحليل التفصيلي</h2>}
      <Row cells={[show('classifications') && [<ClassificationsPanel q={classifications} onDrill={setDrill} panel={sp('classifications')} />, 12]]} />
      <Row cells={[
        show('hashtags') && [<HashtagsPanel q={hashtags} onDrill={setDrill} panel={sp('hashtags')} />, 6],
        show('influencers') && [<InfluencersPanel q={influencers} allowed={Boolean(cap?.influencers)} onDrill={setDrill} panel={sp('influencers')} />, 6],
      ]} />
      {(show('operations') || (show('ai_quality') && cap?.queue)) && <h2 className="dash-band-title">المراقبة التشغيلية</h2>}
      <Row cells={[show('operations') && [<SystemHealthPanel health={health} sources={newsSources} newsAllowed={Boolean(cap?.news)}
        unclassified={overview.data?.context.unclassified ?? null} panel={sp('operations')} />, 12]]} />
      <Row cells={[
        show('operations') && cap?.queue && [<TeamPanel q={operations} panel={{}} />, 6],
        show('ai_quality') && cap?.queue && [<AiQualityPanel q={aiQuality} panel={sp('ai_quality')} />, 6],
      ]} />
    </div>}
    {drill && <DrillDrawer drill={drill} baseQuery={qs} onClose={() => setDrill(null)} />}
    {customizing && <CustomizeDialog layout={layout} scopeName={scopeName} isProgram={programMode} meta={meta} saving={save.isPending || reset.isPending}
      error={(save.error as Error | null)?.message ?? (reset.error as Error | null)?.message} onSave={(l) => save.mutate(l)} onReset={() => reset.mutate()} onClose={() => setCustomizing(false)} />}
  </div>;
}
