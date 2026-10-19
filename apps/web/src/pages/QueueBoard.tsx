import { ModalCloseButton } from '../components/ModalSurface';
import {useState} from 'react';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {AGENT_STATUSES,PERMISSIONS as P,STATUS_SOURCE_LABELS,type AgentStatus} from '@mip/shared';
import {api} from '../lib/api';
import {useAuth} from '../lib/auth';
import {hours,statusLabel,type BoardAgent} from '../lib/workforce';
import {fmtDateTime} from '../lib/format';
import QueueBoardOverview, {type BoardAction} from '../components/queue-board/QueueBoardOverview';
import Dialog from '../components/queue-board/DialogSurface';

import { Button } from '../components/ui/Button';
export default function QueueBoard() {
  const {can}=useAuth();
  const [action,setAction]=useState<{agent:BoardAgent;kind:BoardAction;range:string}|null>(null);
  const permitted=can(P.QUEUE_SUPERVISE,P.QUEUE_VIEW_ALL);
  return <>
    <QueueBoardOverview onAction={(agent,kind,range)=>{if(permitted)setAction({agent,kind,range});}}/>
    {permitted&&action?.kind==='status'&&<StatusDialog agent={action.agent} onClose={()=>setAction(null)}/>}
    {permitted&&action?.kind==='release'&&<ReleaseDialog agent={action.agent} onClose={()=>setAction(null)}/>}
    {permitted&&action?.kind==='periods'&&<PeriodsDialog agent={action.agent} range={action.range} onClose={()=>setAction(null)}/>}
  </>;
}

function StatusDialog({agent,onClose}:{agent:BoardAgent;onClose:()=>void}) {
  const qc=useQueryClient();const [status,setStatus]=useState<AgentStatus>(agent.status);const [reason,setReason]=useState('');
  const save=useMutation({mutationFn:()=>api.post(`/workforce/agents/${agent.id}/status`,{status,reason}),
    onSuccess:()=>{qc.invalidateQueries({queryKey:['workforce']});onClose();}});
  return <Dialog title={`تغيير حالة ${agent.full_name}`} onClose={onClose} busy={save.isPending}>
    <div className="space-y-3">
      <select aria-label="الحالة الجديدة" className="input w-full" value={status} onChange={e=>setStatus(e.target.value as AgentStatus)}>
        {AGENT_STATUSES.map(s=><option key={s} value={s}>{statusLabel(s)}</option>)}</select>
      <input aria-label="السبب" className="input w-full" placeholder="السبب (إلزامي، يُسجل في سجل التدقيق)" maxLength={2000} value={reason} onChange={e=>setReason(e.target.value)}/>
      {save.error&&<p role="alert" className="text-sm text-(--status-danger)">{save.error.message}</p>}
      <div className="flex gap-2"><Button variant="primary" type="submit" disabled={!reason.trim()||save.isPending||status===agent.status} onClick={()=>save.mutate()}>حفظ</Button>
        <ModalCloseButton className="btn-ghost" onClick={onClose}>إلغاء</ModalCloseButton></div>
    </div></Dialog>;
}

function ReleaseDialog({agent,onClose}:{agent:BoardAgent;onClose:()=>void}) {
  const qc=useQueryClient();const [reason,setReason]=useState('');
  const run=useMutation({mutationFn:()=>api.post<{released:number;reassigned:number}>(`/workforce/agents/${agent.id}/release`,{reason}),
    onSuccess:()=>{qc.invalidateQueries({queryKey:['workforce']});qc.invalidateQueries({queryKey:['queue']});}});
  return <Dialog title={`إعادة توزيع صندوق ${agent.full_name}`} onClose={onClose} busy={run.isPending}>
    {run.data?<div className="space-y-3"><p>أُعيد {run.data.released} تفاعل إلى الطابور، وأُسند منها {run.data.reassigned} تلقائياً لموظفين متاحين.</p>
      <ModalCloseButton className="btn-primary" onClick={onClose}>تم</ModalCloseButton></div>:
    <div className="space-y-3">
      <p className="text-sm">يُعاد {agent.open} تفاعل (غير المصعّد) إلى الطابور ثم يُوزَّع على الموظفين المتاحين. يبقى كل شيء في سجل العنصر.
        {agent.status==='available'&&<strong className="block mt-1 text-(--status-warning)">الموظف «متاح» الآن وقد يستلم بعضها مجدداً؛ غيّر حالته أولاً إن لزم.</strong>}</p>
      <input aria-label="السبب" className="input w-full" placeholder="السبب (إلزامي)" maxLength={2000} value={reason} onChange={e=>setReason(e.target.value)}/>
      {run.error&&<p role="alert" className="text-sm text-(--status-danger)">{run.error.message}</p>}
      <div className="flex gap-2"><Button variant="primary" type="submit" disabled={!reason.trim()||run.isPending} onClick={()=>run.mutate()}>إعادة التوزيع</Button>
        <ModalCloseButton className="btn-ghost" onClick={onClose}>إلغاء</ModalCloseButton></div>
    </div>}</Dialog>;
}

interface Period {id:string;status:AgentStatus;previous_status:string|null;started_at:string;ended_at:string|null;source:string;reason:string|null;
  end_source:string|null;end_reason:string|null;corrected_count:number;seconds:number;actor_name:string|null;
  corrections:Array<{reason:string;at:string;by:string;old:{status:string;startedAt:string;endedAt:string};new:{status:string;startedAt:string;endedAt:string}}>}

