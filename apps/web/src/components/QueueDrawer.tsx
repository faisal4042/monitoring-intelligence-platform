import {useEffect,useRef,useState} from 'react';
import {useQuery,useMutation,useQueryClient} from '@tanstack/react-query';
import {Link,useSearchParams} from 'react-router-dom';
import {X,Play,CheckCircle,ArrowUpRight,StickyNote,Sparkles,UserRound,TriangleAlert,ExternalLink,ArrowLeftRight} from 'lucide-react';
import {PERMISSIONS as P,QUEUE_EVENT_LABELS,QUEUE_RESOLUTIONS,QUEUE_RESOLUTION_LABELS,QUEUE_SECTION_LABELS,QUEUE_STATUS_LABELS,type QueueAction} from '@mip/shared';
import {api} from '../lib/api';
import {useAuth} from '../lib/auth';
import {INTENT_LABELS,SENTIMENT_LABELS,SOURCE_LABELS,STORY_STATE_LABELS,duration,sourceOf,type QueueItem,type QueueOptions} from '../lib/queue';
import {fmtCompact,fmtDateTime,fmtRelative} from '../lib/format';
import AuthorHistoryModal from './AuthorHistoryModal';
import Avatar from './Avatar';

export default function QueueDrawer({id,onClose}:{id:string;onClose:()=>void}) {
  const {user,can}=useAuth();const qc=useQueryClient();const supervise=can(P.QUEUE_SUPERVISE);
  const [,setParams]=useSearchParams();
  const [assignee,setAssignee]=useState(''),[reason,setReason]=useState(''),[assignReason,setAssignReason]=useState(''),[note,setNote]=useState(''),[resolution,setResolution]=useState('');
  const [history,setHistory]=useState(false);
  const [transferOpen,setTransferOpen]=useState(false),[toTeam,setToTeam]=useState(''),[toMember,setToMember]=useState(''),[transferReason,setTransferReason]=useState('');
  const closeRef=useRef<HTMLButtonElement>(null);
  const {data:item,error,isLoading}=useQuery({queryKey:['queue-item',id],queryFn:()=>api.get<QueueItem>(`/queue/items/${id}`),
    refetchInterval:supervise?20000:15000,refetchIntervalInBackground:false});
  const {data:options}=useQuery({queryKey:['queue-options'],queryFn:()=>api.get<QueueOptions>('/queue/options'),enabled:supervise});
  const change=useMutation({mutationFn:({action,extra={}}:{action:QueueAction;extra?:object})=>
    api.post(`/queue/items/${id}/${action}`,{expectedVersion:item!.version,...extra}),
    onSuccess:()=>{setNote('');setReason('');setAssignReason('');setAssignee('');setResolution('');qc.invalidateQueries({queryKey:['queue']});qc.invalidateQueries({queryKey:['queue-item',id]});},
    onError:()=>{qc.invalidateQueries({queryKey:['queue-item',id]});qc.invalidateQueries({queryKey:['queue']});}});
  // Cross-team transfer: one audited server transaction (team, assignee, reason, version).
  const transfer=useMutation({mutationFn:()=>api.post(`/queue/items/${id}/transfer`,{expectedVersion:item!.version,teamId:toTeam,assigneeId:toMember,reason:transferReason}),
    onSuccess:()=>{setTransferOpen(false);setToTeam('');setToMember('');setTransferReason('');qc.invalidateQueries({queryKey:['queue']});qc.invalidateQueries({queryKey:['queue-item',id]});},
    onError:()=>{qc.invalidateQueries({queryKey:['queue-item',id]});}});
  const feedback=useMutation({mutationFn:(correct:boolean)=>api.post(`/classification/interactions/${item!.post_id}/topic-feedback`,{correct}),
    onSuccess:()=>qc.invalidateQueries({queryKey:['queue-item',id]})});
  useEffect(()=>{closeRef.current?.focus();const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape')onClose();};document.addEventListener('keydown',onKey);return()=>document.removeEventListener('keydown',onKey);},[onClose]);
  const openItem=(other:string)=>setParams(old=>{const next=new URLSearchParams(old);next.set('item',other);return next;});
  const mine=item?.assignee_id===user?.id;
  const work=(mine||supervise)&&!item?.merged_into_id;
  const story=item?.interaction_type==='story';
  const sentiment=item?.sentiment?SENTIMENT_LABELS[item.sentiment]:null;
  return <div className="queue-drawer" onClick={onClose}>
    <section role="dialog" aria-modal="true" aria-label={story?'تفاصيل القصة':'تفاصيل التفاعل'} className="card p-5 space-y-5" onClick={e=>e.stopPropagation()}>
      <header className="flex justify-between items-center gap-3">
        <h2 className="text-xl font-bold flex items-center gap-2">{story?<><Sparkles size={20}/>تفاصيل القصة</>:'تفاصيل التفاعل'}</h2>
        <button ref={closeRef} className="icon-button" aria-label="إغلاق التفاصيل" onClick={onClose}><X size={18}/></button>
      </header>
      {isLoading&&<p>جارٍ التحميل…</p>}{error&&<p role="alert" className="text-red-600">{error.message}</p>}
      {item&&<>
        <div className="flex gap-2 flex-wrap items-center">
          <span className={`queue-status-badge queue-status-badge--${item.status}`}>{QUEUE_STATUS_LABELS[item.status]}</span>
          <span className={`queue-tag ${item.section==='general'?'':`queue-tag--${item.section}`}`}>{QUEUE_SECTION_LABELS[item.section].ar}</span>
          <span className="queue-tag"><span className="queue-dot" style={{background:item.program_snapshot.color||'var(--color-brand-500)'}}/>{item.program_snapshot.name}</span>
          <span className="queue-tag">{item.team_name}</span>
          {item.section_hold&&<span className="queue-tag queue-tag--hold"><TriangleAlert size={11}/>ينتمي لقصة في فريق آخر — بانتظار مراجعة المشرف</span>}
        </div>
        {item.section_hold&&supervise&&!transferOpen&&<p className="rounded-lg p-3 bg-red-500/5 text-sm flex flex-wrap items-center gap-2">
          هذا التفاعل ضمن قصة يتابعها فريق آخر، فلم يُنقل تلقائياً.
          <button className="underline text-brand-600" onClick={()=>{setTransferOpen(true);setToTeam(item.hold_team_id??'');}}>تنفيذ النقل إلى فريق القصة</button></p>}
        {item.merged_into_id&&<p className="rounded-lg p-3 bg-amber-500/10 text-sm">دُمجت هذه القصة في قصة أخرى. <button className="underline text-brand-600" onClick={()=>openItem(item.merged_into_id!)}>فتح القصة الأساسية</button></p>}

        {story?<article className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
          <div className="flex items-start gap-2 justify-between"><h3 className="font-bold text-lg leading-8">{item.story_title}</h3>
            {item.story_state&&<span className="queue-tag queue-tag--story">{STORY_STATE_LABELS[item.story_state]??item.story_state}</span>}</div>
          {item.story_summary&&<p className="leading-8">{item.story_summary}</p>}
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <div><dt className="muted text-xs">التفاعلات المرتبطة</dt><dd className="font-bold">{item.story_post_count??0}</dd></div>
            <div><dt className="muted text-xs">منها لمؤثرين</dt><dd className="font-bold">{item.story_influencer_count??0}</dd></div>
            <div><dt className="muted text-xs">أول ظهور</dt><dd>{fmtDateTime(item.story_first_seen_at)}</dd></div>
            <div><dt className="muted text-xs">آخر نشاط</dt><dd>{item.story_last_seen_at?fmtRelative(item.story_last_seen_at):'—'}</dd></div>
          </dl>
        </article>:<article className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
          <div className="flex items-center gap-3">
            <Avatar src={item.profile_image_url} name={item.display_name} username={item.username} size={42}/>
            <div className="min-w-0"><div className="font-bold flex items-center gap-2 flex-wrap">{item.display_name??item.username??'تفاعل محفوظ المرجع'}
              {item.section==='influencer'&&<span className="queue-tag queue-tag--influencer"><UserRound size={11}/>مؤثر</span>}</div>
              <div className="text-xs muted">{item.username&&<span dir="ltr">@{item.username}</span>}{item.followers_count?` · ${fmtCompact(item.followers_count)} متابع`:''}</div></div>
          </div>
          {item.parent_story_title&&<p className="text-sm"><span className="queue-tag queue-tag--story"><Sparkles size={11}/>ضمن قصة</span> {item.parent_story_title}
            {item.story_item_id&&supervise&&<button className="ms-2 underline text-brand-600 text-xs" onClick={()=>openItem(item.story_item_id!)}>فتح القصة</button>}</p>}
          <p className="whitespace-pre-wrap leading-8">{item.text??'المصدر غير متاح بعد انتهاء الاحتفاظ أو الحجب. السجل التشغيلي محفوظ.'}</p>
          <div className="text-sm muted">المصدر: X · {SOURCE_LABELS[sourceOf(item)]} · التصنيف: {item.intent?INTENT_LABELS[item.intent]??item.intent:'—'} · المشاعر: <span className={sentiment?.cls}>{sentiment?.text??'—'}</span> · الموضوع: {item.topic_name??'غير مرتبط بموضوع'}</div>
          <div className="text-xs muted">نُشر: {fmtDateTime(item.post_posted_at)} · دخل الطابور: {fmtDateTime(item.entered_at)}</div>
          <div className="grid grid-cols-2 gap-2">{item.media?.map((m,i)=>m.type==='photo'&&m.url?<img key={i} src={m.url} alt="وسائط التفاعل" className="rounded-lg max-h-56 object-contain"/>:m.url?<a key={i} href={m.url} target="_blank" rel="noreferrer" className="text-brand-600 underline">فتح الوسائط</a>:null)}</div>
          <div className="flex gap-2 flex-wrap">
            {item.url&&<a className="btn-ghost" href={item.url} target="_blank" rel="noreferrer"><ExternalLink size={15}/>فتح في X</a>}
            {item.x_author_id&&can(P.CUSTOMERS_READ)&&<button className="btn-ghost" onClick={()=>setHistory(true)}>سجل تفاعلات العميل</button>}
            {/* topic-feedback edits the post's topic link: only offer it when there is one, and say so. */}
            {item.text&&item.topic_id&&can(P.FEEDBACK_WRITE)&&<><button className="btn-ghost" disabled={feedback.isPending} onClick={()=>feedback.mutate(true)}>ربط الموضوع صحيح</button><button className="btn-ghost" disabled={feedback.isPending} onClick={()=>{if(window.confirm(`إزالة ربط هذا التفاعل بموضوع «${item.topic_name??''}»؟ يُسجَّل كتصحيح بشري.`))feedback.mutate(false);}}>ربط الموضوع خاطئ</button></>}
            {item.text&&can(P.FEEDBACK_WRITE)&&<Link className="btn-ghost" to="/classification">مراجعة التصنيف</Link>}
          </div>{feedback.isSuccess&&<p className="text-sm text-emerald-600">حُفظت المراجعة</p>}{feedback.error&&<p role="alert">{feedback.error.message}</p>}
        </article>}

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>المسؤول: <strong>{item.assignee_name??'غير مسند'}</strong></div><div>انتظار الإسناد: {duration(item.entered_at,item.first_assigned_at??undefined)}</div>
          <div>حتى البدء: {duration(item.first_assigned_at,item.first_started_at)}</div><div>وقت المعالجة: {duration(item.first_started_at,item.status==='completed'?item.completed_at:undefined)}</div>
          <div>وقت الإكمال: {duration(item.entered_at,item.status==='completed'?item.completed_at:null)}</div>{!story&&<div>تأخر الاكتشاف (معلوماتي): {duration(item.post_posted_at,item.entered_at)}</div>}
          <div>إعادة الإسناد: {item.reassignment_count}</div><div>التصعيد: {item.escalation_count}</div>
          <div>إعادة الفتح: {item.reopen_count??0}</div><div>الدورة الحالية بدأت: {item.started_at?fmtDateTime(item.started_at):'لم تبدأ بعد'}</div>
        </div>
        {change.error&&<p role="alert" className="rounded-lg p-3 bg-red-500/10 text-red-600">{change.error.message}</p>}
        <fieldset disabled={change.isPending||!!item.merged_into_id} className="space-y-3">
          {supervise&&['new','assigned','escalated','in_progress'].includes(item.status)&&<div className="space-y-2">
            <div className="flex gap-2"><select aria-label="الموظف للإسناد" className="input flex-1" value={assignee} onChange={e=>setAssignee(e.target.value)}><option value="">اختر موظف الفريق</option>{options?.members.filter(m=>m.team_id===item.team_id&&m.id!==item.assignee_id).map(m=><option key={m.id} value={m.id}>{m.full_name}</option>)}</select><button className="btn-primary" disabled={!assignee||(item.status==='in_progress'&&!assignReason.trim())} onClick={()=>change.mutate({action:'assign',extra:{assigneeId:assignee,...(assignReason.trim()?{reason:assignReason}:{})}})}>{item.status==='escalated'?'إعادة التوجيه':item.status==='new'?'إسناد':'إعادة الإسناد'}</button></div>
            {/* Taking work from someone mid-task needs a reason; the new assignee starts their own cycle. */}
            {item.status==='in_progress'&&<input aria-label="سبب إعادة الإسناد" placeholder="سبب إعادة الإسناد أثناء المعالجة (إلزامي)" className="input w-full" value={assignReason} maxLength={2000} onChange={e=>setAssignReason(e.target.value)}/>}
          </div>}
          <div className="flex gap-2">
            {item.status==='assigned'&&mine&&can(P.QUEUE_WORK)&&<button className="btn-primary" onClick={()=>change.mutate({action:'start'})}><Play size={16}/>بدء العمل</button>}
            {item.status==='assigned'&&supervise&&<button className="btn-ghost" onClick={()=>change.mutate({action:'unassign'})}>إلغاء الإسناد</button>}
            {item.status==='completed'&&supervise&&<button className="btn-primary" onClick={()=>change.mutate({action:'reopen'})}>إعادة الفتح</button>}
          </div>
          {work&&['assigned','in_progress'].includes(item.status)&&<div className="flex gap-2"><input aria-label="سبب التصعيد" placeholder="سبب التصعيد (إلزامي)" className="input flex-1" value={reason} maxLength={2000} onChange={e=>setReason(e.target.value)}/><button className="btn-ghost" disabled={!reason.trim()} onClick={()=>change.mutate({action:'escalate',extra:{reason}})}><ArrowUpRight size={16}/>تصعيد</button></div>}
          {work&&(item.status==='in_progress'||item.status==='escalated'&&supervise)&&<div className="flex gap-2"><select aria-label="نتيجة المعالجة" className="input flex-1" value={resolution} onChange={e=>setResolution(e.target.value)}><option value="">اختر نتيجة المعالجة</option>{QUEUE_RESOLUTIONS.map(r=><option key={r} value={r}>{QUEUE_RESOLUTION_LABELS[r]}</option>)}</select><button className="btn-primary" disabled={!resolution} onClick={()=>change.mutate({action:'complete',extra:{resolution}})}><CheckCircle size={16}/>إكمال</button></div>}
          {supervise&&!story&&item.status!=='completed'&&<div className="rounded-lg border border-slate-200 dark:border-slate-700 p-3 space-y-2">
            <button className="flex items-center gap-2 text-sm font-bold" aria-expanded={transferOpen} onClick={()=>{setTransferOpen(o=>!o);if(!toTeam&&item.hold_team_id)setToTeam(item.hold_team_id);}}>
              <ArrowLeftRight size={15}/>نقل إلى فريق آخر</button>
            {transferOpen&&<>
              <div className="grid sm:grid-cols-2 gap-2">
                <select aria-label="الفريق المستلم" className="input" value={toTeam} onChange={e=>{setToTeam(e.target.value);setToMember('');}}>
                  <option value="">اختر الفريق المستلم</option>{options?.teams.filter(t=>t.id!==item.team_id).map(t=><option key={t.id} value={t.id}>{t.name}{t.id===item.hold_team_id?' — فريق القصة':''}</option>)}</select>
                <select aria-label="الموظف المستلم" className="input" value={toMember} disabled={!toTeam} onChange={e=>setToMember(e.target.value)}>
                  <option value="">اختر الموظف المستلم</option>{options?.members.filter(m=>m.team_id===toTeam).map(m=><option key={m.id} value={m.id}>{m.full_name}</option>)}</select>
              </div>
              <input aria-label="سبب النقل" placeholder="سبب النقل (إلزامي)" className="input w-full" value={transferReason} maxLength={2000} onChange={e=>setTransferReason(e.target.value)}/>
              {options&&!options.teams.some(t=>t.id!==item.team_id)&&<p className="text-xs muted">لا يوجد فريق آخر ضمن نطاقك للنقل إليه.</p>}
              {transfer.error&&<p role="alert" className="text-sm text-red-600">{transfer.error.message}</p>}
              <div className="flex gap-2"><button className="btn-primary" disabled={!toTeam||!toMember||!transferReason.trim()||transfer.isPending} onClick={()=>transfer.mutate()}>تنفيذ النقل</button>
                <button className="btn-ghost" onClick={()=>setTransferOpen(false)}>إلغاء</button></div>
              <p className="text-xs muted">يُسند العنصر للموظف المستلم ويبدأ دورة جديدة؛ يبقى الفريق والموظف السابقان في السجل.</p>
            </>}
          </div>}
          {work&&item.status!=='completed'&&<div className="space-y-2"><label className="block text-sm font-bold" htmlFor="queue-note">ملاحظة داخلية</label><textarea id="queue-note" className="input w-full" rows={3} maxLength={5000} value={note} onChange={e=>setNote(e.target.value)} placeholder="التصحيح يكون بملاحظة جديدة؛ لا يمكن تعديل الملاحظات أو حذفها."/><button className="btn-ghost" disabled={!note.trim()} onClick={()=>change.mutate({action:'notes',extra:{body:note}})}><StickyNote size={16}/>إضافة ملاحظة</button></div>}
        </fieldset>

        {story&&<section><h3 className="font-bold mb-3">التفاعلات المرتبطة بالقصة ({item.members?.length??0})</h3>
          {!item.members?.length&&<p className="muted text-sm">لا تتوفر تفاعلات ظاهرة (قد تكون محجوبة أو خارج فترة الاحتفاظ).</p>}
          <ul className="space-y-2">{item.members?.map(m=><li key={m.post_id} className="rounded-lg border border-slate-200 dark:border-slate-700 p-3">
            <div className="flex items-center gap-2 text-sm"><Avatar src={m.profile_image_url} name={m.display_name} username={m.username} size={26}/>
              <strong className="truncate">{m.display_name??m.username??'حساب'}</strong>
              {m.source_role==='influencer'&&<span className="queue-tag queue-tag--influencer">مؤثر</span>}
              <span className="text-xs muted ms-auto">{fmtRelative(m.posted_at)}</span></div>
            <p className="text-sm leading-7 mt-1 line-clamp-3">{m.text}</p>
            {m.item_status&&<div className="text-xs mt-1 flex items-center gap-2"><span className={`queue-status-badge queue-status-badge--${m.item_status}`}>{QUEUE_STATUS_LABELS[m.item_status]}</span>
              {m.item_assignee_name&&<span className="muted">{m.item_assignee_name}</span>}
              {m.item_id&&<button className="underline text-brand-600" onClick={()=>openItem(m.item_id!)}>فتح العنصر</button>}</div>}
          </li>)}</ul>
          {!!item.merged?.length&&<div className="mt-3 text-sm"><h4 className="font-bold mb-1">قصص دُمجت هنا</h4>
            {item.merged.map(m=><button key={m.id} className="block underline text-brand-600" onClick={()=>openItem(m.id)}>{m.title??'قصة'} — {QUEUE_STATUS_LABELS[m.status]}</button>)}</div>}
        </section>}

        <section><h3 className="font-bold mb-3">الملاحظات الداخلية</h3>{!item.notes?.length&&<p className="muted text-sm">لا توجد ملاحظات</p>}{item.notes?.map(n=><div key={n.id} className="border-s-2 border-brand-500 ps-3 py-2 mb-3"><p className="whitespace-pre-wrap">{n.body}</p><p className="muted text-xs mt-1">{n.author_name} · {fmtDateTime(n.created_at)}</p></div>)}</section>
        <section><h3 className="font-bold mb-3">سجل العمل ودورات المعالجة</h3><ol className="space-y-3">{item.events?.map(e=><li key={e.id} className="border-s-2 border-slate-300 ps-3 text-sm"><strong>{QUEUE_EVENT_LABELS[e.event_type]??e.event_type}</strong> · {e.actor_name??'النظام'}
          <p className="muted text-xs">{fmtDateTime(e.created_at)} · {e.from_status&&e.from_status!==e.to_status?QUEUE_STATUS_LABELS[e.from_status]+' ← ':''}{QUEUE_STATUS_LABELS[e.to_status]}</p>
          {e.event_type==='section_changed'&&e.metadata?.from&&e.metadata.to&&<p>{e.metadata.from===e.metadata.to?'انتقل مع قصته المدمجة':`${QUEUE_SECTION_LABELS[e.metadata.from].ar} ← ${QUEUE_SECTION_LABELS[e.metadata.to].ar}`}</p>}
          {e.event_type==='transferred'&&<p>{e.metadata?.fromTeamName??'—'} ← {e.metadata?.toTeamName??'—'}</p>}
          {e.event_type==='section_review'&&<p>{e.metadata?.hold?'التفاعل ضمن قصة يملكها فريق آخر؛ لم يُنقل تلقائياً.':'انتهت حالة المراجعة.'}</p>}
          {e.reason&&<p>{e.reason}</p>}{e.resolution&&<p>{QUEUE_RESOLUTION_LABELS[e.resolution as keyof typeof QUEUE_RESOLUTION_LABELS]}</p>}</li>)}</ol></section>
      </>}
      {history&&item?.x_author_id&&<AuthorHistoryModal xAuthorId={item.x_author_id} onClose={()=>setHistory(false)}/>}
    </section>
  </div>;
}
