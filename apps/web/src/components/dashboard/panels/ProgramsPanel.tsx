import { useMemo, useState } from 'react';
import { fmtNum } from '../../../lib/format';
import EChart from '../charts/EChart';
import { rankHeight, rankOption, type RankRow } from '../charts/options';
import { useChartColors } from '../charts/theme';
import { PROGRAM_LIMIT, rankPrograms } from '../transforms';
import type { ClassData, OnDrill, ProgramRow, ProgramsData, Q } from '../types';
import { Panel, State, pctText } from '../ui';

const METRICS = { relevant: 'ذات الصلة', complaints: 'الشكاوى', inquiries: 'الاستفسارات' } as const;
type Metric = keyof typeof METRICS;

/** All programs: one ranked comparison. One program: its most frequent main topics. */
export default function ProgramsPanel({ q, cls, programMode, onPick, onDrill, panel }: {
  q: Q<ProgramsData>; cls: Q<ClassData>; programMode: boolean; onPick: (key: string) => void; onDrill: OnDrill; panel: object;
}) {
  return programMode ? <TopicsRank q={cls} onDrill={onDrill} panel={panel} /> : <ProgramsRank q={q} onPick={onPick} panel={panel} />;
}

function ProgramsRank({ q, onPick, panel }: { q: Q<ProgramsData>; onPick: (key: string) => void; panel: object }) {
  const c = useChartColors();
  const [metric, setMetric] = useState<Metric>('relevant');
  const [all, setAll] = useState(false);
  const ranked = useMemo(() => rankPrograms(q.data?.items ?? []), [q.data]);
  const top = useMemo(() => [...ranked].sort((a, b) => b[metric] - a[metric]).slice(0, PROGRAM_LIMIT), [ranked, metric]);
  const option = useMemo(() => rankOption(c, top.map((p): RankRow => ({ name: p.name_ar, value: p[metric], tip: tipRows(p) })), { clickable: true }), [c, top, metric]);
  return <Panel id="programs" title="أداء البرامج" eyebrow="مقارنة البرامج" {...panel}
    info="كل منشور مرتبط ببرنامج واحد على الأكثر فلا يتكرر بين البرامج. تُعرض أعلى البرامج حسب المؤشر المختار؛ اضغط برنامجًا لفتح لوحته."
    actions={<div className="dash-segment dash-segment--sm" role="radiogroup" aria-label="مؤشر المقارنة">
      {(Object.keys(METRICS) as Metric[]).map((m) => <button key={m} role="radio" aria-checked={metric === m} onClick={() => setMetric(m)}>{METRICS[m]}</button>)}</div>}
    footer={ranked.length > 0 && <>
      <span className="dash-muted-sm">{ranked.length > PROGRAM_LIMIT ? `أعلى ${PROGRAM_LIMIT} من ${ranked.length} برنامجًا` : `${ranked.length} برامج`}
        {(q.data?.unlinked ?? 0) > 0 && ` · ${fmtNum(q.data!.unlinked)} منشورًا غير مرتبط ببرنامج`}</span>
      <button className="dash-link" aria-expanded={all} onClick={() => setAll((a) => !a)}>{all ? 'إخفاء الجدول' : 'كل البرامج بالتفصيل'}</button>
    </>}>
    <State loading={q.isLoading} error={q.error} empty={!ranked.length} height={rankHeight(6)}>
      <EChart option={option} height={rankHeight(top.length)} label={`البرامج حسب ${METRICS[metric]}`} onRowClick={(i) => top[i] && onPick(top[i].key)} />
      {all && <div className="dash-table-wrap dash-table-scroll mt-3"><table className="dash-table">
        <thead><tr><th>البرنامج</th><th>المنشورات</th><th>ذات الصلة</th><th>الشكاوى</th><th>الاستفسارات</th><th>السلبية</th><th>القضايا</th></tr></thead>
        <tbody>{ranked.map((p) => <tr key={p.id}>
          <td><button className="dash-link" onClick={() => onPick(p.key)}>{p.name_ar}</button></td>
          <td className="num">{fmtNum(p.posts)}</td><td className="num">{fmtNum(p.relevant)}</td><td className="num">{fmtNum(p.complaints)}</td>
          <td className="num">{fmtNum(p.inquiries)}</td>
          <td className="num" title={`من ${fmtNum(p.sentiment_sample)} منشورًا مصنف المشاعر`}>{p.sentiment_sample ? pctText(p.negative / p.sentiment_sample) : '—'}</td>
          <td className="num">{fmtNum(p.stories)}</td></tr>)}</tbody>
      </table></div>}
    </State>
  </Panel>;
}

const tipRows = (p: ProgramRow) => [
  { label: 'كل المنشورات', value: fmtNum(p.posts) }, { label: 'ذات الصلة', value: fmtNum(p.relevant) },
  { label: 'الشكاوى', value: fmtNum(p.complaints) }, { label: 'الاستفسارات', value: fmtNum(p.inquiries) },
  { label: 'نسبة السلبية', value: p.sentiment_sample ? `${pctText(p.negative / p.sentiment_sample)} من ${fmtNum(p.sentiment_sample)}` : 'غير متوفر' },
];

function TopicsRank({ q, onDrill, panel }: { q: Q<ClassData>; onDrill: OnDrill; panel: object }) {
  const c = useChartColors();
  const topics = useMemo(() => (q.data?.topics ?? []).slice(0, PROGRAM_LIMIT), [q.data]);
  const option = useMemo(() => rankOption(c, topics.map((t) => ({ name: t.name, value: t.count,
    tip: [{ label: 'المنشورات', value: fmtNum(t.count) }, { label: 'الشكاوى', value: fmtNum(t.complaints) }, ...(t.previous !== null ? [{ label: 'الفترة السابقة', value: fmtNum(t.previous) }] : [])] })),
  { clickable: true }), [c, topics]);
  return <Panel id="programs" title="أهم موضوعات البرنامج" eyebrow="البرنامج المختار" {...panel}
    info="التصنيفات الرئيسية الأكثر تكرارًا في المنشورات ذات الصلة (التصنيف الفعّال: المراجعة البشرية إن وُجدت وإلا الذكاء الاصطناعي). اضغط تصنيفًا لعرض منشوراته.">
    <State loading={q.isLoading} error={q.error} empty={!topics.length} height={rankHeight(6)} emptyText="لا توجد منشورات مصنفة بتصنيف رئيسي في هذه الفترة.">
      <EChart option={option} height={rankHeight(topics.length)} label="أهم التصنيفات الرئيسية" onRowClick={(i) => topics[i] && onDrill({ title: topics[i].name, params: { topicId: topics[i].id } })} />
    </State>
  </Panel>;
}