/** The record behind every total: each period, who opened/ended it, and any correction. */
function PeriodsDialog({agent,range,onClose}:{agent:BoardAgent;range:string;onClose:()=>void}) {
  const {can}=useAuth();const qc=useQueryClient();
  const {data,isLoading,error,refetch}=useQuery({queryKey:['workforce','periods',agent.id,range],queryFn:()=>api.get<{items:Period[]}>(`/workforce/periods?${range}&employeeId=${agent.id}`)});
  const [edit,setEdit]=useState<Period|null>(null);const [form,setForm]=useState({status:'',startedAt:'',endedAt:'',reason:''});
  const local=(iso:string)=>{const d=new Date(iso);const z=new Date(d.getTime()+3*3600000);return z.toISOString().slice(0,16);};
  const toIso=(v:string)=>new Date(v+':00+03:00').toISOString();
  const save=useMutation({mutationFn:()=>api.post(`/workforce/periods/${edit!.id}/correct`,{
      ...(form.status!==edit!.status?{status:form.status}:{}),
      ...(form.startedAt!==local(edit!.started_at)?{startedAt:toIso(form.startedAt)}:{}),
      ...(edit!.ended_at&&form.endedAt!==local(edit!.ended_at)?{endedAt:toIso(form.endedAt)}:{}),reason:form.reason}),
    onSuccess:()=>{setEdit(null);qc.invalidateQueries({queryKey:['workforce']});}});
  return <Dialog title={`سجل حالات ${agent.full_name}`} onClose={onClose} busy={save.isPending}>
    {isLoading&&<p className="muted">جارٍ التحميل…</p>}
    {error&&<p role="alert" className="text-(--status-danger)">{error.message} <button className="underline" onClick={()=>refetch()}>إعادة المحاولة</button></p>}
    {!isLoading&&!error&&!data?.items.length&&<p className="muted text-sm">لا توجد سجلات في هذه الفترة.</p>}
    <ol className="space-y-2 max-h-[60vh] overflow-y-auto">{data?.items.map(p=><li key={p.id} className="rounded-lg border border-slate-200 dark:border-slate-700 p-2.5 text-sm">
      <div className="flex items-center gap-2 flex-wrap"><span className={`wf-status-chip agent-status--${p.status}`}><span className="agent-status-dot" aria-hidden="true"/>{statusLabel(p.status)}</span>
        <span className="muted text-xs">{hours(p.seconds)}</span>{p.corrected_count>0&&<span className="queue-tag queue-tag--hold">مُصحَّح</span>}
        {can(P.WORKFORCE_CORRECT)&&p.ended_at&&<button disabled={save.isPending} className="ms-auto text-xs underline text-brand-600" onClick={()=>{setEdit(p);setForm({status:p.status,startedAt:local(p.started_at),endedAt:local(p.ended_at!),reason:''});}}>تصحيح</button>}</div>
      <p className="text-xs muted mt-1">{fmtDateTime(p.started_at)} ← {p.ended_at?fmtDateTime(p.ended_at):'جارية'}</p>
      <p className="text-xs muted">بدأها: {STATUS_SOURCE_LABELS[p.source as keyof typeof STATUS_SOURCE_LABELS]}{p.actor_name&&p.source==='supervisor'?` (${p.actor_name})`:''}{p.reason?` — ${p.reason}`:''}
        {p.end_source?` · أنهاها: ${STATUS_SOURCE_LABELS[p.end_source as keyof typeof STATUS_SOURCE_LABELS]}${p.end_reason?` — ${p.end_reason}`:''}`:''}</p>
      {p.corrections.map((c,i)=><p key={i} className="text-xs text-(--status-warning)">تصحيح {c.by} ({fmtDateTime(c.at)}): {statusLabel(c.old.status)} ← {statusLabel(c.new.status)} — {c.reason}</p>)}
      {edit?.id===p.id&&<div className="mt-2 space-y-2">
        <select aria-label="الحالة" className="input w-full" value={form.status} onChange={e=>setForm(f=>({...f,status:e.target.value}))}>{AGENT_STATUSES.map(s=><option key={s} value={s}>{statusLabel(s)}</option>)}</select>
        <div className="grid grid-cols-2 gap-2"><label className="queue-field">البداية (الرياض)<input type="datetime-local" className="input" value={form.startedAt} onChange={e=>setForm(f=>({...f,startedAt:e.target.value}))}/></label>
          <label className="queue-field">النهاية (الرياض)<input type="datetime-local" className="input" value={form.endedAt} onChange={e=>setForm(f=>({...f,endedAt:e.target.value}))}/></label></div>
        <input aria-label="سبب التصحيح" className="input w-full" placeholder="سبب التصحيح (إلزامي)" value={form.reason} maxLength={2000} onChange={e=>setForm(f=>({...f,reason:e.target.value}))}/>
        {save.error&&<p role="alert" className="text-xs text-(--status-danger)">{save.error.message}</p>}
        <div className="flex gap-2"><Button variant="primary" type="submit" disabled={!form.reason.trim()||save.isPending} onClick={()=>save.mutate()}>حفظ التصحيح</Button><Button variant="ghost" type="submit" disabled={save.isPending} onClick={()=>setEdit(null)}>إلغاء</Button></div>
      </div>}
    </li>)}</ol>
  </Dialog>;
}
