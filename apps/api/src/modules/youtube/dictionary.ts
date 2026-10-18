import type {YouTubeSql} from '@mip/db/src/youtube-test-client.js';

export interface DictionaryWord {id:string;term:string;type:string;match_mode:string}
const literal=(value:string)=>`"${value.replace(/["|\u0000-\u001f]/g,' ').replace(/^[-#@]+/,'').replace(/_/g,' ').replace(/\s+/g,' ').trim()}"`;
/** Separate searches preserve each phrase and its exclusions without relying on OR precedence. */
export function compileProgram(words:DictionaryWord[],programKey?:string){
 if(programKey){
  const seeds:Record<string,string[]>={ejar:['منصة إيجار','منصة ايجار','شبكة إيجار','توثيق عقد الإيجار','عقد الإيجار الإلكتروني'],mullak:['منصة ملاك','برنامج ملاك','جمعية الملاك السعودية','اتحاد الملاك السعودية'],mostadam:['برنامج البناء المستدام','شهادة مستدام','تقييم مستدام','منصة مستدام'],rega:['الهيئة العامة للعقار','هيئة العقار','رخصة فال','الوساطة العقارية السعودية','فرز الوحدات العقارية']};
  const terms=seeds[programKey];
  if(terms){
   const base=terms.map((term,index)=>({keywordId:`${programKey}-${index}`,term,type:'primary',q:literal(term),valid:true}));
   const extra=words.filter(w=>['service','related'].includes(w.type)&&!['mention','from','to'].includes(w.match_mode)).map(w=>{
    const q=`${literal(terms[0])} ${literal(w.term)}`;
    return {keywordId:w.id,term:w.term,type:w.type,q,valid:q.length<=500};
   });
   // One OR-search over every core phrase (search.list supports `|`). The cycle runs it before the rotating queries, so a
   // single search unit re-covers the whole program; appended last to keep the names (and watermarks) of the others stable.
   const sweepQ=terms.map(literal).join('|');
   const sweep={keywordId:`${programKey}-sweep`,term:'مسح شامل لعبارات البرنامج',type:'sweep',q:sweepQ,valid:sweepQ.length<=500};
   return [...base,...extra,sweep];
  }
 }
 const usable=words.filter(w=>!['mention','from','to'].includes(w.match_mode));
 const unique=(xs:string[])=>[...new Set(xs)];
 const anchors=unique(usable.filter(w=>w.type==='primary').map(w=>literal(w.term)));
 const negatives=unique(usable.filter(w=>w.type==='negative').map(w=>literal(w.term)));
 const candidates=usable.filter(w=>['primary','service','related'].includes(w.type)).flatMap(w=>{
  const term=literal(w.term);
  return w.type==='related'?anchors.map(anchor=>({word:w,q:`${anchor} ${term}`})):[{word:w,q:term}];
 });
 const seen=new Set<string>();
 return candidates.map(({word,q})=>({keywordId:word.id,term:word.term,type:word.type,q:[q,...negatives.map(n=>`-${n}`)].join(' ')}))
  .filter(row=>{if(seen.has(row.q))return false;seen.add(row.q);return true;})
  .map(row=>({...row,valid:row.q.length<=500}));
}
export async function dictionaryPlans(db:YouTubeSql){
 const programs=await db<{id:string;key:string;name_ar:string}[]>`SELECT id,key,name_ar FROM programs WHERE is_active AND deleted_at IS NULL ORDER BY name_ar`;
 const result=[];
 for(const program of programs){
  const words=await db<DictionaryWord[]>`SELECT k.id,k.term,k.type,k.match_mode FROM keywords k JOIN keyword_groups g ON g.id=k.group_id
   WHERE coalesce(k.program_id,g.program_id)=${program.id} AND k.is_active AND g.is_active ORDER BY k.type,k.term`;
  result.push({...program,words,queries:compileProgram(words,program.key),excludedXOperators:words.filter(w=>['mention','from','to'].includes(w.match_mode)).length});
 }
 return result;
}
export async function syncDictionary(db:YouTubeSql){
 const plans=await dictionaryPlans(db);
 if(plans.some(p=>p.queries.some(q=>!q.valid)))throw new Error('استعلام يتجاوز 500 حرف؛ قلل كلمات الاستبعاد قبل المزامنة');
 await db.begin(async tx=>{
  await tx`SELECT pg_advisory_xact_lock(hashtext('youtube-dictionary-sync'))`;
  // Existing prototype queries remain visible but cannot collect alongside the authoritative dictionary.
  await tx`UPDATE youtube_search_queries SET is_active=false`;
  for(const p of plans)for(const [index,q] of p.queries.entries()){
   const name=`dictionary:${p.key}:${q.keywordId}:${index}`;
   await tx`INSERT INTO youtube_search_queries(program_key,name,q) VALUES(${p.key},${name},${q.q})
    ON CONFLICT(name) DO UPDATE SET q=EXCLUDED.q,is_active=true,
     published_after_watermark=CASE WHEN youtube_search_queries.q=EXCLUDED.q THEN youtube_search_queries.published_after_watermark ELSE NULL END,
     pending_page_token=CASE WHEN youtube_search_queries.q=EXCLUDED.q THEN youtube_search_queries.pending_page_token ELSE NULL END,
     pending_after=CASE WHEN youtube_search_queries.q=EXCLUDED.q THEN youtube_search_queries.pending_after ELSE NULL END,
     pending_before=CASE WHEN youtube_search_queries.q=EXCLUDED.q THEN youtube_search_queries.pending_before ELSE NULL END`;
  }
 });
 return plans;
}
