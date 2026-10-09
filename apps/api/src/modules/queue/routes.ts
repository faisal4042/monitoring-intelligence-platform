import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, normalizeArabic } from '@mip/db';
import { QUEUE_ACTIONS, QUEUE_SECTIONS, QUEUE_STATUSES, PERMISSIONS as P } from '@mip/shared';
import { QUEUE, queueScope, queueTeamScope, requireScope, resolveScope, type QueueActor } from '../../lib/authz.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { dateBoundsFromQuery } from '../../lib/date-range.js';
import { redactRows, redactSensitiveText } from '../../lib/privacy.js';
import { administrativeAudit, claimItem, manualAdd, mutateItem, setPriority, transferItem } from './service.js';
import { INTENT_LABELS, REVIEW_OUTCOMES, SENTIMENT_LABELS } from './reviews.js';
import { queueStats } from './stats.js';
import { expectedVersion, idParams, parse } from './validation.js';

const uuid=z.string().uuid();
const querySchema=z.object({
  range:z.string().optional(),from:z.string().optional(),to:z.string().optional(),basis:z.enum(['entered','posted']).default('entered'),
  // mine: my open work · unassigned · open: everything open in scope · closed · all.
  // 'completed' is the older name of 'closed'.
  view:z.enum(['mine','unassigned','open','closed','completed','all']).optional(),
  outcome:z.enum(REVIEW_OUTCOMES).optional(),status:z.enum(QUEUE_STATUSES).optional(),
  section:z.enum(QUEUE_SECTIONS).optional(),source:z.enum(['original','reply','quote']).optional(),
  programId:uuid.optional(),teamId:uuid.optional(),employeeId:uuid.optional(),
  classification:z.enum(['complaint','inquiry','suggestion','praise','news','experience','warning','issue','request','other']).optional(),
  sentiment:z.enum(['very_positive','positive','neutral','negative','very_negative']).optional(),
  search:z.string().max(200).optional(),limit:z.coerce.number().int().min(1).max(100).default(40),cursor:z.string().max(1200).optional(),
}).strict();
type Query=z.infer<typeof querySchema>;
const reviewSchema=z.object({
  outcome:z.enum(REVIEW_OUTCOMES),
  programId:uuid.nullable().optional(),intent:z.enum(Object.keys(INTENT_LABELS) as [string,...string[]]).nullable().optional(),
  sentiment:z.enum(Object.keys(SENTIMENT_LABELS) as [string,...string[]]).nullable().optional(),relevant:z.boolean().optional(),
  topicId:uuid.nullable().optional(),subtopicId:uuid.nullable().optional(),linksConfirmed:z.boolean().optional(),
  reason:z.string().trim().max(2000).optional(),
}).strict();
const statsSchema=z.object({range:z.string().optional(),from:z.string().optional(),to:z.string().optional(),
  section:z.enum(QUEUE_SECTIONS).optional(),teamId:uuid.optional(),employeeId:uuid.optional()}).strict();
const cursorSchema=z.object({at:z.string().min(10).max(40),id:uuid,through:z.string().min(10).max(40)}).strict();
/**
 * Cards: every item once. A merged story unit is gone (its story lives on in
 * the surviving unit); a post inside a story is worked through the story and
 * only becomes its own card while someone actually holds it.
 */
