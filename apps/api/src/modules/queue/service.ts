import { sql, type Transaction } from '@mip/db';
import { PERMISSIONS as P, type QueueAction, type QueueStatus } from '@mip/shared';
import { claimableByAgent, queueScope, queueTeamScope, type QueueActor } from '../../lib/authz.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { alertForEvents, authoredByInfluencer, storyUnitOf } from './sections.js';
import { prepareReview, type ReviewInput } from './reviews.js';
import { assignAfter } from './workforce.js';
import type { FastifyRequest } from 'fastify';

export type QueueTx = Transaction;
export interface Item {
  id:string; status:QueueStatus; assignee_id:string|null; team_id:string; version:number;
  first_assigned_at:Date|null; first_started_at:Date|null; started_at:Date|null; completed_at:Date|null;
  completed_by:string|null; resolution:string|null; reassignment_count:number; escalation_count:number;
  reopen_count:number; last_reopened_at:Date|null; section:string; merged_into_id:string|null;
  interaction_type:string; post_id:string|null; post_posted_at:Date|null; story_id:string|null; program_id:string;
  story_snapshot:Record<string,unknown>|null; entered_at:Date; assigned_at:Date|null;
}
export interface Mutation { expectedVersion:number; assigneeId?:string; reason?:string; body?:string; review?:ReviewInput }
const has = (a:QueueActor,p:string)=>a.permissions.includes(p);
export const supervises = (a:QueueActor)=>has(a,P.QUEUE_SUPERVISE);

/** Administrative audit shares the transaction; operational events never go here. */
export async function administrativeAudit(tx:QueueTx, req:FastifyRequest, action:string, entityType:string, entityId:string|null, value:unknown) {
  await tx`INSERT INTO audit_log(user_id,user_email,action,entity_type,entity_id,new_value,ip_address)
    VALUES (${req.user.id},${req.user.email},${action},${entityType},${entityId},${JSON.stringify(value)}::jsonb,${req.ip}::inet)`;
}

/**
 * Every state change and note uses a scoped compare-and-swap plus one event.
 *
 * There is no "start" step: an item's time in the agent's box runs from the
 * server-recorded assignment (assigned_at). Items left 'in_progress' by the
 * old flow are open work like 'assigned' ones; their history is untouched.
 */
export async function mutateItem(actor:QueueActor, id:string, action:QueueAction, input:Mutation, req?:FastifyRequest) {
  const item = await mutateItemTx(actor,id,action,input,req);
  // Freed box space or work back in the pool: try to hand out the next item.
  if (['complete','escalate','unassign'].includes(action) || action==='reopen' && item.status==='new' || action==='assign')
    await assignAfter(`item_${action}`);
  return item;
}

