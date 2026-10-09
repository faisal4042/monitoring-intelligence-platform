/**
 * Queue sections, story units and in-app alerts.
 *
 * Every item lives in exactly one section, decided here in SQL — never by the
 * client:  story (its post belongs to an approved story that has a unit)
 *        > influencer (its author is an active tracked influencer)
 *        > general.
 * "Approved story" is the clustering job's own threshold: state <> 'candidate',
 * i.e. at least SIGNAL_MIN_FAMILIES independent sources. A topic link alone
 * never makes a story.
 *
 * All functions take the caller's transaction; the intake worker runs them
 * under its advisory lock, so passes never overlap.
 */
import { sql, type Transaction } from '@mip/db';
import { PERMISSIONS as P } from '@mip/shared';

type Tx = Transaction;

/** For alias p (posts) and t (teams): the live unit of the post's story in that team. */
export const storyUnitOf = sql`(SELECT u.id FROM signal_story_members m
  JOIN queue_items u ON u.interaction_type='story' AND u.story_id=m.story_id AND u.merged_into_id IS NULL
  WHERE m.post_id=p.id AND m.posted_at=p.posted_at AND u.team_id=t.id LIMIT 1)`;

/** For alias p (posts): whether the author is an active tracked influencer. */
export const authoredByInfluencer = sql`EXISTS (SELECT 1 FROM authors a
  JOIN tracked_influencers ti ON lower(ti.username)=lower(a.username) AND ti.is_active
  WHERE a.id=p.author_id)`;

/** For alias u (users). Permissions are the union of role and per-user grants. */
export const holds = (perm: string) => sql`(EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id=u.role_id AND rp.permission_key=${perm})
  OR EXISTS (SELECT 1 FROM user_permissions up WHERE up.user_id=u.id AND up.permission_key=${perm}))`;

const storySnapshot = sql`jsonb_build_object('title',s.title_ar,'summary',s.summary_ar,'why',s.why_ar,
  'firstSeenAt',s.first_seen_at,'lastSeenAt',s.last_seen_at,'postCount',s.post_count,'state',s.state)`;

/**
 * Opens a unit for each approved story that is actually in the queue's scope:
 * it already contains a queued post (e.g. a manual add), or — only while
 * intake is enabled — it has a member collected at/after the intake start.
 * Never a historical backfill.
 */
export async function openStoryUnits(tx: Tx, intakeStart: string | null) {
  const units = await tx<{ id: string; event_id: string }[]>`
    WITH eligible AS (
      SELECT s.id AS story_id, s.program_id, t.id AS team_id,
        jsonb_build_object('id',pr.id,'key',pr.key,'name',pr.name_ar,'color',pr.color) AS program_snapshot,
        ${storySnapshot} || jsonb_build_object('repPostId',rep.post_id,'repPostedAt',rep.posted_at) AS story_snapshot
      FROM signal_stories s
      JOIN programs pr ON pr.id=s.program_id
      JOIN team_programs tp ON tp.program_id=s.program_id JOIN teams t ON t.id=tp.team_id AND t.is_active
      -- The representative member lets a later merge be followed to the surviving story.
      JOIN LATERAL (SELECT m.post_id,m.posted_at FROM signal_story_members m WHERE m.story_id=s.id
        ORDER BY m.is_representative DESC,m.posted_at,m.post_id LIMIT 1) rep ON true
      WHERE s.state<>'candidate'
        AND NOT EXISTS (SELECT 1 FROM queue_items u WHERE u.interaction_type='story' AND u.story_id=s.id)
        AND (EXISTS (SELECT 1 FROM signal_story_members m JOIN queue_items qi ON qi.interaction_type='post'
               AND qi.post_id=m.post_id AND qi.post_posted_at=m.posted_at WHERE m.story_id=s.id)
          OR (${intakeStart}::timestamptz IS NOT NULL AND EXISTS (SELECT 1 FROM signal_story_members m
               JOIN posts p ON p.id=m.post_id AND p.posted_at=m.posted_at
               WHERE m.story_id=s.id AND p.collected_at>=${intakeStart}::timestamptz AND NOT p.is_redacted)))
      ORDER BY s.first_seen_at,s.id LIMIT 100
    ), inserted AS (
      INSERT INTO queue_items(interaction_type,story_id,story_snapshot,program_id,program_snapshot,team_id,section)
      SELECT 'story',story_id,story_snapshot,program_id,program_snapshot,team_id,'story' FROM eligible
      ON CONFLICT (story_id) WHERE interaction_type='story' DO NOTHING RETURNING id
    )
    INSERT INTO queue_events(queue_item_id,event_type,to_status,version)
    SELECT id,'created','new',1 FROM inserted RETURNING queue_item_id AS id,id AS event_id`;
  return units;
}

