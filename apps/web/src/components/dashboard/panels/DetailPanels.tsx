import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { fmtCompact, fmtNum, fmtRelative } from '../../../lib/format';
import { INTENT_LABELS, SENTIMENT_GROUP_LABELS, share } from '../../../lib/dashboard';
import Avatar from '../../Avatar';
import EChart from '../charts/EChart';
import { rankHeight, rankOption } from '../charts/options';
import { useChartColors } from '../charts/theme';
import { topicGrowth } from '../transforms';
import type { ClassData, InfData, OnDrill, Q, TagData } from '../types';
import { Delta, Panel, State, Unavailable, pctText } from '../ui';

const TOP = 8;

/** Interaction types as a meter list, main topics as a ranked chart, and the fastest-growing topics. */
export function ClassificationsPanel({ q, onDrill, panel }: { q: Q<ClassData>; onDrill: OnDrill; panel: object }) {
  const c = useChartColors();
  const d = q.data;
  const topics = useMemo(() => (d?.topics ?? []).slice(0, TOP), [d]);
  const option = useMemo(() => rankOption(c, topics.map((t) => ({ name: t.name, value: t.count,
    tip: [{ label: 'المنشورات', value: fmtNum(t.count) }, { label: 'منها شكاوى', value: fmtNum(t.complaints) }, ...(t.previous !== null ? [{ label: 'الفترة السابقة', value: fmtNum(t.previous) }] : [])] })),
  { clickable: true, color: c.series[2] }), [c, topics]);
  const growth = topicGrowth(d);
  const maxIntent = Math.max(1, ...(d?.intents ?? []).map((i) => i.count));
  return <Panel id="classifications" title="التصنيفات وأنواع التفاعلات" {...panel}
    info="على المنشورات ذات الصلة بالتصنيف الفعّال (المعتمد بشريًا إن وُجد وإلا تصنيف الذكاء الاصطناعي). التصنيفات من قاعدة المعرفة."
    footer={<Link className="dash-link" to="/classification">صفحة التصنيف<ChevronLeft size={14} /></Link>}>
    <State loading={q.isLoading} error={q.error} empty={!d?.sample.relevant} height={260} emptyText="لا توجد منشورات ذات صلة في هذه الفترة.">
      {d && <div className="dash-split">
        <div>
          <h3 className="dash-subtitle">أنواع التفاعلات<span className="dash-muted-sm"> · {fmtNum(d.sample.with_intent)} محدد النوع</span></h3>
          <ul className="dash-meter-list">{d.intents.slice(0, 6).map((i) => <li key={i.intent}>
            <button className="dash-meter-row" onClick={() => onDrill({ title: INTENT_LABELS[i.intent] ?? i.intent, params: { intent: i.intent, series: 'relevant' } })}>
              <span className="truncate">{INTENT_LABELS[i.intent] ?? i.intent}</span>
              <span className="dash-meter"><span style={{ width: `${(i.count / maxIntent) * 100}%` }} /></span>
              <span className="num">{fmtNum(i.count)} <span className="dash-muted-sm">{pctText(share(i.count, d.sample.with_intent))}</span></span>
            </button></li>)}</ul>
          {growth.length > 0 && <>
            <h3 className="dash-subtitle mt-3">الأعلى نموًا</h3>
            <ul className="dash-compact-list">{growth.map((t) => <li key={t.id}><button onClick={() => onDrill({ title: t.name, params: { topicId: t.id } })}>
              <span className="truncate">{t.name}</span><span className="num">{fmtNum(t.count)}</span><Delta value={t.count} previous={t.previous} compact /></button></li>)}</ul>
          </>}
        </div>
        <div className="min-w-0">
          <h3 className="dash-subtitle">التصنيفات الرئيسية<span className="dash-muted-sm"> · {fmtNum(d.sample.with_topic)} من {fmtNum(d.sample.relevant)} مصنفة</span></h3>
          {topics.length ? <EChart option={option} height={rankHeight(topics.length)} label="التصنيفات الرئيسية الأكثر تكرارًا"
            onRowClick={(i) => topics[i] && onDrill({ title: topics[i].name, params: { topicId: topics[i].id } })} />
            : <p className="dash-state is-compact">لا توجد تصنيفات رئيسية في هذه الفترة.</p>}
        </div>
      </div>}
    </State>
  </Panel>;
}

