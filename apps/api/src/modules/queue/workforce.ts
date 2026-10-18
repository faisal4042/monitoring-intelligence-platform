/**
 * Queue workforce: agent availability, time records, per-agent queue settings
 * and automatic assignment.
 *
 * Availability
 *  - A status is an explicit choice. Signing in, opening the browser or a
 *    heartbeat never starts a shift; only choosing a status does.
 *  - Each status is one row in agent_status_periods (server clock, UTC). The
 *    open row is the current status; no open row means offline.
 *  - The system ends a status when the session goes silent (no heartbeat for
 *    workforce.heartbeat_timeout_minutes: ended at the last heartbeat) or runs
 *    past workforce.max_status_hours (a forgotten end of shift). Both open an
 *    'offline' period with source 'system' and a reason.
 *  - Rows are never deleted or edited, except by a supervisor correction
 *    (workforce:correct), which keeps the before/after and an audit entry.
 *
 * Automatic assignment
 *  - Off until queue.auto_assign_enabled is true.
 *  - Every pass holds one transaction-scoped advisory lock, so passes from the
 *    API and the worker never overlap: an item cannot be assigned twice and a
 *    box cannot overflow through a race. Each assignment is also a version
 *    compare-and-swap from 'new', so a retried pass finds nothing to redo.
 *  - A pass is one transaction: a failure rolls back and items stay
 *    unassigned; the worker's periodic pass picks them up again.
 *  - Eligibility: active agent role holding queue:work, active agent member
 *    of the item's team, status 'available', auto-assign on, open box below
 *    its limit, and the item's program / intent / section / priority allowed.
 *  - Order: high priority, then items waiting at least queue.starvation_minutes
 *    (oldest first), then queue.lane_order (stories > influencers > general by
 *    default), then oldest. The least-loaded eligible agent goes first, then
 *    the one who waited longest for an assignment.
 */
import { sql, type Transaction } from '@mip/db';
import { logger } from '@mip/logger';
import { AGENT_STATUSES, PERMISSIONS as P, type AgentStatus } from '@mip/shared';
import type { FastifyRequest } from 'fastify';
import type { QueueActor } from '../../lib/authz.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { alertForEvents, holds } from './sections.js';

type Tx = Transaction;
const log = logger.child({ subsystem: 'workforce' });
const has = (a: QueueActor, p: string) => a.permissions.includes(p);

/** For alias u (users): may the actor manage this agent? (view_all: anyone; supervisor: members of teams they supervise). */
export function agentScope(actor: QueueActor) {
  if (has(actor, P.QUEUE_VIEW_ALL)) return sql`true`;
  if (!has(actor, P.QUEUE_SUPERVISE)) return sql`u.id=${actor.id}::uuid`;
  return sql`(u.id=${actor.id}::uuid OR EXISTS (SELECT 1 FROM team_members am JOIN team_members sm ON sm.team_id=am.team_id
    JOIN teams st ON st.id=sm.team_id AND st.is_active
    WHERE am.user_id=u.id AND am.left_at IS NULL AND sm.user_id=${actor.id}::uuid AND sm.kind='supervisor' AND sm.left_at IS NULL))`;
}

async function settingsMap(tx: Tx | typeof sql, keys: string[]) {
  const rows = await tx<{ key: string; value: unknown }[]>`SELECT key,value FROM settings WHERE key=ANY(${keys}::text[])`;
  return Object.fromEntries(rows.map((r) => [r.key, r.value])) as Record<string, unknown>;
}
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

// ───────────────────────── Availability ─────────────────────────

export interface StatusRow { status: AgentStatus; started_at: string; source: string; id: string | null }

export async function currentStatus(userId: string, tx: Tx | typeof sql = sql): Promise<StatusRow> {
  const [row] = await tx<StatusRow[]>`SELECT id,status,started_at::text AS started_at,source FROM agent_status_periods
    WHERE user_id=${userId}::uuid AND ended_at IS NULL`;
  return row ?? { id: null, status: 'offline', started_at: '', source: 'system' };
}

/**
 * Closes the open period and opens the next one, in the caller's transaction,
 * under the user's row lock (the same lock the sweeper takes). Same status →
 * no change (idempotent for retries and double clicks).
 */
async function transition(tx: Tx, userId: string, status: AgentStatus, src: { source: 'agent' | 'supervisor' | 'system'; actorId: string | null; reason: string | null; at?: string }) {
  const [open] = await tx<{ id: string; status: AgentStatus; started_at: string }[]>`SELECT id,status,started_at::text AS started_at
    FROM agent_status_periods WHERE user_id=${userId}::uuid AND ended_at IS NULL FOR UPDATE`;
  if (open?.status === status) return { changed: false, previous: open.status };
  if (!open && status === 'offline' && src.source !== 'supervisor') return { changed: false, previous: 'offline' as AgentStatus };
  const at = src.at ?? null;
  if (open) {
    await tx`UPDATE agent_status_periods SET ended_at=greatest(started_at,coalesce(${at}::timestamptz,clock_timestamp())),
      end_source=${src.source}, end_reason=${src.reason} WHERE id=${open.id}::uuid`;
  }
  await tx`INSERT INTO agent_status_periods(user_id,status,previous_status,started_at,source,actor_id,reason)
    VALUES (${userId}::uuid,${status},${open?.status ?? 'offline'},
      ${open ? sql`(SELECT ended_at FROM agent_status_periods WHERE id=${open.id}::uuid)` : sql`coalesce(${at}::timestamptz,clock_timestamp())`},
      ${src.source},${src.actorId}::uuid,${src.reason})`;
  return { changed: true, previous: open?.status ?? ('offline' as AgentStatus) };
}

