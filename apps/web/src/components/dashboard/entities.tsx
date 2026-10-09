import ReactECharts from 'echarts-for-react';
import { ExternalLink } from 'lucide-react';
import { fmtCompact, fmtDate, fmtDateTime, fmtNum, fmtRelative } from '../../lib/format';
import { AI_FIELD_LABELS, INTENT_LABELS, SENTIMENT_GROUP_LABELS, SENTIMENT_LABELS, STORY_STATE_LABELS, type Meta } from '../../lib/dashboard';
import Avatar from '../Avatar';
import { Delta, Section, State, Stat, Unavailable, baseChart, minutesText, useChartColors } from './ui';
import type { Drill } from './monitoring';

type OnDrill = (d: Drill) => void;
type Q<T> = { data?: T & Meta; isLoading: boolean; error: unknown };

// ── Influencers ────────────────────────────────────────────────────────────
type InfRow = { id: string; username: string; display_name: string | null; profile_image_url: string | null; followers_count: number | null; posts: number;
  relevant: number; complaints: number; dominant_sentiment: string | null; sentiment_sample: number; program_name: string | null; last_seen_at: string | null };
export type InfData = { tracked: number; active: number; activePrevious: number | null; posts: number; relevantPosts: number; relevantPostsPrevious: number | null;
  top: InfRow[]; complaintTop: Array<{ id: string; username: string; complaints: number }>; byProgram: Array<{ id: string; name_ar: string; color: string | null; accounts: number; posts: number }>; minSentimentSample: number };
export function InfluencersSection({ q, allowed, programMode, onDrill, sectionProps }: { q: Q<InfData>; allowed: boolean; programMode: boolean; onDrill: OnDrill; sectionProps: object }) {
  const d = q.data;
  const drill = (id: string, name: string) => onDrill({ title: `منشورات @${name}`, params: { influencerId: id } });
  return <Section id="influencers" title="المؤثرون" eyebrow="الحسابات المتابَعة" basis="المتابَعون = قائمة الحسابات النشطة · النشطون = من ظهر له منشور في الفترة بالفلاتر الحالية (كل حساب مرة واحدة) · المتابعون من ملف X المخزن، ولا تُعرض مؤشرات وصول أو تفاعل غير متوفرة" {...sectionProps}>
    {!allowed ? <Unavailable reason="يتطلب هذا القسم صلاحية عرض المؤثرين." /> :
    <State loading={q.isLoading} error={q.error}>
      {d && <>
        <div className="dash-stats">
          <Stat label="إجمالي الحسابات المتابَعة" value={fmtNum(d.tracked)} sub="الحالة الآن" />
          <Stat label="نشطون خلال الفترة" value={fmtNum(d.active)} sub={<Delta value={d.active} previous={d.activePrevious} compact />} />
          <Stat label="منشوراتهم ذات الصلة" value={fmtNum(d.relevantPosts)} sub={<Delta value={d.relevantPosts} previous={d.relevantPostsPrevious} compact />}
            onClick={d.relevantPosts ? () => onDrill({ title: 'منشورات المؤثرين ذات الصلة', params: { influencersOnly: 'true', series: 'relevant' } }) : undefined} />
        </div>
        {d.top.length ? <div className="dash-table-wrap mt-3"><table className="dash-table">
          <thead><tr><th>المؤثر</th><th>المتابعون</th><th>المنشورات</th><th>المشاعر الغالبة</th><th>البرنامج</th><th>آخر نشاط مرصود</th></tr></thead>
          <tbody>{d.top.map((r) => <tr key={r.id}>
            <td><button className="dash-link items-center" onClick={() => drill(r.id, r.username)}><Avatar src={r.profile_image_url} name={r.display_name} username={r.username} size={28} />
              <span className="text-start"><span className="block">{r.display_name ?? r.username}</span><span className="block text-xs muted" dir="ltr">@{r.username}</span></span></button></td>
            <td className="num">{r.followers_count === null ? <span className="muted">غير متوفر</span> : fmtCompact(r.followers_count)}</td>
            <td className="num">{fmtNum(r.posts)}<span className="block text-xs muted">{fmtNum(r.relevant)} ذات صلة</span></td>
            <td>{r.dominant_sentiment ? SENTIMENT_GROUP_LABELS[r.dominant_sentiment] : <span className="text-xs muted" title={`يلزم ${d.minSentimentSample} منشورات مصنفة على الأقل`}>عينة غير كافية</span>}</td>
            <td>{r.program_name ?? '—'}</td><td className="text-xs">{r.last_seen_at ? fmtRelative(r.last_seen_at) : '—'}</td></tr>)}</tbody></table></div>
          : <p className="dash-state mt-3">لم يُرصد نشاط لحسابات متابَعة في هذه الفترة.</p>}
        {d.top.length > 0 && <div className="dash-grid-2 mt-3">
          <div><h3 className="dash-subtitle">الأكثر ارتباطًا بالشكاوى</h3>{d.complaintTop.length ? <ul className="dash-list">{d.complaintTop.map((r) =>
            <li key={r.id}><button className="dash-row" onClick={() => onDrill({ title: `شكاوى @${r.username}`, params: { influencerId: r.id, series: 'complaints' } })}><span dir="ltr">@{r.username}</span><span className="num">{fmtNum(r.complaints)} شكوى</span></button></li>)}</ul> : <p className="dash-state">لا توجد شكاوى من المؤثرين.</p>}</div>
          {!programMode && <div><h3 className="dash-subtitle">حسب البرنامج</h3>{d.byProgram.length ? <ul className="dash-list">{d.byProgram.map((b) =>
            <li key={b.id} className="dash-row"><span><span className="dash-dot" style={{ background: b.color ?? undefined }} />{b.name_ar}</span><span className="num">{fmtNum(b.accounts)} حساب · {fmtNum(b.posts)} منشور</span></li>)}</ul> : <p className="dash-state">لا توجد.</p>}</div>}
        </div>}
      </>}
    </State>}
  </Section>;
}

