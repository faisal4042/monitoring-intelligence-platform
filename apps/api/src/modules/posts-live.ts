/** Local interaction management: bounded reads, scoped queue metadata, no collection. */
import { z } from 'zod';
import { sql, normalizeArabic } from '@mip/db';
import { PERMISSIONS as P } from '@mip/shared';
import type { FastifyRequest } from 'fastify';
import { badRequest, forbidden, notFound, HttpError } from '../lib/errors.js';
import { dateBoundsFromQuery, rangeMeta } from '../lib/date-range.js';
import { queueScope } from '../lib/authz.js';
import { redactRows, redactSensitiveText } from '../lib/privacy.js';
import { audit } from '../lib/audit.js';
import { manualAdd, mutateItem } from './queue/service.js';

export const liveQuerySchema = z.object({
  range: z.string().optional(), from: z.string().optional(), to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  page: z.coerce.number().int().min(1).max(4001).default(1),
  sort: z.enum(['newest','oldest','engagement']).default('newest'),
  cursor: z.string().max(180).optional(), cursorId: z.string().uuid().optional(),
  programId: z.string().uuid().optional(), queryId: z.string().uuid().optional(),
  relevance: z.enum(['relevant','irrelevant','advertisement','spam','unknown']).optional(),
  intent: z.string().max(40).optional(), sentiment: z.enum(['very_positive','positive','neutral','negative','very_negative']).optional(),
  username: z.string().max(100).optional(), q: z.string().max(250).optional(),
  influencersOnly: z.enum(['true','false']).optional(), includeFiltered: z.enum(['true','false']).optional(),
  includeDuplicates: z.enum(['true','false']).optional(), excluded: z.enum(['all','only','none']).optional(),
  processing: z.enum(['classified','unclassified','review']).optional(),
  queue: z.enum(['linked','unlinked','completed','open']).optional(),
  content: z.enum(['original','reply','quote','repost','media','image','video']).optional(),
  minRisk: z.coerce.number().int().min(0).max(100).optional(),
}).strict();
export function parseLiveQuery(raw: unknown) {
  const result = liveQuerySchema.safeParse(raw);
  if (!result.success) throw badRequest('فلاتر أو حدود صفحة غير صالحة', 'INVALID_LIVE_FILTER');
  if(result.data.cursor){
    const [at,id,...extra]=result.data.cursor.split('~');
    const normalized=at.replace(' ','T').replace(/([+-]\d{2})$/, '$1:00');
    if(extra.length||!z.string().datetime({offset:true}).safeParse(normalized).success||id&&!z.string().uuid().safeParse(id).success)
      throw badRequest('مؤشر تصفح غير صالح');
    if(id&&result.data.cursorId&&id!==result.data.cursorId)throw badRequest('مؤشر تصفح غير متطابق');
    result.data.cursor=normalized;if(id)result.data.cursorId=id;
  }
  if ((result.data.page - 1) * result.data.limit > 100000) throw badRequest('ضيّق البحث للوصول إلى نتائج أقدم');
  if (result.data.cursor && result.data.sort !== 'newest') throw badRequest('مؤشر التصفح متاح لترتيب الأحدث فقط');
  if(result.data.cursor&&result.data.page!==1)throw badRequest('استخدم مؤشر التصفح أو رقم الصفحة، وليس كليهما');
  if (result.data.cursorId && !result.data.cursor) throw badRequest('وقت مؤشر التصفح مطلوب');
  return result.data;
}
type Query = ReturnType<typeof parseLiveQuery>;
const canQueue = (req: FastifyRequest) => [P.QUEUE_WORK,P.QUEUE_SUPERVISE,P.QUEUE_VIEW_ALL].some(p=>req.user.permissions.includes(p));