/** An agent sets their own status, or a supervisor sets it for an agent in scope (reason required). */
export async function setStatus(req: FastifyRequest, targetId: string, status: AgentStatus, reason?: string) {
  if (!AGENT_STATUSES.includes(status)) throw badRequest('حالة غير معروفة');
  const actor = req.user;
  const self = targetId === actor.id;
  if (self && !has(actor, P.QUEUE_WORK)) throw forbidden();
  if (!self && !has(actor, P.QUEUE_SUPERVISE) && !has(actor, P.QUEUE_VIEW_ALL)) throw forbidden();
  if (!self && !reason?.trim()) throw badRequest('سبب تغيير حالة الموظف مطلوب');
  const result = await sql.begin(async (tx) => {
    const [target] = await tx<{ id: string }[]>`SELECT u.id FROM users u WHERE u.id=${targetId}::uuid AND u.is_active AND u.deleted_at IS NULL
      AND ${holds(P.QUEUE_WORK)} AND (${agentScope(actor)}) FOR UPDATE OF u`;
    if (!target) throw notFound('الموظف غير موجود ضمن نطاقك');
    const r = await transition(tx, targetId, status, { source: self ? 'agent' : 'supervisor', actorId: actor.id, reason: self ? null : reason!.trim() });
    if (self && status !== 'offline') await touchPresence(tx, targetId);
    if (!self && r.changed) {
      await tx`INSERT INTO audit_log(user_id,user_email,action,entity_type,entity_id,old_value,new_value,reason,ip_address)
        VALUES (${actor.id},${actor.email},'workforce.status_set','user',${targetId},${JSON.stringify({ status: r.previous })}::jsonb,
          ${JSON.stringify({ status })}::jsonb,${reason!.trim()},${req.ip}::inet)`;
    }
    return r;
  });
  if (status === 'available' && result.changed) await assignAfter('status_available', targetId);
  return { ...(await currentStatus(targetId)), changed: result.changed };
}

async function touchPresence(tx: Tx | typeof sql, userId: string) {
  await tx`INSERT INTO agent_presence(user_id,last_heartbeat_at) VALUES (${userId}::uuid,clock_timestamp())
    ON CONFLICT (user_id) DO UPDATE SET last_heartbeat_at=EXCLUDED.last_heartbeat_at`;
}

/** The browser's sign of life. It keeps a chosen status alive; it never starts one. */
export async function heartbeat(actor: QueueActor) {
  if (!has(actor, P.QUEUE_WORK)) throw forbidden();
  await touchPresence(sql, actor.id);
  return currentStatus(actor.id);
}

