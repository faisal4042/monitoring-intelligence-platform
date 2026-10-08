import { sql } from '@mip/db';
import { logger } from '@mip/logger';

/** No collection/network calls. A bounded, idempotent scan of eligible new source rows. */
export async function intakeQueue() {
  return sql.begin(async tx=>{
    // Also serializes settings/routing changes. Independent/manual insert races
    // are resolved by the partial unique index, never by a check-then-insert.
    const [lock]=await tx`SELECT pg_try_advisory_xact_lock(hashtext('mip:queue-intake')) AS acquired`;
    if(!lock.acquired)return {created:0};
    const rows=await tx`SELECT key,value FROM settings WHERE key IN ('queue.intake_enabled','queue.intake_starts_at')`;
    const enabled=rows.find(r=>r.key==='queue.intake_enabled')?.value===true;
    const start=rows.find(r=>r.key==='queue.intake_starts_at')?.value;
    if(!enabled||typeof start!=='string'||!Number.isFinite(Date.parse(start)))return {created:0};
    const [{created}]=await tx`WITH inserted AS (
      INSERT INTO queue_items(post_id,post_posted_at,program_id,program_snapshot,team_id)
      SELECT p.id,p.posted_at,c.program_id,jsonb_build_object('id',pr.id,'key',pr.key,'name',pr.name_ar,'color',pr.color),t.id
      FROM posts p JOIN post_classifications c ON c.post_id=p.id AND c.posted_at=p.posted_at
      JOIN programs pr ON pr.id=c.program_id JOIN team_programs tp ON tp.program_id=c.program_id JOIN teams t ON t.id=tp.team_id
      WHERE p.collected_at>=${start}::timestamptz AND c.relevance='relevant' AND c.intent IN ('inquiry','complaint')
        AND p.status NOT IN ('duplicate','filtered_out') AND p.duplicate_of_id IS NULL AND p.duplicate_type IS NULL
        AND NOT p.is_redacted AND t.is_active
        AND NOT EXISTS(SELECT 1 FROM queue_items qi WHERE qi.post_id=p.id AND qi.interaction_type='post')
      ORDER BY p.collected_at,p.id LIMIT 200
      ON CONFLICT (post_id) WHERE interaction_type='post' DO NOTHING RETURNING id
    ), events AS (
      INSERT INTO queue_events(queue_item_id,event_type,to_status,version) SELECT id,'created','new',1 FROM inserted RETURNING id
    ) SELECT count(*)::int AS created FROM events`;
    return {created};
  });
}
export function startQueueIntakeWorker() {
  let running=false;
  const timer=setInterval(async()=>{
    if(running)return;running=true;
    try {const result=await intakeQueue();if(result.created)logger.info({event:'queue_intake',...result},'queue intake completed');}
    catch(err){logger.error({err,event:'queue_intake_failed'},'queue intake failed');}
    finally{running=false;}
  },30_000);
  timer.unref();return ()=>clearInterval(timer);
}
