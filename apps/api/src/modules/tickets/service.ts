/** Ticket reads, scoped visibility and audited transitions. Nothing here calls an external provider. */
import {randomUUID} from 'node:crypto';
import {sql} from '@mip/db';
import {workerCheckpoint} from '../../startup/worker-ownership.js';
import {availableActions, decide, TICKET_ACTIONS, type Actor, type TicketAction, type TicketStatus} from './state-machine.js';

let activatedAt = 0, activated = false;
/** True only when migration 0047 exists on this database (it is NOT applied to mip without approval). */
export async function ticketsActivated(): Promise<boolean> {
  if (Date.now() - activatedAt < 30_000) return activated;
  const [r] = await sql`SELECT to_regclass('public.tickets') IS NOT NULL AND to_regclass('public.report_exports') IS NOT NULL AS ok`;
  activated = !!r.ok; activatedAt = Date.now();
  return activated;
}

let linksAt = 0, links = false;
/** True only when migration 0051 (ticket ↔ queue card links) exists on this database. */
export async function queueLinksActive(): Promise<boolean> {
  if (Date.now() - linksAt < 30_000) return links;
  const [r] = await sql`SELECT to_regclass('public.queue_item_tickets') IS NOT NULL AS ok`;
  links = !!r.ok; linksAt = Date.now();
  return links;
}

type TicketRow = Record<string, any> & {id: string; ticket_number: string; status: TicketStatus; assignee_id: string | null; version: number; conversation_id: string; customer_identity_id: string; program_id: string | null};

export class TicketError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }

/** Actions that never change who works a ticket or its status: allowed on tickets that live on a queue card. */
export const QUEUE_SAFE_ACTIONS: TicketAction[] = ['set_priority', 'clear_review'];

/** Visibility: tickets:read_all → everything; tickets:read → own tickets + unassigned tickets of the user's teams. */
export function ticketScope(actor: Actor, alias = 't') {
  if (actor.perms.has('tickets:read_all')) return sql`true`;
  if (!actor.perms.has('tickets:read')) return sql`false`;
  const t = sql.unsafe(alias);
  return sql`(${t}.assignee_id = ${actor.id}::uuid OR (${t}.assignee_id IS NULL AND (
    ${t}.team_id IN (SELECT team_id FROM team_members WHERE user_id = ${actor.id}::uuid AND left_at IS NULL)
    OR ${t}.program_id IN (SELECT tp.program_id FROM team_programs tp JOIN team_members tm ON tm.team_id = tp.team_id
                           WHERE tm.user_id = ${actor.id}::uuid AND tm.left_at IS NULL))))`;
}