/** Logout ends the agent's status (their own action). */
export async function endOnLogout(userId: string) {
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT id FROM users WHERE id=${userId}::uuid FOR UPDATE`;
      await transition(tx, userId, 'offline', { source: 'agent', actorId: userId, reason: null });
    });
  } catch (err) { log.warn({ err, userId }, 'could not end status on logout'); }
}

/**
 * System policy for silent sessions and forgotten ends of shift. Bounded and
 * idempotent; rows a user is changing right now are skipped (SKIP LOCKED) and
 * looked at again on the next pass.
 */
export async function sweepStatuses() {
  return sql.begin(async (tx) => {
    const s = await settingsMap(tx, ['workforce.heartbeat_timeout_minutes', 'workforce.max_status_hours']);
    const timeout = num(s['workforce.heartbeat_timeout_minutes'], 10);
    const maxHours = num(s['workforce.max_status_hours'], 12);
    const due = await tx<{ user_id: string; status: string; end_at: string; why: string }[]>`
      SELECT p.user_id,p.status,
        CASE WHEN NOT u.is_active OR u.deleted_at IS NOT NULL THEN clock_timestamp()::text
             WHEN p.started_at < clock_timestamp()-make_interval(hours=>${maxHours}) THEN (p.started_at+make_interval(hours=>${maxHours}))::text
             ELSE greatest(p.started_at,coalesce(pr.last_heartbeat_at,p.started_at))::text END AS end_at,
        CASE WHEN NOT u.is_active OR u.deleted_at IS NOT NULL THEN 'deactivated'
             WHEN p.started_at < clock_timestamp()-make_interval(hours=>${maxHours}) THEN 'max_duration'
             ELSE 'silent_session' END AS why
      FROM agent_status_periods p JOIN users u ON u.id=p.user_id
      LEFT JOIN agent_presence pr ON pr.user_id=p.user_id
      WHERE p.ended_at IS NULL AND p.status<>'offline' AND (
        NOT u.is_active OR u.deleted_at IS NOT NULL
        OR p.started_at < clock_timestamp()-make_interval(hours=>${maxHours})
        OR coalesce(pr.last_heartbeat_at,p.started_at) < clock_timestamp()-make_interval(mins=>${timeout}))
      ORDER BY p.started_at LIMIT 200
      FOR UPDATE OF u SKIP LOCKED`;
    const reasons: Record<string, string> = {
      silent_session: 'انقطعت الجلسة دون إشارة من المتصفح؛ انتهت الحالة عند آخر إشارة',
      max_duration: 'تجاوزت الحالة الحد الأقصى المسموح لمدتها (نهاية دوام غير مسجلة)',
      deactivated: 'الحساب معطّل',
    };
    for (const d of due) {
      await transition(tx, d.user_id, 'offline', { source: 'system', actorId: null, reason: reasons[d.why], at: d.end_at });
    }
    return { ended: due.length };
  });
}

/** Supervisor correction of a closed period (workforce:correct, agent in scope). Keeps before/after. */
export async function correctPeriod(req: FastifyRequest, periodId: string, input: { status?: AgentStatus; startedAt?: string; endedAt?: string; reason: string }) {
  const actor = req.user;
  if (!has(actor, P.WORKFORCE_CORRECT)) throw forbidden();
  if (!input.reason.trim()) throw badRequest('سبب التصحيح مطلوب');
  return sql.begin(async (tx) => {
    const [old] = await tx<{ id: string; user_id: string; status: string; started_at: string; ended_at: string | null }[]>`
      SELECT p.id,p.user_id,p.status,p.started_at::text AS started_at,p.ended_at::text AS ended_at
      FROM agent_status_periods p JOIN users u ON u.id=p.user_id
      WHERE p.id=${periodId}::uuid AND (${agentScope(actor)}) FOR UPDATE OF p`;
    if (!old) throw notFound('السجل غير موجود ضمن نطاقك');
    if (!old.ended_at) throw conflict('لا يمكن تصحيح الحالة الجارية؛ صحّحها بعد انتهائها');
    const next = { status: input.status ?? old.status, started_at: input.startedAt ?? old.started_at, ended_at: input.endedAt ?? old.ended_at };
    const [check] = await tx<{ ok: boolean; future: boolean; overlap: boolean }[]>`SELECT
        ${next.ended_at}::timestamptz > ${next.started_at}::timestamptz AS ok,
        ${next.ended_at}::timestamptz > clock_timestamp() AS future,
        EXISTS (SELECT 1 FROM agent_status_periods o WHERE o.user_id=${old.user_id}::uuid AND o.id<>${old.id}::uuid
          AND o.started_at < ${next.ended_at}::timestamptz AND coalesce(o.ended_at,'infinity') > ${next.started_at}::timestamptz) AS overlap`;
    if (!check.ok) throw badRequest('نهاية الفترة يجب أن تكون بعد بدايتها');
    if (check.future) throw badRequest('لا يمكن أن تنتهي الفترة في المستقبل');
    if (check.overlap) throw conflict('الفترة المصححة تتداخل مع فترة أخرى للموظف');
    await tx`SELECT set_config('mip.status_correction','on',true)`;
    await tx`UPDATE agent_status_periods SET status=${next.status},started_at=${next.started_at}::timestamptz,ended_at=${next.ended_at}::timestamptz,
      corrected_count=corrected_count+1 WHERE id=${old.id}::uuid`;
    await tx`SELECT set_config('mip.status_correction','off',true)`;
    const oldValue = { status: old.status, startedAt: old.started_at, endedAt: old.ended_at };
    const newValue = { status: next.status, startedAt: next.started_at, endedAt: next.ended_at };
    await tx`INSERT INTO agent_status_corrections(period_id,corrected_by,reason,old_value,new_value)
      VALUES (${old.id},${actor.id},${input.reason.trim()},${JSON.stringify(oldValue)}::jsonb,${JSON.stringify(newValue)}::jsonb)`;
    await tx`INSERT INTO audit_log(user_id,user_email,action,entity_type,entity_id,old_value,new_value,reason,ip_address)
      VALUES (${actor.id},${actor.email},'workforce.period_corrected','agent_status_period',${old.id},${JSON.stringify(oldValue)}::jsonb,
        ${JSON.stringify(newValue)}::jsonb,${input.reason.trim()},${req.ip}::inet)`;
    return { id: old.id, ...newValue };
  });
}

// ───────────────────────── Queue settings ─────────────────────────

export interface QueueSettingsInput {
  programIds?: string[] | null; intents?: string[] | null; sections?: string[] | null;
  maxOpen?: number | null; autoAssign?: boolean | null; acceptsHighPriority?: boolean | null;
}
const COLUMNS = { programIds: 'program_ids', intents: 'intents', sections: 'sections', maxOpen: 'max_open', autoAssign: 'auto_assign', acceptsHighPriority: 'accepts_high_priority' } as const;

/** Effective settings per agent, with where each value comes from: 'agent', 'team' or 'system'. */
export async function settingsOverview(actor: QueueActor, teamId?: string) {
  const s = await settingsMap(sql, ['queue.default_max_open', 'queue.auto_assign_enabled']);
  const systemMax = num(s['queue.default_max_open'], 5);
  const teams = await sql`SELECT t.id,t.name,d.program_ids,d.intents,d.sections,d.max_open,d.auto_assign,d.accepts_high_priority,
      d.updated_at,ARRAY(SELECT program_id FROM team_programs WHERE team_id=t.id) AS team_program_ids
    FROM teams t LEFT JOIN team_queue_defaults d ON d.team_id=t.id
    WHERE t.is_active AND (${has(actor, P.QUEUE_VIEW_ALL)} OR EXISTS (SELECT 1 FROM team_members sm WHERE sm.team_id=t.id
      AND sm.user_id=${actor.id}::uuid AND sm.kind='supervisor' AND sm.left_at IS NULL))
      AND (${teamId ?? null}::uuid IS NULL OR t.id=${teamId ?? null}::uuid)
    ORDER BY t.name`;
  const agents = await sql`SELECT u.id,u.full_name,u.email,tm.team_id,a.program_ids,a.intents,a.sections,a.max_open,a.auto_assign,
      a.accepts_high_priority,a.updated_at,coalesce(sp.status,'offline') AS status,sp.started_at AS status_since,
      (SELECT count(*)::int FROM queue_items q WHERE q.assignee_id=u.id AND q.status IN ('assigned','in_progress') AND q.merged_into_id IS NULL) AS open
    FROM team_members tm JOIN users u ON u.id=tm.user_id JOIN roles r ON r.id=u.role_id
    LEFT JOIN agent_queue_settings a ON a.user_id=u.id
    LEFT JOIN agent_status_periods sp ON sp.user_id=u.id AND sp.ended_at IS NULL
    WHERE tm.left_at IS NULL AND tm.kind='agent' AND r.key='agent' AND u.is_active AND u.deleted_at IS NULL
      AND tm.team_id=ANY(${teams.map((t) => t.id as string)}::uuid[])
    ORDER BY u.full_name`;
  const resolve = (agent: Record<string, unknown> | null, team: Record<string, unknown> | undefined) => {
    const out: Record<string, { value: unknown; from: 'agent' | 'team' | 'system' }> = {};
    for (const [key, col] of Object.entries(COLUMNS)) {
      if (agent && agent[col] !== null && agent[col] !== undefined) out[key] = { value: agent[col], from: 'agent' };
      else if (team && team[col] !== null && team[col] !== undefined) out[key] = { value: team[col], from: 'team' };
      else out[key] = { value: key === 'maxOpen' ? systemMax : key === 'autoAssign' || key === 'acceptsHighPriority' ? true : null, from: 'system' };
    }
    return out;
  };
  return {
    autoAssignEnabled: s['queue.auto_assign_enabled'] === true, systemMaxOpen: systemMax,
    teams: teams.map((t) => ({ ...t, effective: resolve(null, t) })),
    agents: agents.map((a) => ({ ...a, effective: resolve(a, teams.find((t) => t.id === a.team_id)) })),
  };
}

async function validateSettings(tx: Tx, teamIds: string[], input: QueueSettingsInput) {
  if (input.programIds?.length) {
    const [bad] = await tx`SELECT p FROM unnest(${input.programIds}::uuid[]) p
      WHERE NOT EXISTS (SELECT 1 FROM team_programs tp WHERE tp.program_id=p AND tp.team_id=ANY(${teamIds}::uuid[]))`;
    if (bad) throw badRequest('أحد البرامج غير مرتبط بفريق الموظف');
  }
}

function settingsValues(input: QueueSettingsInput, old: Record<string, unknown> | undefined) {
  const pick = <K extends keyof QueueSettingsInput>(k: K) => (k in input ? input[k] ?? null : old?.[COLUMNS[k]] ?? null);
  return { program_ids: pick('programIds'), intents: pick('intents'), sections: pick('sections'), max_open: pick('maxOpen'),
    auto_assign: pick('autoAssign'), accepts_high_priority: pick('acceptsHighPriority') };
}

export async function updateTeamDefaults(req: FastifyRequest, teamId: string, input: QueueSettingsInput) {
  const actor = req.user;
  if (!has(actor, P.QUEUE_SUPERVISE) && !has(actor, P.QUEUE_VIEW_ALL)) throw forbidden();
  await sql.begin(async (tx) => {
    const [team] = await tx`SELECT t.id FROM teams t WHERE t.id=${teamId}::uuid AND t.is_active AND (${has(actor, P.QUEUE_VIEW_ALL)}
      OR EXISTS (SELECT 1 FROM team_members sm WHERE sm.team_id=t.id AND sm.user_id=${actor.id}::uuid AND sm.kind='supervisor' AND sm.left_at IS NULL))
      FOR UPDATE`;
    if (!team) throw notFound('الفريق غير موجود ضمن نطاقك');
    await validateSettings(tx, [teamId], input);
    const [old] = await tx`SELECT * FROM team_queue_defaults WHERE team_id=${teamId}::uuid FOR UPDATE`;
    const v = settingsValues(input, old);
    await tx`INSERT INTO team_queue_defaults(team_id,program_ids,intents,sections,max_open,auto_assign,accepts_high_priority,updated_at,updated_by)
      VALUES (${teamId}::uuid,${v.program_ids as string[] | null}::uuid[],${v.intents as string[] | null}::text[],${v.sections as string[] | null}::text[],
        ${v.max_open as number | null},${v.auto_assign as boolean | null},${v.accepts_high_priority as boolean | null},now(),${actor.id}::uuid)
      ON CONFLICT (team_id) DO UPDATE SET program_ids=EXCLUDED.program_ids,intents=EXCLUDED.intents,sections=EXCLUDED.sections,
        max_open=EXCLUDED.max_open,auto_assign=EXCLUDED.auto_assign,accepts_high_priority=EXCLUDED.accepts_high_priority,
        updated_at=now(),updated_by=EXCLUDED.updated_by`;
    await tx`INSERT INTO audit_log(user_id,user_email,action,entity_type,entity_id,old_value,new_value,ip_address)
      VALUES (${actor.id},${actor.email},'workforce.team_settings_change','team',${teamId}::uuid,${JSON.stringify(old ?? null)}::jsonb,
        ${JSON.stringify(v)}::jsonb,${req.ip}::inet)`;
  });
  await assignAfter('settings_changed');
  return settingsOverview(actor, teamId);
}

export async function updateAgentSettings(req: FastifyRequest, userId: string, input: QueueSettingsInput) {
  const actor = req.user;
  if (!has(actor, P.QUEUE_SUPERVISE) && !has(actor, P.QUEUE_VIEW_ALL)) throw forbidden();
  await sql.begin(async (tx) => {
    const [agent] = await tx<{ id: string; team_id: string }[]>`SELECT u.id,tm.team_id FROM users u JOIN team_members tm ON tm.user_id=u.id
      AND tm.left_at IS NULL AND tm.kind='agent' WHERE u.id=${userId}::uuid AND u.is_active AND u.deleted_at IS NULL AND u.id<>${actor.id}::uuid
      AND (${agentScope(actor)}) FOR UPDATE OF u`;
    if (!agent) throw notFound('الموظف غير موجود ضمن نطاقك');
    await validateSettings(tx, [agent.team_id], input);
    const [old] = await tx`SELECT * FROM agent_queue_settings WHERE user_id=${userId}::uuid FOR UPDATE`;
    const v = settingsValues(input, old);
    await tx`INSERT INTO agent_queue_settings(user_id,program_ids,intents,sections,max_open,auto_assign,accepts_high_priority,updated_at,updated_by)
      VALUES (${userId}::uuid,${v.program_ids as string[] | null}::uuid[],${v.intents as string[] | null}::text[],${v.sections as string[] | null}::text[],
        ${v.max_open as number | null},${v.auto_assign as boolean | null},${v.accepts_high_priority as boolean | null},now(),${actor.id}::uuid)
      ON CONFLICT (user_id) DO UPDATE SET program_ids=EXCLUDED.program_ids,intents=EXCLUDED.intents,sections=EXCLUDED.sections,
        max_open=EXCLUDED.max_open,auto_assign=EXCLUDED.auto_assign,accepts_high_priority=EXCLUDED.accepts_high_priority,
        updated_at=now(),updated_by=EXCLUDED.updated_by`;
    await tx`INSERT INTO audit_log(user_id,user_email,action,entity_type,entity_id,old_value,new_value,ip_address)
      VALUES (${actor.id},${actor.email},'workforce.agent_settings_change','user',${userId}::uuid,${JSON.stringify(old ?? null)}::jsonb,
        ${JSON.stringify(v)}::jsonb,${req.ip}::inet)`;
  });
  await assignAfter('settings_changed', userId);
  return settingsOverview(actor);
}

// ───────────────────────── Automatic assignment ─────────────────────────

export interface AssignResult { assigned: Array<{ itemId: string; userId: string }>; enabled: boolean }

/**
 * One assignment pass. Safe to call from anywhere at any time: serialized by
 * the advisory lock, atomic, and a no-op when there is nothing eligible.
 */
export async function runAssignmentPass(opts: { trigger: string; userId?: string; limit?: number } = { trigger: 'manual' }): Promise<AssignResult> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('mip:queue-assign'))`;
    const s = await settingsMap(tx, ['queue.auto_assign_enabled', 'queue.lane_order', 'queue.starvation_minutes', 'queue.default_max_open']);
    if (s['queue.auto_assign_enabled'] !== true) return { assigned: [], enabled: false };
    const lanes = Array.isArray(s['queue.lane_order']) ? (s['queue.lane_order'] as string[]) : ['story', 'influencer', 'general'];
    const starvation = num(s['queue.starvation_minutes'], 45);
    const systemMax = num(s['queue.default_max_open'], 5);
    const assigned: AssignResult['assigned'] = [];
    const eventIds: string[] = [];
    for (let i = 0; i < (opts.limit ?? 100); i++) {
      const [pick] = await tx<{ user_id: string; item_id: string; version: number }[]>`
        WITH agents AS (
          SELECT u.id AS user_id,tm.team_id,eff.*,occ.n AS open_count,
            (SELECT max(e.created_at) FROM queue_events e WHERE e.to_assignee=u.id
              AND e.event_type IN ('assigned','reassigned','deescalated','transferred','reopened')) AS last_assigned
          FROM users u JOIN roles r ON r.id=u.role_id
          JOIN team_members tm ON tm.user_id=u.id AND tm.left_at IS NULL AND tm.kind='agent'
          JOIN teams t ON t.id=tm.team_id AND t.is_active
          JOIN agent_status_periods sp ON sp.user_id=u.id AND sp.ended_at IS NULL AND sp.status='available'
          LEFT JOIN agent_queue_settings a ON a.user_id=u.id
          LEFT JOIN team_queue_defaults d ON d.team_id=tm.team_id
          CROSS JOIN LATERAL (SELECT coalesce(a.max_open,d.max_open,${systemMax}) AS max_open,
              coalesce(a.auto_assign,d.auto_assign,true) AS auto_assign,
              coalesce(a.accepts_high_priority,d.accepts_high_priority,true) AS high,
              coalesce(a.program_ids,d.program_ids) AS program_ids,coalesce(a.intents,d.intents) AS intents,
              coalesce(a.sections,d.sections) AS sections) eff
          CROSS JOIN LATERAL (SELECT count(*)::int AS n FROM queue_items q WHERE q.assignee_id=u.id
              AND q.status IN ('assigned','in_progress') AND q.merged_into_id IS NULL) occ
          WHERE r.key='agent' AND u.is_active AND u.deleted_at IS NULL AND ${holds(P.QUEUE_WORK)}
            AND eff.auto_assign AND occ.n < eff.max_open
            AND (${opts.userId ?? null}::uuid IS NULL OR u.id=${opts.userId ?? null}::uuid)
        )
        SELECT ag.user_id,it.id AS item_id,it.version FROM agents ag
        CROSS JOIN LATERAL (
          SELECT q.id,q.version FROM queue_items q
          LEFT JOIN post_classifications c ON c.post_id=q.post_id AND c.posted_at=q.post_posted_at
          WHERE q.team_id=ag.team_id AND q.status='new' AND q.merged_into_id IS NULL AND q.story_item_id IS NULL
            AND (ag.program_ids IS NULL OR q.program_id=ANY(ag.program_ids))
            AND (ag.sections IS NULL OR q.section=ANY(ag.sections))
            AND (q.interaction_type='story' OR ag.intents IS NULL OR c.intent::text=ANY(ag.intents))
            AND (ag.high OR q.priority<>'high')
          ORDER BY (q.priority='high') DESC,
            (coalesce(q.last_reopened_at,q.entered_at) <= clock_timestamp()-make_interval(mins=>${starvation})) DESC,
            coalesce(array_position(${lanes}::text[],q.section),99),
            coalesce(q.last_reopened_at,q.entered_at),q.id
          LIMIT 1 FOR UPDATE OF q SKIP LOCKED
        ) it
        ORDER BY ag.open_count,ag.last_assigned NULLS FIRST,ag.user_id
        LIMIT 1`;
      if (!pick) break;
      const [item] = await tx<{ version: number }[]>`UPDATE queue_items q SET status='assigned',assignee_id=${pick.user_id}::uuid,
          first_assigned_at=coalesce(q.first_assigned_at,clock_timestamp()),assigned_at=clock_timestamp(),started_at=NULL,
          version=q.version+1,updated_at=clock_timestamp()
        WHERE q.id=${pick.item_id}::uuid AND q.version=${pick.version} AND q.status='new' RETURNING q.version`;
      if (!item) continue;
      const [ev] = await tx<{ id: string }[]>`INSERT INTO queue_events(queue_item_id,event_type,from_status,to_status,to_assignee,version,metadata)
        VALUES (${pick.item_id},'assigned','new','assigned',${pick.user_id},${item.version},
          ${JSON.stringify({ auto: true, trigger: opts.trigger })}::jsonb) RETURNING id`;
      eventIds.push(ev.id);
      assigned.push({ itemId: pick.item_id, userId: pick.user_id });
    }
    await alertForEvents(tx, eventIds);
    return { assigned, enabled: true };
  });
}

