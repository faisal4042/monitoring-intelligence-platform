import {useBrowsingParams} from '../lib/useBrowsingParams';
import {useEffect,useState} from 'react';
import QueueDraftNotice from '../components/QueueDraftNotice';
import CursorPager from '../components/CursorPager';
import {changedFilters,uniqueRows,navigateTabs} from '../lib/data-browsing';
import {useCursorNavigation} from '../lib/useCursorNavigation';
import {useLocation} from 'react-router-dom';
import {useQuery} from '@tanstack/react-query';
import {Link} from 'react-router-dom';
import {Inbox,RefreshCw,UsersRound,SlidersHorizontal,Rows3,Rows2,Sparkles,UserRound,MessagesSquare,TriangleAlert,MonitorDot,Settings2,Flame} from 'lucide-react';
import {PERMISSIONS as P,QUEUE_SECTIONS,QUEUE_SECTION_LABELS,QUEUE_STATUSES,QUEUE_STATUS_LABELS,type QueueSection,type QueueStatus} from '@mip/shared';
import {api} from '../lib/api';
import {useAuth} from '../lib/auth';
import {INTENT_LABELS,SENTIMENT_LABELS,SOURCE_LABELS,STORY_STATE_LABELS,sourceOf,useServerClock,workTimer,type AlertUnread,type QueueItem,type QueueOptions,type QueueSummary,type ReviewCatalog} from '../lib/queue';
import {fmtCompact,fmtDateTime,fmtRelative} from '../lib/format';
import {useDateRange} from '../lib/useDateRange';
import DateRangeFilter from '../components/DateRangeFilter';
import QueueDrawer from '../components/QueueDrawer';
import Avatar from '../components/Avatar';
import {ALERTS_UNREAD_KEY} from '../components/AlertCenter';
import AgentWorkspace from './AgentWorkspace';
import {statusLabel} from '../lib/workforce';
import InteractionCard from '../components/queue/InteractionCard';
import {SOURCE_KIND_LABELS,SourceBadge,SourceFilter,SourceIcon,TicketNumbers,isSourceCard,sourceKeyOf,sourceOrigin,sourceText,sourceTitle} from '../components/queue/SourceParts';

import { Button } from '../components/ui/Button';
const SECTION_ICON={general:MessagesSquare,influencer:UserRound,story:Sparkles} as const;
const FILTER_KEYS=['basis','programId','status','employeeId','teamId','classification','sentiment','source','search','kind'] as const;
const pref=(key:string,fallback:string)=>{try{return localStorage.getItem(key)??fallback;}catch{return fallback;}};
const savePref=(key:string,value:string)=>{try{localStorage.setItem(key,value);}catch{/* private mode */}};

export default function MonitoringQueue() {
  const {can}=useAuth();
  // Agents get their own workspace (box, closed, performance); supervisors the team queue.
  return can(P.QUEUE_SUPERVISE,P.QUEUE_VIEW_ALL)?<SupervisorQueue/>:can(P.QUEUE_WORK)?<AgentWorkspace/>:<p role="alert">لا تملك صلاحية استعراض الطابور.</p>;
}