/** One predicate for rows and all KPI counts; no accidental inner join exclusion. */
function source(req: FastifyRequest, q: Query, ids?: string[], details=false, page=false, metrics=false) {
  const dates = dateBoundsFromQuery({range:q.range,from:q.from,to:q.to});
  if (q.queue && !canQueue(req)) throw forbidden('فلتر الطابور يتطلب صلاحية الوصول إلى الطابور');
  const scope = queueScope(req.user);
  return sql`FROM ${page ? sql`page JOIN posts p ON p.id=page.id AND p.posted_at=page.posted_at` : sql`posts p`}
    LEFT JOIN authors a ON a.id=p.author_id
    LEFT JOIN post_classifications c ON c.post_id=p.id AND c.posted_at=p.posted_at
    LEFT JOIN post_sentiments s ON s.post_id=p.id AND s.posted_at=p.posted_at
    ${details ? sql`LEFT JOIN programs pr ON pr.id=c.program_id LEFT JOIN topics t ON t.id=c.topic_id` : sql``}
    ${details||metrics ? sql`LEFT JOIN LATERAL (SELECT pm.like_count,pm.repost_count,pm.reply_count,pm.impression_count FROM post_metrics pm
      WHERE pm.post_id=p.id AND pm.posted_at=p.posted_at ORDER BY pm.captured_at DESC LIMIT 1) m ON true` : sql``}
    LEFT JOIN (SELECT DISTINCT ON (q.post_id,q.post_posted_at)
      q.post_id,q.post_posted_at,q.id,q.status,q.version,q.team_id,q.assignee_id,u.full_name AS assignee_name FROM queue_items q
      LEFT JOIN users u ON u.id=q.assignee_id WHERE q.merged_into_id IS NULL AND (${scope})
      ORDER BY q.post_id,q.post_posted_at,q.entered_at DESC,q.id DESC) qi
      ON qi.post_id=p.id AND qi.post_posted_at=p.posted_at
    WHERE NOT p.is_redacted
    AND (${ids === undefined} OR p.id=ANY(${ids ?? []}::uuid[]))
    AND (${q.excluded === 'all' || q.excluded === 'only' || q.includeFiltered === 'true'} OR p.status<>'filtered_out')
    AND (${q.excluded !== 'only'} OR p.status='filtered_out')
    AND (${q.includeDuplicates === 'true'} OR p.status<>'duplicate')
    AND (${q.programId ?? null}::uuid IS NULL OR c.program_id=${q.programId ?? null}::uuid)
    AND (${q.queryId ?? null}::uuid IS NULL OR p.query_id=${q.queryId ?? null}::uuid)
    AND (${q.relevance ?? null}::text IS NULL OR c.relevance::text=${q.relevance ?? null})
    AND (${q.intent ?? null}::text IS NULL OR c.intent::text=${q.intent ?? null})
    AND (${q.sentiment ?? null}::text IS NULL OR s.label::text=${q.sentiment ?? null})
    AND (${q.username ?? null}::text IS NULL OR lower(a.username)=lower(${q.username ?? null}))
    AND (${q.minRisk ?? null}::int IS NULL OR p.risk_score>=${q.minRisk ?? null}::int)
    AND (${q.q ? normalizeArabic(q.q) : null}::text IS NULL OR p.text_normalized LIKE '%' || ${q.q ? normalizeArabic(q.q) : null} || '%')
    AND (${q.influencersOnly !== 'true'} OR EXISTS(SELECT 1 FROM tracked_influencers ti WHERE lower(ti.username)=lower(a.username) AND ti.is_active))
    AND (${q.processing !== 'classified'} OR c.post_id IS NOT NULL)
    AND (${q.processing !== 'unclassified'} OR c.post_id IS NULL)
    AND (${q.processing !== 'review'} OR c.post_id IS NULL OR c.relevance='unknown')
    AND (${!q.queue} OR (${q.queue === 'unlinked'} AND qi.id IS NULL) OR (${q.queue === 'linked'} AND qi.id IS NOT NULL)
      OR (${q.queue === 'completed'} AND qi.status='completed') OR (${q.queue === 'open'} AND qi.status<>'completed'))
    AND (${!q.content} OR (${q.content === 'original'} AND NOT p.is_reply AND NOT p.is_quote AND NOT p.is_repost)
      OR (${q.content === 'reply'} AND p.is_reply) OR (${q.content === 'quote'} AND p.is_quote)
      OR (${q.content === 'repost'} AND p.is_repost) OR (${q.content === 'media'} AND p.has_media)
      OR (${['image','video'].includes(q.content ?? '')} AND EXISTS(SELECT 1 FROM post_media md
        WHERE md.post_id=p.id AND md.posted_at=p.posted_at AND ((${q.content === 'image'} AND md.type='photo')
          OR (${q.content === 'video'} AND md.type IN ('video','animated_gif'))))))
    AND p.posted_at>=${dates.from}::timestamptz AND p.posted_at<${dates.to}::timestamptz`;
}
const columns = sql`p.id,p.x_post_id,p.x_author_id,p.text,p.posted_at,p.collected_at,p.url,p.lang,p.hashtags,
  p.matched_keywords,p.status,p.filter_reason,p.duplicate_type,p.duplicate_of_id,p.risk_score,p.is_reply,p.is_quote,p.is_repost,
  a.username,a.display_name,a.followers_count,a.following_count,a.is_verified,a.profile_image_url,a.description AS author_bio,a.influence_score,
  c.relevance,c.intent,c.relevance_confidence::float,c.reason_ar,c.stage,c.model,c.human_corrected,c.program_id,
  s.label AS sentiment,s.score::float AS sentiment_score,s.stage AS sentiment_stage,s.model AS sentiment_model,pr.name_ar AS program_name,pr.color AS program_color,t.id AS topic_id,t.name_ar AS topic_name,
  m.like_count,m.repost_count,m.reply_count,m.impression_count,
  EXISTS(SELECT 1 FROM tracked_influencers ti WHERE lower(ti.username)=lower(a.username) AND ti.is_active) AS is_influencer,
  qi.id AS queue_id,qi.status AS queue_status,qi.version AS queue_version,qi.team_id AS queue_team_id,qi.assignee_id,qi.assignee_name,
  coalesce((SELECT jsonb_agg(jsonb_build_object('url',md.url,'previewImageUrl',md.preview_image_url,'type',md.type))
    FROM post_media md WHERE md.post_id=p.id AND md.posted_at=p.posted_at),'[]'::jsonb) AS media`;

