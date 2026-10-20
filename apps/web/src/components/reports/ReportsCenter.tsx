import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { ArrowUpLeft, BarChart3, CalendarClock, CheckCircle2, Clock3, FileBarChart, FileDown, History, LayoutGrid, LayoutTemplate, LockKeyhole, Search, X } from 'lucide-react';
import { api } from '../../lib/api';
import { fmtNum } from '../../lib/format';
import { SECTIONS, tablesReady, type Catalog, type CatalogType, type ExportRow } from '../../lib/reports';
import ReportBuilder, { initialBuilder, type BuilderState } from './ReportBuilder';
import { ExportsView, TemplatesView, SchedulesView } from './ReportManagement';
import ReportOverview from './ReportOverview';
import AsyncState from '../AsyncState';
import { Button } from '../ui/Button';
import './reports.css';
import './reports-center.css';

const VIEWS = [
  {key:'overview',label:'نظرة عامة',icon:BarChart3}, {key:'catalog',label:'كتالوج التقارير',icon:LayoutGrid},
  {key:'exports',label:'سجل التصدير',icon:History}, {key:'templates',label:'القوالب المحفوظة',icon:LayoutTemplate},
  {key:'schedules',label:'الجدولة',icon:CalendarClock},
] as const;

export default function ReportsCenter() {
  const qc = useQueryClient();
  const [params,setParams] = useSearchParams();
  const view = VIEWS.some(v => v.key === params.get('reportsView')) ? params.get('reportsView')! : 'overview';
  const [builder,setBuilder] = useState<{type:CatalogType;state:BuilderState}|null>(null);
  const [category,setCategory] = useState('all');
  const [search,setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const catalog = useQuery({queryKey:['report-catalog'],queryFn:()=>api.get<Catalog>('/reports/catalog'),retry:false,staleTime:60_000});
  const c = catalog.data;
  const history = useQuery({queryKey:['report-exports'],queryFn:()=>api.get<{items:ExportRow[]}>('/reports/exports'),
    enabled:!!c && tablesReady(c) && c.canExport,
    refetchInterval:q=>(q.state.data?.items??[]).some(e=>['queued','running'].includes(e.status))?3000:false});
  const navigate = (key:string) => setParams(previous=>{const next=new URLSearchParams(previous);next.set('reportsView',key);return next;});
  const open = (type:CatalogType) => {setBuilder({type,state:initialBuilder(type)});navigate('catalog');};
  const choose = () => {navigate('catalog');setBuilder(null);requestAnimationFrame(()=>searchRef.current?.focus());};

  return <div className="rc-page rc-workspace" dir="rtl">
    <header className="rc-header">
      <div className="rc-heading"><span className="rc-heading-icon"><FileBarChart size={26} aria-hidden="true" /></span><div>
        <span className="rc-eyebrow">البيانات تتحول إلى قرارات</span><h1 className="rc-h1">مركز التقارير</h1>
        <p className="rc-lead">استكشف تقاريرك، خصّص بياناتها، وتابع ملفات التصدير من مكان واحد.</p>
      </div></div>
      <div className="rc-header-tools">
        {c && <div className="rc-status" aria-label="حالة خدمات التقارير">
          <span className={`rc-pill ${c.exportsActivated?'is-ok':''}`}><span className="rc-status-dot" />التصدير {c.exportsActivated?'مفعّل':'معطّل'}</span>
          <span className={`rc-pill ${c.schedulesActivated?'is-ok':''}`}><CalendarClock size={13} aria-hidden="true" />الجدولة {c.schedulesActivated?'مفعّلة':'معطّلة'}</span>
        </div>}
        {c?.canExport && c.exportsActivated && <Button variant="primary" type="submit" onClick={choose}><FileDown size={17} aria-hidden="true" />إنشاء تصدير</Button>}
      </div>
    </header>

    <nav className="rc-tabs" aria-label="أقسام مركز التقارير">{VIEWS.map(v=><button key={v.key} type="button" aria-current={view===v.key?'page':undefined} onClick={()=>navigate(v.key)}>
      <v.icon size={17} aria-hidden="true" />{v.label}{v.key==='schedules' && c && !c.schedulesActivated && <LockKeyhole size={12} aria-label="غير مفعّلة" />}
    </button>)}</nav>

    {!c ? catalog.error ? <AsyncState error={catalog.error} errorMessage="تعذر تحميل مركز التقارير. تحقق من الاتصال وصلاحية الوصول." onRetry={()=>catalog.refetch()} />
      : <div className="rc-loading-layout" role="status" aria-label="جارٍ تحميل مركز التقارير" aria-busy="true"><div className="rc-kpis">{[1,2,3,4,5].map(n=><div key={n} className="rc-skeleton" />)}</div><div className="rc-skeleton" /></div>
      : <section className="rc-main" id="rc-content">
        {view==='overview' && <>
          <ReportOverview catalog={c} history={history} onHistory={()=>navigate('exports')} />
          <CatalogView c={c} category={category} setCategory={setCategory} search={search} setSearch={setSearch} searchRef={searchRef} onOpen={open} />
        </>}
        {view==='catalog' && (builder ? <>
          <div className="rc-builder-heading"><Button variant="ghost" type="button" onClick={()=>setBuilder(null)}>العودة إلى الكتالوج</Button><div><span className="rc-eyebrow">{SECTIONS.find(s=>s.key===builder.type.section)?.ar}</span><h2 className="rc-h2">{builder.type.ar}</h2><p className="rc-desc">{builder.type.descriptionAr}</p></div><span className="rc-tag">{builder.type.aggregated?'ملخص مجمّع':'تفاصيل السجلات'}</span></div>
          <ReportBuilder key={builder.type.key} catalog={c} type={builder.type} state={builder.state} setState={state=>setBuilder({...builder,state})}
            onExported={()=>{void qc.invalidateQueries({queryKey:['report-exports']});}}
            onTemplateSaved={()=>{void qc.invalidateQueries({queryKey:['report-templates']});}} />
        </> : <CatalogView c={c} category={category} setCategory={setCategory} search={search} setSearch={setSearch} searchRef={searchRef} onOpen={open} />)}
        {view==='exports' && <ExportsView c={c} />}
        {view==='templates' && <TemplatesView c={c} onUse={t=>{
          const type=c.types.find(x=>x.key===t.report_type);if(!type?.available)return;
          setBuilder({type,state:{request:t.definition.request,format:t.definition.options.format,jsonMode:t.definition.options.jsonMode??'flat',zip:!!t.definition.options.zip}});navigate('catalog');
        }} />}
        {view==='schedules' && <SchedulesView c={c} />}
      </section>}
    <footer className="rc-footer"><span><CheckCircle2 size={14} aria-hidden="true" />الصلاحيات مطبّقة على التقارير والبيانات</span><span><Clock3 size={14} aria-hidden="true" />جميع الأوقات بتوقيت الرياض</span></footer>
  </div>;
}

function CatalogView({c,category,setCategory,search,setSearch,searchRef,onOpen}:{c:Catalog;category:string;setCategory:(v:string)=>void;search:string;setSearch:(v:string)=>void;searchRef:React.RefObject<HTMLInputElement|null>;onOpen:(t:CatalogType)=>void}) {
  const term=search.trim().toLocaleLowerCase('ar');
  const types=c.types.filter(t=>(category==='all'||t.section===category)&&(!term||[t.ar,t.en,t.descriptionAr].some(v=>v.toLocaleLowerCase('ar').includes(term))));
  const unavailable=c.unavailable.filter(t=>(category==='all'||t.section===category)&&(!term||[t.ar,t.reasonAr].some(v=>v.toLocaleLowerCase('ar').includes(term))));
  return <section className="rc-catalog" aria-labelledby="rc-catalog-title">
    <div className="rc-section-heading"><div><h2 id="rc-catalog-title" className="rc-h2">كتالوج التقارير</h2><p className="rc-desc">اختر التقرير المناسب لبدء المعاينة أو تجهيز ملف تصدير.</p></div><span className="rc-tag">{fmtNum(c.types.filter(t=>t.available).length)} تقارير متاحة لك</span></div>
    <div className="rc-catalog-toolbar"><label className="rc-search"><Search size={18} aria-hidden="true" /><span className="sr-only">البحث في كتالوج التقارير</span><input ref={searchRef} value={search} onChange={e=>setSearch(e.target.value)} placeholder="ابحث عن تقرير بالاسم أو الوصف…" />{search && <button type="button" aria-label="مسح البحث" onClick={()=>setSearch('')}><X size={16} /></button>}</label>
      <label className="rc-category"><span className="sr-only">فئة التقرير</span><select className="input" value={category} onChange={e=>setCategory(e.target.value)}><option value="all">جميع الفئات</option>{SECTIONS.filter(s=>c.types.some(t=>t.section===s.key)||c.unavailable.some(t=>t.section===s.key)).map(s=><option key={s.key} value={s.key}>{s.ar}</option>)}</select></label>
      {(search||category!=='all')&&<button type="button" className="rc-link" onClick={()=>{setSearch('');setCategory('all');}}>إعادة ضبط</button>}
    </div>
    <p className="rc-results-count" role="status">{fmtNum(types.length+unavailable.length)} نتائج{category!=='all'?` · ${SECTIONS.find(s=>s.key===category)?.ar}`:''}</p>
    <div className="rc-catalog-list">{types.map(t=><article className={`rc-catalog-row ${t.available?'':'is-off'}`} key={t.key}>
      <span className="rc-report-icon"><FileBarChart size={22} aria-hidden="true" /></span>
      <div className="rc-report-copy"><div className="rc-report-title"><h3>{t.ar}</h3><span className="rc-tag">{t.aggregated?'ملخص':'تفصيلي'}</span></div><p>{t.descriptionAr}</p><div className="rc-report-meta"><span>{SECTIONS.find(s=>s.key===t.section)?.ar}</span><span>{fmtNum(t.columns.filter(col=>col.allowed).length)} عمود متاح</span><span>{t.available?'معاينة متاحة':t.reason}</span></div></div>
      <div className="rc-catalog-actions">{t.available?<><Button variant="ghost" type="button" aria-label={`معاينة ${t.ar}`} onClick={()=>onOpen(t)}>معاينة<ArrowUpLeft size={15} aria-hidden="true" /></Button>{c.canExport&&c.exportsActivated&&<button className="rc-export-action" type="button" onClick={()=>onOpen(t)} aria-label={`تصدير ${t.ar}`}><FileDown size={15} aria-hidden="true" />تصدير</button>}</>:<span className="rc-tag"><LockKeyhole size={13} aria-hidden="true" />غير متاح</span>}</div>
    </article>)}</div>
    {unavailable.length>0&&<details className="rc-unavailable"><summary>تقارير غير متاحة حاليًا ({fmtNum(unavailable.length)})</summary>{unavailable.map(u=><div key={u.key}><LockKeyhole size={16} aria-hidden="true" /><div><b>{u.ar}</b><p>{u.reasonAr}</p></div></div>)}</details>}
    {!types.length&&!unavailable.length&&<div className="rc-state"><Search size={28} aria-hidden="true" /><h3>لا توجد تقارير مطابقة</h3><p>جرّب كلمة أخرى أو أعد ضبط فئة التقرير.</p><Button variant="ghost" type="submit" onClick={()=>{setSearch('');setCategory('all');}}>إعادة ضبط البحث</Button></div>}
  </section>;
}