// ── Stories ────────────────────────────────────────────────────────────────
type StoryRow = { id: string; title_ar: string; summary: string | null; state: string; post_count: number; family_count: number; first_seen_at: string; last_seen_at: string; updated_at: string; program_name: string; color: string | null };
export type StoriesData = { approvedTotal: number; liveNow: number; active: number; created: number; activePrevious: number | null; createdPrevious: number | null; items: StoryRow[] };
export function StoriesSection({ q, allowed, onDrill, sectionProps }: { q: Q<StoriesData>; allowed: boolean; onDrill: OnDrill; sectionProps: object }) {
  const d = q.data;
  return <Section id="stories" title="القصص" eyebrow="المعتمدة فقط" basis="قصة معتمدة = مصدران مستقلان على الأقل؛ الموضوع وحده ليس قصة · القصة المدموجة تُحسب مرة واحدة · العدد للقصص لا لمنشوراتها" {...sectionProps}>
    {!allowed ? <Unavailable reason="يتطلب هذا القسم صلاحية عرض المواضيع والقصص." /> :
    <State loading={q.isLoading} error={q.error}>
      {d && <>
        <div className="dash-stats">
          <Stat label="إجمالي القصص المعتمدة" value={fmtNum(d.approvedTotal)} sub={`الحالة الآن · ${fmtNum(d.liveNow)} نشطة`} />
          <Stat label="لها نشاط في الفترة" value={fmtNum(d.active)} sub={<Delta value={d.active} previous={d.activePrevious} compact />} />
          <Stat label="جديدة خلال الفترة" value={fmtNum(d.created)} sub={<Delta value={d.created} previous={d.createdPrevious} compact />} />
        </div>
        {d.items.length ? <ul className="dash-stories mt-3">{d.items.map((s) => <li key={s.id}>
          <button className="dash-story" onClick={() => onDrill({ title: s.title_ar, params: { storyId: s.id } })}>
            <span className="flex items-center gap-2 flex-wrap"><strong>{s.title_ar}</strong><span className="dash-tag">{STORY_STATE_LABELS[s.state] ?? s.state}</span></span>
            {s.summary && <span className="dash-story-summary">{s.summary}</span>}
            <span className="dash-story-meta"><span><span className="dash-dot" style={{ background: s.color ?? undefined }} />{s.program_name}</span>
              <span>{fmtNum(s.post_count)} منشور · {fmtNum(s.family_count)} مصدر مستقل</span>
              <span>أول ظهور {fmtDate(s.first_seen_at)}</span><span>آخر نشاط {fmtRelative(s.last_seen_at)}</span></span>
          </button></li>)}</ul> : <p className="dash-state mt-3">لا توجد قصص معتمدة لها نشاط في هذه الفترة.</p>}
      </>}
    </State>}
  </Section>;
}