export async function liveFeed(req: FastifyRequest, q: Query, ids?: string[]) {
  const from = source(req,q,ids);
  return sql.begin('isolation level repeatable read read only', async tx => {
    await tx`SET LOCAL statement_timeout='8s'`;
    // One-shot lateral aggregates can spend the entire timeout compiling JIT plans.
    await tx`SET LOCAL jit=off`;
    // Optional filters and actor scope vary widely; a cached generic plan cannot prune them.
    await tx`SET LOCAL plan_cache_mode=force_custom_plan`;
    const [stats] = await tx`SELECT count(*)::int AS total,
      count(*) FILTER(WHERE c.post_id IS NULL)::int AS unclassified,
      count(*) FILTER(WHERE qi.status IS DISTINCT FROM 'completed')::int AS unprocessed,
      count(*) FILTER(WHERE qi.id IS NOT NULL)::int AS queued,
      count(*) FILTER(WHERE p.status='filtered_out')::int AS excluded,
      count(*) FILTER(WHERE c.post_id IS NOT NULL)::int AS classified,
      count(*) FILTER(WHERE c.post_id IS NULL OR c.relevance='unknown')::int AS review,
      max(p.posted_at) AS latest_published_at,max(p.collected_at) AS latest_collected_at ${from}`;
    const order = q.sort==='oldest' ? sql`p.posted_at ASC,p.id ASC` : q.sort==='engagement'
      ? sql`(coalesce(m.like_count,0)+coalesce(m.repost_count,0)+coalesce(m.reply_count,0)) DESC,p.posted_at DESC,p.id DESC`
      : sql`p.posted_at DESC,p.id DESC`;
    // Bound the page before media/metrics enrichment, especially for deep offsets.
    const items = await tx`WITH page AS MATERIALIZED (SELECT p.id,p.posted_at ${source(req,q,ids,false,false,q.sort==='engagement')}
      AND (${q.cursor ?? null}::timestamptz IS NULL OR p.posted_at<${q.cursor ?? null}::timestamptz
        OR (${q.cursorId ?? null}::uuid IS NOT NULL AND p.posted_at=${q.cursor ?? null}::timestamptz AND p.id<${q.cursorId ?? null}::uuid))
      ORDER BY ${order} LIMIT ${q.limit} OFFSET ${(q.page-1)*q.limit})
      SELECT ${columns} ${source(req,q,ids,true,true)} ORDER BY ${order}`;
    const last = items[items.length-1];
    const hasNext = q.cursor ? items.length===q.limit : q.page*q.limit<stats.total;
    const at=last?(last.posted_at instanceof Date?last.posted_at.toISOString():String(last.posted_at).replace(' ','T').replace(/([+-]\d{2})$/, '$1:00')):null;
    return {items:redactRows([...items]).map(p=>{for(const key of ['author_bio','reason_ar'])if(typeof p[key]==='string')p[key]=redactSensitiveText(p[key]);return p;}),
      total:stats.total,page:q.page,pageSize:q.limit,stats:canQueue(req)?stats:{...stats,queued:null,unprocessed:null},
      nextCursor:hasNext && last ? `${at}~${last.id}`:null,nextCursorId:hasNext && last ? last.id:null,
      range:rangeMeta(dateBoundsFromQuery({range:q.range,from:q.from,to:q.to}).range),generatedAt:new Date().toISOString()};
  }).catch(e=>{if((e as {code?:string}).code==='57014')throw new HttpError(422,'استغرق العرض وقتًا طويلًا؛ ضيّق الفترة أو أضف فلاتر أدق','LIVE_TIMEOUT');throw e;});
}

