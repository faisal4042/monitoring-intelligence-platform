import {useEffect,useState} from 'react';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {Link} from 'react-router-dom';
import {Settings2,X,MonitorDot} from 'lucide-react';
import {AGENT_STATUSES,PERMISSIONS as P,QUEUE_INTENTS,QUEUE_SECTIONS,QUEUE_SECTION_LABELS,type AgentStatus,type QueueSection} from '@mip/shared';
import {api} from '../lib/api';
import {useAuth} from '../lib/auth';
import {INTENT_LABELS,type QueueOptions} from '../lib/queue';
import {SOURCE_LABELS,statusLabel,type Effective,type SettingsOverview,type SystemSettings} from '../lib/workforce';

type Fields={programIds:string[]|null;intents:string[]|null;sections:string[]|null;maxOpen:number|null;autoAssign:boolean|null;acceptsHighPriority:boolean|null};
const FIELD_LABELS:Record<keyof Fields,string>={programIds:'البرامج المسموحة',intents:'أنواع التفاعلات المسموحة',sections:'المسارات المسموحة',
  maxOpen:'الحد الأعلى للصندوق',autoAssign:'الإسناد التلقائي',acceptsHighPriority:'يستقبل الأولوية العالية'};

/**
 * Per-agent queue settings. Every value is inherited (system → team → agent)
 * unless set explicitly; the page always says which. Each save is audited by
 * the server and immediately triggers an assignment attempt.
 */
export default function QueueWorkforceSettings() {
  const {can}=useAuth();
  const {data,error,isLoading}=useQuery({queryKey:['workforce','settings'],queryFn:()=>api.get<SettingsOverview>('/workforce/settings')});
  const {data:options}=useQuery({queryKey:['queue-options'],queryFn:()=>api.get<QueueOptions>('/queue/options')});
  const [editing,setEditing]=useState<{kind:'team'|'agent';id:string}|null>(null);
  const programName=(id:string)=>options?.programs.find(p=>p.id===id)?.name_ar??'برنامج';
  return <div className="space-y-4">
    <div className="page-heading"><div>
      <p className="eyebrow">QUEUE SETTINGS</p><h1 className="flex items-center gap-2"><Settings2 size={22}/>إعدادات موظفي الطابور</h1>
      <p>القيمة الافتراضية للفريق تنطبق على كل موظفيه ما لم تُخصَّص للموظف. كل تعديل يُسجَّل في سجل التدقيق.</p>
    </div><Link className="btn-ghost" to="/queue/board"><MonitorDot size={16}/>لوحة الفرق</Link></div>
    <SystemCard editable={can(P.SETTINGS_WRITE)}/>
    {error&&<p role="alert" className="card p-4 text-red-600">{error.message}</p>}
    {isLoading&&<div className="card p-8 text-center muted">جارٍ التحميل…</div>}
    {data?.teams.map(t=><section key={t.id} className="card p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap"><h2 className="font-bold">{t.name}</h2>
        <button className="btn-ghost" onClick={()=>setEditing({kind:'team',id:t.id})}>تعديل الافتراضي للفريق</button></div>
      <EffectiveSummary effective={t.effective} programName={programName} team/>
      <div className="dash-table-wrap"><table className="dash-table wf-table">
        <thead><tr><th>الموظف</th><th>الحالة</th><th>المفتوح / الحد</th><th>الإسناد التلقائي</th><th>المسارات</th><th>البرامج</th><th>الأنواع</th><th>أولوية عالية</th><th><span className="sr-only">تعديل</span></th></tr></thead>
        <tbody>{data.agents.filter(a=>a.team_id===t.id).map(a=><tr key={a.id}>
          <td><strong className="block">{a.full_name}</strong><span className="text-xs muted" dir="ltr">{a.email}</span></td>
          <td><span className={`wf-status-chip agent-status--${a.status}`}><span className="agent-status-dot" aria-hidden="true"/>{statusLabel(a.status)}</span></td>
          <td><Val v={`${a.open} / ${a.effective.maxOpen.value}`} from={a.effective.maxOpen.from}/></td>
          <td><Val v={a.effective.autoAssign.value?'مفعّل':'معطّل'} from={a.effective.autoAssign.from}/></td>
          <td><Val v={listText(a.effective.sections.value,s=>QUEUE_SECTION_LABELS[s as QueueSection].ar,'كل المسارات')} from={a.effective.sections.from}/></td>
          <td><Val v={listText(a.effective.programIds.value,programName,'كل برامج الفريق')} from={a.effective.programIds.from}/></td>
          <td><Val v={listText(a.effective.intents.value,i=>INTENT_LABELS[i]??i,'كل الأنواع')} from={a.effective.intents.from}/></td>
          <td><Val v={a.effective.acceptsHighPriority.value?'نعم':'لا'} from={a.effective.acceptsHighPriority.from}/></td>
          <td><button className="btn-ghost !px-2 !py-1 text-xs" onClick={()=>setEditing({kind:'agent',id:a.id})}>تخصيص</button></td>
        </tr>)}
        {!data.agents.some(a=>a.team_id===t.id)&&<tr><td colSpan={9} className="muted text-sm">لا يوجد موظفو رصد في هذا الفريق.</td></tr>}</tbody></table></div>
    </section>)}
    {data&&!data.teams.length&&<p className="card p-6 muted text-center">لا توجد فرق ضمن نطاقك.</p>}
    {editing&&data&&<Editor overview={data} target={editing} programName={programName} onClose={()=>setEditing(null)}/>}
  </div>;
}

