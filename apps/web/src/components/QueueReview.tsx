import {useState} from 'react';
import {QUEUE_REVIEW_OUTCOMES,QUEUE_REVIEW_OUTCOME_LABELS,type QueueReviewOutcome} from '@mip/shared';
import {INTENT_LABELS,SENTIMENT_LABELS,type QueueItem,type QueueReviewInput,type ReviewCatalog} from '../lib/queue';
import {fmtDateTime} from '../lib/format';

export function QueueReviewHistory({item,catalog}:{item:QueueItem;catalog?:ReviewCatalog}) {
  const program=(id:unknown)=>catalog?.programs.find(p=>p.id===id)?.name_ar??String(id??'غير متاح');
  const topic=(id:unknown)=>catalog?.topics.find(t=>t.id===id)?.name_ar??String(id??'غير متاح');
  const fields=[['program_id','البرنامج',program],['intent','نوع التفاعل',(v:unknown)=>INTENT_LABELS[String(v)]??'غير متاح'],
    ['sentiment','المشاعر',(v:unknown)=>SENTIMENT_LABELS[String(v)]?.text??'غير متاح'],['topic_id','التصنيف الرئيسي',topic],['subtopic_id','التصنيف الفرعي',topic],
    ['relevant','الصلة',(v:unknown)=>v?'ذو صلة':'غير ذي صلة']] as const;
  return <section className="space-y-2"><h3 className="font-bold">سجل المراجعات السابقة</h3>
    {!item.reviews?.length&&<p className="text-sm muted">لم تُسجل مراجعة بعد.</p>}
    {item.reviews?.map(r=><details key={r.id} className="rounded-lg border border-slate-200 dark:border-slate-700 p-3">
      <summary className="cursor-pointer text-sm">الدورة {r.cycle} · {QUEUE_REVIEW_OUTCOME_LABELS[r.outcome]} · {r.reviewer_name}</summary>
      <p className="text-xs muted my-2">{fmtDateTime(r.reviewed_at)}</p>
      <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th>الحقل</th><th>AI الأصلي</th><th>اعتماد الموظف</th></tr></thead>
        <tbody>{fields.map(([key,label,format])=><tr key={key}><th className="py-2">{label}</th><td>{format(r.ai[key])}</td><td>{format(r[key])}</td></tr>)}</tbody></table></div>
      {r.links_confirmed!==null&&<p className="text-sm">روابط القصة: {r.links_confirmed?'معتمدة':'تحتاج تصحيحًا'}</p>}
      {r.reason&&<p className="whitespace-pre-wrap text-sm mt-2">السبب: {r.reason}</p>}
    </details>)}
  </section>;
}