export async function liveDetail(req: FastifyRequest, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw badRequest('معرف غير صالح');
  const data=await liveFeed(req,parseLiveQuery({range:'all',includeFiltered:'true',includeDuplicates:'true'}),[id]);
  const post=data.items[0]; if(!post)throw notFound('التفاعل غير متاح');
  const [why]=await sql`SELECT p.matched_keywords,p.filter_reason,q.name AS query_name,v.version,v.compiled
    FROM posts p LEFT JOIN queries q ON q.id=p.query_id LEFT JOIN query_versions v ON v.id=p.query_version_id WHERE p.id=${id}::uuid AND NOT p.is_redacted`;
  const feedback=await sql`SELECT feedback_type,human_value,reason,created_at FROM ai_feedback WHERE post_id=${id}::uuid ORDER BY created_at DESC LIMIT 25`;
  const events=req.user.permissions.includes(P.AUDIT_READ)?await sql`SELECT action,reason,occurred_at FROM audit_log
    WHERE entity_type='post' AND entity_id=${id}::uuid ORDER BY occurred_at DESC LIMIT 25`:[];
  const queueEvents=canQueue(req)?await sql`SELECT e.event_type,e.reason,e.created_at FROM queue_events e JOIN queue_items q ON q.id=e.queue_item_id
    WHERE q.post_id=${id}::uuid AND (${queueScope(req.user)}) ORDER BY e.created_at DESC LIMIT 25`:[];
  const safeReason=(reason:unknown)=>typeof reason==='string'?redactSensitiveText(reason):reason;
  return {post,why:why?{...why,compiled:safeReason(why.compiled),filter_reason:safeReason(why.filter_reason)}:{},
    feedback:feedback.map(r=>({...r,reason:safeReason(r.reason)})),events:events.map(r=>({...r,reason:safeReason(r.reason)})),
    queueEvents:queueEvents.map(r=>({...r,reason:safeReason(r.reason)})),canReadAudit:req.user.permissions.includes(P.AUDIT_READ)};
}