async function mutateItemTx(actor:QueueActor, id:string, action:QueueAction, input:Mutation, req?:FastifyRequest) {
  const supervisory = ['assign','unassign','reopen'].includes(action);
  if (supervisory ? !supervises(actor) : !has(actor,P.QUEUE_WORK) && !supervises(actor)) throw forbidden();
  return sql.begin(async tx=>{
    const [old] = await tx<Item[]>`SELECT q.* FROM queue_items q WHERE q.id=${id}::uuid AND (${queueScope(actor,true)})`;
    if (!old) throw notFound();
    if (old.merged_into_id) throw conflict('دُمجت هذه القصة في قصة أخرى؛ تابع العمل من القصة الأساسية.');
    if (old.version!==input.expectedVersion) throw conflict('تغير العنصر. حدّث القائمة وحاول مجدداً.');
    const isAssignee = old.assignee_id===actor.id;
    if (!supervises(actor) && !isAssignee) throw forbidden();
    let status=old.status, assignee=old.assignee_id, event:string=action, noteId:string|null=null, override:string[]=[];
    let review:Awaited<ReturnType<typeof prepareReview>>|null=null;
    switch(action) {
      case 'assign':
        if (!['new','assigned','escalated','in_progress'].includes(old.status)) throw conflict('لا يمكن الإسناد من هذه الحالة');
        if (!input.assigneeId) throw badRequest('الموظف مطلوب');
        // Taking work away from someone mid-task must say why; the new assignee starts their own cycle.
        if (old.status==='in_progress' && !input.reason?.trim()) throw badRequest('سبب إعادة الإسناد مطلوب أثناء المعالجة');
        // Lock membership and team while assigning; member move/remove uses the same rows.
        const [member]=await tx`SELECT tm.id FROM team_members tm JOIN users u ON u.id=tm.user_id
          JOIN roles r ON r.id=u.role_id JOIN teams t ON t.id=tm.team_id
          WHERE tm.team_id=${old.team_id}::uuid AND tm.user_id=${input.assigneeId}::uuid
            AND tm.left_at IS NULL AND t.is_active AND u.is_active AND u.deleted_at IS NULL
            AND ((tm.kind='agent' AND r.key='agent') OR (tm.kind='supervisor' AND r.key='supervisor'))
          FOR SHARE OF tm,u,t`;
        if(!member) throw badRequest('الموظف ليس عضواً نشطاً في فريق العنصر');
        if(['assigned','in_progress'].includes(old.status) && input.assigneeId===old.assignee_id) throw conflict('العنصر مسند لهذا الموظف بالفعل');
        // A supervisor may hand work to someone who is not available or whose
        // box is full (automatic assignment never does); the event says so.
        const [fit]=await tx<{status:string;open:number;max_open:number}[]>`SELECT coalesce(sp.status,'offline') AS status,
            (SELECT count(*)::int FROM queue_items o WHERE o.assignee_id=${input.assigneeId}::uuid AND o.status IN ('assigned','in_progress') AND o.merged_into_id IS NULL) AS open,
            coalesce(a.max_open,d.max_open,(SELECT value::text::int FROM settings WHERE key='queue.default_max_open'),5) AS max_open
          FROM users u LEFT JOIN agent_status_periods sp ON sp.user_id=u.id AND sp.ended_at IS NULL
          LEFT JOIN agent_queue_settings a ON a.user_id=u.id LEFT JOIN team_queue_defaults d ON d.team_id=${old.team_id}::uuid
          WHERE u.id=${input.assigneeId}::uuid`;
        override=[...(fit.status!=='available'?['not_available']:[]),...(fit.open>=fit.max_open?['box_full']:[])];
        status='assigned';assignee=input.assigneeId;
        event=old.status==='new'?'assigned':old.status==='escalated'?'deescalated':'reassigned';break;
      case 'unassign':
        if(!['assigned','in_progress'].includes(old.status))throw conflict('إلغاء الإسناد متاح للعنصر المسند غير المصعّد فقط');
        if(old.status==='in_progress'&&!input.reason?.trim())throw badRequest('سبب إلغاء الإسناد مطلوب');
        status='new';assignee=null;event='unassigned';break;
      case 'escalate':
        if(!['assigned','in_progress'].includes(old.status))throw conflict('لا يمكن التصعيد من هذه الحالة');
        if(!input.reason?.trim())throw badRequest('سبب التصعيد مطلوب');
        status='escalated';event='escalated';break;
      case 'complete':
        // Closing = monitoring review completed. Only the assignee (or a
        // supervisor for escalated work) closes, and only with a full review.
        if(!['assigned','in_progress'].includes(old.status) && !(old.status==='escalated' && supervises(actor)))throw conflict('الإغلاق متاح للعنصر المسند فقط');        review=await prepareReview(tx,old,input.review);
        status='completed';event='completed';break;
      case 'reopen': {
        if(old.status!=='completed')throw conflict('إعادة الفتح متاحة للمغلق فقط');
        if(!input.reason?.trim())throw badRequest('سبب إعادة الفتح مطلوب');
        // Back to the previous assignee only while they still belong to the team; otherwise it waits for assignment.
        const [still]=old.assignee_id?await tx`SELECT 1 FROM team_members tm JOIN users u ON u.id=tm.user_id JOIN roles r ON r.id=u.role_id
          JOIN teams t ON t.id=tm.team_id WHERE tm.team_id=${old.team_id}::uuid AND tm.user_id=${old.assignee_id}::uuid AND tm.left_at IS NULL
            AND t.is_active AND u.is_active AND u.deleted_at IS NULL AND r.key=tm.kind FOR SHARE OF tm,u`:[];
        status=still?'assigned':'new';assignee=still?old.assignee_id:null;event='reopened';break;
      }
      case 'notes':
        if(!input.body?.trim())throw badRequest('الملاحظة مطلوبة');
        event='note_added';break;
    }
    const [item]=await tx<Item[]>`UPDATE queue_items q SET status=${status}, assignee_id=${assignee}::uuid,
      version=q.version+1,updated_at=clock_timestamp(),
      first_assigned_at=CASE WHEN ${action==='assign'} THEN coalesce(q.first_assigned_at,clock_timestamp()) ELSE q.first_assigned_at END,
      -- The current cycle runs from the server-recorded assignment (or the reopen back to the assignee).
      assigned_at=CASE WHEN ${action==='assign'||action==='reopen'&&status==='assigned'} THEN clock_timestamp()
        WHEN ${action==='unassign'||action==='reopen'&&status==='new'} THEN NULL ELSE q.assigned_at END,
      -- started_at/first_started_at belong to the retired "start" step: kept for history, cleared when a cycle ends.
      started_at=CASE WHEN ${action==='assign'||action==='unassign'||action==='reopen'} THEN NULL ELSE q.started_at END,
      -- A reopened item is open: its previous close lives only in queue_events.
      completed_at=CASE WHEN ${action==='complete'} THEN clock_timestamp() WHEN ${action==='reopen'} THEN NULL ELSE q.completed_at END,
      completed_by=CASE WHEN ${action==='complete'} THEN ${actor.id}::uuid WHEN ${action==='reopen'} THEN NULL ELSE q.completed_by END,
      resolution=CASE WHEN ${action==='complete'} THEN ${review?.resolution??null} WHEN ${action==='reopen'} THEN NULL ELSE q.resolution END,
      reopen_count=q.reopen_count+${action==='reopen'?1:0},
      last_reopened_at=CASE WHEN ${action==='reopen'} THEN clock_timestamp() ELSE q.last_reopened_at END,
      last_escalated_at=CASE WHEN ${action==='escalate'} THEN clock_timestamp() ELSE q.last_escalated_at END,
      reassignment_count=q.reassignment_count+${event==='reassigned'?1:0},
      escalation_count=q.escalation_count+${event==='escalated'?1:0}
      WHERE q.id=${id}::uuid AND q.version=${input.expectedVersion} AND q.status=${old.status}
        AND (${queueScope(actor,true)}) RETURNING q.*`;
    if(!item) {
      const [visible]=await tx`SELECT q.id FROM queue_items q WHERE q.id=${id}::uuid AND (${queueScope(actor,true)})`;
      if(!visible)throw notFound();
      throw conflict('تغير العنصر أثناء العملية. حدّث القائمة.');
    }
    if(action==='notes') {
      const [note]=await tx`INSERT INTO queue_notes(queue_item_id,author_id,body) VALUES (${id},${actor.id},${input.body!}) RETURNING id`;
      noteId=note.id;
    }
    const [ev]=await tx<{id:string}[]>`INSERT INTO queue_events(queue_item_id,event_type,actor_id,from_status,to_status,from_assignee,to_assignee,reason,resolution,version,metadata)
      VALUES (${id},${event},${actor.id},${old.status},${status},${old.assignee_id},${assignee},${input.reason??null},
        ${review?.resolution??null},${item.version},${JSON.stringify(noteId?{noteId}:review?{outcome:review.outcome}:override.length?{override}:{})}::jsonb) RETURNING id`;
    if(review) {
      // One immutable review per closed cycle; the AI rows are not touched.
      const a=review.approved;
      await tx`INSERT INTO queue_reviews(queue_item_id,queue_event_id,cycle,reviewer_id,outcome,ai,program_id,intent,sentiment,relevant,
          topic_id,subtopic_id,links_confirmed,corrected_fields,reason,entered_at,assigned_at,started_at,completed_at)
        VALUES (${id},${ev.id},${old.reopen_count+1},${actor.id},${review.outcome},${JSON.stringify(review.ai)}::jsonb,${a.program_id}::uuid,
          ${a.intent},${a.sentiment},${a.relevant},${a.topic_id}::uuid,${a.subtopic_id}::uuid,${a.links_confirmed},${review.corrected},
          ${review.reason},${old.entered_at},${old.assigned_at},${old.started_at},${item.completed_at})`;
    }
    // Ownership changes are also administrative actions: audit them with the request's identity and IP.
    if(req && ['assigned','reassigned','deescalated','unassigned','reopened'].includes(event))
      await administrativeAudit(tx,req,`queue.${event}`,'queue_item',id,{fromAssignee:old.assignee_id,toAssignee:assignee,
        fromStatus:old.status,toStatus:status,reason:input.reason??null,version:item.version});
    // Handing an influencer/story item to someone tells them, in the same transaction.
    await alertForEvents(tx,[ev.id]);
    return item;
  });
}

