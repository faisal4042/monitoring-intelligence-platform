import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import { api } from '../lib/api';
import {
  apiQuery, normalizeLayout, useDashboardFilters, useFreshFlag, useSection,
  type DashboardMeta, type Layout, type PeriodKey, type SectionId,
} from '../lib/dashboard';
import FiltersBar from '../components/dashboard/FiltersBar';
import { ClassificationsSection, HashtagsSection, InsightsSection, KpiCards, ProgramsSection, SentimentSection, TrendSection,
  type ClassData, type Drill, type InsightsData, type KpiData, type ProgramsData, type SentData, type TagData, type TrendData } from '../components/dashboard/monitoring';
import { AiQualitySection, InfluencersSection, NewsSection, OperationsSection, StoriesSection,
  type Ai, type InfData, type NewsData, type Ops, type StoriesData } from '../components/dashboard/entities';
import DrillDrawer from '../components/dashboard/DrillDrawer';
import CustomizeDialog from '../components/dashboard/CustomizeDialog';

type Prefs = { all: { layout: Layout } | null; program: { layout: Layout } | null };
// Sections that read best at half width on wide screens; the rest span the row.
const HALF: SectionId[] = ['stories', 'news'];

/**
 * One analytics dashboard for all programs or one. Filters live in the URL
 * (/dashboard?program=ejar&period=7d); every figure comes from /dashboard/*
 * and is scoped by the API from the user's permissions.
 */