/**
 * Runs a pass after the caller's transaction committed. A failure here never
 * undoes the caller's action; the periodic pass recovers what it missed.
 */
export async function assignAfter(trigger: string, userId?: string) {
  try {
    const r = await runAssignmentPass({ trigger, userId });
    if (r.assigned.length) log.info({ event: 'queue_auto_assign', trigger, assigned: r.assigned.length }, 'items auto-assigned');
    return r;
  } catch (err) {
    log.error({ err, trigger }, 'auto-assignment pass failed; the periodic pass will retry');
    return { assigned: [], enabled: true };
  }
}

/** Supervisor redistribution: take an agent's not-yet-escalated open work back to the pool, then reassign it. */
export async function releaseAgentItems(req: FastifyRequest, userId: string, reason: string) {
  const actor = req.user;
  if (!has(actor, P.QUEUE_SUPERVISE) && !has(actor, P.QUEUE_VIEW_ALL)) throw forbidden();
  if (!reason.trim()) throw badRequest('سبب إعادة التوزيع مطلوب');
  const released = await sql.begin(async (tx) => {
    const [agent] = await tx`SELECT u.id FROM users u WHERE u.id=${userId}::uuid AND (${agentScope(actor)}) FOR UPDATE OF u`;
    if (!agent) throw notFound('الموظف غير موجود ضمن نطاقك');
    const items = await tx<{ id: string; status: string; version: number }[]>`UPDATE queue_items q SET status='new',assignee_id=NULL,
        assigned_at=NULL,started_at=NULL,version=q.version+1,updated_at=clock_timestamp()
      FROM queue_items o WHERE o.id=q.id AND q.assignee_id=${userId}::uuid AND q.status IN ('assigned','in_progress')
        AND q.merged_into_id IS NULL AND (${has(actor, P.QUEUE_VIEW_ALL)} OR EXISTS (SELECT 1 FROM team_members sm
          WHERE sm.team_id=q.team_id AND sm.user_id=${actor.id}::uuid AND sm.kind='supervisor' AND sm.left_at IS NULL))
      RETURNING q.id,o.status,q.version`;
    for (const it of items) {
      await tx`INSERT INTO queue_events(queue_item_id,event_type,actor_id,from_status,to_status,from_assignee,reason,version,metadata)
        VALUES (${it.id},'unassigned',${actor.id},${it.status},'new',${userId},${reason.trim()},${it.version},${JSON.stringify({ redistribution: true })}::jsonb)`;
    }
    await tx`INSERT INTO audit_log(user_id,user_email,action,entity_type,entity_id,new_value,reason,ip_address)
      VALUES (${actor.id},${actor.email},'workforce.redistribute','user',${userId}::uuid,${JSON.stringify({ items: items.map((i) => i.id) })}::jsonb,
        ${reason.trim()},${req.ip}::inet)`;
    return items.length;
  });
  const pass = await assignAfter('redistribution');
  return { released, reassigned: pass.assigned.length };
}

