import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { fmtDateTime, fmtNum, fmtRelative, parseInstant } from '../../../lib/format';
import { AI_FIELD_LABELS, INTENT_LABELS, SENTIMENT_LABELS } from '../../../lib/dashboard';
import EChart from '../charts/EChart';
import { rankHeight, rankOption } from '../charts/options';
import { useChartColors } from '../charts/theme';
import { newsSourceHealth } from '../transforms';
import type { Ai, Health, NewsSourceHealth, Ops, Q } from '../types';
import { Panel, Stat, State, minutesText } from '../ui';

/** A collected post older than this is flagged; the rule is stated next to the figure. */
const STALE_HOURS = 24;

type Plain<T> = { data?: T; isLoading: boolean; error: unknown };

/**
 * Health of the monitoring pipeline, kept apart from public-opinion figures.
 * Each tile reads a real source; when a source cannot be read it says so
 * instead of showing a success state.
 */
export function SystemHealthPanel({ health, sources, newsAllowed, unclassified, panel }: {
  health: Plain<Health>; sources: Plain<{ items: NewsSourceHealth[] }>; newsAllowed: boolean; unclassified: number | null; panel: object;
}) {
  const h = health.data;
  const latest = h?.collectionLatency?.latest_collected_at ?? null;
  const ageH = latest ? (Date.now() - (parseInstant(latest)?.getTime() ?? Date.now())) / 3_600_000 : null;
  const src = newsSourceHealth(sources.data?.items);
  const x = !h ? null
    : h.mode !== 'live' ? { value: 'وضع تجريبي', tone: 'muted' as const, sub: 'لا اتصال بواجهة X في هذا الوضع' }
    : h.xStream.state === 'connected' ? { value: 'متصل', tone: 'ok' as const, sub: `${fmtNum(h.xStream.rules)} قواعد · آخر حدث ${h.xStream.lastEventAt ? fmtRelative(h.xStream.lastEventAt) : '—'}` }
    : { value: h.xStream.hasError ? 'منقطع مع خطأ' : 'غير متصل', tone: (h.xStream.hasError ? 'bad' : 'warn') as 'bad' | 'warn', sub: `البث المباشر · ${fmtNum(h.xStream.rules)} قواعد` };
  return <Panel id="operations" title="صحة منظومة الرصد" eyebrow="الجمع والمعالجة" {...panel}
    info="مؤشرات تشغيلية منفصلة عن مؤشرات الرأي العام: حالة الجمع من X، آخر منشور مجمع، صحة مصادر الأخبار، والمنشورات التي لم تُصنف بعد. لا تتأثر بفلاتر البرنامج والفترة إلا «بانتظار التصنيف».">
    <div className="dash-health">
      {health.isLoading ? <div className="dash-skeleton" style={{ height: 84 }} />
        : !h ? <Stat label="جمع X" value="غير متاح" tone="muted" sub="تعذر قراءة حالة الخادم" />
        : <Stat label="جمع X (البث المباشر)" value={x!.value} tone={x!.tone} sub={x!.sub} />}
      {health.isLoading ? <div className="dash-skeleton" style={{ height: 84 }} />
        : <Stat label="آخر منشور مجمّع" value={latest ? fmtRelative(latest) : 'غير متاح'} tone={ageH === null ? 'muted' : ageH > STALE_HOURS ? 'warn' : 'ok'}
          sub={latest ? fmtDateTime(latest) : 'لا توجد منشورات مجمعة'} info={`يُميَّز إذا مضى أكثر من ${STALE_HOURS} ساعة على آخر منشور مجمّع من أي مصدر على X.`} />}
      {!newsAllowed ? <Stat label="مصادر الأخبار" value="غير متاح" tone="muted" sub="يتطلب صلاحية عرض الأخبار" />
        : sources.isLoading ? <div className="dash-skeleton" style={{ height: 84 }} />
        : !src ? <Stat label="مصادر الأخبار" value="غير متاح" tone="muted" sub="تعذر قراءة حالة المصادر" />
        : <Stat label="مصادر الأخبار النشطة" value={`${fmtNum(src.healthy)} / ${fmtNum(src.active)} سليمة`} tone={src.failed ? 'bad' : src.degraded ? 'warn' : 'ok'}
          sub={`${fmtNum(src.degraded)} متعثرة · ${fmtNum(src.failed)} متوقفة${src.lastChecked ? ` · آخر فحص ${fmtRelative(src.lastChecked)}` : ''}`}
          info="حالة كل مصدر كما يسجلها جامع الأخبار بعد آخر محاولة جلب: سليم، متعثر (أخطاء متتالية)، متوقف." />}
      <Stat label="بانتظار التصنيف" value={unclassified === null ? 'غير متاح' : fmtNum(unclassified)} tone={unclassified ? 'warn' : 'ok'}
        sub="منشورات الفترة التي لم يُحدد لها تصنيف بعد" info="منشورات X في الفترة والفلاتر الحالية بلا تصنيف فعّال (لا ذكاء اصطناعي ولا مراجعة بشرية)." />
    </div>
    <p className="dash-footnote">{h ? `حالة الخادم كما في ${fmtDateTime(h.time)}.` : ''} <Link className="dash-link" to="/news/sources">إدارة مصادر الأخبار<ChevronLeft size={13} /></Link></p>
  </Panel>;
}

