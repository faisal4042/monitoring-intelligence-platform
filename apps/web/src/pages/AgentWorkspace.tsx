import {useMemo} from 'react';
import {useInfiniteQuery,useQuery} from '@tanstack/react-query';
import {useSearchParams} from 'react-router-dom';
import {Inbox,CheckCircle2,BarChart3,MessagesSquare,UserRound,Sparkles,Flame,RefreshCw} from 'lucide-react';
import {QUEUE_SECTIONS,QUEUE_SECTION_LABELS,QUEUE_STATUS_LABELS,type QueueSection,type QueueStatus} from '@mip/shared';
import {api} from '../lib/api';
import {INTENT_LABELS,SENTIMENT_LABELS,duration,useServerClock,type QueueItem,type QueueSummary,type ReviewCatalog} from '../lib/queue';
import {hours,minutesText,statusLabel,useMyWorkforce} from '../lib/workforce';
import {fmtDateTime,fmtNum,fmtRelative} from '../lib/format';
import {useDateRange} from '../lib/useDateRange';
import DateRangeFilter from '../components/DateRangeFilter';
import QueueDrawer from '../components/QueueDrawer';
import Avatar from '../components/Avatar';

type Tab='box'|'closed'|'performance';
const TABS:Array<{key:Tab;label:string;icon:typeof Inbox}>=[
  {key:'box',label:'صندوقي',icon:Inbox},{key:'closed',label:'المغلقة',icon:CheckCircle2},{key:'performance',label:'أدائي',icon:BarChart3},
];
const LANE_ICON={general:MessagesSquare,influencer:UserRound,story:Sparkles} as const;

/**
 * The monitoring agent's workspace: their box, what they closed, and their own
 * figures. No "start" button: the time in the box runs from the assignment.
 */
export default function AgentWorkspace() {
  const [params,setParams]=useSearchParams();
  const tab=(['box','closed','performance'].includes(params.get('tab')??'')?params.get('tab'):'box') as Tab;
  const set=(key:string,value:string,push=false)=>setParams(old=>{const n=new URLSearchParams(old);value?n.set(key,value):n.delete(key);return n;},{replace:!push});
  const me=useMyWorkforce();
  const selected=params.get('item');
  return <div className="space-y-4">
    <div className="page-heading"><div>
      <p className="eyebrow">MY QUEUE</p><h1>مهامي</h1>
      <p>التفاعلات المسندة إليك بالترتيب. افتح التفاعل وراجع التصنيف ثم أغلقه — لا يلزم بدء المعالجة.</p>
    </div></div>
    <MyStrip/>
    <nav role="tablist" aria-label="أقسام مهامي" className="queue-tabs">
      {TABS.map(t=><button key={t.key} role="tab" aria-selected={t.key===tab} className="queue-tab"
        onClick={()=>setParams(old=>{const n=new URLSearchParams(old);n.set('tab',t.key);n.delete('item');return n;})}>
        <t.icon size={16}/>{t.label}{t.key==='box'&&me.data?<span className="queue-tab-count">{me.data.open+me.data.escalatedOpen}</span>:null}
      </button>)}
    </nav>
    {tab==='box'&&<MyBox onOpen={id=>set('item',id,true)} selected={selected}/>}
    {tab==='closed'&&<MyClosed onOpen={id=>set('item',id,true)} selected={selected}/>}
    {tab==='performance'&&<MyPerformance/>}
    {selected&&<QueueDrawer key={selected} id={selected} onClose={()=>set('item','',true)}/>}
  </div>;
}