export default function Dashboard() {
  const qc = useQueryClient();
  const { program, period: urlPeriod, from, to, advanced, params, set } = useDashboardFilters();
  const { data: meta } = useQuery({ queryKey: ['dashboard-meta'], queryFn: () => api.get<DashboardMeta>('/dashboard/meta'), staleTime: 300_000 });
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
  const period: PeriodKey = urlPeriod ?? layout.defaultPeriod ?? '30d';
  const customIncomplete = period === 'custom' && !from && !to;
  const qs = apiQuery({ program, period, from, to, advanced });
  const programMode = Boolean(program);
  const visible = (id: SectionId) => layout.sections.find((s) => s.id === id)?.visible !== false;
  const cap = meta?.capabilities;
  const fresh = useFreshFlag();
  const ready = Boolean(meta) && !customIncomplete;
  const on = (id: SectionId, extra = true) => ({ enabled: ready && visible(id) && extra, fresh: fresh.ref });

  const overview = useSection<KpiData>('overview', qs, on('kpis'));
  const trends = useSection<TrendData>('trends', qs, on('trend'));
  const programs = useSection<ProgramsData>('programs', qs, on('programs', !programMode));
  // Always loaded: it also feeds the topic filter and the program view's top topics.
  const classifications = useSection<ClassData>('classifications', qs, { enabled: ready, fresh: fresh.ref });
  const sentiments = useSection<SentData>('sentiments', qs, on('sentiment'));
  const hashtags = useSection<TagData>('hashtags', qs, on('hashtags'));
  const influencers = useSection<InfData>('influencers', qs, on('influencers', Boolean(cap?.influencers)));
  const stories = useSection<StoriesData>('stories', qs, on('stories', Boolean(cap?.stories)));
  const news = useSection<NewsData>('news', qs, on('news', Boolean(cap?.news)));
  const operations = useSection<Ops>('operations', qs, on('operations', Boolean(cap?.queue)));
  const aiQuality = useSection<Ai>('ai-quality', qs, on('ai_quality', Boolean(cap?.queue)));
  const insights = useSection<InsightsData>('insights', qs, on('insights'));
  const all = [overview, trends, programs, classifications, sentiments, hashtags, influencers, stories, news, operations, aiQuality, insights];
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

  const scopeName = program ? meta?.programs.find((p) => p.key === program)?.name_ar ?? program : 'جميع البرامج';
  const topicsForFilter = useMemo(() => (classifications.data?.topics ?? []).map((t) => ({ id: t.id, name: t.name })), [classifications.data]);
  const jump = (id: string) => document.getElementById(`dash-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const sp = (id: SectionId) => ({ collapsed: collapsed[id], onToggle: () => setCollapsed((c) => ({ ...c, [id]: !c[id] })) });
  const pick = (key: string) => { set({ program: key, topicId: null }); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const unknownProgram = program && meta && !meta.programs.some((p) => p.key === program);

  const render: Record<SectionId, () => ReactNode> = {
    insights: () => <InsightsSection q={insights} onDrill={setDrill} sectionProps={sp('insights')} />,
    kpis: () => <KpiCards q={overview} layout={layout} onDrill={setDrill} onJump={jump} />,
    trend: () => <TrendSection key={(layout.trendSeries ?? []).join()} q={trends} layout={layout} onDrill={setDrill} sectionProps={sp('trend')} />,
    programs: () => <ProgramsSection q={programs} cls={classifications} programMode={programMode} onPick={pick} onDrill={setDrill} sectionProps={sp('programs')} />,
    classifications: () => <ClassificationsSection q={classifications} onDrill={setDrill} sectionProps={sp('classifications')} />,
    sentiment: () => <SentimentSection q={sentiments} programMode={programMode} onDrill={setDrill} sectionProps={sp('sentiment')} />,
    hashtags: () => <HashtagsSection q={hashtags} programMode={programMode} onDrill={setDrill} sectionProps={sp('hashtags')} />,
    influencers: () => <InfluencersSection q={influencers} allowed={Boolean(cap?.influencers)} programMode={programMode} onDrill={setDrill} sectionProps={sp('influencers')} />,
    stories: () => <StoriesSection q={stories} allowed={Boolean(cap?.stories)} onDrill={setDrill} sectionProps={sp('stories')} />,
    news: () => <NewsSection q={news} allowed={Boolean(cap?.news)} sectionProps={sp('news')} />,
    operations: () => <OperationsSection q={operations} allowed={Boolean(cap?.queue)} sectionProps={sp('operations')} />,
    ai_quality: () => <AiQualitySection q={aiQuality} allowed={Boolean(cap?.queue)} sectionProps={sp('ai_quality')} />,
  };
  const favorites = layout.favorites ?? [];
  const order = [...layout.sections.filter((s) => s.visible && favorites.includes(s.id)), ...layout.sections.filter((s) => s.visible && !favorites.includes(s.id))];
  // Sections the user may not see at all are skipped rather than shown as locked boxes.
  const permitted = (id: SectionId) => !(['operations', 'ai_quality'].includes(id) && cap && !cap.queue);

  return <div className="space-y-4 dash-page">
    <div className="page-heading">
      <div>
        <div className="eyebrow"><span className="status-pulse" /> مركز المتابعة والتحليل</div>
        <h1>لوحة التحكم{program && meta ? ` · ${scopeName}` : ''}</h1>
        <p>{programMode ? 'كل المؤشرات أدناه تخص البرنامج المختار فقط.' : 'نظرة شاملة على جميع البرامج مع مقارنتها ببعضها.'}</p>
      </div>
    </div>
    <FiltersBar meta={meta} program={program} period={period} from={from} to={to} advanced={advanced as Record<string, string>} topics={topicsForFilter} set={set}
      resolved={overview.data ? { fromDate: overview.data.range.fromDate, toDate: overview.data.range.toDate, previous: overview.data.previous } : undefined}
      updatedAt={updatedAt} refreshing={refreshing} onRefresh={() => { fresh.arm(); qc.invalidateQueries({ queryKey: ['dashboard'] }); }} onCustomize={() => setCustomizing(true)} />
    {unknownProgram && <div className="card dash-state" role="alert">البرنامج المحدد في الرابط غير موجود. <button className="dash-link" onClick={() => set({ program: null })}>عرض جميع البرامج</button></div>}
    {customIncomplete && <div className="card dash-state">اختر تاريخ البداية أو النهاية للفترة المخصصة.</div>}
    {!unknownProgram && <div className="dash-layout">
      {order.filter((s) => permitted(s.id)).map((s) => <div key={s.id} className={`${HALF.includes(s.id) ? 'dash-half' : 'dash-full'} ${favorites.includes(s.id) ? 'dash-fav' : ''}`}>
        {favorites.includes(s.id) && <span className="dash-fav-mark" title="قسم مفضل"><Star size={12} fill="currentColor" aria-hidden="true" /><span className="sr-only">قسم مفضل</span></span>}
        {render[s.id]()}
      </div>)}
    </div>}
    {drill && <DrillDrawer drill={drill} baseQuery={qs} onClose={() => setDrill(null)} />}
    {customizing && <CustomizeDialog layout={layout} scopeName={scopeName} isProgram={programMode} meta={meta} saving={save.isPending || reset.isPending}
      error={(save.error as Error | null)?.message ?? (reset.error as Error | null)?.message} onSave={(l) => save.mutate(l)} onReset={() => reset.mutate()} onClose={() => setCustomizing(false)} />}
  </div>;
}