export const bulkSchema=z.object({
  action:z.enum(['queue','classify','export','assign']),ids:z.array(z.string().uuid()).min(1).max(100),
  preview:z.boolean().default(true),confirmed:z.boolean().default(false),
  value:z.enum(['relevant','irrelevant','advertisement','spam','unknown']).optional(),reason:z.string().trim().min(1).max(2000).optional(),
  assigneeId:z.string().uuid().optional(),versions:z.record(z.string().uuid(),z.number().int().positive()).refine(v=>Object.keys(v).length<=100).optional(),
}).strict();

/** Classification uses the existing feedback workflow, now transactional and audited. */
export async function correctClassification(req: FastifyRequest,id:string,value:string,reason?:string) {
  if(!req.user.permissions.includes(P.FEEDBACK_WRITE))throw forbidden();
  if(!['relevant','irrelevant','advertisement','spam','unknown'].includes(value))throw badRequest('تصنيف غير صالح');
  await sql.begin(async tx=>{
    const [p]=await tx`SELECT p.id,p.posted_at,p.text,c.relevance,c.relevance_confidence,c.stage
      FROM posts p JOIN post_classifications c ON c.post_id=p.id AND c.posted_at=p.posted_at
      WHERE p.id=${id}::uuid AND NOT p.is_redacted FOR UPDATE OF c`;
    if(!p)throw notFound('التفاعل أو التصنيف غير متاح');
    await tx`INSERT INTO ai_feedback(post_id,posted_at,feedback_type,ai_value,ai_confidence,ai_stage,human_value,reason,post_text_snapshot,created_by)
      VALUES(${id},${p.posted_at},'relevance',${p.relevance},${p.relevance_confidence},${p.stage},${value},${reason ?? null},${redactSensitiveText(p.text)},${req.user.id})`;
    await tx`UPDATE post_classifications SET relevance=${value}::relevance_label,human_corrected=true,corrected_by=${req.user.id},corrected_at=now()
      WHERE post_id=${id} AND posted_at=${p.posted_at}`;
    await audit(req,{action:'post.classify',entityType:'post',entityId:id,oldValue:{relevance:p.relevance},newValue:{relevance:value},reason},tx);
  });
}