/** Status, time in status, box occupancy and today's closures — always visible. */
function MyStrip() {
  const me=useMyWorkforce();
  const now=useServerClock(me.data?.serverNow,30000);
  if(!me.data)return <div className="card p-4 muted text-sm">جارٍ التحميل…</div>;
  const d=me.data;const pct=d.maxOpen?Math.min(100,Math.round(d.open/d.maxOpen*100)):100;
  return <section className="wf-strip" aria-label="حالتي وسعة صندوقي">
    <div className="card wf-stat">
      <span className="wf-stat-label">حالتي</span>
      <span className={`wf-status-chip agent-status--${d.status.status}`}><span className="agent-status-dot" aria-hidden="true"/>{statusLabel(d.status.status)}</span>
      <span className="wf-stat-sub">{d.status.started_at?`منذ ${duration(d.status.started_at,now)}`:'اختر حالتك من الشريط العلوي'}</span>
    </div>
    <div className="card wf-stat">
      <span className="wf-stat-label">سعة الصندوق</span>
      <span className="wf-stat-value">{d.open} / {d.maxOpen}</span>
      <span className="wf-capacity" role="meter" aria-valuemin={0} aria-valuemax={d.maxOpen} aria-valuenow={d.open} aria-label="إشغال الصندوق"><span style={{inlineSize:`${pct}%`}}/></span>
      <span className="wf-stat-sub">{d.escalatedOpen?`${d.escalatedOpen} مصعّد بانتظار المشرف · `:''}{!d.autoAssignEnabled?'الإسناد التلقائي متوقف':d.autoAssign?(d.status.status==='available'?'يصلك التالي تلقائياً':'الإسناد التلقائي عند «متاح» فقط'):'الإسناد التلقائي معطل لك'}</span>
    </div>
    <div className="card wf-stat">
      <span className="wf-stat-label">أُنجز اليوم</span>
      <span className="wf-stat-value">{fmtNum(d.completedToday)}</span>
      <span className="wf-stat-sub">تفاعلات مغلقة دون تكرار</span>
    </div>
  </section>;
}

function useCatalogWarn() {
  const {data}=useQuery({queryKey:['queue-review-catalog'],queryFn:()=>api.get<ReviewCatalog>('/queue/review-catalog')});
  return data?.waitWarningMinutes??60;
}