export function TeamPanel({ q, panel }: { q: Q<Ops>; panel: object }) {
  const d = q.data;
  return <Panel id="team" title="أداء فريق الرصد" eyebrow={d?.scope === 'own' ? 'عملي فقط' : d?.scope === 'team' ? 'فرقي' : 'كل الفرق'} {...panel}
    info="«الآن» = حالة الطابور الحالية. «خلال الفترة» = إغلاقات ومراجعات حدثت ضمن الفترة. العنصر المعاد فتحه يُحسب عنصرًا مغلقًا واحدًا."
    footer={<Link className="dash-link" to="/queue">طابور الرصد<ChevronLeft size={14} /></Link>}>
    <State loading={q.isLoading} error={q.error} height={180}>
      {d && <><div className="dash-stats">
        <Stat label="غير مسند الآن" value={fmtNum(d.snapshot.unassigned)} />
        <Stat label="في صناديق الموظفين" value={fmtNum(d.snapshot.assigned)} sub={`${fmtNum(d.snapshot.escalated)} مصعّد`} />
        <Stat label="متأخر" value={fmtNum(d.snapshot.overdue)} tone={d.snapshot.overdue ? 'bad' : 'ok'} sub={`أكثر من ${d.warnMinutes} دقيقة`} />
        <Stat label="أُغلق في الفترة" value={fmtNum(d.period.closed_items)} sub={`${fmtNum(d.period.reopened)} إعادة فتح`} />
        <Stat label="من الإسناد حتى الإغلاق" value={minutesText(d.period.avg_assignment_to_close_min)} sub="متوسط — ليس وقت معالجة فعليًا" />
        <Stat label="حتى الإغلاق" value={minutesText(d.period.avg_close_tat_min)} sub="متوسط منذ الدخول" />
        <Stat label="انتظار الإسناد" value={minutesText(d.period.avg_wait_assign_min)} sub="متوسط خلال الفترة" />
        <Stat label="مراجعات مكتملة" value={fmtNum(d.period.review_cycles)} />
      </div>
      {d.employees.length > 0 && <div className="dash-table-wrap mt-3"><table className="dash-table" aria-label="أداء موظفي الرصد خلال الفترة">
        <thead><tr><th>الموظف</th><th>مفتوح الآن</th><th>مغلق في الفترة</th><th>مراجعات</th><th>تصحيحات</th><th>من الإسناد حتى الإغلاق</th></tr></thead>
        <tbody>{d.employees.map(employee => <tr key={employee.id}>
          <td>{employee.full_name}</td><td className="num">{fmtNum(employee.open)}</td><td className="num">{fmtNum(employee.closed_items)}</td>
          <td className="num">{fmtNum(employee.review_cycles)}</td><td className="num">{fmtNum(employee.corrected)}</td>
          <td>{minutesText(employee.avg_assignment_to_close_min)}</td>
        </tr>)}</tbody>
      </table></div>}
      </>}
    </State>
  </Panel>;
}

export function AiQualityPanel({ q, panel }: { q: Q<Ai>; panel: object }) {
  const c = useChartColors();
  const d = q.data;
  const option = useMemo(() => d && rankOption(c, d.fields.map((f) => ({
    name: AI_FIELD_LABELS[f.field] ?? f.field, value: f.rate,
    tip: [{ label: 'نسبة الاتفاق', value: f.rate === null ? 'غير قابل للحساب' : `${f.rate}٪` }, { label: 'متفق', value: `${fmtNum(f.agreed)} من ${fmtNum(f.sample)}` }],
  })), { max: 100, format: (v) => `${v}٪` }), [c, d]);
  const valueLabel = (m: Ai['mostCorrected'][number]) => m.ai_label ?? (m.field === 'intent' ? INTENT_LABELS[m.ai_value] : m.field === 'sentiment' ? SENTIMENT_LABELS[m.ai_value] : null) ?? 'قيمة غير متاحة';
  return <Panel id="ai_quality" title="جودة تصنيفات الذكاء الاصطناعي" eyebrow="الاتفاق مع المراجعة البشرية" {...panel}
    info="آخر مراجعة لكل عنصر روجع في الفترة. لكل حقل: المراجعات التي أعطى فيها الذكاء الاصطناعي قيمة فقط. مؤشر اتفاق على العينة المراجعة، وليس دقة النموذج على كل البيانات.">
    <State loading={q.isLoading} error={q.error} empty={!d?.reviewed} height={180} emptyText="لا توجد مراجعات بشرية في هذه الفترة.">
      {d && <div className="dash-ai">
        <div className="dash-stats dash-stats--col">
          <Stat label="نسبة الاتفاق الإجمالية" value={d.overall?.rate == null ? 'غير متوفر' : `${d.overall.rate}٪`}
            sub={d.overall ? `${fmtNum(d.overall.agreed)} من ${fmtNum(d.overall.sample)} مقارنة${d.overallPrevious?.rate != null ? ` · السابق ${d.overallPrevious.rate}٪` : ''}` : undefined} />
          <Stat label="عناصر روجعت" value={fmtNum(d.reviewed)} sub={`${fmtNum(d.outcomes.corrected)} صُححت${d.correctionRate === null ? '' : ` (${d.correctionRate}٪)`}`} />
        </div>
        <div className="min-w-0">
          <h3 className="dash-subtitle">الاتفاق حسب الحقل</h3>
          {option && <EChart option={option} height={rankHeight(d.fields.length)} label="نسبة الاتفاق لكل حقل" />}
          {d.mostCorrected.length > 0 && <p className="dash-footnote">الأكثر تصحيحًا: {d.mostCorrected.slice(0, 3).map((m) => `${AI_FIELD_LABELS[m.field]}: ${valueLabel(m)} (${fmtNum(m.corrections)})`).join(' · ')}</p>}
        </div>
      </div>}
    </State>
  </Panel>;
}