const cardable=sql`q.merged_into_id IS NULL AND (q.story_item_id IS NULL OR q.status<>'new')`;
function filter(actor:QueueActor,q:Query) {
  const dates=dateBoundsFromQuery({range:q.range,from:q.from,to:q.to});
  const column=q.basis==='posted'?sql`coalesce(q.post_posted_at,(q.story_snapshot->>'firstSeenAt')::timestamptz)`:sql`q.entered_at`;
  const own=resolveScope(actor.permissions,QUEUE)==='own';
  const view=q.view==='completed'?'closed':q.view??(own?'mine':'all');
  const search=q.search?.trim()?q.search.trim():null;
  return sql`(${queueScope(actor)}) AND ${cardable} AND ${column}>=${dates.from}::timestamptz AND ${column}<${dates.to}::timestamptz
    AND (${q.section??null}::text IS NULL OR q.section=${q.section??null})
    AND (${q.status??null}::text IS NULL OR q.status=${q.status??null})
    AND (${q.programId??null}::uuid IS NULL OR q.program_id=${q.programId??null}::uuid)
    AND (${q.teamId??null}::uuid IS NULL OR q.team_id=${q.teamId??null}::uuid)
    AND (${q.employeeId??null}::uuid IS NULL OR q.assignee_id=${q.employeeId??null}::uuid)
    AND (${q.classification??null}::text IS NULL OR c.intent::text=${q.classification??null})
    AND (${q.sentiment??null}::text IS NULL OR s.label::text=${q.sentiment??null})
    AND (${q.source??null}::text IS NULL OR (${q.source==='reply'} AND p.is_reply) OR (${q.source==='quote'} AND p.is_quote)
      OR (${q.source==='original'} AND NOT p.is_reply AND NOT p.is_quote))
    AND (${search}::text IS NULL OR p.text_normalized LIKE ${'%'+normalizeArabic(search??'')+'%'}
      OR strpos(lower(q.story_snapshot->>'title'),lower(${search??''}))>0)
    -- My Queue excludes closed work in SQL, so a closed item cannot linger there.
    AND (${view!=='mine'} OR (q.assignee_id=${actor.id}::uuid AND q.status<>'completed'))
    AND (${view!=='unassigned'} OR q.status='new')
    AND (${view!=='open'} OR (q.status<>'completed' AND (${!own} OR q.assignee_id=${actor.id}::uuid)))
    AND (${view!=='closed'} OR (q.status='completed' AND ${own
      ?sql`EXISTS(SELECT 1 FROM queue_events e WHERE e.queue_item_id=q.id AND e.event_type='completed' AND e.actor_id=${actor.id}::uuid)`
      :sql`true`}))
    -- Outcome of the current closure (the latest review cycle).
    AND (${q.outcome??null}::text IS NULL OR EXISTS (SELECT 1 FROM queue_reviews rv WHERE rv.queue_item_id=q.id
      AND rv.cycle=q.reopen_count+1 AND rv.outcome=${q.outcome??null}))`;
}
// Source can disappear under retention/redaction; operational history survives.
const joins=sql`LEFT JOIN posts p ON p.id=q.post_id AND p.posted_at=q.post_posted_at AND NOT p.is_redacted
  LEFT JOIN post_classifications c ON c.post_id=p.id AND c.posted_at=p.posted_at
  LEFT JOIN post_sentiments s ON s.post_id=p.id AND s.posted_at=p.posted_at`;
// Story cards read the live story; the snapshot covers a story merged away or aged out.
const storyColumns=sql`coalesce(st.title_ar,q.story_snapshot->>'title') AS story_title,
  coalesce(st.summary_ar,st.why_ar,q.story_snapshot->>'summary',q.story_snapshot->>'why') AS story_summary,
  coalesce(st.post_count,(q.story_snapshot->>'postCount')::int) AS story_post_count,
  coalesce(st.first_seen_at,(q.story_snapshot->>'firstSeenAt')::timestamptz) AS story_first_seen_at,
  coalesce(st.last_seen_at,(q.story_snapshot->>'lastSeenAt')::timestamptz) AS story_last_seen_at,
  coalesce(st.state,q.story_snapshot->>'state') AS story_state,st.influencer_count AS story_influencer_count,
  st.live_score::float AS story_score,
  su.story_snapshot->>'title' AS parent_story_title`;
const storyJoins=sql`LEFT JOIN signal_stories st ON st.id=q.story_id LEFT JOIN queue_items su ON su.id=q.story_item_id`;

const alertColumns=sql`a.id,a.kind,a.section,a.created_at,r.read_at,q.id AS item_id,q.program_snapshot->>'name' AS program_name,
  coalesce(q.story_snapshot->>'title',left(p.text,140)) AS title,coalesce(au.display_name,au.username) AS author_name`;
