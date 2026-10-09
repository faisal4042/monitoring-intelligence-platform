import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '@mip/db';
import { AGENT_STATUSES, PERMISSIONS as P, QUEUE_INTENTS, QUEUE_SECTIONS } from '@mip/shared';
import { queueScope, type QueueActor } from '../../lib/authz.js';
import { dateBoundsFromQuery } from '../../lib/date-range.js';
import { badRequest } from '../../lib/errors.js';
import { administrativeAudit } from './service.js';
import { idParams, parse } from './validation.js';
import {
  agentScope, assignAfter, correctPeriod, currentStatus, effectiveLimits, heartbeat, performance, releaseAgentItems,
  setStatus, settingsOverview, timeTotals, statusTime, updateAgentSettings, updateTeamDefaults, type QueueSettingsInput,
} from './workforce.js';

const uuid = z.string().uuid();
const status = z.enum(AGENT_STATUSES);
const range = { range: z.string().optional(), from: z.string().optional(), to: z.string().optional() };
const boardSchema = z.object({ ...range, teamId: uuid.optional(), programId: uuid.optional(), employeeId: uuid.optional() }).strict();
const settingsBody = z.object({
  programIds: z.array(uuid).max(100).nullable().optional(),
  intents: z.array(z.enum(QUEUE_INTENTS)).max(20).nullable().optional(),
  sections: z.array(z.enum(QUEUE_SECTIONS)).max(3).nullable().optional(),
  maxOpen: z.number().int().min(0).max(200).nullable().optional(),
  autoAssign: z.boolean().nullable().optional(),
  acceptsHighPriority: z.boolean().nullable().optional(),
}).strict();
const SYSTEM_KEYS = ['queue.auto_assign_enabled', 'queue.lane_order', 'queue.starvation_minutes', 'queue.default_max_open',
  'workforce.heartbeat_timeout_minutes', 'workforce.max_status_hours', 'workforce.operational_statuses'] as const;
const systemBody = z.object({
  autoAssignEnabled: z.boolean(),
  laneOrder: z.array(z.enum(QUEUE_SECTIONS)).length(3).refine((v) => new Set(v).size === 3, 'ترتيب المسارات يجب أن يذكر كل مسار مرة واحدة'),
  starvationMinutes: z.number().int().min(1).max(10080),
  defaultMaxOpen: z.number().int().min(0).max(200),
  heartbeatTimeoutMinutes: z.number().int().min(2).max(240),
  maxStatusHours: z.number().int().min(1).max(24),
  operationalStatuses: z.array(status).min(1).max(6),
}).strict();

const today = () => dateBoundsFromQuery({ range: 'today' });

/** Agents (active agent members) the actor may see, narrowed by team/employee. */
async function agentsInScope(actor: QueueActor, f: { teamId?: string; employeeId?: string }) {
  return sql<{ id: string; full_name: string; team_id: string; team_name: string; status: string; status_since: string | null;
    status_source: string | null; last_heartbeat_at: string | null }[]>`
    SELECT u.id,u.full_name,t.id AS team_id,t.name AS team_name,coalesce(sp.status,'offline') AS status,
      sp.started_at::text AS status_since,sp.source AS status_source,pr.last_heartbeat_at::text AS last_heartbeat_at
    FROM team_members tm JOIN users u ON u.id=tm.user_id JOIN roles r ON r.id=u.role_id JOIN teams t ON t.id=tm.team_id AND t.is_active
    LEFT JOIN agent_status_periods sp ON sp.user_id=u.id AND sp.ended_at IS NULL
    LEFT JOIN agent_presence pr ON pr.user_id=u.id
    WHERE tm.left_at IS NULL AND tm.kind='agent' AND r.key='agent' AND u.is_active AND u.deleted_at IS NULL
      AND (${agentScope(actor)}) AND u.id<>${actor.id}::uuid
      AND (${f.teamId ?? null}::uuid IS NULL OR t.id=${f.teamId ?? null}::uuid)
      AND (${f.employeeId ?? null}::uuid IS NULL OR u.id=${f.employeeId ?? null}::uuid)
    ORDER BY t.name,u.full_name`;
}

