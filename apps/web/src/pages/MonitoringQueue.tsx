import {useEffect,useState} from 'react';
import {useInfiniteQuery,useQuery} from '@tanstack/react-query';
import {useSearchParams,Link} from 'react-router-dom';
import {Inbox,RefreshCw,UsersRound,SlidersHorizontal,Rows3,Rows2,Sparkles,UserRound,MessagesSquare,TriangleAlert} from 'lucide-react';
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

const SECTION_ICON={general:MessagesSquare,influencer:UserRound,story:Sparkles} as const;
const FILTER_KEYS=['basis','programId','status','employeeId','teamId','classification','sentiment','source','search'] as const;
const pref=(key:string,fallback:string)=>{try{return localStorage.getItem(key)??fallback;}catch{return fallback;}};
const savePref=(key:string,value:string)=>{try{localStorage.setItem(key,value);}catch{/* private mode */}};

export default function MonitoringQueue() {
  const {can}=useAuth();const supervise=can(P.QUEUE_SUPERVISE,P.QUEUE_VIEW_ALL);
  const [params,setParams]=useSearchParams();const date=useDateRange('all');
  const [search,setSearch]=useState(params.get('search')??'');
  // Open by default on wide screens; on phones the list comes first.
  const [showFilters,setShowFilters]=useState(()=>pref('mip.queue.filters',window.innerWidth>=1100?'open':'closed')==='open');
  const [compact,setCompact]=useState(()=>pref('mip.queue.density','comfortable')==='compact');
  const set=(key:string,value:string,push=false)=>setParams(old=>{const next=new URLSearchParams(old);value?next.set(key,value):next.delete(key);return next;},{replace:!push});
  useEffect(()=>{const timer=setTimeout(()=>{if((params.get('search')??'')!==search)set('search',search);},350);return()=>clearTimeout(timer);},[search]);
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
    if(isStory&&['classification','sentiment','source'].includes(key))continue;
    if(params.get(key))base.set(key,params.get(key)!);
  }
  base.set('view',view);
  const summaryQs=base.toString();
  base.set('section',section);const qs=base.toString();
  const interval=supervise?20000:15000;
  const list=useInfiniteQuery({queryKey:['queue','items',qs],initialPageParam:'',
    queryFn:({pageParam})=>api.get<{items:QueueItem[];nextCursor:string|null}>(`/queue/items?${qs}${pageParam?'&cursor='+encodeURIComponent(pageParam):''}`),
    getNextPageParam:last=>last.nextCursor??undefined,enabled:!date.error,refetchInterval:interval,refetchIntervalInBackground:false});
  const summary=useQuery({queryKey:['queue','summary',summaryQs],queryFn:()=>api.get<QueueSummary>(`/queue/summary?${summaryQs}`),
    enabled:!date.error,refetchInterval:interval,refetchIntervalInBackground:false});
  const {data:options}=useQuery({queryKey:['queue-options'],queryFn:()=>api.get<QueueOptions>('/queue/options'),enabled:can(P.QUEUE_SUPERVISE)});
  const {data:catalog}=useQuery({queryKey:['programs'],queryFn:()=>api.get<{items:Array<{id:string;name_ar:string}>}>('/programs'),enabled:can(P.PROGRAMS_READ)&&!options});
  const {data:reviewCatalog}=useQuery({queryKey:['queue-review-catalog'],queryFn:()=>api.get<ReviewCatalog>('/queue/review-catalog')});
  const {data:alerts}=useQuery<AlertUnread>({queryKey:ALERTS_UNREAD_KEY,queryFn:()=>api.get<AlertUnread>('/queue/alerts'),staleTime:Infinity});

  const selected=params.get('item');const items=list.data?.pages.flatMap(p=>p.items)??[];
  const sections=summary.data?.sections;
  const tabCount=(s:QueueSection)=>{const c=sections?.[s];if(!c)return null;return supervise?c.new:c.assigned+c.in_progress+c.escalated;};
  const needsAction=sections?QUEUE_SECTIONS.reduce((n,s)=>n+(supervise?sections[s].new+sections[s].escalated:sections[s].assigned+sections[s].in_progress+sections[s].escalated),0):null;
  const counts=sections?.[section];
  const members=options?.members.filter((m,i,all)=>all.findIndex(n=>n.id===m.id)===i)??[];
  const refreshing=list.isFetching||summary.isFetching;
  // Cards tick every 30s from the server's clock (summary refreshes it).
  const now=useServerClock(summary.data?.serverNow,30000);const warnMinutes=reviewCatalog?.waitWarningMinutes??60;
  const updatedAt=list.dataUpdatedAt?new Date(Math.max(list.dataUpdatedAt,summary.dataUpdatedAt)).toISOString():null;

  return <div className="space-y-4">
    <header className="queue-header">
      <div className="min-w-0">
        <p className="eyebrow">MONITORING QUEUE</p>
        <h1 className="flex items-center gap-2"><Inbox size={22}/>{supervise?'طابور الرصد':'مهامي'}</h1>
      </div>
      {needsAction!==null&&<span className={`queue-chip ${needsAction?'queue-chip--action':''}`} title={supervise?'غير مسند أو مصعّد':'مسند إليك ولم يكتمل'}>
        {needsAction} {supervise?'بحاجة لإجراء':'بانتظارك'}</span>}
      {!!summary.data?.held&&<span className="queue-chip queue-chip--action"><TriangleAlert size={14}/>{summary.data.held} نقل بانتظار المراجعة</span>}
      <div className="flex-1"/>
      {updatedAt&&<span className="text-xs muted" aria-live="polite">آخر تحديث {fmtRelative(updatedAt)}</span>}
      <button className="icon-button" onClick={()=>{list.refetch();summary.refetch();}} aria-label="تحديث الطابور" disabled={refreshing}><RefreshCw size={17} className={refreshing?'animate-spin':''}/></button>
      <button className="icon-button" aria-pressed={compact} aria-label={compact?'عرض مريح':'عرض مضغوط'} title={compact?'عرض مريح':'عرض مضغوط'}
        onClick={()=>{setCompact(c=>{savePref('mip.queue.density',c?'comfortable':'compact');return !c;});}}>{compact?<Rows2 size={17}/>:<Rows3 size={17}/>}</button>
      <button className={showFilters?'btn-primary':'btn-ghost'} aria-expanded={showFilters} aria-controls="queue-filters"
        onClick={()=>setShowFilters(v=>{savePref('mip.queue.filters',v?'closed':'open');return !v;})}><SlidersHorizontal size={16}/>الفلاتر</button>
      {can(P.USERS_READ)&&<Link className="btn-ghost" to="/teams"><UsersRound size={16}/>الفرق</Link>}
    </header>

    <nav role="tablist" aria-label="أقسام الطابور" className="queue-tabs">
      {QUEUE_SECTIONS.map(s=>{const Icon=SECTION_ICON[s];const n=tabCount(s);const unread=s!=='general'?alerts?.unreadBySection[s]??0:0;
        return <button key={s} role="tab" aria-selected={s===section} className="queue-tab"
          onClick={()=>setParams(old=>{const next=new URLSearchParams(old);next.set('section',s);next.delete('item');if(s==='story'||section==='story')next.delete('status');return next;})}>
          <Icon size={16}/>{QUEUE_SECTION_LABELS[s].ar}
          {n!==null&&<span className="queue-tab-count" aria-label={`${n} ${supervise?'جديد':'مفتوح'}`}>{n}</span>}
          {unread>0&&<span className="queue-tab-unread" title={`${unread} تنبيه غير مقروء`} aria-label={`${unread} تنبيه غير مقروء`}/>}
        </button>;})}
    </nav>

    <div role="tablist" aria-label="قوائم العمل" className="flex flex-wrap gap-2">
      {([{key:'mine',label:'مهامي',count:summary.data?.views[section].mine},
        ...((supervise||reviewCatalog?.selfClaim)?[{key:'unassigned',label:'غير مسند',count:summary.data?.views[section].unassigned}]:[]),
        ...(supervise?[{key:'open',label:'كل المفتوح',count:counts?counts.new+counts.assigned+counts.in_progress+counts.escalated:undefined}]:[]),
        {key:'closed',label:'المغلق',count:summary.data?.views[section].closed}]).map(v=><button key={v.key} role="tab" aria-selected={view===v.key}
          className={view===v.key?'btn-primary':'btn-ghost'} onClick={()=>setParams(old=>{const next=new URLSearchParams(old);next.set('view',v.key);next.delete('status');next.delete('item');return next;})}>
          {v.label} <span>{v.count??'?'}</span></button>)}
    </div>

    <div className={`queue-layout ${showFilters?'':'is-collapsed'} ${compact?'queue-compact':''}`}>
      <section aria-label={`عناصر ${QUEUE_SECTION_LABELS[section].ar}`} className="space-y-2.5 min-w-0">
        {list.error&&<p role="alert" className="card p-4 text-red-600">{list.error.message}</p>}
        {list.isLoading&&<div className="card p-8 text-center muted">جارٍ التحميل…</div>}
        {!list.isLoading&&!list.error&&!items.length&&<div className="card p-10 text-center">
          <Inbox size={34} className="mx-auto mb-3 text-brand-600"/><h2 className="font-bold">لا توجد عناصر هنا</h2>
          <p className="muted text-sm mt-2">{isStory?'تظهر هنا القصص المعتمدة (بمصدرين مستقلين على الأقل) ضمن نطاقك.':section==='influencer'?'تظهر هنا تفاعلات الحسابات المؤثرة المتابَعة.':'تظهر هنا التفاعلات المناسبة لنطاقك والفلاتر المحددة.'}</p></div>}
        {items.map(item=><QueueCard key={item.id} item={item} supervise={supervise} now={now} warnMinutes={warnMinutes} selected={item.id===selected} onOpen={()=>set('item',item.id,true)}/>)}
        {list.hasNextPage&&<button className="btn-ghost w-full" disabled={list.isFetchingNextPage} onClick={()=>list.fetchNextPage()}>تحميل المزيد — الأقدم أولاً</button>}
      </section>

      {showFilters&&<aside id="queue-filters" className="queue-aside" aria-label="الفلاتر وعبء الموظفين">
        <div className="card p-4 space-y-3">
          <div className="flex items-center justify-between"><h2 className="font-bold text-sm">الفلاتر</h2>
            {FILTER_KEYS.some(k=>params.get(k))&&<button className="text-xs text-brand-600 underline" onClick={()=>{setSearch('');setParams(old=>{const next=new URLSearchParams(old);FILTER_KEYS.forEach(k=>next.delete(k));return next;},{replace:true});}}>مسح الكل</button>}</div>
          <label className="queue-field">بحث<input className="input" placeholder={isStory?'في عناوين القصص…':'في نص التفاعل…'} value={search} onChange={e=>setSearch(e.target.value)}/></label>
          <label className="queue-field">البرنامج<select className="input" value={params.get('programId')??''} onChange={e=>set('programId',e.target.value)}><option value="">كل البرامج</option>{(options?.programs??catalog?.items??[]).map(p=><option key={p.id} value={p.id}>{p.name_ar}</option>)}</select></label>
          <div className="queue-field">الفترة<DateRangeFilter state={date}/></div>
          <label className="queue-field">أساس الفترة<select className="input" value={params.get('basis')??'entered'} onChange={e=>set('basis',e.target.value==='entered'?'':e.target.value)}><option value="entered">دخول الطابور</option><option value="posted">{isStory?'أول ظهور':'تاريخ النشر'}</option></select></label>
          {!isStory&&<label className="queue-field">مصدر التفاعل<select className="input" value={params.get('source')??''} onChange={e=>set('source',e.target.value)}><option value="">كل المصادر (X)</option>{Object.entries(SOURCE_LABELS).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>}
          <label className="queue-field">حالة المعالجة<select className="input" value={params.get('status')??''} onChange={e=>set('status',e.target.value)}><option value="">كل الحالات</option>{QUEUE_STATUSES.map(s=><option key={s} value={s}>{QUEUE_STATUS_LABELS[s]}</option>)}</select></label>
          {supervise&&<><label className="queue-field">الموظف<select className="input" value={params.get('employeeId')??''} onChange={e=>set('employeeId',e.target.value)}><option value="">كل الموظفين</option>{members.map(m=><option key={m.id} value={m.id}>{m.full_name}</option>)}</select></label>
            <label className="queue-field">الفريق<select className="input" value={params.get('teamId')??''} onChange={e=>set('teamId',e.target.value)}><option value="">كل فرقي</option>{options?.teams.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label></>}
          {!isStory&&<><label className="queue-field">التصنيف<select className="input" value={params.get('classification')??''} onChange={e=>set('classification',e.target.value)}><option value="">كل التصنيفات</option>{Object.entries(INTENT_LABELS).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
            <label className="queue-field">المشاعر<select className="input" value={params.get('sentiment')??''} onChange={e=>set('sentiment',e.target.value)}><option value="">كل المشاعر</option>{Object.entries(SENTIMENT_LABELS).map(([k,v])=><option key={k} value={k}>{v.text}</option>)}</select></label></>}
        </div>
        {/* Short and always relevant to a supervisor, so it sits above the longer filter list. */}
        {supervise&&<div className="card p-4 order-first">
          <h2 className="font-bold text-sm mb-1">عبء الموظفين</h2>
          <p className="text-xs muted mb-2">بانتظار أو مصعّد · قيد المراجعة · مغلق اليوم دون تكرار</p>
          {!summary.data?.workload.length?<p className="text-xs muted">لا يوجد أعضاء في فرقك بعد.</p>:
          <ul className="queue-workload space-y-0.5">{summary.data.workload.map(w=><li key={w.id+w.team_id}>
            <button aria-pressed={params.get('employeeId')===w.id} onClick={()=>set('employeeId',params.get('employeeId')===w.id?'':w.id)}>
              <span className="min-w-0"><strong className="block text-sm truncate">{w.full_name}</strong><span className="block text-xs muted truncate">{w.team_name}</span></span>
              <span className="queue-workload-nums self-center"><span title="مفتوح">{w.open}</span><span className="text-(--status-info)" title="قيد العمل">{w.in_progress}</span><span className="text-emerald-600" title="مكتمل اليوم">{w.completed_today}</span></span>
            </button></li>)}</ul>}
        </div>}
      </aside>}
    </div>
    {selected&&<QueueDrawer key={selected} id={selected} onClose={()=>set('item','',true)}/>}
  </div>;
}

function QueueCard({item,supervise,now,warnMinutes,selected,onOpen}:{item:QueueItem;supervise:boolean;now?:string;warnMinutes:number;selected:boolean;onOpen:()=>void}) {
  const story=item.interaction_type==='story';
  const timer=workTimer(item,now,warnMinutes);
  const sentiment=item.sentiment?SENTIMENT_LABELS[item.sentiment]:null;
  const label=story?`فتح القصة: ${item.story_title??''}`:`فتح تفاعل ${item.display_name??item.username??''}`;
  return <button className={`card queue-card ${selected?'is-selected':''}`} onClick={onOpen} aria-label={label}>
    {story?<span className="alert-kind alert-kind--story !w-10 !h-10" aria-hidden="true"><Sparkles size={18}/></span>
      :<Avatar src={item.profile_image_url} name={item.display_name} username={item.username} size={40}/>}
    <span className="min-w-0 flex-1 space-y-1.5">
      <span className="flex flex-wrap items-center gap-2">
        <strong className="text-sm truncate max-w-[60%]">{story?item.story_title:item.display_name??item.username??'حساب غير متاح'}</strong>
        {!story&&item.username&&<span className="text-xs muted" dir="ltr">@{item.username}</span>}
        {item.section==='influencer'&&<span className="queue-tag queue-tag--influencer"><UserRound size={11}/>مؤثر{item.followers_count?` · ${fmtCompact(item.followers_count)}`:''}</span>}
        {story&&item.story_state&&<span className={`queue-tag ${item.story_state==='rising'?'queue-tag--hold':'queue-tag--story'}`}>{STORY_STATE_LABELS[item.story_state]??item.story_state}</span>}
        {!story&&item.parent_story_title&&<span className="queue-tag queue-tag--story" title="هذا التفاعل ضمن قصة"><Sparkles size={11}/>ضمن قصة: {item.parent_story_title}</span>}
        {item.section_hold&&<span className="queue-tag queue-tag--hold"><TriangleAlert size={11}/>نقل بانتظار المراجعة</span>}
        <span className="flex-1"/>
        <span className={`queue-status-badge queue-status-badge--${item.status}`}>{QUEUE_STATUS_LABELS[item.status as QueueStatus]}</span>
      </span>
      <span className="queue-card-text block text-sm leading-7 line-clamp-2">{story?item.story_summary??'':item.text??'المصدر غير متاح — السجل التشغيلي محفوظ'}</span>
      <span className="queue-card-meta">
        <span className="inline-flex items-center gap-1.5"><span className="queue-dot" style={{background:item.program_snapshot.color||'var(--color-brand-500)'}}/>{item.program_snapshot.name}</span>
        {story?<>
          <span>{item.story_post_count??0} تفاعل{item.story_active_items?` · ${item.story_active_items} قيد المتابعة`:''}</span>
          {item.story_first_seen_at&&<span>أول ظهور {fmtDateTime(item.story_first_seen_at)}</span>}
          {item.story_last_seen_at&&<span>آخر نشاط {fmtRelative(item.story_last_seen_at)}</span>}
        </>:<>
          <span>X · {SOURCE_LABELS[sourceOf(item)]}</span>
          {item.post_posted_at&&<span>نُشر {fmtDateTime(item.post_posted_at)}</span>}
          {item.intent&&<span>{INTENT_LABELS[item.intent]??item.intent}</span>}
          {sentiment&&<span className={sentiment.cls}>{sentiment.text}</span>}
        </>}
        {timer&&<span className={timer.warn?'text-amber-600 font-semibold':''} title={timer.warn?`تجاوز ${warnMinutes} دقيقة (تنبيه بصري)`:undefined}>{timer.label} {timer.text}</span>}
        {item.status==='completed'&&item.completed_at&&<span>أُغلق {fmtRelative(item.completed_at)}</span>}
        {(supervise||item.assignee_name)&&<span>{item.assignee_name?`المسؤول: ${item.assignee_name}`:'غير مسند'}{supervise?` · ${item.team_name}`:''}</span>}
      </span>
    </span>
  </button>;
}
