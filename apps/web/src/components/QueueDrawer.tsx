import {useBrowsingParams} from '../lib/useBrowsingParams';
import { useConfirmAction, useDiscardChanges } from './ConfirmAction';
import ModalSurface, { ModalCloseButton } from './ModalSurface';
import {useEffect,useState} from 'react';
import {useQuery,useMutation,useQueryClient} from '@tanstack/react-query';

import {X,ArrowUpRight,StickyNote,Sparkles,UserRound,TriangleAlert,ExternalLink,ArrowLeftRight,Flame} from 'lucide-react';
import {PERMISSIONS as P,QUEUE_SECTION_LABELS,QUEUE_STATUS_LABELS,type QueueAction} from '@mip/shared';
import {api} from '../lib/api';
import {useAuth} from '../lib/auth';
import {INTENT_LABELS,SENTIMENT_LABELS,SOURCE_LABELS,STORY_STATE_LABELS,duration,sourceOf,useServerClock,type QueueItem,type QueueOptions,type ReviewCatalog,type QueueSummary} from '../lib/queue';
import {fmtCompact,fmtDateTime,fmtRelative} from '../lib/format';
import AuthorHistoryModal from './AuthorHistoryModal';
import Avatar from './Avatar';
import QueueReview,{QueueReviewHistory,type ReviewDraft} from './QueueReview';
import {hasQueueDraft} from './QueueDraftNotice';
import {statusLabel} from '../lib/workforce';
import {XVideoFrame,xPostIdOf} from './live/VideoEmbed';
import VideoPlayer from './media/VideoPlayer';
import {SOURCE_KIND_LABELS,SOURCE_OPEN_LABELS,SourceBadge,SourceIcon,TicketNumbers,isSourceCard,sourceOrigin,sourceText,sourceTitle,sourceUrl} from './queue/SourceParts';

export default function QueueDrawer({id,onClose}:{id:string;onClose:()=>void}) {
  const {user}=useAuth();
  return <QueueDrawerContent key={`${user?.id}:${id}`} id={id} onClose={onClose}/>;
}

