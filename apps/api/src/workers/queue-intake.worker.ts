import { sql } from '@mip/db';
import { logger } from '@mip/logger';
import { alertForEvents, authoredByInfluencer, followStoryMerges, openStoryUnits, reconcileSections, refreshStorySnapshots, storyUnitOf } from '../modules/queue/sections.js';

/**
 * No collection/network calls. A bounded, idempotent pass:
 *  1. follow story merges (the clustering job deletes merged stories),
 *  2. open units for approved stories in scope (never a backfill),
 *  3. intake new eligible posts — only while intake is enabled,
 *  4. move items whose section changed, then alert on the events that deserve it.
 * Steps 1, 2 (for already-queued posts) and 4 also run while intake is off,
 * so manually added items still land in the right section.
 */
export async function intakeQueue() {
  return sql.begin(async tx=>{
    // Also serializes settings/routing changes. Independent/manual insert races
    // are resolved by the partial unique index, never by a check-then-insert.
    const [lock]=await tx`SELECT pg_try_advisory_xact_lock(hashtext('mip:queue-intake')) AS acquired`;
    if(!lock.acquired)return {created:0,units:0,moved:0,alerts:0};
    const rows=await tx`SELECT key,value FROM settings WHERE key IN ('queue.intake_enabled','queue.intake_starts_at')`;
    const enabled=rows.find(r=>r.key==='queue.intake_enabled')?.value===true;
    const start=rows.find(r=>r.key==='queue.intake_starts_at')?.value;
    const intakeStart=enabled&&typeof start==='string'&&Number.isFinite(Date.parse(start))?start:null;

    // Merges first: a unit whose story was merged away claims the surviving
    // story before a second unit (and a second story alert) could be opened for it.
    const merged=await followStoryMerges(tx);
    const units=await openStoryUnits(tx,intakeStart);
    let created:{id:string;event_id:string}[]=[];
    if(intakeStart) {
      created=await tx`WITH inserted AS (
        INSERT INTO queue_items(post_id,post_posted_at,program_id,program_snapshot,team_id,section)
        SELECT p.id,p.posted_at,c.program_id,jsonb_build_object('id',pr.id,'key',pr.key,'name',pr.name_ar,'color',pr.color),t.id,
          CASE WHEN ${authoredByInfluencer} THEN 'influencer' ELSE 'general' END
        FROM posts p JOIN post_classifications c ON c.post_id=p.id AND c.posted_at=p.posted_at
        JOIN programs pr ON pr.id=c.program_id JOIN team_programs tp ON tp.program_id=c.program_id JOIN teams t ON t.id=tp.team_id
        -- General takes inquiries and complaints; a tracked influencer's relevant
        -- interaction is taken whatever its intent. Exclusions apply to both.
        WHERE p.collected_at>=${intakeStart}::timestamptz AND c.relevance='relevant'
          AND (c.intent IN ('inquiry','complaint') OR ${authoredByInfluencer})
          AND p.status NOT IN ('duplicate','filtered_out') AND p.duplicate_of_id IS NULL AND p.duplicate_type IS NULL
          AND NOT p.is_redacted AND t.is_active
          AND NOT EXISTS(SELECT 1 FROM queue_items qi WHERE qi.post_id=p.id AND qi.interaction_type='post')
          -- A post of a story that already has a unit is worked through the story, not as its own card.
          AND ${storyUnitOf} IS NULL
        ORDER BY p.collected_at,p.id LIMIT 200
        ON CONFLICT (post_id) WHERE interaction_type='post' DO NOTHING RETURNING id
      ) INSERT INTO queue_events(queue_item_id,event_type,to_status,version) SELECT id,'created','new',1 FROM inserted
        RETURNING queue_item_id AS id,id AS event_id`;
    }
    await refreshStorySnapshots(tx);
    const reconciled=await reconcileSections(tx);
    const alerts=await alertForEvents(tx,[...units.map(u=>u.event_id),...created.map(c=>c.event_id),...merged,...reconciled.events]);
    return {created:created.length,units:units.length,moved:reconciled.events.length,alerts};
  });
}
export function startQueueIntakeWorker() {
  let running=false;
  const timer=setInterval(async()=>{
    if(running)return;running=true;
    try {const result=await intakeQueue();if(result.created||result.units||result.moved)logger.info({event:'queue_intake',...result},'queue intake completed');}
    catch(err){logger.error({err,event:'queue_intake_failed'},'queue intake failed');}
    finally{running=false;}
  },30_000);
  timer.unref();return ()=>clearInterval(timer);
}
