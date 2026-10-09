import {useState} from 'react';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {Link,useSearchParams} from 'react-router-dom';
import {MonitorDot,RefreshCw,X,History,Settings2} from 'lucide-react';
import {AGENT_STATUSES,PERMISSIONS as P,QUEUE_SECTION_LABELS,STATUS_SOURCE_LABELS,type AgentStatus,type QueueSection} from '@mip/shared';
import {api} from '../lib/api';
import {useAuth} from '../lib/auth';
import {duration,useServerClock,type QueueOptions} from '../lib/queue';
import {hours,minutesText,statusLabel,type Board,type BoardAgent} from '../lib/workforce';
import {fmtDateTime,fmtNum} from '../lib/format';
import {useDateRange} from '../lib/useDateRange';
import DateRangeFilter from '../components/DateRangeFilter';

/**
 * Operational board for queue teams: who is available, how full every box is,
 * what waits unassigned or runs late, and the time spent per status. Scoped
 * by the server (a supervisor sees the teams they supervise).
 */
export default function QueueBoard() {
  const [params,setParams]=useSearchParams();const date=useDateRange('today');
  const set=(k:string,v:string)=>setParams(o=>{const n=new URLSearchParams(o);v?n.set(k,v):n.delete(k);return n;},{replace:true});
  const qs=new URLSearchParams(date.apiQuery);
  for(const k of ['teamId','programId','employeeId'])if(params.get(k))qs.set(k,params.get(k)!);
  const board=useQuery({queryKey:['workforce','board',qs.toString()],queryFn:()=>api.get<Board>(`/workforce/board?${qs}`),
    enabled:!date.error,refetchInterval:20000,refetchIntervalInBackground:false});
  const {data:options}=useQuery({queryKey:['queue-options'],queryFn:()=>api.get<QueueOptions>('/queue/options')});
  const now=useServerClock(board.data?.serverNow,30000);
  const [action,setAction]=useState<{agent:BoardAgent;kind:'status'|'release'|'periods'}|null>(null);
  const d=board.data;
  const members=(options?.members??[]).filter((m,i,all)=>m.kind!=='supervisor'&&all.findIndex(n=>n.id===m.id)===i);
  const programs=(options?.programs??[]).filter((p,i,all)=>all.findIndex(n=>n.id===p.id)===i);
  const maxLoad=Math.max(1,...(d?.agents??[]).map(a=>Math.max(a.maxOpen,a.open)));
  return <div className="space-y-4">
    <div className="page-heading"><div>
      <p className="eyebrow">QUEUE OPERATIONS</p><h1 className="flex items-center gap-2"><MonitorDot size={22}/>لوحة فرق الرصد</h1>
      <p>حالات الموظفين، امتلاء الصناديق، المنتظر دون إسناد، والوقت حسب الحالة. التوقيت بتوقيت الرياض.</p>
    </div>
      <div className="flex gap-2 flex-wrap">
        <Link className="btn-ghost" to="/queue/settings"><Settings2 size={16}/>إعدادات الموظفين</Link>
        <button className="icon-button" aria-label="تحديث" onClick={()=>board.refetch()}><RefreshCw size={16} className={board.isFetching?'animate-spin':''}/></button>
      </div>
    </div>

    <div className="card p-3 wf-filters">
      <label className="queue-field">الفريق<select className="input" value={params.get('teamId')??''} onChange={e=>set('teamId',e.target.value)}>
        <option value="">كل فرقي</option>{options?.teams.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      <label className="queue-field">البرنامج<select className="input" value={params.get('programId')??''} onChange={e=>set('programId',e.target.value)}>
        <option value="">كل البرامج</option>{programs.map(p=><option key={p.id} value={p.id}>{p.name_ar}</option>)}</select></label>
      <label className="queue-field">الموظف<select className="input" value={params.get('employeeId')??''} onChange={e=>set('employeeId',e.target.value)}>
        <option value="">كل الموظفين</option>{members.map(m=><option key={m.id} value={m.id}>{m.full_name}</option>)}</select></label>
      <div className="queue-field">فترة الأداء والوقت<DateRangeFilter state={date}/></div>
    </div>

    {board.error&&<p role="alert" className="card p-4 text-red-600">{board.error.message}</p>}
    {board.isLoading&&<div className="card p-8 text-center muted">جارٍ التحميل…</div>}
    {d&&<>
      {!d.autoAssignEnabled&&<p className="card p-3 text-sm wf-note">الإسناد التلقائي متوقف على مستوى النظام. يُفعَّل من <Link className="underline text-brand-600" to="/queue/settings">إعدادات الموظفين</Link>.</p>}
      <section className="dash-stats" aria-label="الطابور الآن">
        <Stat label="بانتظار الإسناد" value={fmtNum(d.backlog.waiting)} sub={`${fmtNum(d.backlog.waiting_high)} عالية · أقدم ${minutesText(d.backlog.oldest_waiting_min)}`} watch={d.backlog.waiting>0}/>
        <Stat label="تجاوز حد الانتظار" value={fmtNum(d.backlog.starving)} sub={`منتظر ${d.starvationMinutes} دقيقة فأكثر — يتقدم في الإسناد`} watch={d.backlog.starving>0}/>
        <Stat label="متأخر في الصناديق" value={fmtNum(d.backlog.overdue)} sub={`أكثر من ${d.warnMinutes} دقيقة منذ الإسناد`} watch={d.backlog.overdue>0}/>
        <Stat label="في صناديق الموظفين" value={fmtNum(d.backlog.in_boxes)}/>
        <Stat label="مصعّد" value={fmtNum(d.backlog.escalated)}/>
        <Stat label="أُغلق اليوم" value={fmtNum(d.backlog.closedToday)} sub="تفاعلات دون تكرار"/>
      </section>

      <section className="card p-4">
        <h2 className="font-bold mb-3">الموظفون</h2>
        {!d.agents.length?<p className="muted text-sm">لا يوجد موظفو رصد في الفرق المحددة.</p>:
        <div className="dash-table-wrap"><table className="dash-table wf-table">
          <thead><tr><th>الموظف</th><th>الحالة</th><th>الصندوق</th><th>مصعّد</th><th>أُغلق اليوم</th><th>أقدم مفتوح</th>
            <th>مغلق في الفترة</th><th>من الإسناد حتى الإغلاق</th><th>متاح</th><th>استراحة</th><th>اجتماع</th><th>تدريب</th><th>خارج المكتب</th><th><span className="sr-only">إجراءات</span></th></tr></thead>
          <tbody>{d.agents.map(a=><tr key={a.id}>
            <td><strong className="block">{a.full_name}</strong><span className="text-xs muted">{a.team_name}</span></td>
            <td><span className={`wf-status-chip agent-status--${a.status}`}><span className="agent-status-dot" aria-hidden="true"/>{statusLabel(a.status)}</span>
              <span className="block text-xs muted">{a.status_since?duration(a.status_since,now):'—'}{a.status_source&&a.status_source!=='agent'?` · ${STATUS_SOURCE_LABELS[a.status_source as keyof typeof STATUS_SOURCE_LABELS]}`:''}</span></td>
            <td><span className="num">{a.open} / {a.maxOpen}</span>{!a.autoAssign&&<span className="block text-xs muted">إسناد تلقائي معطل</span>}
              <span className="wf-capacity wf-capacity--sm" aria-hidden="true"><span style={{inlineSize:`${Math.min(100,a.open/maxLoad*100)}%`}}/></span></td>
            <td className="num">{fmtNum(a.escalatedOpen)}</td><td className="num">{fmtNum(a.closedToday)}</td>
            <td className={a.oldestOpenMin!=null&&a.oldestOpenMin>=d.warnMinutes?'dash-watch':''}>{minutesText(a.oldestOpenMin)}</td>
            <td className="num">{fmtNum(a.performance.completedItems)}</td><td>{minutesText(a.performance.avgAssignmentToCloseMin)}</td>
            <td>{hours(a.time.available)}</td><td>{hours(a.time.break)}</td><td>{hours(a.time.meeting)}</td><td>{hours(a.time.training)}</td><td>{hours(a.time.away)}</td>
            <td><div className="flex gap-1 justify-end">
              <button className="btn-ghost !px-2 !py-1 text-xs" onClick={()=>setAction({agent:a,kind:'status'})}>الحالة</button>
              <button className="btn-ghost !px-2 !py-1 text-xs" disabled={!a.open} onClick={()=>setAction({agent:a,kind:'release'})}>إعادة توزيع</button>
              <button className="icon-button !w-8 !h-8" aria-label={`سجل حالات ${a.full_name}`} title="سجل الحالات" onClick={()=>setAction({agent:a,kind:'periods'})}><History size={14}/></button>
            </div></td>
          </tr>)}</tbody></table></div>}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-4"><h2 className="font-bold mb-3">حسب المسار</h2>
          <Distribution rows={d.bySection.map(s=>({key:s.section,label:QUEUE_SECTION_LABELS[s.section as QueueSection]?.ar??s.section,...s}))}/></section>
        <section className="card p-4"><h2 className="font-bold mb-3">حسب البرنامج</h2>
          <Distribution rows={d.byProgram.map(p=>({...p,key:p.program_id,label:p.name}))}/></section>
      </div>

      <section className="card p-4"><h2 className="font-bold mb-1">الوقت حسب الحالة — كل الموظفين المعروضين</h2>
        <p className="text-xs muted mb-3">سجلات حالة بتوقيت الخادم، مقسّمة على الأيام بتوقيت الرياض. وقت الحضور في النظام منفصل عن الإنتاجية وعن الدوام المجدول.</p>
        <div className="dash-stats">
          <Stat label="المسجل في النظام" value={hours(d.timeTotals.logged)}/><Stat label="العمل التشغيلي" value={hours(d.timeTotals.operational)} sub={d.operationalStatuses.map(statusLabel).join('، ')}/>
          <Stat label="متاح" value={hours(d.timeTotals.available)}/><Stat label="استراحة" value={hours(d.timeTotals.break)}/>
          <Stat label="اجتماع" value={hours(d.timeTotals.meeting)}/><Stat label="تدريب" value={hours(d.timeTotals.training)}/>
          <Stat label="خارج المكتب" value={hours(d.timeTotals.away)}/>
        </div>
        <p className="text-xs muted mt-2">الفترة: {fmtDateTime(d.range.from)} — {fmtDateTime(d.range.to)}</p>
      </section>
    </>}
    {action?.kind==='status'&&<StatusDialog agent={action.agent} onClose={()=>setAction(null)}/>}
    {action?.kind==='release'&&<ReleaseDialog agent={action.agent} onClose={()=>setAction(null)}/>}
    {action?.kind==='periods'&&<PeriodsDialog agent={action.agent} range={date.apiQuery} onClose={()=>setAction(null)}/>}
  </div>;
}

function Stat({label,value,sub,watch}:{label:string;value:string;sub?:string;watch?:boolean}) {
  return <div className="dash-stat"><span className="dash-stat-label">{label}</span><span className={`dash-stat-value ${watch?'dash-watch':''}`}>{value}</span>{sub&&<span className="dash-stat-sub">{sub}</span>}</div>;
}

function Distribution({rows}:{rows:Array<{key:string;label:string;color?:string|null;waiting:number;in_boxes:number;escalated:number}>}) {
  if(!rows.length)return <p className="muted text-sm">لا توجد عناصر مفتوحة.</p>;
  const max=Math.max(1,...rows.map(r=>r.waiting+r.in_boxes+r.escalated));
  return <ul className="space-y-2.5">{rows.map(r=>{const total=r.waiting+r.in_boxes+r.escalated;return <li key={r.key}>
    <div className="flex justify-between text-sm"><span className="inline-flex items-center gap-1.5">{r.color&&<span className="queue-dot" style={{background:r.color}}/>}{r.label}</span>
      <span className="muted text-xs">منتظر {r.waiting} · في الصناديق {r.in_boxes} · مصعّد {r.escalated}</span></div>
    <div className="wf-stack" aria-hidden="true" style={{inlineSize:`${total/max*100}%`}}>
      <span className="wf-stack-waiting" style={{flexGrow:r.waiting}}/><span className="wf-stack-box" style={{flexGrow:r.in_boxes}}/><span className="wf-stack-esc" style={{flexGrow:r.escalated}}/>
    </div></li>;})}</ul>;
}

function Dialog({title,onClose,children}:{title:string;onClose:()=>void;children:React.ReactNode}) {
  return <div className="modal-overlay" onClick={onClose}>
    <div className="card modal-card p-5 w-full max-w-lg" role="dialog" aria-modal="true" aria-label={title} onClick={e=>e.stopPropagation()}>
      <button className="icon-button absolute top-4 end-4" aria-label="إغلاق" onClick={onClose}><X size={18}/></button>
      <h3 className="font-bold text-lg mb-3">{title}</h3>{children}
    </div></div>;
}

function StatusDialog({agent,onClose}:{agent:BoardAgent;onClose:()=>void}) {
  const qc=useQueryClient();const [status,setStatus]=useState<AgentStatus>(agent.status);const [reason,setReason]=useState('');
  const save=useMutation({mutationFn:()=>api.post(`/workforce/agents/${agent.id}/status`,{status,reason}),
    onSuccess:()=>{qc.invalidateQueries({queryKey:['workforce']});onClose();}});
  return <Dialog title={`تغيير حالة ${agent.full_name}`} onClose={onClose}>
    <div className="space-y-3">
      <select aria-label="الحالة الجديدة" className="input w-full" value={status} onChange={e=>setStatus(e.target.value as AgentStatus)}>
        {AGENT_STATUSES.map(s=><option key={s} value={s}>{statusLabel(s)}</option>)}</select>
      <input aria-label="السبب" className="input w-full" placeholder="السبب (إلزامي، يُسجل في سجل التدقيق)" maxLength={2000} value={reason} onChange={e=>setReason(e.target.value)}/>
      {save.error&&<p role="alert" className="text-sm text-red-600">{save.error.message}</p>}
      <div className="flex gap-2"><button className="btn-primary" disabled={!reason.trim()||save.isPending||status===agent.status} onClick={()=>save.mutate()}>حفظ</button>
        <button className="btn-ghost" onClick={onClose}>إلغاء</button></div>
    </div></Dialog>;
}

function ReleaseDialog({agent,onClose}:{agent:BoardAgent;onClose:()=>void}) {
  const qc=useQueryClient();const [reason,setReason]=useState('');
  const run=useMutation({mutationFn:()=>api.post<{released:number;reassigned:number}>(`/workforce/agents/${agent.id}/release`,{reason}),
    onSuccess:()=>{qc.invalidateQueries({queryKey:['workforce']});qc.invalidateQueries({queryKey:['queue']});}});
  return <Dialog title={`إعادة توزيع صندوق ${agent.full_name}`} onClose={onClose}>
    {run.data?<div className="space-y-3"><p>أُعيد {run.data.released} تفاعل إلى الطابور، وأُسند منها {run.data.reassigned} تلقائياً لموظفين متاحين.</p>
      <button className="btn-primary" onClick={onClose}>تم</button></div>:
    <div className="space-y-3">
      <p className="text-sm">يُعاد {agent.open} تفاعل (غير المصعّد) إلى الطابور ثم يُوزَّع على الموظفين المتاحين. يبقى كل شيء في سجل العنصر.
        {agent.status==='available'&&<strong className="block mt-1 text-amber-600">الموظف «متاح» الآن وقد يستلم بعضها مجدداً؛ غيّر حالته أولاً إن لزم.</strong>}</p>
      <input aria-label="السبب" className="input w-full" placeholder="السبب (إلزامي)" maxLength={2000} value={reason} onChange={e=>setReason(e.target.value)}/>
      {run.error&&<p role="alert" className="text-sm text-red-600">{run.error.message}</p>}
      <div className="flex gap-2"><button className="btn-primary" disabled={!reason.trim()||run.isPending} onClick={()=>run.mutate()}>إعادة التوزيع</button>
        <button className="btn-ghost" onClick={onClose}>إلغاء</button></div>
    </div>}</Dialog>;
}

interface Period {id:string;status:AgentStatus;previous_status:string|null;started_at:string;ended_at:string|null;source:string;reason:string|null;
  end_source:string|null;end_reason:string|null;corrected_count:number;seconds:number;actor_name:string|null;
  corrections:Array<{reason:string;at:string;by:string;old:{status:string;startedAt:string;endedAt:string};new:{status:string;startedAt:string;endedAt:string}}>}

/** The record behind every total: each period, who opened/ended it, and any correction. */
function PeriodsDialog({agent,range,onClose}:{agent:BoardAgent;range:string;onClose:()=>void}) {
  const {can}=useAuth();const qc=useQueryClient();
  const {data,isLoading}=useQuery({queryKey:['workforce','periods',agent.id,range],queryFn:()=>api.get<{items:Period[]}>(`/workforce/periods?${range}&employeeId=${agent.id}`)});
  const [edit,setEdit]=useState<Period|null>(null);const [form,setForm]=useState({status:'',startedAt:'',endedAt:'',reason:''});
  const local=(iso:string)=>{const d=new Date(iso);const z=new Date(d.getTime()+3*3600000);return z.toISOString().slice(0,16);};
  const toIso=(v:string)=>new Date(v+':00+03:00').toISOString();
  const save=useMutation({mutationFn:()=>api.post(`/workforce/periods/${edit!.id}/correct`,{
      ...(form.status!==edit!.status?{status:form.status}:{}),
      ...(form.startedAt!==local(edit!.started_at)?{startedAt:toIso(form.startedAt)}:{}),
      ...(edit!.ended_at&&form.endedAt!==local(edit!.ended_at)?{endedAt:toIso(form.endedAt)}:{}),reason:form.reason}),
    onSuccess:()=>{setEdit(null);qc.invalidateQueries({queryKey:['workforce']});}});
  return <Dialog title={`سجل حالات ${agent.full_name}`} onClose={onClose}>
    {isLoading&&<p className="muted">جارٍ التحميل…</p>}
    {!isLoading&&!data?.items.length&&<p className="muted text-sm">لا توجد سجلات في هذه الفترة.</p>}
    <ol className="space-y-2 max-h-[60vh] overflow-y-auto">{data?.items.map(p=><li key={p.id} className="rounded-lg border border-slate-200 dark:border-slate-700 p-2.5 text-sm">
      <div className="flex items-center gap-2 flex-wrap"><span className={`wf-status-chip agent-status--${p.status}`}><span className="agent-status-dot" aria-hidden="true"/>{statusLabel(p.status)}</span>
        <span className="muted text-xs">{hours(p.seconds)}</span>{p.corrected_count>0&&<span className="queue-tag queue-tag--hold">مُصحَّح</span>}
        {can(P.WORKFORCE_CORRECT)&&p.ended_at&&<button className="ms-auto text-xs underline text-brand-600" onClick={()=>{setEdit(p);setForm({status:p.status,startedAt:local(p.started_at),endedAt:local(p.ended_at!),reason:''});}}>تصحيح</button>}</div>
      <p className="text-xs muted mt-1">{fmtDateTime(p.started_at)} ← {p.ended_at?fmtDateTime(p.ended_at):'جارية'}</p>
      <p className="text-xs muted">بدأها: {STATUS_SOURCE_LABELS[p.source as keyof typeof STATUS_SOURCE_LABELS]}{p.actor_name&&p.source==='supervisor'?` (${p.actor_name})`:''}{p.reason?` — ${p.reason}`:''}
        {p.end_source?` · أنهاها: ${STATUS_SOURCE_LABELS[p.end_source as keyof typeof STATUS_SOURCE_LABELS]}${p.end_reason?` — ${p.end_reason}`:''}`:''}</p>
      {p.corrections.map((c,i)=><p key={i} className="text-xs text-amber-600">تصحيح {c.by} ({fmtDateTime(c.at)}): {statusLabel(c.old.status)} ← {statusLabel(c.new.status)} — {c.reason}</p>)}
      {edit?.id===p.id&&<div className="mt-2 space-y-2">
        <select aria-label="الحالة" className="input w-full" value={form.status} onChange={e=>setForm(f=>({...f,status:e.target.value}))}>{AGENT_STATUSES.map(s=><option key={s} value={s}>{statusLabel(s)}</option>)}</select>
        <div className="grid grid-cols-2 gap-2"><label className="queue-field">البداية (الرياض)<input type="datetime-local" className="input" value={form.startedAt} onChange={e=>setForm(f=>({...f,startedAt:e.target.value}))}/></label>
          <label className="queue-field">النهاية (الرياض)<input type="datetime-local" className="input" value={form.endedAt} onChange={e=>setForm(f=>({...f,endedAt:e.target.value}))}/></label></div>
        <input aria-label="سبب التصحيح" className="input w-full" placeholder="سبب التصحيح (إلزامي)" value={form.reason} maxLength={2000} onChange={e=>setForm(f=>({...f,reason:e.target.value}))}/>
        {save.error&&<p role="alert" className="text-xs text-red-600">{save.error.message}</p>}
        <div className="flex gap-2"><button className="btn-primary" disabled={!form.reason.trim()||save.isPending} onClick={()=>save.mutate()}>حفظ التصحيح</button><button className="btn-ghost" onClick={()=>setEdit(null)}>إلغاء</button></div>
      </div>}
    </li>)}</ol>
  </Dialog>;
}