// ───────────────────────── Time and performance ─────────────────────────

/**
 * Seconds per user, Asia/Riyadh day and status, clipped to [from, to) and to
 * now for the open period. A period across midnight is split between the two
 * days; nothing is counted twice and nothing is dropped.
 */
export async function statusTime(userIds: string[], from: string, to: string) {
  return sql<{ user_id: string; day: string; status: AgentStatus; seconds: number }[]>`
    WITH p AS (
      SELECT user_id,status,greatest(started_at,${from}::timestamptz) AS s,
        least(coalesce(ended_at,clock_timestamp()),${to}::timestamptz,clock_timestamp()) AS e
      FROM agent_status_periods
      WHERE user_id=ANY(${userIds}::uuid[]) AND started_at<${to}::timestamptz
        AND coalesce(ended_at,clock_timestamp())>${from}::timestamptz
    ), d AS (
      SELECT p.user_id,p.status,p.s,p.e,day FROM p
      CROSS JOIN LATERAL generate_series(date_trunc('day',p.s AT TIME ZONE 'Asia/Riyadh'),
        date_trunc('day',p.e AT TIME ZONE 'Asia/Riyadh'),interval '1 day') AS day
      WHERE p.e>p.s
    )
    SELECT user_id,to_char(day,'YYYY-MM-DD') AS day,status,
      round(sum(extract(epoch FROM least(e,(day+interval '1 day') AT TIME ZONE 'Asia/Riyadh')
        - greatest(s,day AT TIME ZONE 'Asia/Riyadh'))))::int AS seconds
    FROM d GROUP BY user_id,day,status HAVING sum(extract(epoch FROM least(e,(day+interval '1 day') AT TIME ZONE 'Asia/Riyadh')
        - greatest(s,day AT TIME ZONE 'Asia/Riyadh')))>0
    ORDER BY user_id,day,status`;
}