/** Keeps unit snapshots current for the cards (title, counts, last activity). No version bump: not a state change. */
export async function refreshStorySnapshots(tx: Tx) {
  await tx`UPDATE queue_items u SET story_snapshot=u.story_snapshot || ${storySnapshot}
    FROM signal_stories s WHERE u.interaction_type='story' AND u.story_id=s.id AND u.merged_into_id IS NULL
      AND u.story_snapshot IS DISTINCT FROM (u.story_snapshot || ${storySnapshot})`;
}

/**
 * The clustering job merges stories by deleting one of them. Follow the
 * representative member to the surviving story: re-point the unit, or — when
 * that story already has its own unit — fold this unit into it. Stories only
 * merge within one topic, hence one program and one team.
 */
export async function followStoryMerges(tx: Tx) {
  const events: string[] = [];
  const lost = await tx<{ id: string; status: string; assignee_id: string | null; version: number; story_id: string; now_story: string }[]>`
    SELECT u.id,u.status,u.assignee_id,u.version,u.story_id,m.story_id AS now_story FROM queue_items u
    JOIN signal_story_members m ON m.post_id=(u.story_snapshot->>'repPostId')::uuid
      AND m.posted_at=(u.story_snapshot->>'repPostedAt')::timestamptz
    WHERE u.interaction_type='story' AND u.merged_into_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM signal_stories s WHERE s.id=u.story_id)
    ORDER BY u.id LIMIT 50 FOR UPDATE OF u`;
  for (const unit of lost) {
    const [target] = await tx<{ id: string; status: string; version: number; team_id: string }[]>`SELECT id,status,version,team_id FROM queue_items
      WHERE interaction_type='story' AND story_id=${unit.now_story}::uuid AND merged_into_id IS NULL FOR UPDATE`;
    const [moved] = await tx<{ version: number }[]>`UPDATE queue_items SET
        story_id=CASE WHEN ${!target} THEN ${unit.now_story}::uuid ELSE story_id END,
        merged_into_id=${target?.id ?? null}::uuid, version=version+1, updated_at=clock_timestamp()
      WHERE id=${unit.id}::uuid AND version=${unit.version} RETURNING version`;
    if (!moved) continue;
    const [e] = await tx<{ id: string }[]>`INSERT INTO queue_events(queue_item_id,event_type,from_status,to_status,version,metadata)
      VALUES (${unit.id},'story_merged',${unit.status},${unit.status},${moved.version},
        ${JSON.stringify(target ? { intoItem: target.id } : { fromStory: unit.story_id, toStory: unit.now_story })}::jsonb) RETURNING id`;
    events.push(e.id);
    if (!target) continue;
    // The merged unit keeps its own events, notes, assignment and completion
    // forever (it is only hidden from the board). If someone was working it and
    // the surviving story is still unowned, the work follows them there as an
    // ordinary, audited assignment — never a silent change and never a second
    // completion: the surviving unit starts its own cycle.
    if (unit.assignee_id && ['assigned','in_progress','escalated'].includes(unit.status) && target.status === 'new') {
      const [member] = await tx`SELECT 1 FROM team_members tm JOIN users u ON u.id=tm.user_id JOIN roles r ON r.id=u.role_id
        WHERE tm.team_id=${target.team_id}::uuid AND tm.user_id=${unit.assignee_id}::uuid AND tm.left_at IS NULL
          AND u.is_active AND u.deleted_at IS NULL AND r.key=tm.kind`;
      if (member) {
        const [t] = await tx<{ version: number }[]>`UPDATE queue_items SET status='assigned', assignee_id=${unit.assignee_id}::uuid,
            first_assigned_at=coalesce(first_assigned_at,clock_timestamp()), assigned_at=clock_timestamp(), started_at=NULL,
            version=version+1, updated_at=clock_timestamp()
          WHERE id=${target.id}::uuid AND version=${target.version} AND status='new' RETURNING version`;
        if (t) {
          const [ae] = await tx<{ id: string }[]>`INSERT INTO queue_events(queue_item_id,event_type,from_status,to_status,to_assignee,reason,version,metadata)
            VALUES (${target.id},'assigned','new','assigned',${unit.assignee_id},'انتقل العمل مع دمج القصة',${t.version},
              ${JSON.stringify({ fromItem: unit.id })}::jsonb) RETURNING id`;
          events.push(ae.id);
        }
      }
    }
    // Members follow their story; each keeps its status and assignee.
    const members = await tx<{ id: string; status: string; version: number }[]>`UPDATE queue_items
      SET story_item_id=${target.id}::uuid, version=version+1, updated_at=clock_timestamp()
      WHERE story_item_id=${unit.id}::uuid RETURNING id,status,version`;
    for (const m of members) {
      await tx`INSERT INTO queue_events(queue_item_id,event_type,from_status,to_status,version,metadata)
        VALUES (${m.id},'section_changed',${m.status},${m.status},${m.version},
          ${JSON.stringify({ from: 'story', to: 'story', fromItem: unit.id, toItem: target.id })}::jsonb)`;
    }
  }
  return events;
}