function MyBox({onOpen,selected}:{onOpen:(id:string)=>void;selected:string|null}) {
  const [params,setParams]=useSearchParams();
  const lane=(QUEUE_SECTIONS as readonly string[]).includes(params.get('lane')??'')?params.get('lane') as QueueSection:null;
  const program=params.get('programId')??'';const intent=params.get('classification')??'';
  const set=(key:string,value:string)=>setParams(old=>{const n=new URLSearchParams(old);value?n.set(key,value):n.delete(key);return n;},{replace:true});
  const qs=new URLSearchParams({range:'all',view:'mine',limit:'100'});
  if(lane)qs.set('section',lane);if(program)qs.set('programId',program);if(intent)qs.set('classification',intent);
  const list=useQuery({queryKey:['queue','items','mine',qs.toString()],queryFn:()=>api.get<{items:QueueItem[]}>(`/queue/items?${qs}`),refetchInterval:15000,refetchIntervalInBackground:false});
  const summary=useQuery({queryKey:['queue','summary','mine'],queryFn:()=>api.get<QueueSummary>('/queue/summary?range=all&view=mine'),refetchInterval:15000,refetchIntervalInBackground:false});
  const now=useServerClock(summary.data?.serverNow,30000);const warn=useCatalogWarn();
  // Work order: high priority first, then the longest in the box.
  const items=useMemo(()=>[...(list.data?.items??[])].sort((a,b)=>
    (a.priority==='high'?0:1)-(b.priority==='high'?0:1)||Date.parse(a.assigned_at??a.entered_at)-Date.parse(b.assigned_at??b.entered_at)),[list.data]);
  const programs=useMemo(()=>{const m=new Map<string,string>();for(const i of list.data?.items??[])m.set(i.program_id,i.program_snapshot.name);return [...m];},[list.data]);
  const count=(s:QueueSection)=>summary.data?.views[s].mine??0;
  const total=QUEUE_SECTIONS.reduce((n,s)=>n+count(s),0);
  return <div className="space-y-3">
    <div className="wf-lanes" role="group" aria-label="المسارات">
      <button className="dash-chip" aria-pressed={!lane} onClick={()=>set('lane','')}>الكل <span className="queue-tab-count">{total}</span></button>
      {QUEUE_SECTIONS.map(s=>{const Icon=LANE_ICON[s];return <button key={s} className="dash-chip" aria-pressed={lane===s} onClick={()=>set('lane',s)}>
        <Icon size={14}/>{QUEUE_SECTION_LABELS[s].ar}<span className="queue-tab-count">{count(s)}</span></button>;})}
      <span className="flex-1"/>
      <select aria-label="البرنامج" className="input wf-filter" value={program} onChange={e=>set('programId',e.target.value)}>
        <option value="">كل البرامج</option>{programs.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select>
      {lane!=='story'&&<select aria-label="نوع التفاعل" className="input wf-filter" value={intent} onChange={e=>set('classification',e.target.value)}>
        <option value="">كل الأنواع</option>{Object.entries(INTENT_LABELS).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select>}
      <button className="icon-button" aria-label="تحديث" onClick={()=>{list.refetch();summary.refetch();}}><RefreshCw size={16} className={list.isFetching?'animate-spin':''}/></button>
    </div>
    {list.error&&<p role="alert" className="card p-4 text-red-600">{list.error.message}</p>}
    {list.isLoading&&<div className="card p-8 text-center muted">جارٍ التحميل…</div>}
    {!list.isLoading&&!items.length&&<div className="card p-10 text-center">
      <Inbox size={34} className="mx-auto mb-3 text-brand-600"/><h2 className="font-bold">صندوقك فارغ</h2>
      <p className="muted text-sm mt-2">عندما تكون حالتك «متاح» يصلك التفاعل التالي تلقائياً.</p></div>}
    <ul className="space-y-2.5">{items.map(i=><li key={i.id}><WorkCard item={i} now={now} warn={warn} selected={i.id===selected} onOpen={()=>onOpen(i.id)}/></li>)}</ul>
  </div>;
}

function WorkCard({item,now,warn,selected,onOpen,closed}:{item:QueueItem;now?:string;warn:number;selected:boolean;onOpen:()=>void;closed?:boolean}) {
  const story=item.interaction_type==='story';
  const since=item.assigned_at??item.entered_at;
  const late=!closed&&!!now&&item.status!=='escalated'&&Date.parse(now)-Date.parse(since)>=warn*60000;
  const sentiment=item.sentiment?SENTIMENT_LABELS[item.sentiment]:null;
  return <button className={`card queue-card ${selected?'is-selected':''}`} onClick={onOpen}
    aria-label={story?`فتح القصة: ${item.story_title??''}`:`فتح تفاعل ${item.display_name??item.username??''}`}>
    {story?<span className="alert-kind alert-kind--story !w-10 !h-10" aria-hidden="true"><Sparkles size={18}/></span>
      :<Avatar src={item.profile_image_url} name={item.display_name} username={item.username} size={40}/>}
    <span className="min-w-0 flex-1 space-y-1.5">
      <span className="flex flex-wrap items-center gap-2">
        <strong className="text-sm truncate max-w-[60%]">{story?item.story_title:item.display_name??item.username??'حساب غير متاح'}</strong>
        <span className={`queue-tag ${item.section==='general'?'':`queue-tag--${item.section}`}`}>{QUEUE_SECTION_LABELS[item.section].ar}</span>
        {item.priority==='high'&&<span className="queue-tag queue-tag--hold"><Flame size={11}/>أولوية عالية</span>}
        <span className="flex-1"/>
        {item.status==='escalated'&&<span className="queue-status-badge queue-status-badge--escalated">{QUEUE_STATUS_LABELS[item.status as QueueStatus]}</span>}
        {closed&&<span className="queue-status-badge queue-status-badge--completed">مغلق</span>}
      </span>
      <span className="queue-card-text block text-sm leading-7 line-clamp-2">{story?item.story_summary??'':item.text??'المصدر غير متاح — السجل التشغيلي محفوظ'}</span>
      <span className="queue-card-meta">
        <span className="inline-flex items-center gap-1.5"><span className="queue-dot" style={{background:item.program_snapshot.color||'var(--color-brand-500)'}}/>{item.program_snapshot.name}</span>
        {!story&&<span>النوع: {item.intent?INTENT_LABELS[item.intent]??item.intent:'—'}</span>}
        {!story&&<span>التصنيف: {item.topic_name??'غير مرتبط بموضوع'}</span>}
        {sentiment&&<span className={sentiment.cls}>{sentiment.text}</span>}
        {closed?<span>أُغلق {fmtRelative(item.completed_at??'')}</span>
          :<span className={late?'text-amber-600 font-semibold':''} title={late?`تجاوز ${warn} دقيقة (تنبيه بصري)`:undefined}>في صندوقك منذ {duration(since,now)}</span>}
      </span>
    </span>
  </button>;
}

function MyClosed({onOpen,selected}:{onOpen:(id:string)=>void;selected:string|null}) {
  const date=useDateRange('today');const warn=useCatalogWarn();
  const qs=`${date.apiQuery}&view=closed&limit=40`;
  const list=useInfiniteQuery({queryKey:['queue','items','closed',qs],initialPageParam:'',enabled:!date.error,
    queryFn:({pageParam})=>api.get<{items:QueueItem[];nextCursor:string|null}>(`/queue/items?${qs}${pageParam?'&cursor='+encodeURIComponent(pageParam):''}`),
    getNextPageParam:last=>last.nextCursor??undefined});
  const items=list.data?.pages.flatMap(p=>p.items)??[];
  return <div className="space-y-3">
    <div className="card p-3 flex flex-wrap items-center gap-3"><span className="text-sm font-bold">الفترة (دخول الطابور)</span><DateRangeFilter state={date}/></div>
    {list.isLoading&&<div className="card p-8 text-center muted">جارٍ التحميل…</div>}
    {!list.isLoading&&!items.length&&<div className="card p-8 text-center muted">لا توجد تفاعلات أغلقتها في هذه الفترة.</div>}
    <ul className="space-y-2.5">{items.map(i=><li key={i.id}><WorkCard item={i} warn={warn} closed selected={i.id===selected} onOpen={()=>onOpen(i.id)}/></li>)}</ul>
    {list.hasNextPage&&<button className="btn-ghost w-full" disabled={list.isFetchingNextPage} onClick={()=>list.fetchNextPage()}>تحميل المزيد</button>}
  </div>;
}

function MyPerformance() {
  const date=useDateRange('today');
  const {data,error,isLoading}=useQuery({queryKey:['workforce','me','perf',date.apiQuery],enabled:!date.error,
    queryFn:()=>api.get<import('../lib/workforce').MyWorkforce>(`/workforce/me?${date.apiQuery}`)});
  const p=data?.performance;const t=data?.time;
  const occupancy=data&&data.maxOpen?Math.round(data.open/data.maxOpen*100):null;
  return <div className="space-y-3">
    <div className="card p-3 flex flex-wrap items-center gap-3"><span className="text-sm font-bold">الفترة</span><DateRangeFilter state={date}/></div>
    {error&&<p role="alert" className="card p-4 text-red-600">{error.message}</p>}
    {isLoading&&<div className="card p-8 text-center muted">جارٍ التحميل…</div>}
    {p&&t&&<>
      <section className="card p-4"><h2 className="font-bold mb-3">إنجازي</h2>
        <div className="dash-stats">
          <Stat label="تفاعلات مغلقة" value={fmtNum(p.completedItems)} sub={`${fmtNum(p.completedCycles)} مراجعة مكتملة`}/>
          <Stat label="من الإسناد حتى الإغلاق" value={minutesText(p.avgAssignmentToCloseMin)} sub="متوسط — ليس وقت معالجة فعلي"/>
          <Stat label="انتظار الطابور" value={minutesText(p.avgQueueWaitMin)} sub={`لـ ${fmtNum(p.firstAssignedItems)} تفاعل وصلك أولاً`}/>
          <Stat label="أُعيد فتحه" value={fmtNum(p.reopened)} sub="من تفاعلات أغلقتها"/>
          <Stat label="صعّدته" value={fmtNum(p.escalated)}/>
          <Stat label="إشغال الصندوق الآن" value={occupancy==null?'—':`${occupancy}%`} sub={`أقدم مفتوح: ${minutesText(p.oldestOpenMin)}`}/>
        </div>
      </section>
      <section className="card p-4"><h2 className="font-bold mb-1">وقتي حسب الحالة</h2>
        <p className="text-xs muted mb-3">من سجلات الحالة بتوقيت الخادم، تُعرض بتوقيت الرياض. هذا وقت الحضور في النظام، لا ساعات الدوام المجدولة ولا الإنتاجية.</p>
        <div className="dash-stats">
          <Stat label="المسجل في النظام" value={hours(t.logged)} sub="كل الحالات عدا غير متصل"/>
          <Stat label="وقت العمل التشغيلي" value={hours(t.operational)} sub={data.operationalStatuses.map(statusLabel).join('، ')}/>
          <Stat label="متاح" value={hours(t.available)}/><Stat label="استراحة" value={hours(t.break)}/>
          <Stat label="اجتماع" value={hours(t.meeting)}/><Stat label="تدريب" value={hours(t.training)}/>
          <Stat label="خارج المكتب" value={hours(t.away)}/><Stat label="غير متصل" value={hours(t.offline)}/>
        </div>
        <p className="text-xs muted mt-3">الفترة: {fmtDateTime(data.range.from)} — {fmtDateTime(data.range.to)}</p>
      </section>
    </>}
  </div>;
}

function Stat({label,value,sub}:{label:string;value:string;sub?:string}) {
  return <div className="dash-stat"><span className="dash-stat-label">{label}</span><span className="dash-stat-value">{value}</span>{sub&&<span className="dash-stat-sub">{sub}</span>}</div>;
}