// ── News ───────────────────────────────────────────────────────────────────
export type NewsData = { total: number; relevant: number; totalPrevious: number | null; relevantPrevious: number | null;
  bySource: Array<{ source: string; articles: number; relevant: number }>; latest: Array<{ id: string; title: string; url: string; published_at: string; source: string; program_name: string | null }>;
  topics: Array<{ id: string; name_ar: string; articles: number }> };
export function NewsSection({ q, allowed, sectionProps }: { q: Q<NewsData>; allowed: boolean; sectionProps: object }) {
  const d = q.data;
  return <Section id="news" title="الأخبار" eyebrow="مصادر الأخبار" basis="حسب تاريخ نشر الخبر (أو تاريخ اكتشافه إن لم يتوفر) · منفصلة تمامًا عن منشورات X ولا تُضاف لإجمالياتها" {...sectionProps}>
    {!allowed ? <Unavailable reason="يتطلب هذا القسم صلاحية عرض الأخبار." /> :
    <State loading={q.isLoading} error={q.error}>
      {d && <>
        <div className="dash-stats">
          <Stat label="الأخبار المجمعة" value={fmtNum(d.total)} sub={<Delta value={d.total} previous={d.totalPrevious} compact />} />
          <Stat label="الأخبار ذات الصلة" value={fmtNum(d.relevant)} sub={<Delta value={d.relevant} previous={d.relevantPrevious} compact />} />
        </div>
        <div className="dash-grid-3 mt-3">
          <div className="lg:col-span-2"><h3 className="dash-subtitle">أحدث الأخبار ذات الصلة</h3>{d.latest.length ? <ul className="dash-list">{d.latest.map((n) =>
            <li key={n.id}><a className="dash-row" href={n.url} target="_blank" rel="noreferrer"><span className="min-w-0"><span className="block truncate">{n.title}</span>
              <span className="block text-xs muted">{n.source}{n.program_name ? ` · ${n.program_name}` : ''} · {fmtDateTime(n.published_at)}</span></span><ExternalLink size={14} aria-label="يفتح المصدر" /></a></li>)}</ul>
            : <p className="dash-state">لا توجد أخبار ذات صلة.</p>}</div>
          <div><h3 className="dash-subtitle">حسب المصدر</h3>{d.bySource.length ? <ul className="dash-list">{d.bySource.map((s) =>
            <li key={s.source} className="dash-row"><span className="truncate">{s.source}</span><span className="num">{fmtNum(s.relevant)} / {fmtNum(s.articles)}</span></li>)}</ul> : <p className="dash-state">لا توجد.</p>}
            {d.topics.length > 0 && <><h3 className="dash-subtitle mt-3">الموضوعات الأكثر نشاطًا</h3><ul className="dash-list">{d.topics.map((t) =>
              <li key={t.id} className="dash-row"><span>{t.name_ar}</span><span className="num">{fmtNum(t.articles)}</span></li>)}</ul></>}</div>
        </div>
      </>}
    </State>}
  </Section>;
}

// ── Team performance ───────────────────────────────────────────────────────
export type Ops = { scope: string; warnMinutes: number; snapshot: Record<'unassigned' | 'assigned' | 'escalated' | 'overdue', number>;
  period: { closed_items: number; review_cycles: number; reopened: number; avg_wait_assign_min: number | null; avg_assignment_to_close_min: number | null; avg_close_tat_min: number | null };
  employees: Array<{ id: string; full_name: string; open: number; closed_items: number; review_cycles: number; corrected: number; avg_assignment_to_close_min: number | null }> };
