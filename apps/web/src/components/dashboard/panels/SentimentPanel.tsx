import { useMemo } from 'react';
import { fmtNum } from '../../../lib/format';
import { SENTIMENT_GROUP_LABELS, share } from '../../../lib/dashboard';
import EChart from '../charts/EChart';
import { ratioOption, rankHeight, stackOption, type StackGroup } from '../charts/options';
import { useChartColors } from '../charts/theme';
import { MIN_SENTIMENT_SAMPLE, SENTIMENT_KEYS, negativeTrend, sentimentCats } from '../transforms';
import type { OnDrill, Q, SentData } from '../types';
import { Delta, LegendItem, Panel, State, pctText } from '../ui';

/**
 * Distribution (one share bar, counts and % together), how it moved, and how
 * it differs between programs (or topics inside one program). No donut: the
 * share bar carries the same information without repeating it.
 */
export default function SentimentPanel({ q, programMode, onDrill, panel }: { q: Q<SentData>; programMode: boolean; onDrill: OnDrill; panel: object }) {
  const c = useChartColors();
  const d = q.data;
  const color: Record<string, string> = { positive: c.positive, neutral: c.neutral, negative: c.negative };
  const groups: StackGroup[] = SENTIMENT_KEYS.map((k) => ({ key: k, label: SENTIMENT_GROUP_LABELS[k], color: color[k] }));
  const classified = d ? d.current.positive + d.current.neutral + d.current.negative : 0;
  const prevClassified = d?.previous ? d.previous.positive + d.previous.neutral + d.previous.negative : 0;
  const cats = useMemo(() => sentimentCats(programMode ? d?.byTopic ?? [] : d?.byProgram ?? []), [d, programMode]);
  const stack = useMemo(() => stackOption(c, cats, groups), [c, cats]); // eslint-disable-line react-hooks/exhaustive-deps
  const trend = useMemo(() => negativeTrend(d), [d]);
  const drawable = (trend?.values.filter((v) => v !== null).length ?? 0) > 1;
  const ratio = useMemo(() => trend && ratioOption(c, trend.labels, trend.titles, trend.values, trend.samples, c.negative), [c, trend]);
  const drill = (g: string) => onDrill({ title: `مشاعر ${SENTIMENT_GROUP_LABELS[g]}`, params: { sentiment: g, series: 'relevant' } });

  return <Panel id="sentiment" title="تحليل المشاعر" eyebrow="ذكاء المشاعر" {...panel}
    info="منشورات X ذات الصلة فقط. النسب من المنشورات المصنفة المشاعر؛ غير المصنف يُعرض منفصلًا ولا يُحتسب محايدًا. الأخبار غير مشمولة.">
    <State loading={q.isLoading} error={q.error} empty={!d || classified + d.current.unclassified === 0} height={300}>
      {d && <div className="dash-sent">
        <div className="dash-sent-overall">
          <div className="dash-sharebar" role="img" aria-label={SENTIMENT_KEYS.map((g) => `${SENTIMENT_GROUP_LABELS[g]} ${pctText(share(d.current[g], classified))}`).join('، ')}>
            {SENTIMENT_KEYS.map((g) => { const s = share(d.current[g], classified) ?? 0;
              return s > 0 ? <span key={g} style={{ width: `${s * 100}%`, background: color[g] }} /> : null; })}
          </div>
          <ul className="dash-sent-rows">{SENTIMENT_KEYS.map((g) => {
            const now = share(d.current[g], classified);
            const before = d.previous && prevClassified ? share(d.previous[g], prevClassified) : null;
            return <li key={g}><button className="dash-sent-row" onClick={() => drill(g)}>
              <LegendItem color={color[g]} label={SENTIMENT_GROUP_LABELS[g]} />
              <strong className="num">{pctText(now, 1)}</strong>
              <span className="num dash-muted-sm">{fmtNum(d.current[g])}</span>
              <Delta value={now} previous={before} kind="share" attention={g === 'negative' ? 'up' : g === 'positive' ? 'down' : undefined} />
            </button></li>;
          })}
            <li><button className="dash-sent-row" onClick={() => drill('unclassified')}>
              <LegendItem hatch label="غير مصنف" /><span />
              <span className="num dash-muted-sm">{fmtNum(d.current.unclassified)}</span><span className="dash-delta is-none">خارج النسب</span></button></li>
          </ul>
          <p className="dash-footnote">العينة: {fmtNum(classified)} منشورًا مصنف المشاعر.</p>
          <h3 className="dash-subtitle">اتجاه نسبة السلبية</h3>
          {drawable && ratio ? <EChart option={ratio} height={130} label="نسبة المشاعر السلبية عبر الزمن" />
            : <p className="dash-state is-compact">نقاط غير كافية لرسم الاتجاه.</p>}
          <p className="dash-footnote">لا تُرسم الفترات التي فيها أقل من {MIN_SENTIMENT_SAMPLE} منشورات مصنفة.</p>
        </div>
        <div className="dash-sent-compare">
          <h3 className="dash-subtitle">{programMode ? 'حسب التصنيف الرئيسي' : 'حسب البرنامج'}<span className="dash-muted-sm"> · الأعلى عينة</span></h3>
          {cats.length ? <>
            <EChart option={stack} height={rankHeight(cats.length)} label={programMode ? 'توزيع المشاعر حسب التصنيف' : 'توزيع المشاعر حسب البرنامج'} />
            <div className="dash-legend">{groups.map((g) => <LegendItem key={g.key} color={g.color} label={g.label} />)}</div>
          </> : <p className="dash-state is-compact">لا توجد بيانات كافية للمقارنة.</p>}
        </div>
      </div>}
    </State>
  </Panel>;
}