const listText=(v:string[]|null,label:(x:string)=>string,all:string)=>v===null?all:v.length?v.map(label).join('، '):'لا شيء';
function Val({v,from}:{v:string;from:keyof typeof SOURCE_LABELS}) {
  return <span className="block"><span>{v}</span><span className={`wf-source wf-source--${from}`}>{SOURCE_LABELS[from]}</span></span>;
}
function EffectiveSummary({effective,programName,team}:{effective:Effective;programName:(id:string)=>string;team?:boolean}) {
  return <dl className="wf-summary">
    <div><dt>الحد الأعلى</dt><dd><Val v={String(effective.maxOpen.value)} from={effective.maxOpen.from}/></dd></div>
    <div><dt>الإسناد التلقائي</dt><dd><Val v={effective.autoAssign.value?'مفعّل':'معطّل'} from={effective.autoAssign.from}/></dd></div>
    <div><dt>المسارات</dt><dd><Val v={listText(effective.sections.value,s=>QUEUE_SECTION_LABELS[s as QueueSection].ar,'كل المسارات')} from={effective.sections.from}/></dd></div>
    <div><dt>البرامج</dt><dd><Val v={listText(effective.programIds.value,programName,team?'كل برامج الفريق':'كل برامج الفريق')} from={effective.programIds.from}/></dd></div>
    <div><dt>الأنواع</dt><dd><Val v={listText(effective.intents.value,i=>INTENT_LABELS[i]??i,'كل الأنواع')} from={effective.intents.from}/></dd></div>
    <div><dt>أولوية عالية</dt><dd><Val v={effective.acceptsHighPriority.value?'نعم':'لا'} from={effective.acceptsHighPriority.from}/></dd></div>
  </dl>;
}