export async function manualAdd(req:FastifyRequest, input:{postId:string;postedAt:string;teamId?:string}) {
  if(!supervises(req.user))throw forbidden();
  const item=await sql.begin(async tx=>{
    // Program is derived from source classification, never supplied by the client.
    const [source]=await tx`SELECT p.id,p.posted_at,c.program_id,pr.name_ar,pr.key,pr.color,t.id AS team_id,
        ${storyUnitOf} AS unit_id,${authoredByInfluencer} AS influencer
      FROM posts p JOIN post_classifications c ON c.post_id=p.id AND c.posted_at=p.posted_at
      JOIN programs pr ON pr.id=c.program_id JOIN team_programs tp ON tp.program_id=c.program_id
      JOIN teams t ON t.id=tp.team_id WHERE p.id=${input.postId}::uuid AND p.posted_at=${input.postedAt}::timestamptz
      AND NOT p.is_redacted AND p.status NOT IN ('duplicate','filtered_out') AND p.duplicate_of_id IS NULL AND p.duplicate_type IS NULL
      AND t.is_active AND (${queueTeamScope(req.user)})
      AND (${input.teamId??null}::uuid IS NULL OR t.id=${input.teamId??null}::uuid) FOR SHARE OF t,tp`;
    if(!source)throw notFound('المنشور أو فريق البرنامج غير متاح ضمن نطاقك');
    // Same placement rule as intake: inside its story's unit, else influencer, else general.
    const section=source.unit_id?'story':source.influencer?'influencer':'general';
    const [item]=await tx`INSERT INTO queue_items(post_id,post_posted_at,program_id,program_snapshot,team_id,section,story_item_id)
      VALUES (${source.id},${source.posted_at},${source.program_id},
        ${JSON.stringify({id:source.program_id,key:source.key,name:source.name_ar,color:source.color})}::jsonb,${source.team_id},
        ${section},${source.unit_id??null}::uuid)
      ON CONFLICT (post_id) WHERE interaction_type='post' DO NOTHING RETURNING *`;
    if(!item)throw conflict('المنشور موجود في الطابور بالفعل');
    const [ev]=await tx<{id:string}[]>`INSERT INTO queue_events(queue_item_id,event_type,actor_id,to_status,version) VALUES (${item.id},'created',${req.user.id},'new',1) RETURNING id`;
    await alertForEvents(tx,[ev.id]);
    await administrativeAudit(tx,req,'queue.manual_add','queue_item',item.id,{postId:source.id,teamId:source.team_id});
    return item;
  });
  await assignAfter('item_created');
  return item;
}