export default function QueueReview({item,catalog,onComplete,disabled}:{item:QueueItem;catalog?:ReviewCatalog;onComplete:(review:QueueReviewInput)=>void;disabled:boolean}) {
  const story=item.interaction_type==='story';
  const [outcome,setOutcome]=useState<QueueReviewOutcome|''>('');
  const [changes,setChanges]=useState<Omit<QueueReviewInput,'outcome'>>({});
  const [reason,setReason]=useState('');
  const program=changes.programId===undefined?(story?item.program_id:item.ai_program_id):changes.programId;
  const topic=changes.topicId===undefined?item.ai_topic_id:changes.topicId;
  const confidence=(v:number|null|undefined)=>v==null?'غير متاحة':`${Math.round(v*100)}٪`;
  const changed=Object.keys(changes).length>0;
  return <section className="rounded-lg border border-slate-200 dark:border-slate-700 p-3 space-y-3">
    <h3 className="font-bold">مراجعة تصنيفات الذكاء الاصطناعي</h3>
    <p className="text-xs muted">اعتمد القيم الصحيحة مباشرة، أو اختر التصحيح. تبقى القيم الأصلية محفوظة. الإغلاق يعني انتهاء مراجعة الرصد.</p>
    <dl className="grid grid-cols-2 gap-2 text-sm">
      <div><dt className="muted">البرنامج الأصلي</dt><dd>{catalog?.programs.find(p=>p.id===(story?item.program_id:item.ai_program_id))?.name_ar??'غير متاح'}</dd></div>
      {!story&&<><div><dt className="muted">نوع التفاعل</dt><dd>{INTENT_LABELS[item.intent??'']??'غير متاح'} · ثقة {confidence(item.intent_confidence)}</dd></div>
        <div><dt className="muted">التصنيف الرئيسي</dt><dd>{catalog?.topics.find(t=>t.id===item.ai_topic_id)?.name_ar??'غير متاح'}</dd></div>
        <div><dt className="muted">التصنيف الفرعي</dt><dd>{catalog?.topics.find(t=>t.id===item.ai_subtopic_id)?.name_ar??'غير متاح'}</dd></div>
        <div><dt className="muted">المشاعر</dt><dd>{SENTIMENT_LABELS[item.sentiment??'']?.text??'غير متاحة'} · ثقة {confidence(item.sentiment_confidence)}</dd></div>
        <div><dt className="muted">الصلة بالبرنامج</dt><dd>{item.relevance==='irrelevant'?'غير ذي صلة':item.relevance==='relevant'?'ذو صلة':'غير متاحة'} · ثقة {confidence(item.relevance_confidence)}</dd></div></>}
    </dl>
    <label className="queue-field">نتيجة المراجعة<select aria-label="نتيجة المراجعة" className="input" value={outcome} onChange={e=>{setOutcome(e.target.value as QueueReviewOutcome);setChanges({});setReason('');}}>
      <option value="">اختر نتيجة المراجعة</option>{QUEUE_REVIEW_OUTCOMES.map(o=><option key={o} value={o}>{QUEUE_REVIEW_OUTCOME_LABELS[o]}</option>)}</select></label>
    {outcome==='corrected'&&<div className="grid sm:grid-cols-2 gap-2">
      <label className="queue-field">البرنامج المعتمد<select className="input" value={program??''} onChange={e=>setChanges(c=>({...c,programId:e.target.value,topicId:null,subtopicId:null}))}>
        <option value="">غير متاح</option>{catalog?.programs.map(p=><option key={p.id} value={p.id}>{p.name_ar}</option>)}</select></label>
      {!story&&<>
        <label className="queue-field">نوع التفاعل المعتمد<select className="input" value={(changes.intent===undefined?item.intent:changes.intent)??''} onChange={e=>setChanges(c=>({...c,intent:e.target.value||null}))}>
          <option value="">غير متاح</option>{Object.entries(INTENT_LABELS).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
        <label className="queue-field">المشاعر المعتمدة<select className="input" value={(changes.sentiment===undefined?item.sentiment:changes.sentiment)??''} onChange={e=>setChanges(c=>({...c,sentiment:e.target.value||null}))}>
          <option value="">غير متاحة</option>{Object.entries(SENTIMENT_LABELS).map(([k,v])=><option key={k} value={k}>{v.text}</option>)}</select></label>
        <label className="queue-field">التصنيف الرئيسي المعتمد<select className="input" value={topic??''} onChange={e=>setChanges(c=>({...c,topicId:e.target.value||null,subtopicId:null}))}>
          <option value="">بدون تصنيف</option>{catalog?.topics.filter(t=>t.level===1&&t.program_id===program).map(t=><option key={t.id} value={t.id}>{t.name_ar}</option>)}</select></label>
        <label className="queue-field">التصنيف الفرعي المعتمد<select className="input" value={(changes.subtopicId===undefined?item.ai_subtopic_id:changes.subtopicId)??''} onChange={e=>setChanges(c=>({...c,subtopicId:e.target.value||null}))}>
          <option value="">بدون تصنيف</option>{catalog?.topics.filter(t=>t.level===2&&t.parent_id===topic).map(t=><option key={t.id} value={t.id}>{t.name_ar}</option>)}</select></label>
      </>}
      {story&&<label className="queue-field">روابط القصة<select className="input" value={changes.linksConfirmed===false?'false':'true'} onChange={e=>setChanges(c=>({...c,linksConfirmed:e.target.value==='true'}))}><option value="true">صحيحة</option><option value="false">تحتاج تصحيحًا</option></select></label>}
    </div>}
    {(outcome==='corrected'||outcome==='irrelevant')&&<label className="queue-field">سبب {outcome==='corrected'?'التصحيح':'الاستبعاد'} (إلزامي)<textarea aria-label="سبب المراجعة" className="input" maxLength={2000} value={reason} onChange={e=>setReason(e.target.value)}/></label>}
    <button className="btn-primary" disabled={disabled||!outcome||outcome==='corrected'&&(!changed||!reason.trim())||outcome==='irrelevant'&&!reason.trim()}
      onClick={()=>outcome&&onComplete({outcome,...changes,...(outcome==='irrelevant'?{relevant:false}:{}),...(reason.trim()?{reason}: {})})}>إغلاق التفاعل</button>
  </section>;
}
