import { lazy, Suspense } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { ArrowUpLeft, CheckCircle2, Clock3, FileDown, LoaderCircle, XCircle } from 'lucide-react';
import { summarizeExports } from '../../lib/report-insights';
import { EXPORT_STATUS, tablesReady, type Catalog, type ExportRow } from '../../lib/reports';
import { fmtNum } from '../../lib/format';
import AsyncState from '../AsyncState';

const Charts=lazy(()=>import('./ReportCharts'));
export default function ReportOverview({catalog:c,history,onHistory}:{catalog:Catalog;history:UseQueryResult<{items:ExportRow[]},Error>;onHistory:()=>void}) {
  const available=tablesReady(c)&&c.canExport;
  const ready=available&&!!history.data&&!history.error;
  const s=summarizeExports(ready?history.data!.items:[]);
  const metrics=[
    {label:'عمليات التصدير',value:s.total,icon:FileDown,tone:'brand',note:'ضمن السجل المتاح'},
    {label:'اكتملت بنجاح',value:s.succeeded,icon:CheckCircle2,tone:'ok',note:'ملفات أُنشئت بنجاح'},
    {label:'قيد التنفيذ والانتظار',value:s.active,icon:LoaderCircle,tone:'info',note:'تُحدّث حالتها تلقائيًا'},
    {label:'عمليات فاشلة',value:s.failed,icon:XCircle,tone:'bad',note:'قد تحتاج إعادة محاولة'},
    {label:'متوسط زمن التنفيذ',value:s.averageSeconds===null?null:Math.round(s.averageSeconds*10)/10,icon:Clock3,tone:'muted',note:s.durationCount?`من ${fmtNum(s.durationCount)} عملية ناجحة ذات توقيت مكتمل`:'لا توجد مدد مكتملة متاحة'},
  ];
  return <section className="rc-overview" aria-label="ملخص سجل التصدير">
    <div className="rc-section-heading"><div><h2 className="rc-h2">لمحة عن نشاطك</h2><p className="rc-desc">إحصائيات سجلك الشخصي المتاح، حتى آخر 100 عملية. ليست إجمالي عمليات المنصة.</p></div><button className="rc-link" onClick={onHistory}>عرض السجل<ArrowUpLeft size={15} aria-hidden="true" /></button></div>
    <div className="rc-kpis">{metrics.map((m,i)=><article className={`rc-kpi rc-kpi-${m.tone}`} key={m.label} aria-busy={available&&history.isLoading}>
      <div><span>{m.label}</span><m.icon size={18} aria-hidden="true" /></div>
      <strong>{available&&history.isLoading?<span className="rc-skeleton rc-value-skeleton" />:ready?m.value===null?'—':fmtNum(m.value):'—'}{i===4&&ready&&m.value!==null&&<small> ثانية</small>}</strong>
      <p>{!available?'غير متاح لحسابك حاليًا':history.error?'تعذر تحميل المؤشر':m.note}</p>
    </article>)}</div>
    {!available?<div className="rc-note">تصفح التقارير ومعاينتها حسب صلاحياتك. مؤشرات التصدير تتطلب إتاحة السجل وصلاحية التصدير.</div>
      :history.error?<AsyncState error={history.error} errorMessage="تعذر تحميل نشاط التصدير. لا تمثل القيم غير المتاحة أعدادًا صفرية." onRetry={()=>history.refetch()} />
      :history.isLoading?<div className="rc-analytics" role="status" aria-label="جارٍ تحميل تحليلات التصدير"><div className="rc-skeleton"/><div className="rc-skeleton"/></div>
      :!s.total?<div className="rc-first-export"><span className="rc-report-icon"><FileDown size={24}/></span><div><h3>كل تقاريرك تبدأ من هنا</h3><p>اختر تقريرًا من الكتالوج أدناه. سيظهر نشاط التصدير هنا بعد إنشاء أول ملف.</p></div></div>
      :<Suspense fallback={<div className="rc-skeleton" role="status" aria-label="جارٍ تجهيز الرسوم"/>}><Charts summary={s} catalog={c}/></Suspense>}
    {ready&&s.total>0&&<div className="rc-insight-foot"><span>الأكثر استخدامًا في سجلك: <b>{c.types.find(t=>t.key===s.types[0]?.[0])?.ar??s.types[0]?.[0]}</b></span><span>لا يتضمن السجل برنامج كل عملية؛ توزيع البرامج غير متاح.</span></div>}
  </section>;
}
