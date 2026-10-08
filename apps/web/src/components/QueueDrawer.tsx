import {useEffect,useState} from 'react';
import {useQuery,useMutation,useQueryClient} from '@tanstack/react-query';
import {Link} from 'react-router-dom';
import {X,Play,CheckCircle,ArrowUpRight,StickyNote} from 'lucide-react';
import {PERMISSIONS as P,QUEUE_EVENT_LABELS,QUEUE_RESOLUTIONS,QUEUE_RESOLUTION_LABELS,QUEUE_STATUS_LABELS,type QueueAction} from '@mip/shared';
import {api} from '../lib/api';
import {useAuth} from '../lib/auth';
import {duration,type QueueItem,type QueueOptions} from '../lib/queue';
import {fmtDateTime} from '../lib/format';
import AuthorHistoryModal from './AuthorHistoryModal';

export default function QueueDrawer({id,onClose}:{id:string;onClose:()=>void}) {
  const {user,can}=useAuth();const qc=useQueryClient();const supervise=can(P.QUEUE_SUPERVISE);
  const [assignee,setAssignee]=useState(''),[reason,setReason]=useState(''),[note,setNote]=useState(''),[resolution,setResolution]=useState('');
  const [history,setHistory]=useState(false);
  const {data:item,error,isLoading}=useQuery({queryKey:['queue-item',id],queryFn:()=>api.get<QueueItem>(`/queue/items/${id}`),
    refetchInterval:supervise?20000:15000,refetchIntervalInBackground:false});
  const {data:options}=useQuery({queryKey:['queue-options'],queryFn:()=>api.get<QueueOptions>('/queue/options'),enabled:supervise});
  const change=useMutation({mutationFn:({action,extra={}}:{action:QueueAction;extra?:object})=>
    api.post(`/queue/items/${id}/${action}`,{expectedVersion:item!.version,...extra}),
    onSuccess:()=>{setNote('');setReason('');setResolution('');qc.invalidateQueries({queryKey:['queue']});qc.invalidateQueries({queryKey:['queue-item',id]});},
    onError:()=>{qc.invalidateQueries({queryKey:['queue-item',id]});qc.invalidateQueries({queryKey:['queue']});}});
  const feedback=useMutation({mutationFn:(correct:boolean)=>api.post(`/classification/interactions/${item!.post_id}/topic-feedback`,{correct}),
    onSuccess:()=>qc.invalidateQueries({queryKey:['queue-item',id]})});
  useEffect(()=>{const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape')onClose();};document.addEventListener('keydown',onKey);return()=>document.removeEventListener('keydown',onKey);},[onClose]);
  const mine=item?.assignee_id===user?.id;
  const work=mine||supervise;
  return <div className="fixed inset-0 z-50 bg-black/45 flex justify-end" onClick={onClose}>
    <section role="dialog" aria-modal="true" aria-label="تفاصيل عنصر الطابور" className="card h-full w-full max-w-2xl overflow-y-auto !rounded-none p-5 space-y-5" onClick={e=>e.stopPropagation()}>
      <header className="flex justify-between items-center"><h2 className="text-xl font-bold">تفاصيل التفاعل</h2><button className="btn-ghost" aria-label="إغلاق التفاصيل" onClick={onClose}><X size={20}/></button></header>
      {isLoading&&<p>جارٍ التحميل…</p>}{error&&<p role="alert" className="text-red-600">{error.message}</p>}
      {item&&<>
        <div className="flex gap-2 flex-wrap"><span className="badge bg-brand-500/10 text-brand-600">{QUEUE_STATUS_LABELS[item.status]}</span><span className="badge">{item.program_snapshot.name}</span><span className="badge">{item.team_name}</span></div>
        <article className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
          <div className="font-bold">{item.display_name??item.username??'تفاعل محفوظ المرجع'}</div>
          <p className="whitespace-pre-wrap leading-8">{item.text??'المصدر غير متاح بعد انتهاء الاحتفاظ أو الحجب. السجل التشغيلي محفوظ.'}</p>
          <div className="text-sm muted">النيّة: {item.intent??'—'} · المشاعر: {item.sentiment??'—'} · الموضوع: {item.topic_name??'غير مرتبط بموضوع'}</div>
          <div className="text-xs muted">نُشر: {fmtDateTime(item.post_posted_at)} · دخل الطابور: {fmtDateTime(item.entered_at)}</div>
          <div className="grid grid-cols-2 gap-2">{item.media?.map((m,i)=>m.type==='photo'&&m.url?<img key={i} src={m.url} alt="وسائط التفاعل" className="rounded-lg max-h-56 object-contain"/>:m.url?<a key={i} href={m.url} target="_blank" rel="noreferrer" className="text-brand-600 underline">فتح الوسائط</a>:null)}</div>
          <div className="flex gap-2 flex-wrap">
            {item.x_author_id&&can(P.CUSTOMERS_READ)&&<button className="btn-ghost" onClick={()=>setHistory(true)}>سجل تفاعلات العميل</button>}
            {/* topic-feedback edits the post's topic link: only offer it when there is one, and say so. */}
            {item.text&&item.topic_id&&can(P.FEEDBACK_WRITE)&&<><button className="btn-ghost" disabled={feedback.isPending} onClick={()=>feedback.mutate(true)}>ربط الموضوع صحيح</button><button className="btn-ghost" disabled={feedback.isPending} onClick={()=>{if(window.confirm(`إزالة ربط هذا التفاعل بموضوع «${item.topic_name??''}»؟ يُسجَّل كتصحيح بشري.`))feedback.mutate(false);}}>ربط الموضوع خاطئ</button></>}
            {item.text&&can(P.FEEDBACK_WRITE)&&<Link className="btn-ghost" to="/classification">مراجعة التصنيف</Link>}
          </div>{feedback.isSuccess&&<p className="text-sm text-emerald-600">حُفظت المراجعة</p>}{feedback.error&&<p role="alert">{feedback.error.message}</p>}
        </article>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>المسند إليه: <strong>{item.assignee_name??'غير مسند'}</strong></div><div>انتظار الإسناد: {duration(item.entered_at,item.first_assigned_at??undefined)}</div>
          <div>حتى البدء: {duration(item.first_assigned_at,item.first_started_at)}</div><div>وقت المعالجة: {duration(item.first_started_at,item.status==='completed'?item.completed_at:undefined)}</div>
          <div>وقت الإكمال: {duration(item.entered_at,item.status==='completed'?item.completed_at:null)}</div><div>تأخر الاكتشاف (معلوماتي): {duration(item.post_posted_at,item.entered_at)}</div>
          <div>إعادة الإسناد: {item.reassignment_count}</div><div>التصعيد: {item.escalation_count}</div>
        </div>
        {change.error&&<p role="alert" className="rounded-lg p-3 bg-red-500/10 text-red-600">{change.error.message}</p>}
        <fieldset disabled={change.isPending} className="space-y-3">
          {supervise&&['new','assigned','escalated'].includes(item.status)&&<div className="flex gap-2"><select aria-label="الموظف للإسناد" className="input flex-1" value={assignee} onChange={e=>setAssignee(e.target.value)}><option value="">اختر موظف الفريق</option>{options?.members.filter(m=>m.team_id===item.team_id).map(m=><option key={m.id} value={m.id}>{m.full_name}</option>)}</select><button className="btn-primary" disabled={!assignee} onClick={()=>change.mutate({action:'assign',extra:{assigneeId:assignee}})}>{item.status==='escalated'?'إعادة التوجيه':item.status==='assigned'?'إعادة الإسناد':'إسناد'}</button></div>}
          <div className="flex gap-2">
            {item.status==='assigned'&&mine&&can(P.QUEUE_WORK)&&<button className="btn-primary" onClick={()=>change.mutate({action:'start'})}><Play size={16}/>بدء العمل</button>}
            {item.status==='assigned'&&supervise&&<button className="btn-ghost" onClick={()=>change.mutate({action:'unassign'})}>إلغاء الإسناد</button>}
            {item.status==='completed'&&supervise&&<button className="btn-primary" onClick={()=>change.mutate({action:'reopen'})}>إعادة الفتح</button>}
          </div>
          {work&&['assigned','in_progress'].includes(item.status)&&<div className="flex gap-2"><input aria-label="سبب التصعيد" placeholder="سبب التصعيد (إلزامي)" className="input flex-1" value={reason} maxLength={2000} onChange={e=>setReason(e.target.value)}/><button className="btn-ghost" disabled={!reason.trim()} onClick={()=>change.mutate({action:'escalate',extra:{reason}})}><ArrowUpRight size={16}/>تصعيد</button></div>}
          {work&&(item.status==='in_progress'||item.status==='escalated'&&supervise)&&<div className="flex gap-2"><select aria-label="نتيجة المعالجة" className="input flex-1" value={resolution} onChange={e=>setResolution(e.target.value)}><option value="">اختر نتيجة المعالجة</option>{QUEUE_RESOLUTIONS.map(r=><option key={r} value={r}>{QUEUE_RESOLUTION_LABELS[r]}</option>)}</select><button className="btn-primary" disabled={!resolution} onClick={()=>change.mutate({action:'complete',extra:{resolution}})}><CheckCircle size={16}/>إكمال</button></div>}
          {work&&item.status!=='completed'&&<div className="space-y-2"><label className="block text-sm font-bold" htmlFor="queue-note">ملاحظة داخلية</label><textarea id="queue-note" className="input w-full" rows={3} maxLength={5000} value={note} onChange={e=>setNote(e.target.value)} placeholder="التصحيح يكون بملاحظة جديدة؛ لا يمكن تعديل الملاحظات أو حذفها."/><button className="btn-ghost" disabled={!note.trim()} onClick={()=>change.mutate({action:'notes',extra:{body:note}})}><StickyNote size={16}/>إضافة ملاحظة</button></div>}
        </fieldset>
        <section><h3 className="font-bold mb-3">الملاحظات الداخلية</h3>{!item.notes?.length&&<p className="muted text-sm">لا توجد ملاحظات</p>}{item.notes?.map(n=><div key={n.id} className="border-s-2 border-brand-500 ps-3 py-2 mb-3"><p className="whitespace-pre-wrap">{n.body}</p><p className="muted text-xs mt-1">{n.author_name} · {fmtDateTime(n.created_at)}</p></div>)}</section>
        <section><h3 className="font-bold mb-3">سجل العمل ودورات المعالجة</h3><ol className="space-y-3">{item.events?.map(e=><li key={e.id} className="border-s-2 border-slate-300 ps-3 text-sm"><strong>{QUEUE_EVENT_LABELS[e.event_type]??e.event_type}</strong> · {e.actor_name??'النظام'}<p className="muted text-xs">{fmtDateTime(e.created_at)} · {e.from_status?QUEUE_STATUS_LABELS[e.from_status]+' ← ':''}{QUEUE_STATUS_LABELS[e.to_status]}</p>{e.reason&&<p>{e.reason}</p>}{e.resolution&&<p>{QUEUE_RESOLUTION_LABELS[e.resolution as keyof typeof QUEUE_RESOLUTION_LABELS]}</p>}</li>)}</ol></section>
      </>}
      {history&&item?.x_author_id&&<AuthorHistoryModal xAuthorId={item.x_author_id} onClose={()=>setHistory(false)}/>}
    </section>
  </div>;
}