export default async function workforceRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);
  const work = { preHandler: [app.requirePermission(P.QUEUE_WORK)] };
  const supervise = { preHandler: [app.requirePermission(P.QUEUE_SUPERVISE, P.QUEUE_VIEW_ALL)] };

  // ── The agent's own status and figures ──
  app.get('/me', work, async (req) => {
    const q = parse(z.object(range).strict(), req.query);
    const window = dateBoundsFromQuery({ range: q.range ?? 'today', from: q.from, to: q.to });
    const me = req.user.id;
    const [limits] = await effectiveLimits([me]);
    const [team] = await sql<{ team_id: string; team_name: string }[]>`SELECT t.id AS team_id,t.name AS team_name FROM team_members tm
      JOIN teams t ON t.id=tm.team_id WHERE tm.user_id=${me}::uuid AND tm.left_at IS NULL AND tm.kind='agent' AND t.is_active`;
    const [{ auto }] = await sql<{ auto: boolean }[]>`SELECT coalesce((SELECT value='true'::jsonb FROM settings WHERE key='queue.auto_assign_enabled'),false) AS auto`;
    const day = today();
    const perfToday = (await performance([me], day.from, day.to))[me];
    const perf = (await performance([me], window.from, window.to))[me];
    const time = await timeTotals([me], window.from, window.to);
    const [{ now }] = await sql<{ now: string }[]>`SELECT clock_timestamp()::text AS now`;
    return {
      status: await currentStatus(me), team: team ?? null, maxOpen: limits.max_open, autoAssign: limits.auto_assign, autoAssignEnabled: auto,
      open: perfToday.open, escalatedOpen: perfToday.escalatedOpen, completedToday: perfToday.completedItems,
      performance: perf, time: time.totals[me], days: time.days, operationalStatuses: time.operationalStatuses,
      range: { from: window.from, to: window.to }, serverNow: new Date(now).toISOString(),
    };
  });
  app.post('/status', work, async (req) => {
    const input = parse(z.object({ status }).strict(), req.body);
    return setStatus(req, req.user.id, input.status);
  });
  app.post('/heartbeat', work, async (req) => heartbeat(req.user));

  // ── Supervisor: availability, board, time, corrections, redistribution ──
  app.post('/agents/:id/status', supervise, async (req) => {
    const { id } = parse(idParams, req.params);
    const input = parse(z.object({ status, reason: z.string().trim().min(1).max(2000) }).strict(), req.body);
    return setStatus(req, id, input.status, input.reason);
  });
  app.post('/agents/:id/release', supervise, async (req) => {
    const { id } = parse(idParams, req.params);
    const input = parse(z.object({ reason: z.string().trim().min(1).max(2000) }).strict(), req.body);
    return releaseAgentItems(req, id, input.reason);
  });

  app.get('/board', supervise, async (req) => {
    const f = parse(boardSchema, req.query);
    const window = dateBoundsFromQuery({ range: f.range ?? 'today', from: f.from, to: f.to });
    const agents = await agentsInScope(req.user, f);
    const ids = agents.map((a) => a.id);
    const day = today();
    const [limits, perf, perfToday, time] = await Promise.all([
      effectiveLimits(ids), performance(ids, window.from, window.to), performance(ids, day.from, day.to), timeTotals(ids, window.from, window.to),
    ]);
    const settings = await sql<{ key: string; value: unknown }[]>`SELECT key,value FROM settings
      WHERE key IN ('queue.wait_warning_minutes','queue.starvation_minutes','queue.auto_assign_enabled')`;
    const warn = Number(settings.find((s) => s.key === 'queue.wait_warning_minutes')?.value ?? 60);
    const starvation = Number(settings.find((s) => s.key === 'queue.starvation_minutes')?.value ?? 45);
    const items = sql`(${queueScope(req.user)}) AND q.merged_into_id IS NULL AND q.story_item_id IS NULL
      AND (${f.teamId ?? null}::uuid IS NULL OR q.team_id=${f.teamId ?? null}::uuid)
      AND (${f.programId ?? null}::uuid IS NULL OR q.program_id=${f.programId ?? null}::uuid)
      AND (${f.employeeId ?? null}::uuid IS NULL OR q.assignee_id=${f.employeeId ?? null}::uuid OR q.status='new')`;
    const [backlog] = await sql`SELECT count(*) FILTER (WHERE q.status='new')::int AS waiting,
        count(*) FILTER (WHERE q.status='new' AND coalesce(q.last_reopened_at,q.entered_at)<=clock_timestamp()-make_interval(mins=>${starvation}))::int AS starving,
        round((max(extract(epoch FROM clock_timestamp()-coalesce(q.last_reopened_at,q.entered_at))) FILTER (WHERE q.status='new')/60)::numeric,1)::float AS oldest_waiting_min,
        count(*) FILTER (WHERE q.status IN ('assigned','in_progress') AND q.assigned_at<clock_timestamp()-make_interval(mins=>${warn}))::int AS overdue,
        count(*) FILTER (WHERE q.status IN ('assigned','in_progress'))::int AS in_boxes,
        count(*) FILTER (WHERE q.status='escalated')::int AS escalated,
        count(*) FILTER (WHERE q.status='new' AND q.priority='high')::int AS waiting_high
      FROM queue_items q WHERE ${items} AND q.status<>'completed'`;
    const bySection = await sql`SELECT q.section,count(*) FILTER (WHERE q.status='new')::int AS waiting,
        count(*) FILTER (WHERE q.status IN ('assigned','in_progress'))::int AS in_boxes,count(*) FILTER (WHERE q.status='escalated')::int AS escalated
      FROM queue_items q WHERE ${items} AND q.status<>'completed' GROUP BY q.section`;
    const byProgram = await sql`SELECT q.program_id,q.program_snapshot->>'name' AS name,q.program_snapshot->>'color' AS color,
        count(*) FILTER (WHERE q.status='new')::int AS waiting,count(*) FILTER (WHERE q.status IN ('assigned','in_progress'))::int AS in_boxes,
        count(*) FILTER (WHERE q.status='escalated')::int AS escalated
      FROM queue_items q WHERE ${items} AND q.status<>'completed' GROUP BY 1,2,3 ORDER BY 2`;
    const closedToday = await sql`SELECT count(DISTINCT r.queue_item_id)::int AS n FROM queue_reviews r JOIN queue_items q ON q.id=r.queue_item_id
      WHERE ${items} AND r.reviewed_at>=${day.from}::timestamptz AND r.reviewed_at<${day.to}::timestamptz`;
    const sum = (k: string) => ids.reduce((n, id) => n + ((time.totals[id] as Record<string, number>)[k] ?? 0), 0);
    const [{ now }] = await sql<{ now: string }[]>`SELECT clock_timestamp()::text AS now`;
    return {
      autoAssignEnabled: settings.find((s) => s.key === 'queue.auto_assign_enabled')?.value === true,
      warnMinutes: warn, starvationMinutes: starvation, range: { from: window.from, to: window.to }, serverNow: new Date(now).toISOString(),
      agents: agents.map((a) => {
        const l = limits.find((x) => x.user_id === a.id);
        return { ...a, maxOpen: l?.max_open ?? 0, autoAssign: l?.auto_assign ?? true, open: perfToday[a.id].open,
          escalatedOpen: perfToday[a.id].escalatedOpen, closedToday: perfToday[a.id].completedItems, oldestOpenMin: perfToday[a.id].oldestOpenMin,
          performance: perf[a.id], time: time.totals[a.id] };
      }),
      backlog: { ...backlog, closedToday: closedToday[0].n }, bySection, byProgram,
      timeTotals: { available: sum('available'), break: sum('break'), meeting: sum('meeting'), training: sum('training'), away: sum('away'),
        offline: sum('offline'), logged: sum('logged'), operational: sum('operational') },
      operationalStatuses: time.operationalStatuses,
    };
  });

  /** Per-day time (Asia/Riyadh) per agent and status, for reports. */
  app.get('/time', supervise, async (req) => {
    const f = parse(boardSchema, req.query);
    const window = dateBoundsFromQuery({ range: f.range ?? 'today', from: f.from, to: f.to });
    const agents = await agentsInScope(req.user, f);
    const rows = await statusTime(agents.map((a) => a.id), window.from, window.to);
    return { range: { from: window.from, to: window.to }, agents: agents.map((a) => ({ id: a.id, full_name: a.full_name, team_name: a.team_name })), rows };
  });

  /** One agent's periods, newest first, with corrections — the audit view behind every total. */
  app.get('/periods', supervise, async (req) => {
    const f = parse(z.object({ ...range, employeeId: uuid }).strict(), req.query);
    const window = dateBoundsFromQuery({ range: f.range ?? 'today', from: f.from, to: f.to });
    const [agent] = await sql`SELECT u.id FROM users u WHERE u.id=${f.employeeId}::uuid AND (${agentScope(req.user)})`;
    if (!agent) return { items: [] };
    const items = await sql`SELECT p.id,p.status,p.previous_status,p.started_at,p.ended_at,p.source,p.reason,p.end_source,p.end_reason,
        p.corrected_count,round(extract(epoch FROM coalesce(p.ended_at,clock_timestamp())-p.started_at))::int AS seconds,
        au.full_name AS actor_name,
        coalesce((SELECT jsonb_agg(jsonb_build_object('reason',c.reason,'old',c.old_value,'new',c.new_value,'at',c.created_at,'by',cu.full_name) ORDER BY c.created_at)
          FROM agent_status_corrections c JOIN users cu ON cu.id=c.corrected_by WHERE c.period_id=p.id),'[]') AS corrections
      FROM agent_status_periods p LEFT JOIN users au ON au.id=p.actor_id
      WHERE p.user_id=${f.employeeId}::uuid AND p.started_at<${window.to}::timestamptz AND coalesce(p.ended_at,clock_timestamp())>${window.from}::timestamptz
      ORDER BY p.started_at DESC LIMIT 500`;
    return { items };
  });
  app.post('/periods/:id/correct', { preHandler: [app.requirePermission(P.WORKFORCE_CORRECT)] }, async (req) => {
    const { id } = parse(idParams, req.params);
    const input = parse(z.object({ status: status.optional(), startedAt: z.string().datetime({ offset: true }).optional(),
      endedAt: z.string().datetime({ offset: true }).optional(), reason: z.string().trim().min(1).max(2000) }).strict()
      .refine((v) => v.status || v.startedAt || v.endedAt, 'لا يوجد تغيير'), req.body);
    return correctPeriod(req, id, input);
  });

  // ── Per-agent queue settings (team defaults, agent overrides) ──
  app.get('/settings', supervise, async (req) => {
    const f = parse(z.object({ teamId: uuid.optional() }).strict(), req.query);
    return settingsOverview(req.user, f.teamId);
  });
  app.put('/settings/teams/:id', supervise, async (req) => {
    const { id } = parse(idParams, req.params);
    return updateTeamDefaults(req, id, parse(settingsBody, req.body) as QueueSettingsInput);
  });
  app.put('/settings/agents/:id', supervise, async (req) => {
    const { id } = parse(idParams, req.params);
    return updateAgentSettings(req, id, parse(settingsBody, req.body) as QueueSettingsInput);
  });

  // ── System-wide assignment and time policy ──
  app.get('/system-settings', supervise, async () => {
    const rows = await sql<{ key: string; value: unknown }[]>`SELECT key,value FROM settings WHERE key=ANY(${[...SYSTEM_KEYS]}::text[])`;
    const v = (k: string) => rows.find((r) => r.key === k)?.value;
    return {
      autoAssignEnabled: v('queue.auto_assign_enabled') === true, laneOrder: v('queue.lane_order') ?? ['story', 'influencer', 'general'],
      starvationMinutes: v('queue.starvation_minutes') ?? 45, defaultMaxOpen: v('queue.default_max_open') ?? 5,
      heartbeatTimeoutMinutes: v('workforce.heartbeat_timeout_minutes') ?? 10, maxStatusHours: v('workforce.max_status_hours') ?? 12,
      operationalStatuses: v('workforce.operational_statuses') ?? ['available'],
    };
  });
  app.put('/system-settings', { preHandler: [app.requirePermission(P.SETTINGS_WRITE)] }, async (req) => {
    const input = parse(systemBody, req.body);
    if (input.operationalStatuses.includes('offline')) throw badRequest('حالة غير متصل لا تُحسب وقت عمل');
    const values: Record<(typeof SYSTEM_KEYS)[number], unknown> = {
      'queue.auto_assign_enabled': input.autoAssignEnabled, 'queue.lane_order': input.laneOrder,
      'queue.starvation_minutes': input.starvationMinutes, 'queue.default_max_open': input.defaultMaxOpen,
      'workforce.heartbeat_timeout_minutes': input.heartbeatTimeoutMinutes, 'workforce.max_status_hours': input.maxStatusHours,
      'workforce.operational_statuses': input.operationalStatuses,
    };
    await sql.begin(async (tx) => {
      const old = await tx<{ key: string; value: unknown }[]>`SELECT key,value FROM settings WHERE key=ANY(${[...SYSTEM_KEYS]}::text[]) FOR UPDATE`;
      for (const [key, value] of Object.entries(values)) {
        await tx`UPDATE settings SET value=${JSON.stringify(value)}::jsonb,updated_at=now(),updated_by=${req.user.id}::uuid WHERE key=${key}`;
      }
      await administrativeAudit(tx, req, 'workforce.system_settings_change', 'settings', null,
        { old: Object.fromEntries(old.map((r) => [r.key, r.value])), new: values });
    });
    await assignAfter('settings_changed');
    return input;
  });
}
