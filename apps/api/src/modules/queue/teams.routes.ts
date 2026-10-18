import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '@mip/db';
import { PERMISSIONS as P } from '@mip/shared';
import { badRequest,conflict,notFound } from '../../lib/errors.js';
import { administrativeAudit } from './service.js';
import { idParams,parse } from './validation.js';

export default async function teamRoutes(app:FastifyInstance) {
  app.addHook('onRequest',app.authenticate);
  const read={preHandler:[app.requirePermission(P.USERS_READ)]};
  const write={preHandler:[app.requirePermission(P.USERS_WRITE)]};
  app.get('/',read,async()=>({items:await sql`SELECT t.*,
    coalesce((SELECT jsonb_agg(jsonb_build_object('id',tm.id,'userId',tm.user_id,'name',u.full_name,'kind',tm.kind,
      'joinedAt',tm.joined_at,'leftAt',tm.left_at) ORDER BY tm.joined_at) FROM team_members tm JOIN users u ON u.id=tm.user_id WHERE tm.team_id=t.id),'[]') AS members,
    ARRAY(SELECT program_id FROM team_programs WHERE team_id=t.id) AS program_ids FROM teams t ORDER BY t.name`}));
  app.post('/',write,async(req,reply)=>{
    const input=parse(z.object({name:z.string().trim().min(1).max(120)}).strict(),req.body);
    const result=await sql.begin(async tx=>{
      const [team]=await tx`INSERT INTO teams(name) VALUES (${input.name}) RETURNING *`;
      await administrativeAudit(tx,req,'team.create','team',team.id,input);return team;
    });return reply.code(201).send(result);
  });
  app.patch('/:id',write,async req=>{
    const {id}=parse(idParams,req.params);
    const input=parse(z.object({name:z.string().trim().min(1).max(120).optional(),isActive:z.boolean().optional()}).strict()
      .refine(v=>Object.keys(v).length>0),req.body);
    return sql.begin(async tx=>{
      await tx`SELECT pg_advisory_xact_lock(hashtext('mip:queue-intake'))`;
      const [old]=await tx`SELECT * FROM teams WHERE id=${id} FOR UPDATE`;if(!old)throw notFound();
      if(input.isActive===false) {
        const [open]=await tx`SELECT id FROM queue_items WHERE team_id=${id} AND status<>'completed' LIMIT 1`;
        const [member]=await tx`SELECT id FROM team_members WHERE team_id=${id} AND left_at IS NULL LIMIT 1`;
        if(open||member)throw conflict('انقل العضويات وعالج العناصر المفتوحة قبل تعطيل الفريق');
      }
      const [team]=await tx`UPDATE teams SET name=${input.name??old.name},is_active=${input.isActive??old.is_active},updated_at=now() WHERE id=${id} RETURNING *`;
      await administrativeAudit(tx,req,'team.update','team',id,input);return team;
    });
  });
  app.post('/:id/members',write,async req=>{
    const {id}=parse(idParams,req.params);
    const input=parse(z.object({userId:z.string().uuid(),move:z.boolean().default(false)}).strict(),req.body);
    return sql.begin(async tx=>{
      const [u]=await tx`SELECT u.id,r.key FROM users u JOIN roles r ON r.id=u.role_id
        WHERE u.id=${input.userId} AND u.is_active AND u.deleted_at IS NULL FOR UPDATE OF u`;
      if(!u||!['agent','supervisor'].includes(u.key))throw badRequest('العضوية لموظف رصد أو مشرف نشط فقط');
      const [team]=await tx`SELECT id FROM teams WHERE id=${id} AND is_active FOR SHARE`;if(!team)throw notFound();
      const active=await tx`SELECT * FROM team_members WHERE user_id=${u.id} AND left_at IS NULL FOR UPDATE`;
      if(active.some(m=>m.team_id===id))throw conflict('المستخدم عضو بالفعل');
      if(u.key==='agent'&&active.length&&!input.move)throw conflict('للموظف فريق واحد. استخدم النقل لحفظ التاريخ');
      if(u.key==='agent'&&active.length)await tx`UPDATE team_members SET left_at=clock_timestamp() WHERE user_id=${u.id} AND left_at IS NULL`;
      const [member]=await tx`INSERT INTO team_members(team_id,user_id,kind) VALUES (${id},${u.id},${u.key}) RETURNING *`;
      await administrativeAudit(tx,req,u.key==='agent'&&active.length?'team.member_move':'team.member_add','team',id,
        {userId:u.id,fromTeams:active.map(m=>m.team_id),toTeam:id});return member;
    });
  });
  app.post('/:id/members/remove',write,async req=>{
    const {id}=parse(idParams,req.params);const input=parse(z.object({userId:z.string().uuid()}).strict(),req.body);
    return sql.begin(async tx=>{
      await tx`SELECT id FROM users WHERE id=${input.userId} FOR UPDATE`;
      const [member]=await tx`UPDATE team_members SET left_at=clock_timestamp() WHERE team_id=${id} AND user_id=${input.userId} AND left_at IS NULL RETURNING *`;
      if(!member)throw notFound();
      await administrativeAudit(tx,req,'team.member_remove','team',id,input);return member;
    });
  });
  app.put('/:id/programs',write,async req=>{
    const {id}=parse(idParams,req.params);const {programIds}=parse(z.object({programIds:z.array(z.string().uuid()).max(100)}).strict(),req.body);
    if(new Set(programIds).size!==programIds.length)throw badRequest('برنامج مكرر');
    return sql.begin(async tx=>{
      await tx`SELECT pg_advisory_xact_lock(hashtext('mip:queue-intake'))`;
      const [team]=await tx`SELECT id FROM teams WHERE id=${id} AND is_active FOR UPDATE`;if(!team)throw notFound();
      const programs=await tx`SELECT id FROM programs WHERE id=ANY(${programIds}::uuid[])`;
      if(programs.length!==programIds.length)throw badRequest('برنامج غير موجود');
      const [other]=await tx`SELECT team_id FROM team_programs WHERE program_id=ANY(${programIds}::uuid[]) AND team_id<>${id} LIMIT 1`;
      if(other)throw conflict('أحد البرامج مرتبط بفريق آخر. أزل الربط القديم أولاً');
      await tx`DELETE FROM team_programs WHERE team_id=${id}`;
      for(const p of programIds)await tx`INSERT INTO team_programs(team_id,program_id) VALUES (${id},${p})`;
      await administrativeAudit(tx,req,'team.programs_change','team',id,{programIds});return {programIds};
    });
  });
}