export interface TicketFilters { status?: string[]; programId?: string; assignee?: string; channels?: string[]; review?: boolean; q?: string; cursor?: string; limit?: number; dates?: {from: string; to: string} }
export async function listTickets(actor: Actor, f: TicketFilters) {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 100);
  let cursor: {at: string; id: string} | null = null;
  if (f.cursor) { try { cursor = JSON.parse(Buffer.from(f.cursor, 'base64url').toString('utf8')); } catch { throw new TicketError(400, 'INVALID_CURSOR', 'مؤشر الصفحة غير صالح'); } }
  const rows = await sql`
    SELECT t.id, t.ticket_number, t.status, t.priority, t.channel, t.opened_at, t.last_activity_at, t.closed_at, t.message_count,
      t.needs_review, t.review_reason, t.assignee_id, u.full_name AS assignee_name, p.name_ar AS program_name, p.color AS program_color,
      ci.handle AS customer_handle, ci.display_name AS customer_name, t.first_response_at, t.version,
      a.profile_image_url, a.followers_count, a.following_count, a.tweet_count, a.is_verified, a.description AS author_bio,
      lm.text AS last_message_text,
      qi.id AS queue_item_id, qi.version AS queue_item_version, qi.status AS queue_item_status
    FROM tickets t
    JOIN customer_identities ci ON ci.id = t.customer_identity_id
    LEFT JOIN users u ON u.id = t.assignee_id
    LEFT JOIN programs p ON p.id = t.program_id
    -- Read-only X account enrichment for the card (avatar, figures, bio); non-X customers stay null.
    LEFT JOIN LATERAL (
      SELECT au.profile_image_url, au.followers_count, au.following_count, au.tweet_count, au.is_verified, au.description
      FROM authors au
      WHERE ci.provider = 'x' AND ci.handle IS NOT NULL AND lower(au.username) = lower(ci.handle)
      ORDER BY au.last_seen_at DESC NULLS LAST LIMIT 1
    ) a ON true
    -- The interaction's own content for the card, like the queue: the latest inbound customer message.
    LEFT JOIN LATERAL (
      SELECT COALESCE(m.body, po.text) AS text
      FROM ticket_messages m
      LEFT JOIN posts po ON po.id = m.post_id AND po.posted_at = m.post_posted_at
      WHERE m.ticket_id = t.id AND m.direction = 'inbound'
      ORDER BY m.event_at DESC, m.id DESC LIMIT 1
    ) lm ON true
    -- The queue card that manages this ticket (when links are active): bulk actions route through it.
    LEFT JOIN LATERAL (
      SELECT q2.id, q2.version, q2.status
      FROM queue_item_tickets qit JOIN queue_items q2 ON q2.id = qit.queue_item_id
      WHERE qit.ticket_id = t.id ORDER BY q2.entered_at DESC LIMIT 1
    ) qi ON true
    WHERE ${ticketScope(actor)}
      AND (${f.status?.length ? sql`t.status = ANY(${f.status})` : sql`true`})
      AND (${f.programId ? sql`t.program_id = ${f.programId}::uuid` : sql`true`})
      AND (${f.channels?.length ? sql`t.channel = ANY(${f.channels})` : sql`true`})
      AND (${f.review ? sql`t.needs_review` : sql`true`})
      AND (${f.dates ? sql`t.last_activity_at >= ${f.dates.from}::timestamptz AND t.last_activity_at < ${f.dates.to}::timestamptz` : sql`true`})
      AND (${f.assignee === 'me' ? sql`t.assignee_id = ${actor.id}::uuid` : f.assignee === 'unassigned' ? sql`t.assignee_id IS NULL` : f.assignee ? sql`t.assignee_id = ${f.assignee}::uuid` : sql`true`})
      AND (${f.q ? (/^#?[0-9]+$/.test(f.q.trim()) ? sql`t.ticket_number = ${f.q.trim().replace(/^#/, '')}` : sql`t.ticket_number ILIKE ${f.q.replace(/[%_\\]/g, '') + '%'}`) : sql`true`})
      AND (${cursor ? sql`(t.last_activity_at, t.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : sql`true`})
    ORDER BY t.last_activity_at DESC, t.id DESC LIMIT ${limit + 1}`;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {items, queueLinked: await queueLinksActive(),
    nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({at: new Date(last.last_activity_at).toISOString(), id: last.id})).toString('base64url') : null};
}

async function loadVisible(actor: Actor, id: string) {
  const [t] = await sql<TicketRow[]>`SELECT t.* FROM tickets t WHERE t.id = ${id}::uuid AND ${ticketScope(actor)}`;
  // Same 404 for "missing" and "not yours": no existence oracle (IDOR).
  if (!t) throw new TicketError(404, 'TICKET_NOT_FOUND', 'التذكرة غير موجودة');
  return t;
}

export async function getTicket(actor: Actor, id: string) {
  const t = await loadVisible(actor, id);
  const linked = await queueLinksActive();
  const [[conversation], [customer], messages, events, previous, queue] = await Promise.all([
    sql`SELECT id, channel, provider, managed_account, provider_thread_id, identity_confidence, ticket_count, created_at, last_message_at FROM conversations WHERE id = ${t.conversation_id}`,
    sql`SELECT id, provider, handle, display_name, first_seen_at, last_seen_at FROM customer_identities WHERE id = ${t.customer_identity_id}`,
    sql`SELECT m.id, m.provider, m.provider_message_id, m.direction, m.author_kind, m.event_at, m.received_at, m.disposition,
          COALESCE(m.body, po.text) AS text, m.post_id, a.full_name AS agent_name,
          po.x_post_id AS post_x_id, po.url AS post_url, po.status::text AS post_status, po.collected_at AS post_collected_at
        FROM ticket_messages m LEFT JOIN posts po ON po.id = m.post_id AND po.posted_at = m.post_posted_at
        LEFT JOIN users a ON a.id = m.agent_id
        WHERE m.ticket_id = ${t.id} ORDER BY m.event_at, m.id LIMIT 500`,
    sql`SELECT e.version, e.event_type, e.from_status, e.to_status, e.actor_kind, e.reason, e.occurred_at, e.payload,
          u.full_name AS actor_name, au.full_name AS assignee_name
        FROM ticket_events e LEFT JOIN users u ON u.id = e.actor_id LEFT JOIN users au ON au.id = e.assignee_id
        WHERE e.ticket_id = ${t.id} ORDER BY e.version`,
    sql`SELECT id, ticket_number, status, opened_at, closed_at FROM tickets t
        WHERE customer_identity_id = ${t.customer_identity_id} AND id <> ${t.id} AND ${ticketScope(actor)} ORDER BY opened_at DESC LIMIT 20`,
    linked ? sql`SELECT qi.id, qi.status, qi.interaction_type, qi.assigned_at, qi.completed_at, u.full_name AS assignee_name FROM queue_item_tickets l
        JOIN queue_items qi ON qi.id = l.queue_item_id LEFT JOIN users u ON u.id = qi.assignee_id WHERE l.ticket_id = ${t.id}`
      : sql`SELECT qi.id, qi.status, qi.interaction_type, qi.assigned_at, qi.completed_at, NULL AS assignee_name FROM queue_items qi
        WHERE qi.post_id IN (SELECT post_id FROM ticket_messages WHERE ticket_id = ${t.id} AND post_id IS NOT NULL)`,
  ]);
  const [[assignee], [program]] = await Promise.all([
    t.assignee_id ? sql`SELECT id, full_name FROM users WHERE id = ${t.assignee_id}` : Promise.resolve([] as never[]),
    t.program_id ? sql`SELECT id, name_ar, color FROM programs WHERE id = ${t.program_id}` : Promise.resolve([] as never[]),
  ]);
  // A ticket worked on a queue card changes status only through the card (migration 0051 keeps them in step).
  const actions = linked && queue.length ? availableActions(t, actor).filter((a) => QUEUE_SAFE_ACTIONS.includes(a as TicketAction)) : availableActions(t, actor);
  return {ticket: t, conversation, customer, assignee: assignee ?? null, program: program ?? null, messages, events,
    previousTickets: previous, queueItems: queue, queueManaged: linked && queue.length > 0, actions};
}

export async function ticketForPost(actor: Actor, postId: string) {
  const [row] = await sql`SELECT t.id, t.ticket_number, t.status, t.message_count, t.opened_at, t.last_activity_at, t.first_response_at,
      t.last_response_at, t.closed_at, u.full_name AS assignee_name, t.channel
    FROM ticket_messages m JOIN tickets t ON t.id = m.ticket_id LEFT JOIN users u ON u.id = t.assignee_id
    WHERE m.post_id = ${postId}::uuid AND ${ticketScope(actor)} LIMIT 1`;
  return row ?? null;
}

export async function transition(actor: Actor, id: string, action: string, input: {expectedVersion: number; reason?: string; assigneeId?: string | null; body?: string; priority?: string; correlationId?: string}) {
  if (!(action in TICKET_ACTIONS)) throw new TicketError(400, 'UNKNOWN_ACTION', 'إجراء غير معروف');
  const correlationId = input.correlationId ?? randomUUID();
  await workerCheckpoint();
  return sql.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '5s'`;
    const [t] = await tx<TicketRow[]>`SELECT t.* FROM tickets t WHERE t.id = ${id}::uuid AND ${ticketScope(actor)} FOR UPDATE`;
    if (!t) throw new TicketError(404, 'TICKET_NOT_FOUND', 'التذكرة غير موجودة');
    if (t.version !== input.expectedVersion) throw new TicketError(409, 'VERSION_CONFLICT', 'تغيّرت التذكرة منذ فتحها. حدّث الصفحة وأعد المحاولة.');
    if (!QUEUE_SAFE_ACTIONS.includes(action as TicketAction) && await queueLinksActive()) {
      const [card] = await tx`SELECT queue_item_id FROM queue_item_tickets WHERE ticket_id = ${t.id}`;
      if (card) throw new TicketError(409, 'QUEUE_MANAGED', 'تُعالَج هذه التذكرة من طابور الرصد: الإسناد والتصعيد والإغلاق تتم من بطاقتها في الطابور.');
    }
    const assigneeId = action === 'claim' ? actor.id : input.assigneeId ?? null;
    const d = decide(t, action, actor, {reason: input.reason, assigneeId});
    if (!d.ok) throw new TicketError(d.code === 'FORBIDDEN' ? 403 : 422, d.code, d.message);
    if (assigneeId && ['assign', 'reassign', 'admin_correction'].includes(action)) {
      const [ok] = await tx`SELECT 1 FROM users u WHERE u.id = ${assigneeId}::uuid AND u.is_active AND u.deleted_at IS NULL AND (
        EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = u.role_id AND rp.permission_key = 'tickets:work')
        OR EXISTS (SELECT 1 FROM user_permissions up WHERE up.user_id = u.id AND up.permission_key = 'tickets:work'))`;
      if (!ok) throw new TicketError(422, 'ASSIGNEE_NOT_ELIGIBLE', 'الموظف المختار غير نشط أو لا يملك صلاحية معالجة التذاكر');
    }
    if (action === 'reply' && !(input.body ?? '').trim()) throw new TicketError(422, 'BODY_REQUIRED', 'نص الرد مطلوب');
    if (action === 'set_priority' && !['normal', 'high'].includes(input.priority ?? '')) throw new TicketError(422, 'PRIORITY_INVALID', 'أولوية غير صالحة');
    const to = d.to as TicketStatus;
    const version = t.version + 1;
    const now = new Date().toISOString();
    const newAssignee = ['claim', 'assign', 'reassign', 'admin_correction'].includes(action) ? assigneeId : action === 'unassign' ? null : t.assignee_id;
    let messageId: string | null = null;
    if (action === 'reply') {
      const [m] = await tx`INSERT INTO ticket_messages (ticket_id, conversation_id, provider, provider_message_id, direction, author_kind, agent_id, body, event_at, correlation_id)
        VALUES (${t.id}, ${t.conversation_id}, 'mip', ${'mip-reply:' + randomUUID()}, 'outbound', 'agent', ${actor.id}::uuid, ${input.body!.trim()}, ${now}, ${correlationId}) RETURNING id`;
      messageId = m.id;
    }
    try {
      await tx`UPDATE tickets SET status = ${to}, version = ${version}, assignee_id = ${newAssignee}::uuid,
        first_assigned_at = CASE WHEN ${newAssignee}::uuid IS NOT NULL THEN coalesce(first_assigned_at, ${now}::timestamptz) ELSE first_assigned_at END,
        last_assigned_at = CASE WHEN ${['claim', 'assign', 'reassign', 'admin_correction'].includes(action)} THEN ${now}::timestamptz ELSE last_assigned_at END,
        reassignment_count = reassignment_count + ${action === 'reassign' ? 1 : 0},
        escalation_count = escalation_count + ${action === 'escalate' ? 1 : 0},
        correction_count = correction_count + ${action === 'admin_correction' ? 1 : 0},
        first_response_at = CASE WHEN ${action === 'reply'} THEN coalesce(first_response_at, ${now}::timestamptz) ELSE first_response_at END,
        last_response_at = CASE WHEN ${action === 'reply'} THEN ${now}::timestamptz ELSE last_response_at END,
        agent_message_count = agent_message_count + ${action === 'reply' ? 1 : 0},
        message_count = message_count + ${action === 'reply' ? 1 : 0},
        resolved_at = CASE WHEN ${to} = 'resolved' THEN ${now}::timestamptz WHEN ${to} = 'closed' THEN resolved_at ELSE NULL END,
        closed_at = CASE WHEN ${to} = 'closed' THEN ${now}::timestamptz ELSE NULL END,
        closed_by = CASE WHEN ${to} = 'closed' THEN ${actor.id}::uuid ELSE NULL END,
        close_reason = CASE WHEN ${to} = 'closed' THEN ${input.reason ?? null} ELSE NULL END,
        priority = CASE WHEN ${action === 'set_priority'} THEN ${input.priority ?? 'normal'} ELSE priority END,
        needs_review = CASE WHEN ${action === 'clear_review'} THEN false ELSE needs_review END,
        review_reason = CASE WHEN ${action === 'clear_review'} THEN NULL ELSE review_reason END,
        last_activity_at = GREATEST(last_activity_at, ${now}::timestamptz)
        WHERE id = ${t.id}`;
    } catch (error) {
      if ((error as {code?: string}).code === '23505') throw new TicketError(409, 'CONVERSATION_HAS_ACTIVE_TICKET', 'توجد تذكرة نشطة أحدث لهذه المحادثة؛ لا يمكن تصحيح هذه التذكرة دون إغلاقها');
      throw error;
    }
    await tx`INSERT INTO ticket_events (ticket_id, version, event_type, from_status, to_status, actor_kind, actor_id, assignee_id, reason, correlation_id, payload)
      VALUES (${t.id}, ${version}, ${d.event}, ${t.status}, ${to}, 'user', ${actor.id}::uuid, ${newAssignee}::uuid, ${input.reason?.trim() || null}, ${correlationId},
        ${JSON.stringify({action, ...(messageId ? {messageId} : {}), ...(action === 'set_priority' ? {priority: input.priority} : {}), ...(t.assignee_id !== newAssignee ? {previousAssigneeId: t.assignee_id} : {})})}::jsonb)`;
    return {id: t.id, ticketNumber: t.ticket_number as string, from: t.status as TicketStatus, to, version, event: d.event, action: action as TicketAction};
  });
}