/** Totals per user: every status, logged-in time (all but offline) and operational time (configured statuses). */
export async function timeTotals(userIds: string[], from: string, to: string) {
  const rows = await statusTime(userIds, from, to);
  const s = await settingsMap(sql, ['workforce.operational_statuses']);
  const operational = Array.isArray(s['workforce.operational_statuses']) ? (s['workforce.operational_statuses'] as string[]) : ['available'];
  const out: Record<string, Record<AgentStatus | 'logged' | 'operational', number>> = {};
  for (const id of userIds) out[id] = { available: 0, break: 0, away: 0, meeting: 0, training: 0, offline: 0, logged: 0, operational: 0 };
  for (const r of rows) {
    const t = out[r.user_id];
    t[r.status] += r.seconds;
    if (r.status !== 'offline') t.logged += r.seconds;
    if (operational.includes(r.status)) t.operational += r.seconds;
  }
  return { totals: out, days: rows, operationalStatuses: operational };
}

/**
 * Queue performance per agent in [from, to). Attribution follows ownership:
 *  - Completed: review cycles closed by the agent (an item closed twice after
 *    a reopen counts as two cycles and one item).
 *  - Assignment-to-Close: from the closer's own assignment to the close. A
 *    transfer or reassignment restarts the clock for the new holder, so the
 *    previous holder's time is never credited to them. Not handling time.
 *  - Queue Wait: entered → first assignment, for items whose first owner was the agent.
 *  - Reopened: reopens of work the agent held when it was closed.
 *  - Escalated: escalations raised by the agent.
 *  - Open item age: now − the current assignment, for open items.
 */
