import type {YouTubeSql} from '@mip/db/src/youtube-test-client.js';
export const normalize=(s:string)=>s.normalize('NFKC').replace(/[\u064B-\u065F\u0670\u0640]/g,'').replace(/[أإآ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه').replace(/[^\p{L}\p{N}]+/gu,' ').toLowerCase().trim();
const phrases:Record<string,string[]>={
 ejar:['منصة إيجار','شبكة إيجار','برنامج إيجار','ejar.sa','ejar platform','عقد الإيجار الإلكتروني','عقد إيجار إلكتروني','توثيق عقد الإيجار','توثيق عقود الإيجار','عقود إيجار موثقة'],
 mullak:['منصة ملاك','برنامج ملاك','جمعية الملاك','جمعيات الملاك','اتحاد الملاك','اتحاد ملاك العقار','mullak.sa'],
 rega:['الهيئة العامة للعقار','هيئة العقار','رخصة فال','رخصة الوساطة العقارية','فال العقارية','فرز الوحدات العقارية','rega.gov.sa'],
 mostadam:['برنامج البناء المستدام','شهادة مستدام','تقييم مستدام','منصة مستدام','البناء المستدام السعودية','mostadam'],
};
const hitsIn=(program:string,value:string)=>{const text=' '+normalize(value)+' ';return (phrases[program]??[]).filter(p=>text.includes(' '+normalize(p)+' '));};
/**
 * Only the title (or a channel registered for the program) makes a video relevant on its own.
 * Uploaders stuff descriptions with popular names (e.g. «الهيئة العامة للعقار» under a car or
 * land listing) to be found, so a description-only match waits for a person and never feeds the queue.
 */
export function assessRelevance(program:string,title:string,description:string,fromTrackedChannel=false){
 const titleHits=hitsIn(program,title);
 if(titleHits.length)return {status:'matched',reason:'عبارة البرنامج في عنوان المقطع؛ يحتاج اعتمادًا بشريًا',terms:titleHits};
 // A channel the team registered for this program (e.g. the program's own channel) is relevant by source, not by wording.
 if(fromTrackedChannel)return {status:'matched',reason:'منشور في قناة متابعة لهذا البرنامج؛ يحتاج اعتمادًا بشريًا',terms:[]};
 const descriptionHits=hitsIn(program,description);
 if(descriptionHits.length)return {status:'needs_review',reason:'عبارة البرنامج في الوصف فقط (غالبًا حشو كلمات لجلب المشاهدات)؛ لا يدخل الطابور إلا باعتماد بشري',terms:descriptionHits};
 if(program==='mullak'&&/ملاك عسكر|نبض الخليج|hoa|homeowners association/i.test(title+' '+description))return {status:'excluded',reason:'اسم شخص أو جمعية خارج سياق البرنامج السعودي',terms:[]};
 if(!/[\u0600-\u06ff]/.test(title+' '+description)&&!normalize(title+' '+description).includes('saudi'))return {status:'excluded',reason:'لا توجد إشارة عربية أو سياق سعودي واضح؛ يمكن تعديل القرار يدويًا',terms:[]};
 return {status:'needs_review',reason:'لا يوجد تطابق صريح مع عبارات البرنامج',terms:[]};
}
export async function linkVideoProgram(db:YouTubeSql,videoId:string,queryId:string|null,title:string,description:string,programKey?:string){
 const q=programKey?{program_key:programKey}:(await db`SELECT program_key FROM youtube_search_queries WHERE id=${queryId}`)[0];
 if(!q)return;
 const a=assessRelevance(q.program_key,title,description,!!programKey);
 await db`INSERT INTO youtube_video_programs(video_id,program_key,query_id,suggested_status,reason,matched_terms)
  VALUES(${videoId},${q.program_key},${queryId},${a.status},${a.reason},${a.terms})
  ON CONFLICT(video_id,program_key) DO UPDATE SET suggested_status=EXCLUDED.suggested_status,reason=EXCLUDED.reason,matched_terms=EXCLUDED.matched_terms`;
}
export async function refreshRelevance(db:YouTubeSql){
 const rows=await db`SELECT vp.video_id,vp.program_key,v.title,v.description,
  vp.suggested_status,vp.reason,
  EXISTS(SELECT 1 FROM youtube_channels c WHERE c.youtube_channel_id=v.youtube_channel_id AND c.program_key=vp.program_key AND c.is_active) AS tracked
  FROM youtube_video_programs vp JOIN youtube_videos v ON v.id=vp.video_id`;
 let changed=0;
 for(const r of rows){const a=assessRelevance(r.program_key,r.title??'',r.description??'',r.tracked);
  // Runs every cycle: write only what the current rules change.
  if(a.status===r.suggested_status&&a.reason===r.reason)continue;
  changed++;
  await db`UPDATE youtube_video_programs SET suggested_status=${a.status},reason=${a.reason},matched_terms=${a.terms} WHERE video_id=${r.video_id} AND program_key=${r.program_key}`;}
 return changed;
}