export function OperationsSection({ q, allowed, sectionProps }: { q: Q<Ops>; allowed: boolean; sectionProps: object }) {
  const d = q.data;
  return <Section id="operations" title="أداء فريق الرصد" eyebrow={d?.scope === 'own' ? 'عملي فقط' : d?.scope === 'team' ? 'فرقي' : 'كل الفرق'} basis="«الآن» = حالة الطابور الحالية · «خلال الفترة» = إغلاقات ومراجعات حدثت ضمن الفترة · العنصر المعاد فتحه يُحسب عنصرًا مغلقًا واحدًا" {...sectionProps}>
    {!allowed ? <Unavailable reason="يتطلب هذا القسم صلاحيات طابور الرصد." /> :
    <State loading={q.isLoading} error={q.error}>
      {d && <>
        <h3 className="dash-subtitle">الآن</h3>
        <div className="dash-stats">
          <Stat label="غير مسند" value={fmtNum(d.snapshot.unassigned)} /><Stat label="في صناديق الموظفين" value={fmtNum(d.snapshot.assigned)} />
          <Stat label="مصعّد" value={fmtNum(d.snapshot.escalated)} />
          <Stat label="متأخر" value={<span className={d.snapshot.overdue ? 'dash-watch' : ''}>{fmtNum(d.snapshot.overdue)}</span>} sub={`أكثر من ${d.warnMinutes} دقيقة`} />
        </div>
        <h3 className="dash-subtitle mt-3">خلال الفترة</h3>
        <div className="dash-stats">
          <Stat label="عناصر مغلقة" value={fmtNum(d.period.closed_items)} sub="دون تكرار" /><Stat label="مراجعات مكتملة" value={fmtNum(d.period.review_cycles)} sub={`${fmtNum(d.period.reopened)} إعادة فتح`} />
          <Stat label="انتظار الإسناد" value={minutesText(d.period.avg_wait_assign_min)} sub="متوسط" />
          <Stat label="من الإسناد حتى الإغلاق" value={minutesText(d.period.avg_assignment_to_close_min)} sub="متوسط — ليس وقت معالجة فعلي" /><Stat label="حتى الإغلاق" value={minutesText(d.period.avg_close_tat_min)} sub="متوسط منذ الدخول" />
        </div>
        {d.employees.length > 0 && <div className="dash-table-wrap mt-3"><table className="dash-table">
          <thead><tr><th>الموظف</th><th>مفتوح الآن</th><th>مغلق في الفترة</th><th>مراجعات</th><th>تصحيحات</th><th>من الإسناد حتى الإغلاق</th></tr></thead>
          <tbody>{d.employees.map((e) => <tr key={e.id}><td>{e.full_name}</td><td className="num">{fmtNum(e.open)}</td><td className="num">{fmtNum(e.closed_items)}</td>
            <td className="num">{fmtNum(e.review_cycles)}</td><td className="num">{fmtNum(e.corrected)}</td><td>{minutesText(e.avg_assignment_to_close_min)}</td></tr>)}</tbody></table></div>}
      </>}
    </State>}
  </Section>;
}

// ── AI quality ─────────────────────────────────────────────────────────────
type Field = { field: string; sample: number; agreed: number; rate: number | null };
export type Ai = { reviewed: number; cycles: number; outcomes: Record<'confirmed' | 'corrected' | 'irrelevant' | 'no_action', number>; correctionRate: number | null;
  overall: { sample: number; agreed: number; rate: number | null } | null; overallPrevious: { sample: number; rate: number | null } | null;
  fields: Field[]; byProgram: Array<{ id: string; name_ar: string; color: string | null; reviewed: number; comparable: number; agreed: number; rate: number | null }>;
  mostCorrected: Array<{ field: string; ai_value: string; ai_label: string | null; corrections: number }> };