export async function performance(userIds: string[], from: string, to: string) {
  const closed = await sql<{ user_id: string; cycles: number; items: number; avg_assign_to_close_min: number | null }[]>`
    SELECT r.reviewer_id AS user_id,count(*)::int AS cycles,count(DISTINCT r.queue_item_id)::int AS items,
      round((avg(extract(epoch FROM r.completed_at-r.assigned_at))/60)::numeric,1)::float AS avg_assign_to_close_min
    FROM queue_reviews r WHERE r.reviewer_id=ANY(${userIds}::uuid[]) AND r.reviewed_at>=${from}::timestamptz AND r.reviewed_at<${to}::timestamptz
    GROUP BY r.reviewer_id`;
  const flow = await sql<{ user_id: string; reopened: number; escalated: number }[]>`
    SELECT u AS user_id,
      count(*) FILTER (WHERE e.event_type='reopened' AND e.from_assignee=u)::int AS reopened,
      count(*) FILTER (WHERE e.event_type='escalated' AND e.actor_id=u)::int AS escalated
    FROM unnest(${userIds}::uuid[]) u JOIN queue_events e ON (e.from_assignee=u OR e.actor_id=u)
      AND e.event_type IN ('reopened','escalated') AND e.created_at>=${from}::timestamptz AND e.created_at<${to}::timestamptz
    GROUP BY u`;
  const wait = await sql<{ user_id: string; items: number; avg_queue_wait_min: number | null }[]>`
    WITH firsts AS (SELECT DISTINCT ON (e.queue_item_id) e.queue_item_id,e.to_assignee,e.created_at
      FROM queue_events e WHERE e.event_type IN ('assigned','transferred') AND e.to_assignee IS NOT NULL
        AND e.queue_item_id IN (SELECT x.queue_item_id FROM queue_events x WHERE x.to_assignee=ANY(${userIds}::uuid[])
          AND x.event_type IN ('assigned','transferred') AND x.created_at>=${from}::timestamptz AND x.created_at<${to}::timestamptz)
      ORDER BY e.queue_item_id,e.version)
    SELECT f.to_assignee AS user_id,count(*)::int AS items,
      round((avg(extract(epoch FROM f.created_at-q.entered_at))/60)::numeric,1)::float AS avg_queue_wait_min
    FROM firsts f JOIN queue_items q ON q.id=f.queue_item_id
    WHERE f.to_assignee=ANY(${userIds}::uuid[]) AND f.created_at>=${from}::timestamptz AND f.created_at<${to}::timestamptz
    GROUP BY f.to_assignee`;
  const open = await sql<{ user_id: string; open: number; escalated_open: number; oldest_min: number | null; avg_age_min: number | null }[]>`
    SELECT q.assignee_id AS user_id,count(*) FILTER (WHERE q.status IN ('assigned','in_progress'))::int AS open,
      count(*) FILTER (WHERE q.status='escalated')::int AS escalated_open,
      round((max(extract(epoch FROM clock_timestamp()-q.assigned_at)) FILTER (WHERE q.status IN ('assigned','in_progress'))/60)::numeric,1)::float AS oldest_min,
      round((avg(extract(epoch FROM clock_timestamp()-q.assigned_at)) FILTER (WHERE q.status IN ('assigned','in_progress'))/60)::numeric,1)::float AS avg_age_min
    FROM queue_items q WHERE q.assignee_id=ANY(${userIds}::uuid[]) AND q.status IN ('assigned','in_progress','escalated') AND q.merged_into_id IS NULL
    GROUP BY q.assignee_id`;
  return Object.fromEntries(userIds.map((id) => {
    const c = closed.find((r) => r.user_id === id); const f = flow.find((r) => r.user_id === id);
    const w = wait.find((r) => r.user_id === id); const o = open.find((r) => r.user_id === id);
    return [id, {
      completedCycles: c?.cycles ?? 0, completedItems: c?.items ?? 0, avgAssignmentToCloseMin: c?.avg_assign_to_close_min ?? null,
      reopened: f?.reopened ?? 0, escalated: f?.escalated ?? 0,
      firstAssignedItems: w?.items ?? 0, avgQueueWaitMin: w?.avg_queue_wait_min ?? null,
      open: o?.open ?? 0, escalatedOpen: o?.escalated_open ?? 0, oldestOpenMin: o?.oldest_min ?? null, avgOpenAgeMin: o?.avg_age_min ?? null,
    }];
  }));
}

/** Effective box limit and auto-assign flag for each agent. */
export async function effectiveLimits(userIds: string[]) {
  const s = await settingsMap(sql, ['queue.default_max_open']);
  const systemMax = num(s['queue.default_max_open'], 5);
  return sql<{ user_id: string; max_open: number; auto_assign: boolean }[]>`SELECT u AS user_id,
      coalesce(a.max_open,d.max_open,${systemMax})::int AS max_open,coalesce(a.auto_assign,d.auto_assign,true) AS auto_assign
    FROM unnest(${userIds}::uuid[]) u LEFT JOIN agent_queue_settings a ON a.user_id=u
    LEFT JOIN team_members tm ON tm.user_id=u AND tm.left_at IS NULL AND tm.kind='agent'
    LEFT JOIN team_queue_defaults d ON d.team_id=tm.team_id`;
}