/** One editor for a team default or an agent override; "موروث" stores NULL (inherit). */
function Editor({overview,target,programName,onClose}:{overview:SettingsOverview;target:{kind:'team'|'agent';id:string};programName:(id:string)=>string;onClose:()=>void}) {
  const qc=useQueryClient();
  const row=target.kind==='team'?overview.teams.find(t=>t.id===target.id)!:overview.agents.find(a=>a.id===target.id)!;
  const team=overview.teams.find(t=>t.id===(target.kind==='team'?target.id:(row as SettingsOverview['agents'][number]).team_id))!;
  const [f,setF]=useState<Fields>({programIds:row.program_ids,intents:row.intents,sections:row.sections,maxOpen:row.max_open,autoAssign:row.auto_assign,acceptsHighPriority:row.accepts_high_priority});
  const save=useMutation({mutationFn:()=>api.put(target.kind==='team'?`/workforce/settings/teams/${target.id}`:`/workforce/settings/agents/${target.id}`,f),
    onSuccess:()=>{qc.invalidateQueries({queryKey:['workforce']});qc.invalidateQueries({queryKey:['queue']});onClose();}});
  const inheritFrom=target.kind==='team'?'افتراضي النظام':'افتراضي الفريق';
  const set=<K extends keyof Fields>(k:K,v:Fields[K])=>setF(o=>({...o,[k]:v}));
  const inherit=(k:keyof Fields,def:Fields[keyof Fields])=><label className="wf-inherit"><input type="checkbox" checked={f[k]===null} onChange={e=>set(k,e.target.checked?null:def as never)}/>موروث ({inheritFrom})</label>;
  const toggle=(k:'programIds'|'intents'|'sections',v:string)=>set(k,(f[k]??[]).includes(v)?(f[k]??[]).filter(x=>x!==v):[...(f[k]??[]),v]);
  return <div className="modal-overlay" onClick={onClose}>
    <div className="card modal-card p-5 w-full max-w-2xl" role="dialog" aria-modal="true" aria-label="تعديل الإعدادات" onClick={e=>e.stopPropagation()}>
      <button className="icon-button absolute top-4 end-4" aria-label="إغلاق" onClick={onClose}><X size={18}/></button>
      <h3 className="font-bold text-lg mb-1">{target.kind==='team'?`الافتراضي لفريق ${team.name}`:`تخصيص ${(row as SettingsOverview['agents'][number]).full_name}`}</h3>
      <p className="text-sm muted mb-4">الحقل «الموروث» يأخذ قيمته من {inheritFrom}. القيمة الحالية الفعلية معروضة في الجدول.</p>
      <div className="space-y-4 max-h-[65vh] overflow-y-auto">
        <fieldset className="wf-fieldset"><legend>{FIELD_LABELS.maxOpen}</legend>{inherit('maxOpen',5)}
          {f.maxOpen!==null&&<input type="number" min={0} max={200} className="input w-32" aria-label={FIELD_LABELS.maxOpen} value={f.maxOpen} onChange={e=>set('maxOpen',Math.max(0,Math.min(200,Number(e.target.value)||0)))}/>}</fieldset>
        <fieldset className="wf-fieldset"><legend>{FIELD_LABELS.autoAssign}</legend>{inherit('autoAssign',true)}
          {f.autoAssign!==null&&<label className="wf-check"><input type="checkbox" checked={f.autoAssign} onChange={e=>set('autoAssign',e.target.checked)}/>يستقبل الإسناد التلقائي</label>}</fieldset>
        <fieldset className="wf-fieldset"><legend>{FIELD_LABELS.acceptsHighPriority}</legend>{inherit('acceptsHighPriority',true)}
          {f.acceptsHighPriority!==null&&<label className="wf-check"><input type="checkbox" checked={f.acceptsHighPriority} onChange={e=>set('acceptsHighPriority',e.target.checked)}/>يُسند إليه ما رفعه المشرف لأولوية عالية</label>}</fieldset>
        <fieldset className="wf-fieldset"><legend>{FIELD_LABELS.sections}</legend>{inherit('sections',[...QUEUE_SECTIONS])}
          {f.sections!==null&&<div className="wf-checks">{QUEUE_SECTIONS.map(s=><label key={s} className="wf-check"><input type="checkbox" checked={f.sections!.includes(s)} onChange={()=>toggle('sections',s)}/>{QUEUE_SECTION_LABELS[s].ar}</label>)}</div>}</fieldset>
        <fieldset className="wf-fieldset"><legend>{FIELD_LABELS.programIds}</legend>{inherit('programIds',team.team_program_ids)}
          {f.programIds!==null&&<div className="wf-checks">{team.team_program_ids.map(p=><label key={p} className="wf-check"><input type="checkbox" checked={f.programIds!.includes(p)} onChange={()=>toggle('programIds',p)}/>{programName(p)}</label>)}
            {!team.team_program_ids.length&&<span className="text-sm muted">لا توجد برامج مرتبطة بالفريق.</span>}</div>}</fieldset>
        <fieldset className="wf-fieldset"><legend>{FIELD_LABELS.intents}</legend>{inherit('intents',[...QUEUE_INTENTS])}
          {f.intents!==null&&<div className="wf-checks">{QUEUE_INTENTS.map(i=><label key={i} className="wf-check"><input type="checkbox" checked={f.intents!.includes(i)} onChange={()=>toggle('intents',i)}/>{INTENT_LABELS[i]}</label>)}</div>}
          <p className="text-xs muted mt-1">لا تنطبق على القصص (لا نوع تفاعل للقصة).</p></fieldset>
      </div>
      {save.error&&<p role="alert" className="text-sm text-red-600 mt-3">{save.error.message}</p>}
      <div className="flex gap-2 mt-4"><button className="btn-primary" disabled={save.isPending} onClick={()=>save.mutate()}>حفظ</button><button className="btn-ghost" onClick={onClose}>إلغاء</button></div>
    </div></div>;
}