function SupervisorQueue() {
  const {can}=useAuth();const supervise=true;
  const [params,setParams]=useBrowsingParams();const location=useLocation();const date=useDateRange(undefined,{resetKeys:['page','cursor','item']});
  const [search,setSearch]=useState(params.get('search')??'');
  // Open by default on wide screens; on phones the list comes first.
  const [showFilters,setShowFilters]=useState(()=>pref('mip.queue.filters',window.innerWidth>=1100?'open':'closed')==='open');
  const [compact,setCompact]=useState(()=>pref('mip.queue.density','comfortable')==='compact');
  const set=(key:string,value:string,push=true)=>setParams(old=>{if(key!=='item')return changedFilters(old,{[key]:value});const next=new URLSearchParams(old);value?next.set(key,value):next.delete(key);return next;},{replace:!push,state:key==='item'?location.state:undefined});
  // Back/forward restores the search box too.
  useEffect(()=>{setSearch(params.get('search')??'');},[params.get('search')]);

  const sectionParam=params.get('section');
  const section:QueueSection=(QUEUE_SECTIONS as readonly string[]).includes(sectionParam??'')?sectionParam as QueueSection:'general';
  const isStory=section==='story';
  const rawView=params.get('view');
  const view=rawView==='completed'?'closed':rawView??(supervise?'open':'mine');
  const base=new URLSearchParams(date.apiQuery);
  for(const key of FILTER_KEYS){
    // Interaction-only filters never apply to story cards.
    if(isStory&&['classification','sentiment','source','kind'].includes(key))continue;
    if(params.get(key))base.set(key,params.get(key)!);
  }
  base.set('view',view);
  const summaryQs=base.toString();
  base.set('section',section);const qs=base.toString();
  const interval=supervise?20000:15000;
  const navigation=useCursorNavigation('supervisor:'+qs);
  const list=useQuery({queryKey:['queue','items',qs,navigation.cursor],
    queryFn:({signal})=>api.get<{items:QueueItem[];nextCursor:string|null}>(`/queue/items?${qs}&limit=40${navigation.cursor?'&cursor='+encodeURIComponent(navigation.cursor):''}`,signal),
    enabled:!date.error,refetchInterval:interval,refetchIntervalInBackground:false});
  const summary=useQuery({queryKey:['queue','summary',summaryQs],queryFn:()=>api.get<QueueSummary>(`/queue/summary?${summaryQs}`),
    enabled:!date.error,refetchInterval:interval,refetchIntervalInBackground:false});
  const {data:options}=useQuery({queryKey:['queue-options'],queryFn:()=>api.get<QueueOptions>('/queue/options'),enabled:can(P.QUEUE_SUPERVISE)});
  const {data:catalog}=useQuery({queryKey:['programs'],queryFn:()=>api.get<{items:Array<{id:string;name_ar:string}>}>('/programs'),enabled:can(P.PROGRAMS_READ)&&!options});
  const {data:reviewCatalog}=useQuery({queryKey:['queue-review-catalog'],queryFn:()=>api.get<ReviewCatalog>('/queue/review-catalog')});
  const {data:alerts}=useQuery<AlertUnread>({queryKey:ALERTS_UNREAD_KEY,queryFn:()=>api.get<AlertUnread>('/queue/alerts'),staleTime:Infinity});

  const selected=params.get('item');const items=uniqueRows(list.data?.items??[]);
  const sections=summary.data?.sections;
  // Each section tab counts the selected work view, so the tab and the list below never disagree.
  const tabCount=(s:QueueSection)=>{const c=sections?.[s];const v=summary.data?.views[s];if(!c||!v)return null;
    return view==='mine'?v.mine:view==='unassigned'?v.unassigned:view==='closed'?v.closed:c.new+c.assigned+c.in_progress+c.escalated;};
  const VIEW_NOUN:Record<string,string>={mine:'من مهامي',unassigned:'غير مسند',open:'مفتوح',closed:'مغلق'};
  const needsAction=sections?QUEUE_SECTIONS.reduce((n,s)=>n+(supervise?sections[s].new+sections[s].escalated:sections[s].assigned+sections[s].in_progress+sections[s].escalated),0):null;
  const counts=sections?.[section];
  const members=options?.members.filter((m,i,all)=>all.findIndex(n=>n.id===m.id)===i)??[];
  const refreshing=list.isFetching||summary.isFetching;
  // Cards tick every 30s from the server's clock (summary refreshes it).
  const now=useServerClock(summary.data?.serverNow,30000);const warnMinutes=reviewCatalog?.waitWarningMinutes??60;
  const updatedAt=list.dataUpdatedAt?new Date(Math.max(list.dataUpdatedAt,summary.dataUpdatedAt)).toISOString():null;

  return <div className="space-y-4" dir="rtl"><QueueDraftNotice/>
    <header className="queue-header">
      <div className="min-w-0">
        <p className="eyebrow">العمل اليومي</p>
        <h1 className="flex items-center gap-2"><Inbox size={22}/>{supervise?'طابور الرصد':'مهامي'}</h1>
      </div>
      {needsAction!==null&&<span className={`queue-chip ${needsAction?'queue-chip--action':''}`} title={supervise?'غير مسند أو مصعّد':'مسند إليك ولم يكتمل'}>
        {needsAction} {supervise?'غير مسند أو مصعّد':'بانتظارك'}</span>}
      {!!summary.data?.held&&<span className="queue-chip queue-chip--action"><TriangleAlert size={14}/>{summary.data.held} نقل بانتظار المراجعة</span>}
      <div className="flex-1"/>
      {updatedAt&&<span className="text-xs muted" aria-live="polite">آخر تحديث {fmtRelative(updatedAt)}</span>}
      <button className="icon-button" onClick={()=>{list.refetch();summary.refetch();}} aria-label="تحديث الطابور" disabled={refreshing}><RefreshCw size={17} className={refreshing?'animate-spin':''}/></button>
      <button className="icon-button" aria-pressed={compact} aria-label={compact?'عرض مريح':'عرض مضغوط'} title={compact?'عرض مريح':'عرض مضغوط'}
        onClick={()=>{setCompact(c=>{savePref('mip.queue.density',c?'comfortable':'compact');return !c;});}}>{compact?<Rows2 size={17}/>:<Rows3 size={17}/>}</button>
      <button className={showFilters?'btn-primary':'btn-ghost'} aria-expanded={showFilters} aria-controls="queue-filters"
        onClick={()=>setShowFilters(v=>{savePref('mip.queue.filters',v?'closed':'open');return !v;})}><SlidersHorizontal size={16}/>الفلاتر</button>
      <Link className="btn-ghost queue-header-link" to="/queue/board"><MonitorDot size={16}/>لوحة الفرق</Link>
      <Link className="btn-ghost queue-header-link" to="/queue/settings"><Settings2 size={16}/>إعدادات الموظفين</Link>
      {can(P.USERS_READ)&&<Link className="btn-ghost queue-header-link" to="/teams"><UsersRound size={16}/>الفرق</Link>}
    </header>

    <nav onKeyDown={navigateTabs} role="tablist" aria-label="أقسام الطابور" className="queue-tabs">
      {QUEUE_SECTIONS.map(s=>{const Icon=SECTION_ICON[s];const n=tabCount(s);const unread=s!=='general'?alerts?.unreadBySection[s]??0:0;
        return <button key={s} role="tab" aria-selected={s===section} className="queue-tab"
          onClick={()=>setParams(old=>{const next=new URLSearchParams(old);next.set('section',s);next.delete('item');next.delete('cursor');next.delete('page');if(s==='story'||section==='story')next.delete('status');return next;})}>
          <Icon size={16}/>{QUEUE_SECTION_LABELS[s].ar}
          {n!==null&&<span className="queue-tab-count" aria-label={`${n} ${VIEW_NOUN[view]??''}`}>{n}</span>}
          {unread>0&&<span className="queue-tab-unread" title={`${unread} تنبيه غير مقروء`} aria-label={`${unread} تنبيه غير مقروء`}/>}
        </button>;})}
    </nav>

    <div onKeyDown={navigateTabs} role="tablist" aria-label="قوائم العمل" className="flex flex-wrap gap-2">
      {([{key:'mine',label:'مهامي',count:summary.data?.views[section].mine},
        ...((supervise||reviewCatalog?.selfClaim)?[{key:'unassigned',label:'غير مسند',count:summary.data?.views[section].unassigned}]:[]),
        ...(supervise?[{key:'open',label:'كل المفتوح',count:counts?counts.new+counts.assigned+counts.in_progress+counts.escalated:undefined}]:[]),
        {key:'closed',label:'المغلق',count:summary.data?.views[section].closed}]).map(v=><button key={v.key} role="tab" aria-selected={view===v.key}
          className={view===v.key?'btn-primary':'btn-ghost'} onClick={()=>setParams(old=>{const next=new URLSearchParams(old);next.set('view',v.key);next.delete('status');next.delete('item');next.delete('cursor');next.delete('page');return next;})}>
          {v.label} <span>{v.count??'?'}</span></button>)}
    </div>
    {!isStory&&<SourceFilter value={params.get('kind')??''} onChange={kinds=>set('kind',kinds)} withStories={false}/>}

    <div className={`queue-layout ${showFilters?'':'is-collapsed'} ${compact?'queue-compact':''}`}>
      <section aria-label={`عناصر ${QUEUE_SECTION_LABELS[section].ar}`} className="space-y-2.5 min-w-0">
        {date.error&&<p role="alert">{date.error}</p>}
        {summary.error&&<p role="alert" className="card p-4">تعذر تحميل أعداد الطابور: {summary.error.message}<Button variant="ghost" type="submit" onClick={()=>summary.refetch()}>إعادة تحميل الأعداد</Button></p>}
        {list.error&&<p role="alert" className="card p-4 text-(--status-danger)">{list.error.message}<Button variant="ghost" type="submit" onClick={()=>list.refetch()}>إعادة المحاولة</Button></p>}
        {list.isLoading&&<div className="card p-8 text-center muted">جارٍ التحميل…</div>}
        {list.isSuccess&&!items.length&&<div className="card p-10 text-center">
          <Inbox size={34} className="mx-auto mb-3 text-brand-600"/><h2 className="font-bold">لا توجد عناصر هنا</h2>
          <p className="muted text-sm mt-2">{isStory?'تظهر هنا القصص المعتمدة (بمصدرين مستقلين على الأقل) ضمن نطاقك.':section==='influencer'?'تظهر هنا تفاعلات الحسابات المؤثرة المتابَعة.':'تظهر هنا التفاعلات المناسبة لنطاقك والفلاتر المحددة.'}</p></div>}
        {items.map(item=><QueueCard key={item.id} item={item} supervise={supervise} now={now} warnMinutes={warnMinutes} selected={item.id===selected} onOpen={()=>set('item',item.id,true)}/>)}
        <CursorPager shown={items.length} total={!summary.error?tabCount(section):null} {...navigation} nextCursor={list.data?.nextCursor} busy={list.isFetching} error={!!list.error||!!date.error} onNext={()=>navigation.next(list.data!.nextCursor!)} onPrevious={navigation.previous} onFirst={navigation.first}/>
      </section>

      {showFilters&&<aside id="queue-filters" className="queue-aside" aria-label="الفلاتر وعبء الموظفين">
        <div className="card p-4 space-y-3">
          <div className="flex items-center justify-between"><h2 className="font-bold text-sm">الفلاتر</h2>
            {FILTER_KEYS.some(k=>params.get(k))&&<button className="text-xs text-brand-600 underline" onClick={()=>{setSearch('');setParams(old=>{const next=new URLSearchParams(old);FILTER_KEYS.forEach(k=>next.delete(k));next.delete('page');next.delete('cursor');next.delete('item');return next;});}}>مسح الكل</button>}</div>
          <form onSubmit={e=>{e.preventDefault();set('search',search.trim());}}><label className="queue-field">بحث<input className="input" maxLength={200} placeholder={isStory?'في عناوين القصص…':'في نص التفاعل…'} value={search} onChange={e=>setSearch(e.target.value)}/></label><Button variant="ghost" type="submit">تطبيق البحث</Button>{search!==(params.get('search')??'')&&<p className="text-xs muted">اضغط تطبيق البحث لعرض نتائج النص الجديد.</p>}</form>
          <label className="queue-field">البرنامج<select className="input" value={params.get('programId')??''} onChange={e=>set('programId',e.target.value)}><option value="">كل البرامج</option>{(options?.programs??catalog?.items??[]).map(p=><option key={p.id} value={p.id}>{p.name_ar}</option>)}</select></label>
          <div className="queue-field">الفترة<DateRangeFilter state={date}/></div>
          <label className="queue-field">أساس الفترة<select className="input" value={params.get('basis')??'entered'} onChange={e=>set('basis',e.target.value==='entered'?'':e.target.value)}><option value="entered">دخول الطابور</option><option value="posted">{isStory?'أول ظهور':'تاريخ النشر'}</option></select></label>
          {!isStory&&<label className="queue-field">مصدر التفاعل<select className="input" value={params.get('source')??''} onChange={e=>set('source',e.target.value)}><option value="">كل المصادر (إكس)</option>{Object.entries(SOURCE_LABELS).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>}
          <label className="queue-field">حالة المعالجة<select className="input" value={params.get('status')??''} onChange={e=>set('status',e.target.value)}><option value="">كل الحالات</option>{QUEUE_STATUSES.map(s=><option key={s} value={s}>{QUEUE_STATUS_LABELS[s]}</option>)}</select></label>
          {supervise&&<><label className="queue-field">الموظف<select className="input" value={params.get('employeeId')??''} onChange={e=>set('employeeId',e.target.value)}><option value="">كل الموظفين</option>{members.map(m=><option key={m.id} value={m.id}>{m.full_name}</option>)}</select></label>
            <label className="queue-field">الفريق<select className="input" value={params.get('teamId')??''} onChange={e=>set('teamId',e.target.value)}><option value="">كل فرقي</option>{options?.teams.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label></>}
          {!isStory&&<><label className="queue-field">التصنيف<select className="input" value={params.get('classification')??''} onChange={e=>set('classification',e.target.value)}><option value="">كل التصنيفات</option>{Object.entries(INTENT_LABELS).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
            <label className="queue-field">المشاعر<select className="input" value={params.get('sentiment')??''} onChange={e=>set('sentiment',e.target.value)}><option value="">كل المشاعر</option>{Object.entries(SENTIMENT_LABELS).map(([k,v])=><option key={k} value={k}>{v.text}</option>)}</select></label></>}
        </div>
        {/* Short and always relevant to a supervisor, so it sits above the longer filter list. */}
        {supervise&&<div className="card p-4 order-first">
          <h2 className="font-bold text-sm mb-1">عبء الموظفين</h2>
          <p className="text-xs muted mb-2">في الصندوق · مصعّد · مغلق اليوم دون تكرار</p>
          {!summary.data?.workload.length?<p className="text-xs muted">لا يوجد أعضاء في فرقك بعد.</p>:
          <ul className="queue-workload space-y-0.5">{summary.data.workload.map(w=><li key={w.id+w.team_id}>
            <button aria-pressed={params.get('employeeId')===w.id} onClick={()=>set('employeeId',params.get('employeeId')===w.id?'':w.id)}>
              <span className="min-w-0"><strong className="block text-sm truncate">{w.full_name}</strong><span className="block text-xs muted truncate"><span className={`agent-status-dot agent-status--${w.agent_status}`} aria-hidden="true"/> {statusLabel(w.agent_status)} · {w.team_name}</span></span>
              <span className="queue-workload-nums self-center"><span title="في الصندوق">{w.open}</span><span className="text-(--status-danger)" title="مصعّد">{w.escalated}</span><span className="text-(--status-success)" title="مكتمل اليوم">{w.completed_today}</span></span>
            </button></li>)}</ul>}
        </div>}
      </aside>}
    </div>
    {selected&&<QueueDrawer key={selected} id={selected} onClose={()=>set('item','',true)}/>}
  </div>;
}

function QueueCard({item,now,warnMinutes,selected,onOpen}:{item:QueueItem;supervise:boolean;now?:string;warnMinutes:number;selected:boolean;onOpen:()=>void}) {
  return <InteractionCard item={item} now={now} warnMinutes={warnMinutes} selected={selected} onOpen={onOpen}/>;
}