interface Move {
  id: string; status: string; version: number; section: string; story_item_id: string | null;
  section_hold: string | null; to_section: string; to_unit: string | null; to_hold: string | null;
}

/**
 * Moves every post item whose section is no longer right. The item keeps its
 * id, status, assignee and history; the move is one CAS update plus one
 * event. A move into a story owned by another team is never made silently:
 * the item stays where it is and is held for supervisor review instead.
 */
export async function reconcileSections(tx: Tx, limit = 200) {
  const moves = await tx<Move[]>`
    WITH cur AS (
      SELECT q.id,q.status,q.version,q.section,q.story_item_id,q.section_hold,q.team_id,
        u.id AS unit_id,u.team_id AS unit_team,(p.id IS NULL) AS source_gone,
        (ti.id IS NOT NULL) AS influencer,coalesce(c.intent::text IN ('inquiry','complaint'),false) AS general_intent
      FROM queue_items q
      LEFT JOIN signal_story_members m ON m.post_id=q.post_id AND m.posted_at=q.post_posted_at
      LEFT JOIN queue_items u ON u.interaction_type='story' AND u.story_id=m.story_id AND u.merged_into_id IS NULL
      LEFT JOIN posts p ON p.id=q.post_id AND p.posted_at=q.post_posted_at
      LEFT JOIN post_classifications c ON c.post_id=p.id AND c.posted_at=p.posted_at
      LEFT JOIN authors a ON a.id=p.author_id
      LEFT JOIN tracked_influencers ti ON lower(ti.username)=lower(a.username) AND ti.is_active
      WHERE q.interaction_type='post'
    ), want AS (
      SELECT cur.*,
        CASE WHEN unit_id IS NOT NULL AND unit_team=team_id THEN 'story'
             -- A source removed by retention/redaction cannot be re-judged; leave it be.
             WHEN source_gone THEN CASE WHEN section='story' AND story_item_id IS NOT NULL THEN 'story' ELSE section END
             WHEN influencer THEN 'influencer'
             -- No longer an influencer's, but general only takes inquiries and
             -- complaints: an influencer-only item keeps its section.
             WHEN section='influencer' AND NOT general_intent THEN 'influencer'
             ELSE 'general' END AS to_section,
        CASE WHEN unit_id IS NOT NULL AND unit_team=team_id THEN unit_id
             WHEN source_gone AND section='story' THEN story_item_id END AS to_unit,
        CASE WHEN unit_id IS NOT NULL AND unit_team<>team_id THEN 'story' END AS to_hold
      FROM cur
    )
    SELECT id,status,version,section,story_item_id,section_hold,to_section,to_unit,to_hold FROM want
    WHERE section<>to_section OR story_item_id IS DISTINCT FROM to_unit OR section_hold IS DISTINCT FROM to_hold
    ORDER BY id LIMIT ${limit}`;
  const events: string[] = [];
  for (const m of moves) {
    const [row] = await tx<{ version: number }[]>`UPDATE queue_items SET section=${m.to_section},
        story_item_id=${m.to_unit}::uuid, section_hold=${m.to_hold}, version=version+1, updated_at=clock_timestamp()
      WHERE id=${m.id}::uuid AND version=${m.version} RETURNING version`;
    if (!row) continue; // changed by someone meanwhile; the next pass re-evaluates it
    const sectionMoved = m.section !== m.to_section || m.story_item_id !== m.to_unit;
    const [e] = await tx<{ id: string }[]>`INSERT INTO queue_events(queue_item_id,event_type,from_status,to_status,version,metadata)
      VALUES (${m.id},${sectionMoved ? 'section_changed' : 'section_review'},${m.status},${m.status},${row.version},
        ${JSON.stringify(sectionMoved
          ? { from: m.section, to: m.to_section, fromItem: m.story_item_id, toItem: m.to_unit, hold: m.to_hold }
          : { hold: m.to_hold })}::jsonb) RETURNING id`;
    events.push(e.id);
  }
  return { moved: moves.length, events };
}