function QueueDrawerContent({id,onClose}:{id:string;onClose:()=>void}) {
  const {user,can}=useAuth();const qc=useQueryClient();const supervise=can(P.QUEUE_SUPERVISE);
  const draftKey=['queue-draft',user?.id,id];
  const stored=qc.getQueryData<Record<string,unknown>>(draftKey);
  const [reviewDraft,setReviewDraft]=useState<ReviewDraft|undefined>(stored?.review as ReviewDraft|undefined);
  const [,setParams]=useBrowsingParams();const confirmation=useConfirmAction();
  const [assignee,setAssignee]=useState(String(stored?.assignee??'')),[reason,setReason]=useState(String(stored?.reason??'')),[assignReason,setAssignReason]=useState(String(stored?.assignReason??'')),[note,setNote]=useState(String(stored?.note??'')),[reopenReason,setReopenReason]=useState(String(stored?.reopenReason??''));
  const [priorityReason,setPriorityReason]=useState(String(stored?.priorityReason??''));
  const [history,setHistory]=useState(false);
  const [transferOpen,setTransferOpen]=useState(Boolean(stored?.transferOpen)),[toTeam,setToTeam]=useState(String(stored?.toTeam??'')),[toMember,setToMember]=useState(String(stored?.toMember??'')),[transferReason,setTransferReason]=useState(String(stored?.transferReason??''));
  const dirty=hasQueueDraft({assignee,reason,assignReason,note,reopenReason,priorityReason,toTeam,toMember,transferReason,review:reviewDraft});
  useEffect(()=>{qc.setQueryDefaults(['queue-draft'],{gcTime:Infinity});qc.setQueryData(draftKey,{assignee,reason,assignReason,note,reopenReason,priorityReason,toTeam,toMember,transferReason,transferOpen,review:reviewDraft});},[qc,user?.id,id,assignee,reason,assignReason,note,reopenReason,priorityReason,toTeam,toMember,transferReason,transferOpen,reviewDraft]);
  useEffect(()=>{if(!dirty)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty]);
  const discard=useDiscardChanges(dirty,()=>{qc.removeQueries({queryKey:draftKey,exact:true});onClose();});

  const {data:item,error,isLoading}=useQuery({queryKey:['queue-item',id],queryFn:()=>api.get<QueueItem>(`/queue/items/${id}`),
    refetchInterval:supervise?20000:15000,refetchIntervalInBackground:false});
  const {data:options}=useQuery({queryKey:['queue-options'],queryFn:()=>api.get<QueueOptions>('/queue/options'),enabled:supervise});
  const change=useMutation({mutationFn:({action,extra={}}:{action:QueueAction|'claim';extra?:object})=>
    api.post(`/queue/items/${id}/${action}`,{expectedVersion:item!.version,...extra}),
    onSuccess:async(_,variables)=>{if(variables.action==='notes')setNote('');setReason('');setAssignReason('');setAssignee('');setReopenReason('');await Promise.all([qc.invalidateQueries({queryKey:['queue']}),qc.invalidateQueries({queryKey:['queue-item',id]})]);if(variables.action==='complete'){qc.removeQueries({queryKey:draftKey,exact:true});onClose();}},
    onError:()=>{qc.invalidateQueries({queryKey:['queue-item',id]});qc.invalidateQueries({queryKey:['queue']});}});
  // High priority is a supervisor decision with a reason (one event, audited).
  const priority=useMutation({mutationFn:(to:'normal'|'high')=>api.post(`/queue/items/${id}/priority`,{expectedVersion:item!.version,priority:to,reason:priorityReason}),
    onSuccess:()=>{setPriorityReason('');qc.invalidateQueries({queryKey:['queue']});qc.invalidateQueries({queryKey:['queue-item',id]});},
    onError:()=>{qc.invalidateQueries({queryKey:['queue-item',id]});}});
  // Cross-team transfer: one audited server transaction (team, assignee, reason, version).
  const transfer=useMutation({mutationFn:()=>api.post(`/queue/items/${id}/transfer`,{expectedVersion:item!.version,teamId:toTeam,assigneeId:toMember,reason:transferReason}),
    onSuccess:()=>{setTransferOpen(false);setToTeam('');setToMember('');setTransferReason('');qc.invalidateQueries({queryKey:['queue']});qc.invalidateQueries({queryKey:['queue-item',id]});},
    onError:()=>{qc.invalidateQueries({queryKey:['queue-item',id]});}});
  const {data:catalog}=useQuery({queryKey:['queue-review-catalog'],queryFn:()=>api.get<ReviewCatalog>('/queue/review-catalog')});
  const {data:clock}=useQuery({queryKey:['queue','clock'],queryFn:()=>api.get<QueueSummary>('/queue/summary?range=all'),refetchInterval:30000});
  const serverNow=useServerClock(clock?.serverNow);

  const openItem=(other:string)=>setParams(old=>{const next=new URLSearchParams(old);next.set('item',other);return next;});
  const mine=item?.assignee_id===user?.id;
  const work=((mine&&can(P.QUEUE_WORK))||supervise)&&!item?.merged_into_id;
  const story=item?.interaction_type==='story';
  const src=!!item&&isSourceCard(item);
  const sentiment=item?.sentiment?SENTIMENT_LABELS[item.sentiment]:null;
  return <ModalSurface label={story ? 'تفاصيل القصة' : 'تفاصيل التفاعل'} onClose={discard.close} busy={change.isPending || priority.isPending || transfer.isPending} overlayClassName="queue-drawer" panelClassName="card p-5 space-y-5">
      {confirmation.dialog}{discard.dialog}<header className="flex justify-between items-center gap-3">
        <h2 className="text-xl font-bold flex items-center gap-2">{story?<><Sparkles size={20}/>تفاصيل القصة</>:'تفاصيل التفاعل'}</h2>
        <ModalCloseButton  className="icon-button" aria-label="إغلاق التفاصيل" onClick={discard.close}><X size={18}/></ModalCloseButton>
      </header>
      {isLoading&&<p>جارٍ التحميل…</p>}{error&&<p role="alert" className="text-red-600">{error.message}</p>}
      {item&&<>
        <div className="flex gap-2 flex-wrap items-center">
          <SourceBadge item={item}/>
          <span className={`queue-status-badge queue-status-badge--${item.status}`}>{QUEUE_STATUS_LABELS[item.status]}</span>
          <span className={`queue-tag ${item.section==='general'?'':`queue-tag--${item.section}`}`}>{QUEUE_SECTION_LABELS[item.section].ar}</span>
          <span className="queue-tag"><span className="queue-dot" style={{background:item.program_snapshot.color||'var(--color-brand-500)'}}/>{item.program_snapshot.name}</span>
          <span className="queue-tag">{item.team_name}</span>
          <TicketNumbers tickets={item.tickets} linked/>
          {item.priority==='high'&&<span className="queue-tag queue-tag--hold"><Flame size={11}/>أولوية عالية</span>}
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
        </article>:src&&isSourceCard(item)?<article className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
          <div className="flex items-start gap-3">
            <SourceIcon kind={item.interaction_type} size={20}/>
            <div className="min-w-0"><div className="text-xs muted">{SOURCE_KIND_LABELS[item.interaction_type]}{sourceOrigin(item)?` · ${sourceOrigin(item)}`:''}</div>
              <h3 className="font-bold text-lg leading-8">{sourceTitle(item)}</h3></div>
          </div>
          {item.interaction_type==='youtube_video'&&item.source_snapshot?.videoId&&<div className="queue-source-player">
            <iframe src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(item.source_snapshot.videoId)}`} title={sourceTitle(item)} loading="lazy"
              allow="encrypted-media; picture-in-picture; fullscreen" referrerPolicy="strict-origin-when-cross-origin" allowFullScreen/></div>}
          {sourceText(item)&&<p className="whitespace-pre-wrap leading-8">{sourceText(item)}</p>}
          <div className="text-xs muted">نُشر: {fmtDateTime(item.source_snapshot?.publishedAt)} · دخل الطابور: {fmtDateTime(item.entered_at)}</div>
          {sourceUrl(item)&&<a className="btn-ghost" href={sourceUrl(item)!} target="_blank" rel="noopener noreferrer"><ExternalLink size={15}/>{SOURCE_OPEN_LABELS[item.interaction_type]}</a>}
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
          <div className="grid grid-cols-2 gap-2">{item.media?.map((m,i)=>m.type==='photo'&&m.url?<img key={i} src={m.url} alt="وسائط التفاعل" className="rounded-lg max-h-56 object-contain"/>
            // Videos: the stored MP4 plays here; one collected without its file opens on X.
            :m.type!=='photo'&&m.url&&/^https:\/\/[^ ]+\.mp4(\?|#|$)/i.test(m.url)?<div key={i} className="col-span-2"><VideoPlayer src={m.url} poster={m.previewImageUrl} gif={m.type==='animated_gif'} fallbackUrl={item.url} title="فيديو التفاعل" className="vp-inline"/></div>
            // No MP4 stored: X's own player, embedded here.
            :m.type!=='photo'&&xPostIdOf(item.url)?<div key={i} className="col-span-2"><XVideoFrame postId={xPostIdOf(item.url)!} className="x-video-frame--inline"/></div>
            :m.url?<a key={i} href={m.url} target="_blank" rel="noreferrer" className="text-brand-600 underline">فتح الوسائط</a>:null)}</div>
          <div className="flex gap-2 flex-wrap">
            {item.url&&<a className="btn-ghost" href={item.url} target="_blank" rel="noreferrer"><ExternalLink size={15}/>فتح في X</a>}
            {item.x_author_id&&can(P.CUSTOMERS_READ)&&<button className="btn-ghost" onClick={()=>setHistory(true)}>سجل تفاعلات العميل</button>}
          </div>
        </article>}

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>المسؤول: <strong>{item.assignee_name??'غير مسند'}</strong></div><div>انتظار الإسناد: {duration(item.entered_at,item.first_assigned_at??serverNow)}</div>
          <div>{item.status==='completed'?'من الإسناد حتى الإغلاق':'في الصندوق منذ'}: {duration(item.assigned_at,item.status==='completed'?item.completed_at:serverNow)}</div><div>الإسناد الحالي: {item.assigned_at?fmtDateTime(item.assigned_at):'—'}</div>
          <div>وقت الإكمال: {duration(item.entered_at,item.status==='completed'?item.completed_at:null)}</div>{!story&&!src&&<div>تأخر الاكتشاف (معلوماتي): {duration(item.post_posted_at,item.entered_at)}</div>}
          <div>إعادة الإسناد: {item.reassignment_count}</div><div>التصعيد: {item.escalation_count}</div>
          <div>إعادة الفتح: {item.reopen_count??0}</div><div>الأولوية: {item.priority==='high'?'عالية':'عادية'}</div>
        </div>
        {change.error&&<p role="alert" className="rounded-lg p-3 bg-red-500/10 text-red-600">{change.error.message}</p>}
        <fieldset disabled={change.isPending||!!item.merged_into_id} className="space-y-3">
          {supervise&&['new','assigned','escalated','in_progress'].includes(item.status)&&<div className="space-y-2">
            <div className="flex gap-2"><select aria-label="الموظف للإسناد" className="input flex-1" value={assignee} onChange={e=>setAssignee(e.target.value)}><option value="">اختر موظف الفريق</option>{options?.members.filter(m=>m.team_id===item.team_id&&m.id!==item.assignee_id).map(m=><option key={m.id} value={m.id}>{m.full_name}{m.status?` — ${statusLabel(m.status)} · ${m.open??0} في الصندوق`:''}</option>)}</select><button className="btn-primary" disabled={!assignee||(item.status==='in_progress'&&!assignReason.trim())} onClick={()=>confirmation.request({title:item.assignee_id?'إعادة إسناد التفاعل':'إسناد التفاعل',description:`التفاعل ${id} سيُسند إلى «${options?.members.find(m=>m.id===assignee)?.full_name??assignee}»${item.assignee_id?' بدل الموظف الحالي':''}. السبب: ${assignReason||'غير مطلوب لهذه الحالة'}.`,confirmLabel:'تأكيد الإسناد',allowed:can=>can(P.QUEUE_SUPERVISE),execute:()=>change.mutateAsync({action:'assign',extra:{assigneeId:assignee,...(assignReason.trim()?{reason:assignReason}:{})}})})}>{item.status==='escalated'?'إعادة التوجيه':item.status==='new'?'إسناد':'إعادة الإسناد'}</button></div>
            {/* Taking work from someone mid-task needs a reason; the new assignee starts their own cycle. */}
            {assignee&&options?.members.find(m=>m.id===assignee&&m.team_id===item.team_id&&m.status&&m.status!=='available')&&<p className="text-xs text-amber-600">الموظف المختار ليس «متاحاً» الآن؛ الإسناد اليدوي مسموح ويُسجَّل في السجل.</p>}
            {item.status==='in_progress'&&<input aria-label="سبب إعادة الإسناد" placeholder="سبب إعادة الإسناد أثناء المعالجة (إلزامي)" className="input w-full" value={assignReason} maxLength={2000} onChange={e=>setAssignReason(e.target.value)}/>}
          </div>}
          <div className="flex gap-2">
            {item.status==='assigned'&&supervise&&<button className="btn-ghost" onClick={()=>confirmation.request({title:'إلغاء إسناد التفاعل',description:`سيعود التفاعل ${id} إلى انتظار الإسناد وفق قواعد Queue الحالية.`,confirmLabel:'إلغاء الإسناد',danger:true,allowed:can=>can(P.QUEUE_SUPERVISE),execute:()=>change.mutateAsync({action:'unassign'})})}>إلغاء الإسناد</button>}
            {item.status==='in_progress'&&supervise&&<button className="btn-ghost" disabled={!assignReason.trim()} title="اكتب السبب في حقل سبب إعادة الإسناد" onClick={()=>confirmation.request({title:'إلغاء إسناد تفاعل قيد العمل',description:`التفاعل ${id} سيخرج من صندوق الموظف الحالي. السبب: ${assignReason}.`,confirmLabel:'إلغاء الإسناد',danger:true,allowed:can=>can(P.QUEUE_SUPERVISE),execute:()=>change.mutateAsync({action:'unassign',extra:{reason:assignReason}})})}>إلغاء الإسناد</button>}
            {item.status==='completed'&&supervise&&<div className="flex gap-2 w-full"><input aria-label="سبب إعادة الفتح" className="input flex-1" placeholder="سبب إعادة الفتح (إلزامي)" maxLength={2000} value={reopenReason} onChange={e=>setReopenReason(e.target.value)}/><button className="btn-primary" disabled={!reopenReason.trim()} onClick={()=>confirmation.request({title:'إعادة فتح التفاعل',description:`سيعود التفاعل المكتمل ${id} إلى العمل وفق قواعد Queue. السبب: ${reopenReason}.`,confirmLabel:'إعادة الفتح',allowed:can=>can(P.QUEUE_SUPERVISE),execute:()=>change.mutateAsync({action:'reopen',extra:{reason:reopenReason}})})}>إعادة الفتح</button></div>}
            {item.status==='new'&&!supervise&&catalog?.selfClaim&&can(P.QUEUE_WORK)&&<button className="btn-primary" onClick={()=>change.mutate({action:'claim'})}>استلام التفاعل</button>}
          </div>
          {work&&['assigned','in_progress'].includes(item.status)&&<div className="flex gap-2"><input aria-label="سبب التصعيد" placeholder="سبب التصعيد (إلزامي)" className="input flex-1" value={reason} maxLength={2000} onChange={e=>setReason(e.target.value)}/><button className="btn-ghost" disabled={!reason.trim()} onClick={()=>change.mutate({action:'escalate',extra:{reason}})}><ArrowUpRight size={16}/>تصعيد</button></div>}
          {/* Review and close straight from the box: there is no start step. */}
          {work&&(['assigned','in_progress'].includes(item.status)||item.status==='escalated'&&supervise)&&<><QueueReview draft={reviewDraft} onDraftChange={setReviewDraft} item={item} catalog={catalog} disabled={change.isPending||!!note.trim()} onComplete={review=>change.mutate({action:'complete',extra:{review}})}/>{note.trim()&&<p className="text-sm muted">احفظ الملاحظة المكتوبة قبل إغلاق التفاعل.</p>}</>}
          {supervise&&item.status!=='completed'&&<div className="flex gap-2 flex-wrap items-center">
            <input aria-label="سبب تغيير الأولوية" className="input flex-1 min-w-[12rem]" placeholder="سبب تغيير الأولوية (إلزامي)" maxLength={2000} value={priorityReason} onChange={e=>setPriorityReason(e.target.value)}/>
            <button className="btn-ghost" disabled={!priorityReason.trim()||priority.isPending} onClick={()=>priority.mutate(item.priority==='high'?'normal':'high')}>
              <Flame size={15}/>{item.priority==='high'?'إرجاع لأولوية عادية':'أولوية عالية'}</button>
            {priority.error&&<p role="alert" className="text-sm text-red-600 w-full">{priority.error.message}</p>}
          </div>}
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
              <div className="flex gap-2"><button className="btn-primary" disabled={!toTeam||!toMember||!transferReason.trim()||transfer.isPending} onClick={()=>confirmation.request({title:'نقل التفاعل بين الفرق',description:`نقل ${id} إلى «${options?.teams.find(t=>t.id===toTeam)?.name??toTeam}» وإسناده إلى «${options?.members.find(m=>m.id===toMember)?.full_name??toMember}». السبب: ${transferReason}.`,confirmLabel:'تنفيذ النقل',allowed:can=>can(P.QUEUE_SUPERVISE),execute:()=>transfer.mutateAsync()})}>تنفيذ النقل</button>
                <button className="btn-ghost" onClick={()=>setTransferOpen(false)}>إلغاء</button></div>
              <p className="text-xs muted">يُسند العنصر للموظف المستلم ويبدأ دورة جديدة؛ يبقى الفريق والموظف السابقان في السجل.</p>
            </>}
          </div>}
          {work&&item.status!=='completed'&&<div className="space-y-2"><label className="block text-sm font-bold" htmlFor="queue-note">ملاحظة داخلية</label><textarea id="queue-note" className="input w-full" rows={3} maxLength={5000} value={note} onChange={e=>setNote(e.target.value)} placeholder="التصحيح يكون بملاحظة جديدة؛ لا يمكن تعديل الملاحظات أو حذفها."/><button className="btn-ghost" disabled={!note.trim()} onClick={()=>change.mutate({action:'notes',extra:{body:note}})}><StickyNote size={16}/>إضافة ملاحظة</button></div>}
        </fieldset>

        <QueueReviewHistory item={item} catalog={catalog}/>
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
      </>}
      {history&&item?.x_author_id&&<AuthorHistoryModal xAuthorId={item.x_author_id} onClose={()=>setHistory(false)}/>}
    </ModalSurface>;
}