/**
 * Cross-team transfer: one transaction moves an open post item to another
 * team and hands it to a member of that team. The actor must hold the item
 * in scope (404 otherwise) and the target team in scope (404 otherwise); the
 * version must match (409). The previous team and assignee stay in the
 * event and the administrative audit. A post whose story is owned by the
 * target team lands in that story right away (the held move is resolved).
 */
export async function transferItem(req:FastifyRequest, id:string, input:{expectedVersion:number;teamId:string;assigneeId:string;reason:string}) {
  const actor=req.user;
  if(!supervises(actor))throw forbidden();
  const moved=await sql.begin(async tx=>{
    const [old]=await tx<(Item&{interaction_type:string;post_id:string;post_posted_at:string;story_item_id:string|null})[]>`
      SELECT q.* FROM queue_items q WHERE q.id=${id}::uuid AND (${queueScope(actor,true)}) FOR UPDATE`;
    if(!old)throw notFound();
    if(old.merged_into_id)throw conflict('دُمجت هذه القصة في قصة أخرى؛ تابع العمل من القصة الأساسية.');
    if(old.version!==input.expectedVersion)throw conflict('تغير العنصر. حدّث القائمة وحاول مجدداً.');
    if(old.interaction_type!=='post')throw conflict('القصة تتبع فريق برنامجها؛ النقل متاح للتفاعلات فقط');
    if(old.status==='completed')throw conflict('لا يمكن نقل عنصر مكتمل');
    if(old.team_id===input.teamId)throw badRequest('العنصر في هذا الفريق بالفعل؛ استخدم الإسناد');
    // The target team must be one the actor may act for; anything else looks absent.
    const [team]=await tx<{id:string;name:string}[]>`SELECT t.id,t.name FROM teams t
      WHERE t.id=${input.teamId}::uuid AND t.is_active AND (${queueTeamScope(actor)}) FOR SHARE`;
    if(!team)throw notFound('الفريق غير موجود ضمن نطاقك');
    const [member]=await tx`SELECT tm.id FROM team_members tm JOIN users u ON u.id=tm.user_id JOIN roles r ON r.id=u.role_id
      WHERE tm.team_id=${team.id}::uuid AND tm.user_id=${input.assigneeId}::uuid AND tm.left_at IS NULL
        AND u.is_active AND u.deleted_at IS NULL
        AND ((tm.kind='agent' AND r.key='agent') OR (tm.kind='supervisor' AND r.key='supervisor'))
      FOR SHARE OF tm,u`;
    if(!member)throw badRequest('الموظف ليس عضواً نشطاً في الفريق المستلم');
    const [from]=await tx<{name:string}[]>`SELECT name FROM teams WHERE id=${old.team_id}::uuid`;
    // Placement in the new team: inside its story's unit there, if any.
    const [unit]=await tx<{id:string}[]>`SELECT u.id FROM signal_story_members m
      JOIN queue_items u ON u.interaction_type='story' AND u.story_id=m.story_id AND u.merged_into_id IS NULL
      WHERE m.post_id=${old.post_id}::uuid AND m.posted_at=${old.post_posted_at}::timestamptz AND u.team_id=${team.id}::uuid LIMIT 1`;
    const [{influencer}]=await tx<{influencer:boolean}[]>`SELECT coalesce((SELECT ${authoredByInfluencer} FROM posts p
      WHERE p.id=${old.post_id}::uuid AND p.posted_at=${old.post_posted_at}::timestamptz),false) AS influencer`;
    const toSection=unit?'story':influencer?'influencer':old.section==='story'?'general':old.section;
    const [item]=await tx<Item[]>`UPDATE queue_items q SET team_id=${team.id}::uuid, status='assigned', assignee_id=${input.assigneeId}::uuid,
        section=${toSection}, story_item_id=${unit?.id??null}::uuid, section_hold=NULL,
        first_assigned_at=coalesce(q.first_assigned_at,clock_timestamp()), assigned_at=clock_timestamp(), started_at=NULL,
        reassignment_count=q.reassignment_count+${old.assignee_id?1:0},
        version=q.version+1, updated_at=clock_timestamp()
      WHERE q.id=${id}::uuid AND q.version=${input.expectedVersion} RETURNING q.*`;
    if(!item)throw conflict('تغير العنصر أثناء العملية. حدّث القائمة.');
    const meta={fromTeam:old.team_id,fromTeamName:from?.name??null,toTeam:team.id,toTeamName:team.name,
      fromSection:old.section,toSection,fromItem:old.story_item_id,toItem:unit?.id??null};
    const [ev]=await tx<{id:string}[]>`INSERT INTO queue_events(queue_item_id,event_type,actor_id,from_status,to_status,from_assignee,to_assignee,reason,version,metadata)
      VALUES (${id},'transferred',${actor.id},${old.status},'assigned',${old.assignee_id},${input.assigneeId},${input.reason},${item.version},
        ${JSON.stringify(meta)}::jsonb) RETURNING id`;
    await administrativeAudit(tx,req,'queue.transfer','queue_item',id,{...meta,fromAssignee:old.assignee_id,toAssignee:input.assigneeId,reason:input.reason});
    await alertForEvents(tx,[ev.id]);
    return item;
  });
  // The previous holder's box has room again.
  await assignAfter('item_transferred');
  return moved;
}

