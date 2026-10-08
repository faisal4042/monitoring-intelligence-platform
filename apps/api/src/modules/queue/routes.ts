import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql, normalizeArabic } from '@mip/db';
import { QUEUE_ACTIONS, QUEUE_RESOLUTIONS, QUEUE_STATUSES, PERMISSIONS as P } from '@mip/shared';
import { QUEUE, queueScope, queueTeamScope, requireScope, resolveScope, type QueueActor } from '../../lib/authz.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { dateBoundsFromQuery } from '../../lib/date-range.js';
import { redactRows } from '../../lib/privacy.js';
import { administrativeAudit, manualAdd, mutateItem } from './service.js';
import { expectedVersion, idParams, parse } from './validation.js';

const uuid=z.string().uuid();
const querySchema=z.object({
  range:z.string().optional(),from:z.string().optional(),to:z.string().optional(),basis:z.enum(['entered','posted']).default('entered'),
  view:z.enum(['open','completed','all']).optional(),status:z.enum(QUEUE_STATUSES).optional(),
  programId:uuid.optional(),teamId:uuid.optional(),employeeId:uuid.optional(),
  classification:z.enum(['complaint','inquiry','suggestion','praise','news','experience','warning','issue','request','other']).optional(),
  sentiment:z.enum(['very_positive','positive','neutral','negative','very_negative']).optional(),
  search:z.string().max(200).optional(),limit:z.coerce.number().int().min(1).max(100).default(40),cursor:z.string().max(1200).optional(),
}).strict();
type Query=z.infer<typeof querySchema>;
const cursorSchema=z.object({at:z.string().min(10).max(40),id:uuid,through:z.string().min(10).max(40)}).strict();
function filter(actor:QueueActor,q:Query) {
  const dates=dateBoundsFromQuery({range:q.range,from:q.from,to:q.to});
  const column=q.basis==='posted'?sql`q.post_posted_at`:sql`q.entered_at`;
  const own=resolveScope(actor.permissions,QUEUE)==='own';
  const view=q.view??(own?'open':'all');
  return sql`(${queueScope(actor)}) AND ${column}>=${dates.from}::timestamptz AND ${column}<${dates.to}::timestamptz
    AND (${q.status??null}::text IS NULL OR q.status=${q.status??null})
    AND (${q.programId??null}::uuid IS NULL OR q.program_id=${q.programId??null}::uuid)
    AND (${q.teamId??null}::uuid IS NULL OR q.team_id=${q.teamId??null}::uuid)
    AND (${q.employeeId??null}::uuid IS NULL OR q.assignee_id=${q.employeeId??null}::uuid)
    AND (${q.classification??null}::text IS NULL OR c.intent::text=${q.classification??null})
    AND (${q.sentiment??null}::text IS NULL OR s.label::text=${q.sentiment??null})
    AND (${q.search??null}::text IS NULL OR p.text_normalized LIKE ${'%'+normalizeArabic(q.search??'')+'%'})
    AND (${view!=='open'} OR (q.status<>'completed' AND (${!own} OR q.assignee_id=${actor.id}::uuid)))
    AND (${view!=='completed'} OR ${own
      ?sql`EXISTS(SELECT 1 FROM queue_events e WHERE e.queue_item_id=q.id AND e.event_type='completed' AND e.actor_id=${actor.id}::uuid)`
      :sql`q.status='completed'`})`;
}
// Source can disappear under retention/redaction; operational history survives.
const joins=sql`LEFT JOIN posts p ON p.id=q.post_id AND p.posted_at=q.post_posted_at AND NOT p.is_redacted
  LEFT JOIN post_classifications c ON c.post_id=p.id AND c.posted_at=p.posted_at
  LEFT JOIN post_sentiments s ON s.post_id=p.id AND s.posted_at=p.posted_at`;

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
    const rows=await sql`SELECT q.*,q.entered_at::text AS cursor_at,p.text,p.x_author_id,p.url,
      a.username,a.display_name,c.intent,c.relevance,s.label AS sentiment,u.full_name AS assignee_name,t.name AS team_name
      FROM queue_items q ${joins} LEFT JOIN authors a ON a.id=p.author_id
      LEFT JOIN users u ON u.id=q.assignee_id JOIN teams t ON t.id=q.team_id
      WHERE ${filter(req.user,q)} AND q.entered_at<=${upper}::timestamptz
        AND (${cursor?.at??null}::timestamptz IS NULL OR (q.entered_at,q.id)>(${cursor?.at??null}::timestamptz,${cursor?.id??null}::uuid))
      ORDER BY q.entered_at,q.id LIMIT ${q.limit+1}`;
    const more=rows.length>q.limit;const items=rows.slice(0,q.limit);const last=items.at(-1);
    return {items:redactRows(items),nextCursor:more&&last?Buffer.from(JSON.stringify({at:last.cursor_at,id:last.id,through:upper})).toString('base64url'):null};
  });
  app.get('/items/:id',read,async req=>{
    const {id}=parse(idParams,req.params);
    const [item]=await sql`SELECT q.*,p.text,p.x_author_id,p.url,a.username,a.display_name,c.intent,c.relevance,
      c.topic_id,c.reason_ar,s.label AS sentiment,u.full_name AS assignee_name,t.name AS team_name,
      coalesce((SELECT jsonb_agg(jsonb_build_object('url',m.url,'type',m.type,'previewImageUrl',m.preview_image_url))
        FROM post_media m WHERE m.post_id=p.id AND m.posted_at=p.posted_at),'[]') AS media
      FROM queue_items q ${joins} LEFT JOIN authors a ON a.id=p.author_id LEFT JOIN users u ON u.id=q.assignee_id
      JOIN teams t ON t.id=q.team_id WHERE q.id=${id}::uuid AND (${queueScope(req.user)})`;
    if(!item)throw notFound();
    const events=await sql`SELECT e.*,u.full_name AS actor_name FROM queue_events e JOIN queue_items q ON q.id=e.queue_item_id
      LEFT JOIN users u ON u.id=e.actor_id WHERE q.id=${id}::uuid AND (${queueScope(req.user)}) ORDER BY e.version`;
    const notes=await sql`SELECT n.*,u.full_name AS author_name FROM queue_notes n JOIN queue_items q ON q.id=n.queue_item_id
      JOIN users u ON u.id=n.author_id WHERE q.id=${id}::uuid AND (${queueScope(req.user)}) ORDER BY n.created_at,n.id`;
    return {...redactRows([item])[0],events,notes};
  });
  app.get('/summary',read,async req=>{
    const q=parse(querySchema,req.query);
    const counts=await sql`SELECT q.status,count(*)::int AS count FROM queue_items q ${joins}
      WHERE ${filter(req.user,{...q,view:'all',status:undefined})} GROUP BY q.status`;
    const today=dateBoundsFromQuery({range:'today'});
    const workload=resolveScope(req.user.permissions,QUEUE)==='own'?[]:await sql`
      SELECT u.id,u.full_name,t.id AS team_id,t.name AS team_name,
        (SELECT count(*)::int FROM queue_items q WHERE q.team_id=t.id AND q.assignee_id=u.id AND q.status<>'completed' AND (${queueScope(req.user)})) AS open,
        (SELECT count(DISTINCT e.queue_item_id)::int FROM queue_events e JOIN queue_items q ON q.id=e.queue_item_id
          WHERE e.actor_id=u.id AND e.event_type='completed' AND e.created_at>=${today.from}::timestamptz
          AND e.created_at<${today.to}::timestamptz AND q.team_id=t.id AND (${queueScope(req.user)})) AS completed_today
      FROM team_members tm JOIN users u ON u.id=tm.user_id JOIN teams t ON t.id=tm.team_id
      WHERE tm.left_at IS NULL AND t.is_active AND u.is_active AND u.deleted_at IS NULL AND (${queueTeamScope(req.user)})
        AND (${q.teamId??null}::uuid IS NULL OR t.id=${q.teamId??null}::uuid) ORDER BY t.name,u.full_name`;
    return {counts:Object.fromEntries(QUEUE_STATUSES.map(s=>[s,counts.find(c=>c.status===s)?.count??0])),workload};
  });
  app.get('/options',manage,async req=>{
    const teams=await sql`SELECT t.id,t.name FROM teams t WHERE t.is_active AND (${queueTeamScope(req.user)}) ORDER BY t.name`;
    const members=await sql`SELECT u.id,u.full_name,tm.team_id FROM team_members tm JOIN teams t ON t.id=tm.team_id
      JOIN users u ON u.id=tm.user_id JOIN roles r ON r.id=u.role_id WHERE t.is_active AND tm.left_at IS NULL
      AND u.is_active AND u.deleted_at IS NULL AND r.key=tm.kind AND (${queueTeamScope(req.user)}) ORDER BY u.full_name`;
    const programs=await sql`SELECT p.id,p.name_ar,tp.team_id FROM team_programs tp JOIN teams t ON t.id=tp.team_id
      JOIN programs p ON p.id=tp.program_id WHERE t.is_active AND (${queueTeamScope(req.user)}) ORDER BY p.name_ar`;
    return {teams,members,programs};
  });
  app.post('/items',manage,async(req,reply)=>{
    const input=parse(z.object({postId:uuid,postedAt:z.string().datetime({offset:true}),teamId:uuid.optional()}).strict(),req.body);
    return reply.code(201).send(await manualAdd(req,input));
  });
  for(const action of QUEUE_ACTIONS) {
    app.post(`/items/:id/${action}`,{
      preHandler:[app.requirePermission(...(['assign','unassign','reopen'].includes(action)?[P.QUEUE_SUPERVISE]:[P.QUEUE_WORK,P.QUEUE_SUPERVISE])),requireScope(QUEUE)],
    },async req=>{
      const {id}=parse(idParams,req.params);
      const fields={expectedVersion};
      const schema=action==='assign'?z.object({...fields,assigneeId:uuid}):
        action==='escalate'?z.object({...fields,reason:z.string().trim().min(1).max(2000)}):
        action==='complete'?z.object({...fields,resolution:z.enum(QUEUE_RESOLUTIONS)}):
        action==='notes'?z.object({...fields,body:z.string().trim().min(1).max(5000)}):z.object(fields);
      return mutateItem(req.user,id,action,parse(schema.strict(),req.body));
    });
  }
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