export function HashtagsPanel({ q, onDrill, panel }: { q: Q<TagData>; onDrill: OnDrill; panel: object }) {
  const c = useChartColors();
  const d = q.data;
  const top = useMemo(() => (d?.top ?? []).slice(0, TOP), [d]);
  const option = useMemo(() => rankOption(c, top.map((t) => ({ name: `#${t.tag}`, value: t.posts,
    tip: [{ label: 'المنشورات', value: fmtNum(t.posts) }, { label: 'شكاوى', value: fmtNum(t.complaints) }, ...(t.previous !== null ? [{ label: 'الفترة السابقة', value: fmtNum(t.previous) }] : [])] })),
  { clickable: true, color: c.series[2] }), [c, top]);
  return <Panel id="hashtags" title="الهاشتاقات" {...panel}
    info="هاشتاقات المنشورات ذات الصلة: كل هاشتاق مرة واحدة لكل منشور، مع تطبيع عربي/إنجليزي للمطابقة. ليست كلمات الاستعلام.">
    <State loading={q.isLoading} error={q.error} empty={!d?.unique} height={260} emptyText="لا توجد هاشتاقات في المنشورات ذات الصلة لهذه الفترة.">
      {d && <>
        <p className="dash-inline-stats"><span><strong className="num">{fmtNum(d.unique)}</strong> هاشتاق فريد <Delta value={d.unique} previous={d.uniquePrevious} compact /></span>
          <span><strong className="num">{d.newCount === null ? '—' : fmtNum(d.newCount)}</strong> جديد في الفترة</span></p>
        <EChart option={option} height={rankHeight(top.length)} label="أكثر الهاشتاقات استخدامًا" onRowClick={(i) => top[i] && onDrill({ title: `#${top[i].tag}`, params: { hashtag: top[i].key } })} />
        {d.newTags.length > 0 && <div className="dash-tags mt-2"><span className="dash-muted-sm">جديدة:</span>
          {d.newTags.slice(0, 6).map((t) => <button key={t.key} className="dash-chip dash-chip--sm" dir="auto" onClick={() => onDrill({ title: `#${t.tag}`, params: { hashtag: t.key } })}>#{t.tag} · {t.posts}</button>)}</div>}
      </>}
    </State>
  </Panel>;
}

export function InfluencersPanel({ q, allowed, onDrill, panel }: { q: Q<InfData>; allowed: boolean; onDrill: OnDrill; panel: object }) {
  const d = q.data;
  return <Panel id="influencers" title="المؤثرون النشطون" {...panel}
    info="حسابات متابَعة ظهر لها منشور في الفترة بالفلاتر الحالية (كل حساب مرة واحدة). المتابعون من ملف إكس المخزن؛ لا تُعرض مؤشرات وصول غير متوفرة."
    footer={allowed && <Link className="dash-link" to="/influencers">كل المؤثرين<ChevronLeft size={14} /></Link>}>
    {!allowed ? <Unavailable reason="يتطلب هذا القسم صلاحية عرض المؤثرين." /> :
    <State loading={q.isLoading} error={q.error} height={260}>
      {d && <>
        <p className="dash-inline-stats"><span><strong className="num">{fmtNum(d.active)}</strong> نشطون من {fmtNum(d.tracked)} <Delta value={d.active} previous={d.activePrevious} compact /></span>
          <span><strong className="num">{fmtNum(d.relevantPosts)}</strong> منشورًا ذا صلة</span></p>
        {d.top.length ? <ul className="dash-people">{d.top.slice(0, 5).map((r) => <li key={r.id}>
          <button onClick={() => onDrill({ title: `منشورات @${r.username}`, params: { influencerId: r.id } })}>
            <Avatar src={r.profile_image_url} name={r.display_name} username={r.username} size={30} />
            <span className="min-w-0 flex-1"><strong className="truncate block">{r.display_name ?? r.username}</strong>
              <span className="dash-muted-sm" dir="ltr">@{r.username}</span></span>
            <span className="dash-people-meta"><span className="num">{fmtNum(r.posts)} منشور</span>
              <span>{r.followers_count === null ? 'المتابعون غير متوفر' : `${fmtCompact(r.followers_count)} متابع`}</span>
              <span>{r.dominant_sentiment ? SENTIMENT_GROUP_LABELS[r.dominant_sentiment] : 'عينة غير كافية'}{r.last_seen_at ? ` · ${fmtRelative(r.last_seen_at)}` : ''}</span></span>
          </button></li>)}</ul>
          : <p className="dash-state is-compact">لم يُرصد نشاط لحسابات متابَعة في هذه الفترة.</p>}
      </>}
    </State>}
  </Panel>;
}