/**
 * Self-claim: an agent takes an unassigned item of their own team (only when
 * queue.self_claim_enabled is on). An ordinary audited assignment to oneself;
 * 404 for anything they may not claim, 409 on a stale version.
 */
export async function claimItem(actor:QueueActor, id:string, input:{expectedVersion:number}) {
  if(!has(actor,P.QUEUE_WORK))throw forbidden();
  return sql.begin(async tx=>{
    const [old]=await tx<Item[]>`SELECT q.* FROM queue_items q WHERE q.id=${id}::uuid AND q.status='new'
      AND q.merged_into_id IS NULL AND ${claimableByAgent(actor.id)} FOR UPDATE`;
    if(!old)throw notFound();
    if(old.version!==input.expectedVersion)throw conflict('تغير العنصر. حدّث القائمة وحاول مجدداً.');
    const [member]=await tx`SELECT 1 FROM team_members tm JOIN users u ON u.id=tm.user_id JOIN roles r ON r.id=u.role_id
      WHERE tm.team_id=${old.team_id}::uuid AND tm.user_id=${actor.id}::uuid AND tm.left_at IS NULL AND tm.kind='agent'
        AND r.key='agent' AND u.is_active AND u.deleted_at IS NULL FOR SHARE OF tm,u`;
    if(!member)throw notFound();
    const [item]=await tx<Item[]>`UPDATE queue_items q SET status='assigned',assignee_id=${actor.id}::uuid,
        first_assigned_at=coalesce(q.first_assigned_at,clock_timestamp()),assigned_at=clock_timestamp(),started_at=NULL,
        version=q.version+1,updated_at=clock_timestamp()
      WHERE q.id=${id}::uuid AND q.version=${input.expectedVersion} AND q.status='new' RETURNING q.*`;
    if(!item)throw conflict('استلم غيرك هذا العنصر. حدّث القائمة.');
    await tx`INSERT INTO queue_events(queue_item_id,event_type,actor_id,from_status,to_status,to_assignee,version,metadata)
      VALUES (${id},'assigned',${actor.id},'new','assigned',${actor.id},${item.version},${JSON.stringify({claimed:true})}::jsonb)`;
    return item;
  });
}