const alertJoins=sql`JOIN queue_alerts a ON a.id=r.alert_id JOIN queue_items q ON q.id=a.queue_item_id
  LEFT JOIN posts p ON p.id=q.post_id AND p.posted_at=q.post_posted_at AND NOT p.is_redacted
  LEFT JOIN authors au ON au.id=p.author_id`;
const cleanAlerts=(rows:Array<Record<string,unknown>>)=>rows.map(r=>({...r,title:typeof r.title==='string'?redactSensitiveText(r.title):r.title}));

export default async function queueRoutes(app:FastifyInstance) {
  app.addHook('onRequest',app.authenticate);
  const read={preHandler:[requireScope(QUEUE)]};
  const manage={preHandler:[app.requirePermission(P.QUEUE_SUPERVISE),requireScope(QUEUE)]};
  app.get('/items',read,async req=>{
    const q=parse(querySchema,req.query);
    let cursor:z.infer<typeof cursorSchema>|null=null;
    if(q.cursor) {
      try {cursor=parse(cursorSchema,JSON.parse(Buffer.from(q.cursor,'base64url').toString()));}
      catch {throw badRequest('مؤشر الصفحة غير صالح');}
      if(!Number.isFinite(Date.parse(cursor.at))||!Number.isFinite(Date.parse(cursor.through)))throw badRequest('مؤشر الصفحة غير صالح');
    }
    // Preserve microseconds as text; Date truncation would repeat/skip cursor rows.
    const [{through}]=await sql`SELECT clock_timestamp()::text AS through`;
    const upper=cursor?.through??through;
    const rows=await sql`SELECT q.*,q.entered_at::text AS cursor_at,p.text,p.x_author_id,p.url,p.is_reply,p.is_quote,
      a.username,a.display_name,a.profile_image_url,a.followers_count,c.intent,c.relevance,s.label AS sentiment,
      u.full_name AS assignee_name,t.name AS team_name,${storyColumns},tpc.name_ar AS topic_name,
      (SELECT count(*)::int FROM queue_items m WHERE m.story_item_id=q.id AND m.status NOT IN ('new','completed')) AS story_active_items
      FROM queue_items q ${joins} ${storyJoins} LEFT JOIN authors a ON a.id=p.author_id LEFT JOIN topics tpc ON tpc.id=c.topic_id
      LEFT JOIN users u ON u.id=q.assignee_id JOIN teams t ON t.id=q.team_id
      WHERE ${filter(req.user,q)} AND q.entered_at<=${upper}::timestamptz
        AND (${cursor?.at??null}::timestamptz IS NULL OR (q.entered_at,q.id)>(${cursor?.at??null}::timestamptz,${cursor?.id??null}::uuid))
      ORDER BY q.entered_at,q.id LIMIT ${q.limit+1}`;
    const more=rows.length>q.limit;const items=rows.slice(0,q.limit);const last=items.at(-1);
    return {items:redactRows(items),nextCursor:more&&last?Buffer.from(JSON.stringify({at:last.cursor_at,id:last.id,through:upper})).toString('base64url'):null};
  });
  app.get('/items/:id',read,async req=>{
    const {id}=parse(idParams,req.params);
    const [item]=await sql`SELECT q.*,p.text,p.x_author_id,p.url,p.is_reply,p.is_quote,a.username,a.display_name,a.profile_image_url,
      a.followers_count,c.intent,c.relevance,c.topic_id,tp.name_ar AS topic_name,c.reason_ar,s.label AS sentiment,
      -- The AI prediction as the reviewer sees it: main/sub topic split, confidences, model.
      c.program_id AS ai_program_id,c.intent_confidence::float AS intent_confidence,c.relevance_confidence::float AS relevance_confidence,
      s.confidence::float AS sentiment_confidence,c.model AS ai_model,
      CASE WHEN tp.level=2 THEN tp.parent_id ELSE tp.id END AS ai_topic_id,CASE WHEN tp.level=2 THEN tp.id END AS ai_subtopic_id,
      u.full_name AS assignee_name,t.name AS team_name,${storyColumns},
      -- For a held move: the team that owns this post's story (the transfer's natural target).
      (SELECT ht.id FROM signal_story_members hm JOIN queue_items hu ON hu.interaction_type='story' AND hu.story_id=hm.story_id
        AND hu.merged_into_id IS NULL JOIN teams ht ON ht.id=hu.team_id
        WHERE q.section_hold IS NOT NULL AND hm.post_id=q.post_id AND hm.posted_at=q.post_posted_at LIMIT 1) AS hold_team_id,
      coalesce((SELECT jsonb_agg(jsonb_build_object('url',m.url,'type',m.type,'previewImageUrl',m.preview_image_url))
        FROM post_media m WHERE m.post_id=p.id AND m.posted_at=p.posted_at),'[]') AS media
      FROM queue_items q ${joins} ${storyJoins} LEFT JOIN topics tp ON tp.id=c.topic_id LEFT JOIN authors a ON a.id=p.author_id
      LEFT JOIN users u ON u.id=q.assignee_id
      JOIN teams t ON t.id=q.team_id WHERE q.id=${id}::uuid AND (${queueScope(req.user)})`;
    if(!item)throw notFound();
    const events=await sql`SELECT e.*,u.full_name AS actor_name FROM queue_events e JOIN queue_items q ON q.id=e.queue_item_id
      LEFT JOIN users u ON u.id=e.actor_id WHERE q.id=${id}::uuid AND (${queueScope(req.user)}) ORDER BY e.version`;
    const notes=await sql`SELECT n.*,u.full_name AS author_name FROM queue_notes n JOIN queue_items q ON q.id=n.queue_item_id
      JOIN users u ON u.id=n.author_id WHERE q.id=${id}::uuid AND (${queueScope(req.user)}) ORDER BY n.created_at,n.id`;
    // A story unit carries its interactions: the live story's members, plus the
    // queue status of any member that is (or was) its own work item.
    const members=item.interaction_type!=='story'?[]:redactRows(await sql`
      SELECT po.id AS post_id,po.text,po.url,po.posted_at,a.username,a.display_name,a.profile_image_url,sm.source_role,
        ps.label AS sentiment,mi.id AS item_id,mi.status AS item_status,mu.full_name AS item_assignee_name
      FROM signal_story_members sm JOIN posts po ON po.id=sm.post_id AND po.posted_at=sm.posted_at AND NOT po.is_redacted
      LEFT JOIN authors a ON a.id=po.author_id
      LEFT JOIN post_sentiments ps ON ps.post_id=po.id AND ps.posted_at=po.posted_at
      LEFT JOIN queue_items mi ON mi.interaction_type='post' AND mi.post_id=po.id AND mi.post_posted_at=po.posted_at
      LEFT JOIN users mu ON mu.id=mi.assignee_id
      WHERE sm.story_id=${item.story_id}::uuid
      ORDER BY sm.is_representative DESC,po.posted_at DESC LIMIT 100`);
    const merged=item.interaction_type!=='story'?[]:await sql`SELECT q.id,q.story_snapshot->>'title' AS title,q.status
      FROM queue_items q WHERE q.merged_into_id=${id}::uuid AND (${queueScope(req.user)}) ORDER BY q.entered_at`;
    // Every review cycle, oldest first: a reopened item keeps its earlier reviews.
    const reviews=await sql`SELECT r.id,r.cycle,r.outcome,r.ai,r.program_id,r.intent,r.sentiment,r.relevant,r.topic_id,r.subtopic_id,
        r.links_confirmed,r.corrected_fields,r.reason,r.reviewed_at,r.assigned_at,r.started_at,r.completed_at,u.full_name AS reviewer_name
      FROM queue_reviews r JOIN queue_items q ON q.id=r.queue_item_id JOIN users u ON u.id=r.reviewer_id
      WHERE q.id=${id}::uuid AND (${queueScope(req.user)}) ORDER BY r.cycle`;
    return {...redactRows([item])[0],events,notes,members,merged,reviews};
  });
  app.get('/summary',read,async req=>{
    const q=parse(querySchema,req.query);
    // One pass over every section with all filters except section and status,
    // so the tab counts and the status strip always agree and never overlap.
    const rows=await sql<{section:string;status:string;count:number}[]>`SELECT q.section,q.status,count(*)::int AS count
      FROM queue_items q ${joins} WHERE ${filter(req.user,{...q,view:'all',status:undefined,section:undefined})}
      GROUP BY q.section,q.status`;
    const sections=Object.fromEntries(QUEUE_SECTIONS.map(sec=>[sec,Object.fromEntries(QUEUE_STATUSES.map(st=>
      [st,rows.find(r=>r.section===sec&&r.status===st)?.count??0]))]));
    const counts=q.section?sections[q.section]:Object.fromEntries(QUEUE_STATUSES.map(st=>[st,rows.filter(r=>r.status===st).reduce((n,r)=>n+r.count,0)]));
    const today=dateBoundsFromQuery({range:'today'});
    const workload=resolveScope(req.user.permissions,QUEUE)==='own'?[]:await sql`
      SELECT u.id,u.full_name,t.id AS team_id,t.name AS team_name,
        (SELECT count(*)::int FROM queue_items q WHERE q.team_id=t.id AND q.assignee_id=u.id AND q.merged_into_id IS NULL AND q.status IN ('assigned','in_progress') AND (${queueScope(req.user)})) AS open,
        (SELECT count(*)::int FROM queue_items q WHERE q.team_id=t.id AND q.assignee_id=u.id AND q.merged_into_id IS NULL AND q.status='escalated' AND (${queueScope(req.user)})) AS escalated,
        coalesce((SELECT sp.status FROM agent_status_periods sp WHERE sp.user_id=u.id AND sp.ended_at IS NULL),'offline') AS agent_status,
        (SELECT count(DISTINCT e.queue_item_id)::int FROM queue_events e JOIN queue_items q ON q.id=e.queue_item_id
          WHERE e.actor_id=u.id AND e.event_type='completed' AND e.created_at>=${today.from}::timestamptz
          AND e.created_at<${today.to}::timestamptz AND q.team_id=t.id AND (${queueScope(req.user)})) AS completed_today
      FROM team_members tm JOIN users u ON u.id=tm.user_id JOIN teams t ON t.id=tm.team_id
      WHERE tm.left_at IS NULL AND t.is_active AND u.is_active AND u.deleted_at IS NULL AND (${queueTeamScope(req.user)})
        AND (${q.teamId??null}::uuid IS NULL OR t.id=${q.teamId??null}::uuid) ORDER BY t.name,u.full_name`;
    const held=resolveScope(req.user.permissions,QUEUE)==='own'?0:(await sql<{n:number}[]>`SELECT count(*)::int AS n FROM queue_items q
      WHERE q.section_hold IS NOT NULL AND (${queueScope(req.user)})`)[0].n;
    // Per-section counts of each work view, with the same filters, for the view tabs.
    const views=await sql<{section:string;mine:number;unassigned:number;closed:number}[]>`SELECT q.section,
        count(*) FILTER (WHERE q.assignee_id=${req.user.id}::uuid AND q.status<>'completed')::int AS mine,
        count(*) FILTER (WHERE q.status='new')::int AS unassigned,
        count(*) FILTER (WHERE q.status='completed' AND (${resolveScope(req.user.permissions,QUEUE)!=='own'} OR EXISTS
          (SELECT 1 FROM queue_events e WHERE e.queue_item_id=q.id AND e.event_type='completed' AND e.actor_id=${req.user.id}::uuid)))::int AS closed
      FROM queue_items q ${joins} WHERE ${filter(req.user,{...q,view:'all',status:undefined,section:undefined})} GROUP BY q.section`;
    const viewCounts=Object.fromEntries(QUEUE_SECTIONS.map(sec=>{const r=views.find(v=>v.section===sec);
      return [sec,{mine:r?.mine??0,unassigned:r?.unassigned??0,closed:r?.closed??0}];}));
    // Server clock, so timers never depend on the browser's clock.
    const [{now}]=await sql<{now:string}[]>`SELECT now()::text AS now`;
    return {counts,sections,views:viewCounts,workload,held,updatedAt:new Date(now).toISOString(),serverNow:new Date(now).toISOString()};
  });
  app.get('/options',manage,async req=>{
    const teams=await sql`SELECT t.id,t.name FROM teams t WHERE t.is_active AND (${queueTeamScope(req.user)}) ORDER BY t.name`;
    // Availability and box load next to each name, so a manual assignment is an informed choice.
    const members=await sql`SELECT u.id,u.full_name,tm.team_id,tm.kind,coalesce(sp.status,'offline') AS status,
        (SELECT count(*)::int FROM queue_items o WHERE o.assignee_id=u.id AND o.status IN ('assigned','in_progress') AND o.merged_into_id IS NULL) AS open
      FROM team_members tm JOIN teams t ON t.id=tm.team_id
      JOIN users u ON u.id=tm.user_id JOIN roles r ON r.id=u.role_id
      LEFT JOIN agent_status_periods sp ON sp.user_id=u.id AND sp.ended_at IS NULL WHERE t.is_active AND tm.left_at IS NULL
      AND u.is_active AND u.deleted_at IS NULL AND r.key=tm.kind AND (${queueTeamScope(req.user)}) ORDER BY u.full_name`;
    const programs=await sql`SELECT p.id,p.name_ar,tp.team_id FROM team_programs tp JOIN teams t ON t.id=tp.team_id
      JOIN programs p ON p.id=tp.program_id WHERE t.is_active AND (${queueTeamScope(req.user)}) ORDER BY p.name_ar`;
    return {teams,members,programs};
  });
  app.post('/items',manage,async(req,reply)=>{
    const input=parse(z.object({postId:uuid,postedAt:z.string().datetime({offset:true}),teamId:uuid.optional()}).strict(),req.body);
    return reply.code(201).send(await manualAdd(req,input));
  });
  app.post('/items/:id/transfer',manage,async req=>{
    const {id}=parse(idParams,req.params);
    const input=parse(z.object({expectedVersion,teamId:uuid,assigneeId:uuid,reason:z.string().trim().min(1).max(2000)}).strict(),req.body);
    return transferItem(req,id,input);
  });
  app.post('/items/:id/priority',manage,async req=>{
    const {id}=parse(idParams,req.params);
    const input=parse(z.object({expectedVersion,priority:z.enum(['normal','high']),reason:z.string().trim().min(1).max(2000)}).strict(),req.body);
    return setPriority(req,id,input);
  });
  for(const action of QUEUE_ACTIONS) {
    app.post(`/items/:id/${action}`,{
      preHandler:[app.requirePermission(...(['assign','unassign','reopen'].includes(action)?[P.QUEUE_SUPERVISE]:[P.QUEUE_WORK,P.QUEUE_SUPERVISE])),requireScope(QUEUE)],
    },async req=>{
      const {id}=parse(idParams,req.params);
      const fields={expectedVersion};
      const schema=action==='assign'?z.object({...fields,assigneeId:uuid,reason:z.string().trim().min(1).max(2000).optional()}):
        action==='escalate'?z.object({...fields,reason:z.string().trim().min(1).max(2000)}):
        action==='complete'?z.object({...fields,review:reviewSchema}):
        action==='reopen'?z.object({...fields,reason:z.string().trim().min(1).max(2000)}):
        action==='unassign'?z.object({...fields,reason:z.string().trim().min(1).max(2000).optional()}):
        action==='notes'?z.object({...fields,body:z.string().trim().min(1).max(5000)}):z.object(fields);
      return mutateItem(req.user,id,action,parse(schema.strict(),req.body),req);
    });
  }
  app.post('/items/:id/claim',{preHandler:[app.requirePermission(P.QUEUE_WORK),requireScope(QUEUE)]},async req=>{
    const {id}=parse(idParams,req.params);
    return claimItem(req.user,id,parse(z.object({expectedVersion}).strict(),req.body));
  });
  /** The live dictionary the reviewer chooses from: programs, active topics/subtopics, intents, sentiments. */
  app.get('/review-catalog',read,async()=>{
    const programs=await sql`SELECT id,key,name_ar FROM programs WHERE is_active ORDER BY name_ar`;
    const topics=await sql`SELECT id,program_id,parent_id,level,name_ar FROM topics WHERE is_active AND level IN (1,2) ORDER BY program_id,level,name_ar`;
    const settings=await sql`SELECT key,value FROM settings WHERE key IN ('queue.self_claim_enabled','queue.wait_warning_minutes')`;
    return {programs,topics,intents:INTENT_LABELS,sentiments:SENTIMENT_LABELS,
      selfClaim:settings.find(r=>r.key==='queue.self_claim_enabled')?.value===true,
      waitWarningMinutes:Number(settings.find(r=>r.key==='queue.wait_warning_minutes')?.value??60)};
  });
  app.get('/stats',read,async req=>queueStats(req.user,parse(statsSchema,req.query)));

  // ── Alerts: influencer and story sections only, per-user read/announce state ──
  // Every read re-applies the queue scope, so an alert never outlives access.
  app.get('/alerts',read,async req=>{
    const items=await sql`SELECT ${alertColumns} FROM queue_alert_recipients r ${alertJoins}
      WHERE r.user_id=${req.user.id}::uuid AND (${queueScope(req.user)}) ORDER BY a.created_at DESC,a.id LIMIT 40`;
    return {items:cleanAlerts(items),...await unread(req.user)};
  });
  /**
   * Claims the caller's not-yet-announced alerts, atomically: a claimed alert
   * is never returned again — not on the next poll, a reload or another tab.
   * Only alerts at most two minutes old come back as "fresh" (sound/toast);
   * older ones (offline, first sign-in) are claimed silently and stay in the bell.
   * `initial` (first poll of a page) claims silently too.
   */
  app.post('/alerts/claim',read,async req=>{
    const {initial}=parse(z.object({initial:z.boolean().default(false)}).strict(),req.body??{});
    const claimed=await sql<{alert_id:string}[]>`UPDATE queue_alert_recipients r SET announced_at=now()
      WHERE r.user_id=${req.user.id}::uuid AND r.announced_at IS NULL RETURNING r.alert_id`;
    const ids=claimed.map(c=>c.alert_id);
    const fresh=initial||!ids.length?[]:await sql`SELECT ${alertColumns} FROM queue_alert_recipients r ${alertJoins}
      WHERE r.user_id=${req.user.id}::uuid AND a.id=ANY(${ids}::uuid[]) AND a.created_at>now()-interval '2 minutes'
        AND r.read_at IS NULL AND (${queueScope(req.user)}) ORDER BY a.created_at,a.id`;
    return {fresh:cleanAlerts(fresh),...await unread(req.user)};
  });
  app.post('/alerts/:id/read',read,async req=>{
    const {id}=parse(idParams,req.params);
    const [row]=await sql`UPDATE queue_alert_recipients r SET read_at=coalesce(r.read_at,now())
      FROM queue_alerts a JOIN queue_items q ON q.id=a.queue_item_id
      WHERE r.alert_id=${id}::uuid AND a.id=r.alert_id AND r.user_id=${req.user.id}::uuid AND (${queueScope(req.user)}) RETURNING r.alert_id`;
    if(!row)throw notFound();
    return unread(req.user);
  });
  app.post('/alerts/read-all',read,async req=>{
    const {section}=parse(z.object({section:z.enum(['influencer','story']).optional()}).strict(),req.body??{});
    await sql`UPDATE queue_alert_recipients r SET read_at=now()
      FROM queue_alerts a JOIN queue_items q ON q.id=a.queue_item_id
      WHERE a.id=r.alert_id AND r.user_id=${req.user.id}::uuid AND r.read_at IS NULL
        AND (${section??null}::text IS NULL OR a.section=${section??null}) AND (${queueScope(req.user)})`;
    return unread(req.user);
  });
  app.get('/alerts/prefs',read,async req=>prefs(req.user.id));
  app.put('/alerts/prefs',read,async req=>{
    const input=parse(z.object({soundEnabled:z.boolean(),toastsEnabled:z.boolean(),volume:z.number().min(0).max(1)}).strict(),req.body);
    await sql`INSERT INTO queue_alert_prefs(user_id,sound_enabled,toasts_enabled,volume)
      VALUES (${req.user.id},${input.soundEnabled},${input.toastsEnabled},${input.volume})
      ON CONFLICT (user_id) DO UPDATE SET sound_enabled=EXCLUDED.sound_enabled,toasts_enabled=EXCLUDED.toasts_enabled,
        volume=EXCLUDED.volume,updated_at=now()`;
    return prefs(req.user.id);
  });

  const settingsAccess={preHandler:[app.requirePermission(P.SETTINGS_WRITE)]};
  app.get('/intake-settings',settingsAccess,async()=>{
    const rows=await sql`SELECT key,value FROM settings WHERE key IN ('queue.intake_enabled','queue.intake_starts_at')`;
    return {enabled:rows.find(r=>r.key==='queue.intake_enabled')?.value===true,startsAt:rows.find(r=>r.key==='queue.intake_starts_at')?.value??null};
  });
  app.put('/intake-settings',settingsAccess,async req=>{
    const input=parse(z.object({enabled:z.boolean(),startsAt:z.string().datetime({offset:true}).nullable()}).strict(),req.body);
    return sql.begin(async tx=>{
      await tx`SELECT pg_advisory_xact_lock(hashtext('mip:queue-intake'))`;
      const rows=await tx`SELECT key,value FROM settings WHERE key IN ('queue.intake_enabled','queue.intake_starts_at') FOR UPDATE`;
      const oldStart=rows.find(r=>r.key==='queue.intake_starts_at')?.value;
      if(input.enabled&&!input.startsAt)throw badRequest('حدد لحظة إطلاق الاستقبال أولاً');
      // No retrospective enable, and an established boundary never moves back.
      if(input.startsAt && (oldStart?Date.parse(input.startsAt)<Date.parse(oldStart):Date.parse(input.startsAt)<Date.now()))
        throw badRequest('بداية الاستقبال الجديدة يجب أن تكون الآن أو مستقبلاً، ولا يمكن إرجاعها للخلف');
      if(oldStart&&!input.startsAt)throw badRequest('لا يمكن مسح بداية استقبال سابقة');
      for(const [key,value] of [['queue.intake_enabled',input.enabled],['queue.intake_starts_at',input.startsAt]] as const)
        await tx`UPDATE settings SET value=${JSON.stringify(value)}::jsonb WHERE key=${key}`;
      await administrativeAudit(tx,req,'queue.intake_settings_change','settings',null,input);
      return input;
    });
  });
}

async function unread(actor:QueueActor) {
  const rows=await sql<{section:string;n:number}[]>`SELECT a.section,count(*)::int AS n FROM queue_alert_recipients r
    JOIN queue_alerts a ON a.id=r.alert_id JOIN queue_items q ON q.id=a.queue_item_id
    WHERE r.user_id=${actor.id}::uuid AND r.read_at IS NULL AND (${queueScope(actor)}) GROUP BY a.section`;
  const bySection={influencer:rows.find(r=>r.section==='influencer')?.n??0,story:rows.find(r=>r.section==='story')?.n??0};
  return {unread:bySection.influencer+bySection.story,unreadBySection:bySection};
}
async function prefs(userId:string) {
  const [row]=await sql<{sound_enabled:boolean;toasts_enabled:boolean;volume:string}[]>`
    SELECT sound_enabled,toasts_enabled,volume FROM queue_alert_prefs WHERE user_id=${userId}::uuid`;
  return {soundEnabled:row?.sound_enabled??true,toastsEnabled:row?.toasts_enabled??true,volume:row?Number(row.volume):0.6};
}