export function AiQualitySection({ q, allowed, sectionProps }: { q: Q<Ai>; allowed: boolean; sectionProps: object }) {
  const c = useChartColors();
  const d = q.data;
  const valueLabel = (m: Ai['mostCorrected'][number]) => m.ai_label ?? (m.field === 'intent' ? INTENT_LABELS[m.ai_value] : m.field === 'sentiment' ? SENTIMENT_LABELS[m.ai_value] : null) ?? 'قيمة غير متاحة';
  const fieldsChart = d && {
    ...baseChart(c), grid: { left: 40, right: 8, top: 6, bottom: 6, containLabel: true },
    tooltip: { ...baseChart(c).tooltip, trigger: 'item', formatter: (p: { dataIndex: number }) => { const f = d.fields[p.dataIndex]; return `${AI_FIELD_LABELS[f.field]}: ${f.rate === null ? 'غير قابل للحساب' : `${f.rate}٪`} (${f.agreed} من ${f.sample})`; } },
    xAxis: { type: 'value', inverse: true, max: 100, axisLabel: { color: c.muted, formatter: '{value}٪', fontSize: 10 }, splitLine: { lineStyle: { color: c.grid } } },
    yAxis: { type: 'category', position: 'right', inverse: true, data: d.fields.map((f) => `${AI_FIELD_LABELS[f.field]} (ن=${f.sample})`), axisTick: { show: false }, axisLabel: { color: c.ink } },
    series: [{ type: 'bar', barMaxWidth: 16, data: d.fields.map((f) => ({ value: f.rate, itemStyle: { color: c.series[0], borderRadius: [4, 0, 0, 4] } })),
      label: { show: true, position: 'left', color: c.muted, fontSize: 10, formatter: (p: { value: number | null }) => (p.value === null ? 'غير متوفر' : `${p.value}٪`) } }],
  };
  return <Section id="ai_quality" title="جودة تصنيفات الذكاء الاصطناعي" eyebrow="نسبة الاتفاق مع المراجعة البشرية" basis="آخر مراجعة لكل عنصر روجع في الفترة · لكل حقل: المراجعات التي أعطى فيها الذكاء الاصطناعي قيمة فقط · مؤشر اتفاق على العينة المراجعة، وليس دقة النموذج على كل البيانات" {...sectionProps}>
    {!allowed ? <Unavailable reason="يتطلب هذا القسم صلاحيات طابور الرصد." /> :
    <State loading={q.isLoading} error={q.error} empty={!d?.reviewed} emptyText="لا توجد مراجعات بشرية في هذه الفترة.">
      {d && <>
        <div className="dash-stats">
          <Stat label="عناصر روجعت" value={fmtNum(d.reviewed)} sub={`${fmtNum(d.cycles)} دورة مراجعة`} />
          <Stat label="نسبة الاتفاق الإجمالية" value={d.overall?.rate === null || !d.overall ? 'غير متوفر' : `${d.overall.rate}٪`}
            sub={d.overall ? `${fmtNum(d.overall.agreed)} من ${fmtNum(d.overall.sample)} مقارنة${d.overallPrevious?.rate != null ? ` · السابق ${d.overallPrevious.rate}٪` : ''}` : undefined} />
          <Stat label="اعتُمدت دون تعديل" value={fmtNum(d.outcomes.confirmed)} /><Stat label="صُححت" value={fmtNum(d.outcomes.corrected)} sub={d.correctionRate === null ? undefined : `نسبة التصحيح ${d.correctionRate}٪`} />
          <Stat label="غير ذات صلة / بلا إجراء" value={`${fmtNum(d.outcomes.irrelevant)} / ${fmtNum(d.outcomes.no_action)}`} />
        </div>
        <div className="dash-grid-2 mt-3">
          <div><h3 className="dash-subtitle">الاتفاق حسب الحقل</h3><ReactECharts option={fieldsChart!} style={{ height: 190 }} notMerge /></div>
          <div><h3 className="dash-subtitle">الأكثر تصحيحًا</h3>{d.mostCorrected.length ? <ul className="dash-list">{d.mostCorrected.map((m, i) =>
            <li key={i} className="dash-row"><span>{AI_FIELD_LABELS[m.field]}: {valueLabel(m)}</span><span className="num">{fmtNum(m.corrections)} تصحيح</span></li>)}</ul> : <p className="dash-state">لا توجد تصحيحات.</p>}
            {d.byProgram.length > 1 && <><h3 className="dash-subtitle mt-3">حسب البرنامج</h3><ul className="dash-list">{d.byProgram.map((p) =>
              <li key={p.id} className="dash-row"><span><span className="dash-dot" style={{ background: p.color ?? undefined }} />{p.name_ar}</span>
                <span className="num">{p.rate === null ? 'غير متوفر' : `${p.rate}٪`} <span className="muted text-xs">(ن={p.comparable})</span></span></li>)}</ul></>}</div>
        </div>
      </>}
    </State>}
  </Section>;
}