/**
 * Turns qualifying queue events into alerts, at most once each:
 *  - arrival: an influencer post entering the influencer section, or a story
 *    unit being opened. Once per item and kind, whatever moves follow — so
 *    a post that later joins a story never re-alerts, and a story alerts once
 *    no matter how many posts it gathers.
 *  - assigned / reopened: an influencer/story item handed to someone else,
 *    or reopened back to its assignee — only that person is told.
 * General items never alert.
 *
 * Recipients are resolved now, from each user's queue scope: queue:view_all
 * sees everything; a supervisor only items of teams they supervise; an agent
 * only what is assigned to them. Reading alerts re-applies the scope.
 */
export async function alertForEvents(tx: Tx, eventIds: string[]) {
  if (!eventIds.length) return 0;
  const alerts = await tx<{ id: string; kind: string; to_assignee: string | null; team_id: string }[]>`
    WITH candidates AS (
      SELECT e.id AS event_id,q.id AS item_id,q.section,q.team_id,e.to_assignee,
        CASE
          WHEN e.event_type='created' AND q.interaction_type='story' THEN 'story'
          WHEN e.event_type IN ('created','section_changed') AND q.interaction_type='post' AND q.section='influencer' THEN 'influencer'
          WHEN e.event_type IN ('assigned','reassigned','deescalated','transferred') AND q.section IN ('influencer','story')
            AND e.to_assignee IS NOT NULL AND e.to_assignee IS DISTINCT FROM e.actor_id THEN 'assigned'
          -- Reopened work handed back to its assignee: a work alert, never a second arrival.
          WHEN e.event_type='reopened' AND q.section IN ('influencer','story')
            AND e.to_assignee IS NOT NULL AND e.to_assignee IS DISTINCT FROM e.actor_id THEN 'reopened'
        END AS kind
      FROM queue_events e JOIN queue_items q ON q.id=e.queue_item_id
      WHERE e.id=ANY(${eventIds}::uuid[]) AND q.merged_into_id IS NULL
    )
    INSERT INTO queue_alerts(kind,queue_item_id,queue_event_id,section)
    SELECT kind,item_id,event_id,section FROM candidates WHERE kind IS NOT NULL
    ON CONFLICT DO NOTHING
    RETURNING id,kind,(SELECT to_assignee FROM queue_events WHERE id=queue_event_id) AS to_assignee,
      (SELECT team_id FROM queue_items WHERE id=queue_item_id) AS team_id`;
  for (const a of alerts) {
    if (a.kind === 'assigned' || a.kind === 'reopened') {
      await tx`INSERT INTO queue_alert_recipients(alert_id,user_id)
        SELECT ${a.id},u.id FROM users u WHERE u.id=${a.to_assignee}::uuid AND u.is_active AND u.deleted_at IS NULL
          AND (${holds(P.QUEUE_WORK)} OR ${holds(P.QUEUE_SUPERVISE)}) ON CONFLICT DO NOTHING`;
    } else {
      await tx`INSERT INTO queue_alert_recipients(alert_id,user_id)
        SELECT ${a.id},u.id FROM users u WHERE u.is_active AND u.deleted_at IS NULL AND (${holds(P.QUEUE_VIEW_ALL)}
          OR (${holds(P.QUEUE_SUPERVISE)} AND EXISTS (SELECT 1 FROM team_members tm JOIN teams t ON t.id=tm.team_id
            WHERE tm.user_id=u.id AND tm.team_id=${a.team_id}::uuid AND tm.kind='supervisor' AND tm.left_at IS NULL AND t.is_active)))
        ON CONFLICT DO NOTHING`;
    }
  }
  return alerts.length;
}