export async function liveBulk(req:FastifyRequest,raw:unknown) {
  const parsed=bulkSchema.safeParse(raw);if(!parsed.success)throw badRequest('طلب جماعي غير صالح');
  const input=parsed.data;const ids=[...new Set(input.ids)];
  const permission=['queue','assign'].includes(input.action)?P.QUEUE_SUPERVISE:input.action==='classify'?P.FEEDBACK_WRITE:P.POSTS_EXPORT;
  if(!req.user.permissions.includes(permission))throw forbidden();
  if(input.action==='classify'&&!input.value)throw badRequest('التصنيف مطلوب');
  if(input.action==='assign'&&!input.assigneeId)throw badRequest('الموظف مطلوب');
  if(!input.preview&&!input.confirmed)throw badRequest('تأكيد المعاينة مطلوب');
  if(!input.preview&&['classify','assign'].includes(input.action)&&!input.reason)throw badRequest('سبب الإجراء مطلوب');
  const data=await liveFeed(req,parseLiveQuery({range:'all',includeFiltered:'true',includeDuplicates:'true',limit:100}),ids);
  const byId=new Map(data.items.map(p=>[p.id,p]));
  const results=[];
  for(const id of ids){
    const post=byId.get(id);
    if(!post){results.push({id,ok:false,error:'التفاعل غير متاح'});continue;}
    if(input.preview){
      if(input.action==='assign'){
        if(!post.queue_id||!['new','assigned','in_progress','escalated'].includes(post.queue_status)||post.assignee_id===input.assigneeId){results.push({id,ok:false,error:'لا تذكرة قابلة للإسناد أو مسندة للموظف نفسه'});continue;}
        const [member]=await sql`SELECT 1 FROM team_members tm JOIN users u ON u.id=tm.user_id JOIN roles r ON r.id=u.role_id JOIN teams t ON t.id=tm.team_id
          WHERE tm.team_id=${post.queue_team_id}::uuid AND tm.user_id=${input.assigneeId!}::uuid AND tm.left_at IS NULL
          AND t.is_active AND u.is_active AND u.deleted_at IS NULL AND ((tm.kind='agent' AND r.key='agent') OR (tm.kind='supervisor' AND r.key='supervisor')) LIMIT 1`;
        if(!member){results.push({id,ok:false,error:'الموظف ليس عضوًا نشطًا في فريق التذكرة'});continue;}
        results.push({id,ok:true,label:post.username??post.display_name??id,version:post.queue_version});continue;
      }
      if(input.action==='classify'&&!post.relevance){results.push({id,ok:false,error:'لا سجل تصنيف لتصحيحه'});continue;}
      if(input.action==='queue'){
        const [eligible]=await sql`SELECT 1 FROM posts p JOIN post_classifications c ON c.post_id=p.id AND c.posted_at=p.posted_at
          JOIN team_programs tp ON tp.program_id=c.program_id JOIN teams t ON t.id=tp.team_id
          WHERE p.id=${id}::uuid AND NOT p.is_redacted AND p.status NOT IN ('filtered_out','duplicate')
          AND p.duplicate_of_id IS NULL AND p.duplicate_type IS NULL AND t.is_active
          AND (${req.user.permissions.includes(P.QUEUE_VIEW_ALL)} OR EXISTS(SELECT 1 FROM team_members tm
            WHERE tm.team_id=t.id AND tm.user_id=${req.user.id}::uuid AND tm.kind='supervisor' AND tm.left_at IS NULL))
          AND NOT EXISTS(SELECT 1 FROM queue_items existing WHERE existing.post_id=p.id AND existing.interaction_type='post') LIMIT 1`;
        if(!eligible){results.push({id,ok:false,error:'موجود بالطابور أو غير مؤهل ضمن فريق البرنامج المتاح'});continue;}
      }
      results.push({id,ok:true,label:post.username ?? post.display_name ?? id});continue;
    }
    try {
      if(input.action==='queue'){
        const item=await manualAdd(req,{postId:id,postedAt:new Date(post.posted_at).toISOString()});
        results.push({id,ok:true,queueId:item.id});
      }else if(input.action==='assign'){
        if(!post.queue_id||!input.versions?.[id])throw badRequest('معاينة حديثة للتذكرة مطلوبة');
        const item=await mutateItem(req.user,post.queue_id,'assign',{expectedVersion:input.versions[id],assigneeId:input.assigneeId,reason:input.reason},req);
        results.push({id,ok:true,queueId:item.id});
      }else if(input.action==='classify'){
        await correctClassification(req,id,input.value!,input.reason);results.push({id,ok:true});
      }else results.push({id,ok:true});
    }catch(e){
      const expected=e instanceof Error&&'statusCode' in e;
      if(!expected)req.log.error({event:'live_bulk_failure',action:input.action,postId:id},'Interaction action failed');
      results.push({id,ok:false,error:expected?(e as Error).message:'تعذر تنفيذ العملية؛ حدّث البيانات وراجع سجل الإجراءات قبل إعادة المحاولة'});
    }
  }
  if(!input.preview)await audit(req,{action:'post.bulk.'+input.action,entityType:'post_bulk',newValue:{results},reason:input.reason});
  const exported=input.action==='export'&&!input.preview?data.items.map(p=>({id:p.id,x_post_id:p.x_post_id,text:p.text,posted_at:p.posted_at,url:p.url,username:p.username,relevance:p.relevance,sentiment:p.sentiment})):undefined;
  return {preview:input.preview,action:input.action,results,success:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length,exported};
}
