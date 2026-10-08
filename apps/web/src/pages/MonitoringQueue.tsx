import {useEffect,useState} from 'react';
import {useInfiniteQuery,useQuery} from '@tanstack/react-query';
import {useSearchParams,Link} from 'react-router-dom';
import {Inbox,RefreshCw,UsersRound} from 'lucide-react';
import {PERMISSIONS as P,QUEUE_STATUSES,QUEUE_STATUS_LABELS,type QueueStatus} from '@mip/shared';
import {api} from '../lib/api';
import {useAuth} from '../lib/auth';
import {duration,type QueueItem,type QueueOptions,type QueueSummary} from '../lib/queue';
import {fmtDateTime} from '../lib/format';
import {useDateRange} from '../lib/useDateRange';
import DateRangeFilter from '../components/DateRangeFilter';
import QueueDrawer from '../components/QueueDrawer';

export default function MonitoringQueue() {
  const {can}=useAuth();const supervise=can(P.QUEUE_SUPERVISE,P.QUEUE_VIEW_ALL);
  const [params,setParams]=useSearchParams();const date=useDateRange('all');
  const [search,setSearch]=useState(params.get('search')??'');
  const [,tick]=useState(0);
  useEffect(()=>{const timer=setInterval(()=>{if(!document.hidden)tick(n=>n+1);},15000);return()=>clearInterval(timer);},[]);
  const set=(key:string,value:string)=>setParams(old=>{const next=new URLSearchParams(old);value?next.set(key,value):next.delete(key);return next;},{replace:true});
  useEffect(()=>{const timer=setTimeout(()=>set('search',search),350);return()=>clearTimeout(timer);},[search]);
  const view=params.get('view')??(supervise?'all':'open');
  const query=new URLSearchParams(date.apiQuery);
  for(const key of ['basis','programId','status','employeeId','teamId','classification','sentiment','search'])if(params.get(key))query.set(key,params.get(key)!);
  query.set('view',view);
  const qs=query.toString();const interval=supervise?20000:15000;
  const list=useInfiniteQuery({queryKey:['queue','items',qs],initialPageParam:'',
    queryFn:({pageParam})=>api.get<{items:QueueItem[];nextCursor:string|null}>(`/queue/items?${qs}${pageParam?'&cursor='+encodeURIComponent(pageParam):''}`),
    getNextPageParam:last=>last.nextCursor??undefined,enabled:!date.error,refetchInterval:interval,refetchIntervalInBackground:false});
  const {data:summary}=useQuery({queryKey:['queue','summary',qs],queryFn:()=>api.get<QueueSummary>(`/queue/summary?${qs}`),enabled:!date.error,refetchInterval:interval,refetchIntervalInBackground:false});
  const {data:options}=useQuery({queryKey:['queue-options'],queryFn:()=>api.get<QueueOptions>('/queue/options'),enabled:can(P.QUEUE_SUPERVISE)});
  const {data:catalog}=useQuery({queryKey:['programs'],queryFn:()=>api.get<{items:Array<{id:string;name_ar:string}>}>('/programs'),enabled:can(P.PROGRAMS_READ)&&!supervise});
  const selected=params.get('item');const items=list.data?.pages.flatMap(p=>p.items)??[];
  return <div className="space-y-5">
    <div className="page-heading"><div><p className="eyebrow">MONITORING QUEUE</p><h1 className="flex items-center gap-2"><Inbox size={24}/>{supervise?'طابور الرصد':'مهامي — My Queue'}</h1><p>{supervise?'توزيع التفاعلات ومتابعة عبء الفريق، من الدخول حتى الإكمال.':'تفاعلاتك المسندة فقط. افتح العنصر ثم اضغط بدء العمل.'}</p></div><div className="flex gap-2">{can(P.USERS_READ)&&<Link className="btn-ghost" to="/teams"><UsersRound size={16}/>الفرق</Link>}<button className="btn-ghost" onClick={()=>list.refetch()} aria-label="تحديث الطابور"><RefreshCw size={17}/></button></div></div>
    {supervise&&<div className="grid grid-cols-2 lg:grid-cols-5 gap-3">{QUEUE_STATUSES.map(s=><button key={s} onClick={()=>{set('status',params.get('status')===s?'':s);}} className={`card p-4 text-start ${params.get('status')===s?'ring-2 ring-brand-500':''}`}><span className="text-xs muted">{QUEUE_STATUS_LABELS[s]}</span><strong className={`block text-3xl mt-2 num ${s==='escalated'?'text-amber-600':s==='completed'?'text-emerald-600':''}`}>{summary?.counts[s]??0}</strong></button>)}</div>}
    {!supervise&&<div role="tablist" aria-label="قوائم عملي" className="flex gap-2"><button role="tab" aria-selected={view==='open'} className={view==='open'?'btn-primary':'btn-ghost'} onClick={()=>set('view','open')}>مهامي المفتوحة</button><button role="tab" aria-selected={view==='completed'} className={view==='completed'?'btn-primary':'btn-ghost'} onClick={()=>set('view','completed')}>أكملتها سابقاً</button></div>}
    <div className="card p-4 flex flex-wrap gap-3 items-center">
      <input aria-label="البحث في الطابور" className="input max-w-64" placeholder="بحث في نص التفاعل…" value={search} onChange={e=>setSearch(e.target.value)}/>
      <select aria-label="حالة العنصر" className="input max-w-40" value={params.get('status')??''} onChange={e=>set('status',e.target.value)}><option value="">كل الحالات</option>{QUEUE_STATUSES.map(s=><option key={s} value={s}>{QUEUE_STATUS_LABELS[s]}</option>)}</select>
      <select aria-label="البرنامج" className="input max-w-44" value={params.get('programId')??''} onChange={e=>set('programId',e.target.value)}><option value="">كل البرامج</option>{(options?.programs??catalog?.items??[]).map(p=><option key={p.id} value={p.id}>{p.name_ar}</option>)}</select>
      {supervise&&<><select aria-label="الفريق" className="input max-w-44" value={params.get('teamId')??''} onChange={e=>set('teamId',e.target.value)}><option value="">كل فرقي</option>{options?.teams.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select><select aria-label="الموظف" className="input max-w-44" value={params.get('employeeId')??''} onChange={e=>set('employeeId',e.target.value)}><option value="">كل الموظفين</option>{options?.members.filter((m,i,all)=>all.findIndex(n=>n.id===m.id)===i).map(m=><option key={m.id} value={m.id}>{m.full_name}</option>)}</select>
        <select aria-label="التصنيف" className="input max-w-40" value={params.get('classification')??''} onChange={e=>set('classification',e.target.value)}><option value="">كل التصنيفات</option>{['inquiry','complaint','praise','suggestion','news','experience','warning','issue','request','other'].map(s=><option key={s}>{s}</option>)}</select>
        <select aria-label="المشاعر" className="input max-w-40" value={params.get('sentiment')??''} onChange={e=>set('sentiment',e.target.value)}><option value="">كل المشاعر</option>{['positive','very_positive','neutral','negative','very_negative'].map(s=><option key={s}>{s}</option>)}</select></>}
      <DateRangeFilter state={date}/><select aria-label="أساس الفترة" className="input max-w-40" value={params.get('basis')??'entered'} onChange={e=>set('basis',e.target.value)}><option value="entered">تاريخ دخول الطابور</option><option value="posted">تاريخ النشر</option></select>
    </div>
    {supervise&&!!summary?.workload.length&&<section className="card p-4"><h2 className="font-bold mb-3">عبء الموظفين</h2><div className="flex gap-3 flex-wrap">{summary.workload.map(w=><button key={w.id+w.team_id} className="rounded-lg bg-slate-500/5 px-4 py-3 text-start" onClick={()=>set('employeeId',w.id)}><strong className="text-sm">{w.full_name}</strong><p className="text-xs muted">{w.team_name}</p><div className="mt-2 text-sm">{w.open} مفتوح <span className="mx-2 muted">·</span><span className="text-emerald-600">{w.completed_today} مكتمل اليوم</span></div></button>)}</div></section>}
    {list.error&&<p role="alert" className="card p-4 text-red-600">{list.error.message}</p>}
    {list.isLoading&&<div className="card p-8 text-center muted">جارٍ التحميل…</div>}
    {!list.isLoading&&!list.error&&!items.length&&<div className="card p-12 text-center"><Inbox size={38} className="mx-auto mb-4 text-brand-500"/><h2 className="font-bold">لا توجد تفاعلات في هذه القائمة</h2><p className="muted text-sm mt-2">ستظهر العناصر المناسبة لنطاقك والفلاتر المحددة هنا.</p></div>}
    <div className="space-y-3">{items.map(item=><button key={item.id} className="card p-4 w-full text-start hover:border-brand-500 transition-colors" onClick={()=>set('item',item.id)} aria-label={`فتح التفاعل ${item.id}`}>
      <div className="flex flex-wrap justify-between gap-2 mb-2"><div className="flex gap-2 items-center"><span className="badge bg-brand-500/10 text-brand-600">{QUEUE_STATUS_LABELS[item.status as QueueStatus]}</span><span className="text-xs font-bold">{item.program_snapshot.name}</span></div><span className="text-xs muted">انتظار الإسناد {duration(item.entered_at,item.first_assigned_at??undefined)}</span></div>
      <p className="line-clamp-2 leading-7">{item.text??'المصدر غير متاح — السجل التشغيلي محفوظ'}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-xs muted"><span>{item.display_name??item.username??'حساب غير متاح'}</span><span>نُشر {fmtDateTime(item.post_posted_at)}</span><span>دخول {fmtDateTime(item.entered_at)}</span><span>{item.intent??'غير مصنف'} · {item.sentiment??'مشاعر غير محددة'}</span>{supervise&&<span>{item.assignee_name??'غير مسند'} · {item.team_name}</span>}</div>
    </button>)}</div>
    {list.hasNextPage&&<button className="btn-ghost w-full" disabled={list.isFetchingNextPage} onClick={()=>list.fetchNextPage()}>تحميل المزيد — الأقدم أولاً</button>}
    {selected&&<QueueDrawer key={selected} id={selected} onClose={()=>set('item','')}/>}
  </div>;
}