/**
 * High priority is a supervisor's call, never inferred: one CAS update plus a
 * 'priority_changed' event with the reason. Open items only.
 */
export async function setPriority(req:FastifyRequest, id:string, input:{expectedVersion:number;priority:'normal'|'high';reason:string}) {
  const actor=req.user;
  if(!supervises(actor))throw forbidden();
  const item=await sql.begin(async tx=>{
    const [old]=await tx<(Item&{priority:string})[]>`SELECT q.* FROM queue_items q WHERE q.id=${id}::uuid AND (${queueScope(actor,true)}) FOR UPDATE`;
    if(!old)throw notFound();
    if(old.version!==input.expectedVersion)throw conflict('تغير العنصر. حدّث القائمة وحاول مجدداً.');
    if(old.status==='completed'||old.merged_into_id)throw conflict('تغيير الأولوية متاح للعناصر المفتوحة فقط');
    if(old.priority===input.priority)throw conflict('الأولوية مضبوطة على هذه القيمة بالفعل');
    const [row]=await tx<Item[]>`UPDATE queue_items q SET priority=${input.priority},version=q.version+1,updated_at=clock_timestamp()
      WHERE q.id=${id}::uuid AND q.version=${input.expectedVersion} RETURNING q.*`;
    if(!row)throw conflict('تغير العنصر أثناء العملية. حدّث القائمة.');
    await tx`INSERT INTO queue_events(queue_item_id,event_type,actor_id,from_status,to_status,from_assignee,to_assignee,reason,version,metadata)
      VALUES (${id},'priority_changed',${actor.id},${old.status},${old.status},${old.assignee_id},${old.assignee_id},${input.reason},${row.version},
        ${JSON.stringify({from:old.priority,to:input.priority})}::jsonb)`;
    await administrativeAudit(tx,req,'queue.priority_change','queue_item',id,{from:old.priority,to:input.priority,reason:input.reason});
    return row;
  });
  if(item.status==='new')await assignAfter('priority_changed');
  return item;
}