/** System-wide assignment and time policy (settings:write to change). */
function SystemCard({editable}:{editable:boolean}) {
  const qc=useQueryClient();
  const {data}=useQuery({queryKey:['workforce','system'],queryFn:()=>api.get<SystemSettings>('/workforce/system-settings')});
  const [f,setF]=useState<SystemSettings|null>(null);
  useEffect(()=>{if(data)setF(data);},[data]);
  const save=useMutation({mutationFn:()=>api.put('/workforce/system-settings',f),onSuccess:()=>{qc.invalidateQueries({queryKey:['workforce']});}});
  if(!f)return null;
  const num=(k:keyof SystemSettings,label:string,min:number,max:number,unit:string)=><label className="queue-field">{label}
    <span className="flex items-center gap-2"><input type="number" className="input w-28" min={min} max={max} disabled={!editable} value={f[k] as number}
      onChange={e=>setF({...f,[k]:Number(e.target.value)})}/><span className="text-xs muted">{unit}</span></span></label>;
  return <section className="card p-4 space-y-3">
    <h2 className="font-bold">سياسة الإسناد والوقت</h2>
    <label className="wf-check text-base"><input type="checkbox" disabled={!editable} checked={f.autoAssignEnabled} onChange={e=>setF({...f,autoAssignEnabled:e.target.checked})}/>
      <strong>تفعيل الإسناد التلقائي</strong></label>
    <p className="text-xs muted">عند التفعيل تُوزَّع العناصر المنتظرة حالياً على الموظفين «المتاحين» فوراً.</p>
    <div className="wf-system">
      <div className="queue-field">ترتيب أولوية المسارات
        <span className="flex gap-2 flex-wrap">{[0,1,2].map(i=><select key={i} className="input" disabled={!editable} aria-label={`المرتبة ${i+1}`} value={f.laneOrder[i]}
          onChange={e=>{const next=[...f.laneOrder];const j=next.indexOf(e.target.value);next[j]=next[i];next[i]=e.target.value;setF({...f,laneOrder:next});}}>
          {QUEUE_SECTIONS.map(s=><option key={s} value={s}>{i+1}. {QUEUE_SECTION_LABELS[s].ar}</option>)}</select>)}</span></div>
      {num('starvationMinutes','منع التجويع: يتقدم المنتظر بعد',1,10080,'دقيقة')}
      {num('defaultMaxOpen','الحد الافتراضي للصندوق',0,200,'تفاعل')}
      {num('heartbeatTimeoutMinutes','انقطاع الجلسة بعد',2,240,'دقيقة دون إشارة')}
      {num('maxStatusHours','أقصى مدة لحالة واحدة',1,24,'ساعة')}
    </div>
    <div className="queue-field">الحالات المحسوبة وقت عمل تشغيلي
      <span className="wf-checks">{AGENT_STATUSES.filter(s=>s!=='offline').map(s=><label key={s} className="wf-check"><input type="checkbox" disabled={!editable}
        checked={f.operationalStatuses.includes(s)} onChange={()=>setF({...f,operationalStatuses:f.operationalStatuses.includes(s)?f.operationalStatuses.filter(x=>x!==s):[...f.operationalStatuses,s as AgentStatus]})}/>{statusLabel(s)}</label>)}</span></div>
    {editable?<div className="flex gap-2 items-center"><button className="btn-primary" disabled={save.isPending||!f.operationalStatuses.length} onClick={()=>save.mutate()}>حفظ السياسة</button>
      {save.isSuccess&&<span className="text-sm text-emerald-600">حُفظت</span>}{save.error&&<span role="alert" className="text-sm text-red-600">{save.error.message}</span>}</div>
      :<p className="text-xs muted">التعديل لمن يملك صلاحية إعدادات النظام.</p>}
  </section>;
}
