/** Integrated authenticated routes. No schema initialization, scheduler or collection at import/startup. */
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {sql} from '@mip/db';
import {PERMISSIONS} from '@mip/shared';
import {audit} from '../../lib/audit.js';
import {HttpError} from '../../lib/errors.js';
import {QuotaManager,limitsFromEnv,type Mode} from './quota.js';
import {YouTubeGateway} from './gateway.js';
import {LiveTransport,MockTransport} from './transport.js';
import {runChannel,runComments,runDiscovery,runStats} from './collector.js';
import {retentionFromEnv,runRetention} from './retention.js';
import {dictionaryPlans,syncDictionary} from './dictionary.js';
import {refreshRelevance} from './relevance.js';
import {runCycle} from './cycle.js';
import {workerCheckpoint} from '../../startup/worker-ownership.js';
export const YOUTUBE_PERMISSIONS={READ:PERMISSIONS.YOUTUBE_READ,MANAGE:PERMISSIONS.YOUTUBE_MANAGE} as const;
function parse<S extends z.ZodTypeAny>(schema:S,data:unknown):z.output<S>{const r=schema.safeParse(data);if(!r.success)throw new HttpError(400,'بيانات الطلب غير صالحة','VALIDATION_ERROR');return r.data;}
export default async function youtubeRoutes(app:FastifyInstance){
 const mode=(process.env.YOUTUBE_MODE??'dry_run') as Mode;
 if(!['dry_run','mock','live'].includes(mode))throw Error('Invalid YouTube mode');
 const quota=new QuotaManager(sql,limitsFromEnv(process.env),undefined,process.env.YOUTUBE_INTERNAL_LIMITS_ENABLED!=='false');
 const gateway=new YouTubeGateway(sql,quota,{mode,transport:mode==='mock'?new MockTransport():mode==='live'?new LiveTransport(()=>process.env.YOUTUBE_API_KEY):null,
  liveApproved:process.env.YOUTUBE_LIVE_APPROVED==='1'});
 const ready=async()=>{const [r]=await sql`SELECT to_regclass('public.youtube_videos') IS NOT NULL AS ready`;if(!r.ready)throw new HttpError(503,'رصد YouTube ينتظر تهيئة قاعدة البيانات المعتمدة','YOUTUBE_NOT_ACTIVATED');};
 const read={preHandler:[app.authenticate,app.requirePermission(YOUTUBE_PERMISSIONS.READ,YOUTUBE_PERMISSIONS.MANAGE),ready]};
 const write={preHandler:[app.authenticate,app.requirePermission(YOUTUBE_PERMISSIONS.MANAGE),ready]};
 let busy:string|null=null;
 let cycle:Promise<unknown>|null=null;
 const collectCycle=async()=>{
  if(busy)throw new HttpError(409,'عملية رصد قيد التشغيل','RUN_BUSY');
  busy='cycle';
  try{
   await workerCheckpoint();
   const [control]=await sql`SELECT * FROM youtube_collector_controls WHERE singleton`;
   if(control.paused)throw new HttpError(409,'الرصد متوقف؛ استأنفه أولًا','COLLECTION_PAUSED');
   const results=await runCycle(sql,gateway,quota,mode);
   const problem=results.find(r=>r.error)?.error??null;
   await sql`UPDATE youtube_collector_controls SET last_cycle_at=now(),last_cycle_error=${problem},next_run_at=now()+interval_minutes*interval '1 minute' WHERE singleton`;
   return {results};
  }catch(e){await sql`UPDATE youtube_collector_controls SET last_cycle_error=${String((e as Error).message).slice(0,300)},next_run_at=now()+interval_minutes*interval '1 minute' WHERE singleton`;throw e;}
  finally{busy=null;}
 };
 const launchCycle=()=>{cycle=collectCycle().finally(()=>{cycle=null;});return cycle;};
 const tick=async()=>{
  if(busy||mode!=='live')return;
  const [c]=await sql`SELECT scheduler_enabled,paused,next_run_at FROM youtube_collector_controls WHERE singleton`;
  if(c.scheduler_enabled&&!c.paused&&(!c.next_run_at||new Date(c.next_run_at)<=new Date()))await launchCycle();
 };
 let timer:ReturnType<typeof setInterval>|undefined;
 if(process.env.YOUTUBE_SCHEDULER_ENABLED==='true')app.addHook('onReady',async()=>{timer=setInterval(()=>void tick().catch(e=>app.log.error({err:e},'YouTube scheduler failed')),60_000);});
 app.addHook('onClose',async()=>{if(timer)clearInterval(timer);if(cycle)await cycle.catch(()=>{});});
 app.get('/status',read,async()=>({mode,keyConfigured:!!process.env.YOUTUBE_API_KEY,controls:await gateway.controls(),quota:await quota.status(mode),busy,
  retention:retentionFromEnv(),scheduler:process.env.YOUTUBE_SCHEDULER_ENABLED==='true'?'available':'disabled',
  schedule:(await sql`SELECT scheduler_enabled,interval_minutes,next_run_at,last_cycle_at,last_cycle_error FROM youtube_collector_controls WHERE singleton`)[0],
  connection:(await sql`SELECT http_status,outcome,occurred_at FROM youtube_api_calls WHERE mode=${mode} AND outcome IN ('ok','error') ORDER BY occurred_at DESC LIMIT 1`)[0]??null,derivedMetrics:'disabled',
  runs:await sql`SELECT id,lane,target,mode,status,calls,units,items_new,items_updated,error_message,started_at,finished_at FROM youtube_collection_runs ORDER BY started_at DESC LIMIT 15`,
  errors:await sql`SELECT occurred_at,endpoint,mode,outcome,http_status,error_reason,attempt FROM youtube_api_calls WHERE outcome IN ('error','denied') ORDER BY occurred_at DESC LIMIT 20`}));
 app.get('/videos',read,async req=>{
  const query=parse(z.object({limit:z.coerce.number().int().min(1).max(100).default(24),page:z.coerce.number().int().min(1).max(100000).default(1),program:z.string().max(50).default(''),state:z.enum(['all','matched','confirmed','needs_review','excluded']).default('all'),search:z.string().max(200).default(''),days:z.coerce.number().int().min(0).max(365).default(30),
   sort:z.enum(['published','collected','views','comments']).default('published')}),req.query);
  const order=query.sort==='views'?sql`s.view_count DESC NULLS LAST,v.published_at DESC`:query.sort==='comments'?sql`s.comment_count DESC NULLS LAST,v.published_at DESC`:
   query.sort==='collected'?sql`v.collected_at DESC`:sql`v.published_at DESC`;
  const filter=sql`WHERE v.status='active' AND (${query.program}='' OR vp.program_key=${query.program})
    AND (${query.search}='' OR v.title ILIKE ${'%'+query.search+'%'} OR v.channel_title ILIKE ${'%'+query.search+'%'})
    AND (${query.days}=0 OR v.published_at>=now()-${query.days}*interval '1 day')`;
  const [counts]=await sql`SELECT count(*)::int AS total,count(*) FILTER(WHERE coalesce(vp.review_status,vp.suggested_status)='confirmed')::int AS confirmed,
    count(*) FILTER(WHERE coalesce(vp.review_status,vp.suggested_status)='matched')::int AS matched,
    count(*) FILTER(WHERE coalesce(vp.review_status,vp.suggested_status)='needs_review')::int AS needs_review,
    count(*) FILTER(WHERE coalesce(vp.review_status,vp.suggested_status)='excluded')::int AS excluded,
    count(*) FILTER(WHERE vp.review_status IN ('confirmed','excluded'))::int AS reviewed
    FROM youtube_videos v JOIN youtube_video_programs vp ON vp.video_id=v.id ${filter}`;
  const [filtered]=await sql`SELECT count(*)::int AS total FROM youtube_videos v JOIN youtube_video_programs vp ON vp.video_id=v.id ${filter}
   AND (${query.state}='all' OR coalesce(vp.review_status,vp.suggested_status)=${query.state})`;
  return {total:filtered.total,counts,page:query.page,limit:query.limit,items:await sql`SELECT v.*,vp.program_key,p.name_ar AS program_name,q.name AS search_query_name,q.q AS search_query,
   coalesce(vp.review_status,vp.suggested_status) AS relevance_status,vp.suggested_status,vp.reason,vp.matched_terms,vp.review_note,vp.reviewed_at,
   s.view_count,s.like_count,s.comment_count,s.captured_at AS stats_at,
   (SELECT count(*)::int FROM youtube_comments c WHERE c.video_id=v.id AND NOT c.is_reply) AS stored_threads,
   (SELECT count(*)::int FROM youtube_comments c WHERE c.video_id=v.id AND c.is_reply) AS stored_replies
   FROM youtube_videos v JOIN youtube_video_programs vp ON vp.video_id=v.id LEFT JOIN youtube_search_queries q ON q.id=vp.query_id LEFT JOIN programs p ON p.key=vp.program_key
   LEFT JOIN LATERAL (SELECT * FROM youtube_video_stats s WHERE s.video_id=v.id ORDER BY captured_at DESC LIMIT 1) s ON true
   ${filter} AND (${query.state}='all' OR coalesce(vp.review_status,vp.suggested_status)=${query.state})
   ORDER BY ${order},v.id LIMIT ${query.limit} OFFSET ${(query.page-1)*query.limit}`};
 });
 app.post('/videos/:id/review',write,async req=>{
  const {id}=parse(z.object({id:z.string().uuid()}),req.params);
  const body=parse(z.object({programKey:z.string().min(1).max(50),status:z.enum(['confirmed','excluded','needs_review','auto']),note:z.string().max(500).default('')}),req.body);
  await sql.begin(async tx=>{const rows=await tx`UPDATE youtube_video_programs SET review_status=${body.status==='auto'?null:body.status},review_note=${body.note},reviewed_by=${body.status==='auto'?null:req.user.id},reviewed_at=CASE WHEN ${body.status}='auto' THEN NULL ELSE now() END WHERE video_id=${id} AND program_key=${body.programKey} RETURNING video_id`;
   if(!rows.length)throw new HttpError(404,'الفيديو غير موجود ضمن البرنامج','VIDEO_NOT_FOUND');
   await audit(req,{action:'youtube.review',entityType:'youtube_video',entityId:id,newValue:body},tx);});return {ok:true};
 });
 app.post('/cycle',write,async req=>{const result=await launchCycle();await audit(req,{action:'youtube.cycle',entityType:'youtube'},sql);return result;});
 app.post('/schedule',write,async req=>{
  const body=parse(z.object({enabled:z.boolean(),intervalMinutes:z.number().int().min(15).max(1440),runImmediately:z.boolean().default(false)}),req.body);
  if(body.enabled&&(mode!=='live'||process.env.YOUTUBE_SCHEDULER_ENABLED!=='true'))throw new HttpError(409,'الجدولة الفعلية غير مهيأة','SCHEDULER_UNAVAILABLE');
  await sql.begin(async tx=>{await tx`UPDATE youtube_collector_controls SET scheduler_enabled=${body.enabled},interval_minutes=${body.intervalMinutes},next_run_at=CASE WHEN ${body.runImmediately} THEN now() ELSE now()+${body.intervalMinutes}*interval '1 minute' END WHERE singleton`;
   await audit(req,{action:'youtube.schedule',entityType:'youtube',newValue:body},tx);});return {ok:true};
 });
 app.get('/videos/:id/comments',read,async req=>{const {id}=parse(z.object({id:z.string().uuid()}),req.params);return {items:await sql`SELECT youtube_comment_id,thread_id,parent_comment_id,is_reply,author_channel_id,author_display_name,text_display,like_count,total_reply_count,published_at,status FROM youtube_comments WHERE video_id=${id}::uuid ORDER BY thread_id,is_reply,published_at LIMIT 2000`};});
 // Per program: how much of the dictionary was actually searched recently and what it produced.
 app.get('/coverage',read,async()=>({items:await sql`SELECT p.key,p.name_ar,
   count(q.id) FILTER(WHERE q.is_active)::int AS queries,
   count(q.id) FILTER(WHERE q.is_active AND q.last_attempt_at>now()-interval '24 hours')::int AS searched_24h,
   count(q.id) FILTER(WHERE q.is_active AND q.pending_page_token IS NOT NULL)::int AS pending_pages,
   max(q.last_attempt_at) FILTER(WHERE q.is_active AND q.name LIKE '%-sweep:%') AS sweep_at,
   max(q.published_after_watermark) FILTER(WHERE q.is_active AND q.name LIKE '%-sweep:%') AS sweep_covered_until,
   (SELECT count(*)::int FROM youtube_channels c WHERE c.program_key=p.key AND c.is_active) AS channels,
   (SELECT count(*)::int FROM youtube_video_programs vp JOIN youtube_videos v ON v.id=vp.video_id WHERE vp.program_key=p.key AND v.status='active'
     AND coalesce(vp.review_status,vp.suggested_status) IN ('matched','confirmed')) AS relevant,
   (SELECT count(*)::int FROM youtube_video_programs vp JOIN youtube_videos v ON v.id=vp.video_id WHERE vp.program_key=p.key AND v.status='active'
     AND coalesce(vp.review_status,vp.suggested_status)='needs_review') AS needs_review,
   (SELECT max(v.collected_at) FROM youtube_video_programs vp JOIN youtube_videos v ON v.id=vp.video_id WHERE vp.program_key=p.key) AS last_new_at
  FROM programs p LEFT JOIN youtube_search_queries q ON q.program_key=p.key
  WHERE p.is_active AND p.deleted_at IS NULL GROUP BY p.key,p.name_ar ORDER BY p.name_ar`}));
 app.get('/channels',read,async()=>({items:await sql`SELECT * FROM youtube_channels ORDER BY created_at`}));
 app.get('/dictionary',read,async()=>({items:await dictionaryPlans(sql)}));
 app.post('/dictionary/sync',write,async req=>{if(busy)throw new HttpError(409,'عملية رصد قيد التشغيل','RUN_BUSY');busy='dictionary';try{const items=await syncDictionary(sql);await refreshRelevance(sql);await audit(req,{action:'youtube.dictionary_sync',entityType:'youtube',newValue:{programs:items.length,queries:items.reduce((n,p)=>n+p.queries.length,0)}});return {items};}finally{busy=null;}});
 app.get('/queries',read,async()=>({items:await sql`SELECT * FROM youtube_search_queries ORDER BY program_key,name`}));
 app.post('/controls',write,async req=>{const body=parse(z.object({paused:z.boolean(),reason:z.string().min(1).max(300).default('manual action')}),req.body);
  await sql.begin(async tx=>{await tx`UPDATE youtube_collector_controls SET paused=${body.paused},reason=${body.reason},consecutive_failures=CASE WHEN ${body.paused} THEN consecutive_failures ELSE 0 END,changed_at=now() WHERE singleton`;
   await audit(req,{action:'youtube.controls',entityType:'youtube',newValue:{paused:body.paused}},tx);});return {controls:await gateway.controls()};});
 app.post('/channels',write,async req=>{const body=parse(z.object({youtubeChannelId:z.string().regex(/^UC[0-9A-Za-z_-]{22}$/),programKey:z.string().min(1).max(50).nullable().optional()}),req.body);
  if(body.programKey){const [p]=await sql`SELECT id FROM programs WHERE key=${body.programKey}`;if(!p)throw new HttpError(400,'البرنامج غير موجود','INVALID_PROGRAM');}
  const channel=await sql.begin(async tx=>{const [channel]=await tx`INSERT INTO youtube_channels(youtube_channel_id,program_key) VALUES(${body.youtubeChannelId},${body.programKey??null}) ON CONFLICT(youtube_channel_id) DO UPDATE SET is_active=true RETURNING *`;
   await audit(req,{action:'youtube.channel_added',entityType:'youtube',entityId:channel.id},tx);return channel;});
  if(body.programKey)await refreshRelevance(sql);
  return {channel};});
 app.post('/run',write,async req=>{
  const body=parse(z.object({lane:z.enum(['discovery','channels','comments','stats','retention']),targetId:z.string().uuid().optional(),limit:z.number().int().min(1).max(200).default(50)}),req.body);
  if(['discovery','channels','comments'].includes(body.lane)&&!body.targetId)throw new HttpError(400,'اختر هدف التشغيل','TARGET_REQUIRED');
  if(busy)throw new HttpError(409,'هناك عملية تشغيل جارية','RUN_BUSY');busy=body.lane;
  try{
   const result=body.lane==='discovery'?await runDiscovery(sql,gateway,body.targetId!):body.lane==='channels'?await runChannel(sql,gateway,body.targetId!):
    body.lane==='comments'?await runComments(sql,gateway,body.targetId!):body.lane==='stats'?await runStats(sql,gateway,body.limit):await runRetention(sql,gateway,retentionFromEnv());
   await audit(req,{action:'youtube.run',entityType:'youtube',newValue:{lane:body.lane,mode}});return {result};
  }finally{busy=null;}
 });
}
