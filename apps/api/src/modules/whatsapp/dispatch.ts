/**
 * WhatsApp dispatch: who receives an event, the outbox of messages, and the
 * sender that drains it.
 *
 * Guarantees
 *  - One message per (event, recipient): idempotency_key is UNIQUE.
 *  - Only opted-in, active recipients who are active platform users; an employee's
 *    own opt-out of an optional alert is honoured; mandatory alerts are not optional.
 *  - Only templates approved by Meta are used (checked when queuing and again when sending).
 *  - A message is never sent twice: a send whose outcome is unknown (timeout after the
 *    request left, crash mid-send) becomes 'failed/uncertain' and is not retried automatically.
 *  - Paused channel: messages wait; anything older than the retention window is cancelled,
 *    never sent late. Disabled channel: nothing is detected, queued or sent.
 *  - Limits per minute/day/month are counted on messages Meta accepted.
 */
import { sql } from '@mip/db';
import { whatsappEvent, WHATSAPP_TEST_EVENT } from '@mip/shared';
import { decryptJson } from '../../lib/crypto.js';
import { isRetryable, type ClassifiedError } from './errors.js';
import { createMetaClient, type MetaClient } from './meta-client.js';
import { backoffSeconds, buildParams, idempotencyKey } from './policy.js';
import { credentialsFrom, recordIntegrationError, type SettingsRow } from './settings.js';
import type { DetectedEvent } from './detect.js';

interface RouteRow { audience: string; role_key: string | null; program_id: string | null; recipient_id: string | null }
interface TemplateRow { id: string; name: string; language: string; variables: string[]; meta_status: string; is_active: boolean }

/** The approved template configured for an event type, or null. */
export async function approvedTemplateFor(eventType: string): Promise<TemplateRow | null> {
  const [t] = await sql<TemplateRow[]>`
    SELECT t.id, t.name, t.language, t.variables, t.meta_status, t.is_active
    FROM whatsapp_event_settings es JOIN whatsapp_templates t ON t.id = es.template_id
    WHERE es.event_type = ${eventType} AND t.meta_status = 'approved' AND t.is_active`;
  return t ?? null;
}

/**
 * Recipient ids for an event: the configured routes, or the event's default audience when none exist.
 * Always intersected with "opted in, active, user active, not opted out of this optional alert".
 */
export async function resolveRecipients(e: Pick<DetectedEvent, 'eventType' | 'programId' | 'assigneeId'>): Promise<string[]> {
  const def = whatsappEvent(e.eventType);
  let routes: RouteRow[] = [...await sql<RouteRow[]>`SELECT audience, role_key, program_id, recipient_id FROM whatsapp_routes WHERE event_type = ${e.eventType} AND is_active`];
  if (!routes.length && def) {
    routes = [{ audience: def.defaultAudience, role_key: def.defaultAudience === 'role' ? 'admin' : null, program_id: null, recipient_id: null }];
  }
  const ids = new Set<string>();
  for (const r of routes) {
    // A route scoped to a program only applies to that program's events.
    if (r.program_id && r.audience !== 'program_team' && e.programId !== r.program_id) continue;
    let rows: Array<{ id: string }> = [];
    if (r.audience === 'assignee') {
      if (!e.assigneeId) continue;
      rows = await sql`SELECT id FROM whatsapp_recipients WHERE user_id = ${e.assigneeId}::uuid`;
    } else if (r.audience === 'supervisors') {
      rows = await sql`
        SELECT DISTINCT wr.id FROM whatsapp_recipients wr
        WHERE wr.is_supervisor
           OR (${e.programId}::uuid IS NOT NULL AND EXISTS (
                SELECT 1 FROM team_members tm JOIN team_programs tp ON tp.team_id = tm.team_id
                WHERE tm.user_id = wr.user_id AND tm.kind = 'supervisor' AND tm.left_at IS NULL AND tp.program_id = ${e.programId}::uuid))`;
    } else if (r.audience === 'role') {
      rows = await sql`SELECT wr.id FROM whatsapp_recipients wr JOIN users u ON u.id = wr.user_id JOIN roles ro ON ro.id = u.role_id WHERE ro.key = ${r.role_key}`;
    } else if (r.audience === 'program_team') {
      const program = r.program_id ?? e.programId;
      if (!program || (r.program_id && e.programId && r.program_id !== e.programId)) continue;
      rows = await sql`
        SELECT DISTINCT wr.id FROM whatsapp_recipients wr JOIN team_members tm ON tm.user_id = wr.user_id AND tm.left_at IS NULL
        JOIN team_programs tp ON tp.team_id = tm.team_id WHERE tp.program_id = ${program}::uuid`;
    } else if (r.audience === 'recipient' && r.recipient_id) {
      rows = [{ id: r.recipient_id }];
    }
    rows.forEach((x) => ids.add(x.id));
  }
  if (!ids.size) return [];
  const optional = def?.optional ?? true;
  const eligible = await sql<{ id: string }[]>`
    SELECT wr.id FROM whatsapp_recipients wr JOIN users u ON u.id = wr.user_id
    WHERE wr.id = ANY(${[...ids]}::uuid[]) AND wr.is_active AND wr.opt_in_status = 'opted_in'
      AND u.is_active AND u.deleted_at IS NULL
      AND (${!optional}::boolean OR NOT EXISTS (
        SELECT 1 FROM whatsapp_recipient_subscriptions s WHERE s.recipient_id = wr.id AND s.event_type = ${e.eventType} AND NOT s.enabled))`;
  return eligible.map((x) => x.id);
}

/** Queues one message per eligible recipient. Returns how many were newly queued. */
export async function enqueueEvent(e: DetectedEvent & { id: string }, s: SettingsRow): Promise<{ queued: number; skipped?: string }> {
  const template = await approvedTemplateFor(e.eventType);
  if (!template) return { queued: 0, skipped: 'no_approved_template' };
  const recipients = await resolveRecipients(e);
  const params = buildParams(template.variables, e.values);
  let queued = 0;
  for (const rid of recipients) {
    const rows = await sql`
      INSERT INTO whatsapp_messages (event_id, event_type, recipient_id, template_id, template_name, template_language, program_id,
                                     variables, idempotency_key, expires_at)
      VALUES (${e.id}::uuid, ${e.eventType}, ${rid}::uuid, ${template.id}::uuid, ${template.name}, ${template.language}, ${e.programId}::uuid,
              ${params}, ${idempotencyKey(e.dedupeKey, rid)}, now() + (${s.retention_minutes} || ' minutes')::interval)
      ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`;
    queued += rows.length;
  }
  return { queued };
}

/** Test message to one recipient (never part of alert history; still subject to every send rule). */
export async function enqueueTest(recipientId: string, templateId: string, values: Record<string, string>, s: SettingsRow, actorId: string) {
  const [t] = await sql<TemplateRow[]>`SELECT id, name, language, variables, meta_status, is_active FROM whatsapp_templates WHERE id = ${templateId}::uuid`;
  if (!t) return { error: 'القالب غير موجود' };
  if (t.meta_status !== 'approved' || !t.is_active) return { error: 'لا يُرسل إلا قالب معتمد من Meta ومفعّل' };
  const [r] = await sql<{ id: string; opt_in_status: string; is_active: boolean }[]>`SELECT id, opt_in_status, is_active FROM whatsapp_recipients WHERE id = ${recipientId}::uuid`;
  if (!r) return { error: 'المستلم غير موجود' };
  if (!r.is_active || r.opt_in_status !== 'opted_in') return { error: 'لا يُرسل إلا لمستلم نشط سجّل موافقته على الاستقبال' };
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO whatsapp_messages (event_type, recipient_id, template_id, template_name, template_language, variables, idempotency_key, expires_at, is_test)
    VALUES (${WHATSAPP_TEST_EVENT}, ${r.id}::uuid, ${t.id}::uuid, ${t.name}, ${t.language}, ${buildParams(t.variables, values)},
            ${`test:${actorId}:${Date.now()}`}, now() + (${s.retention_minutes} || ' minutes')::interval, true)
    RETURNING id`;
  return { id: row.id };
}

interface Claimed {
  id: string; recipient_id: string; template_id: string | null; template_name: string; template_language: string; variables: string[];
  attempts: number; phone_encrypted: string; opt_in_status: string; recipient_active: boolean; user_active: boolean;
  template_status: string | null; template_active: boolean | null; event_type: string; is_test: boolean;
}

/** Remaining sends allowed by the per-minute, daily and monthly limits (counted on accepted messages, Riyadh calendar). */
export async function remainingCapacity(s: SettingsRow): Promise<number> {
  const [c] = await sql<{ minute: number; day: number; month: number }[]>`
    SELECT count(*) FILTER (WHERE accepted_at > now() - interval '1 minute')::int AS minute,
           count(*) FILTER (WHERE accepted_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh')::int AS day,
           count(*) FILTER (WHERE accepted_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh')::int AS month
    FROM whatsapp_messages WHERE accepted_at > now() - interval '32 days'`;
  const left = [s.max_per_minute - c.minute];
  if (s.daily_limit !== null) left.push(s.daily_limit - c.day);
  if (s.monthly_limit !== null) left.push(s.monthly_limit - c.month);
  return Math.max(0, Math.min(...left));
}

/** Housekeeping before each send pass: expire stale messages and recover crashed sends. */
export async function housekeeping(): Promise<{ expired: number; uncertain: number; requeued: number }> {
  const expired = await sql`
    UPDATE whatsapp_messages SET status = 'cancelled', cancelled_at = now(), updated_at = now(),
           error_class = 'policy', last_error_code = 'expired', last_error_message = 'انتهت صلاحية الإشعار قبل إرساله فلم يُرسل متأخرًا'
    WHERE status = 'queued' AND expires_at <= now() RETURNING id`;
  // A lock that ran out with an attempt still in flight: the process died mid-send. Meta may have the
  // message, so it is marked uncertain and NOT resent.
  const uncertain = await sql`
    UPDATE whatsapp_messages m SET status = 'failed', failed_at = now(), updated_at = now(), locked_until = NULL,
           error_class = 'uncertain', last_error_code = 'interrupted', last_error_message = 'توقفت المعالجة أثناء الإرسال؛ لم يُعد الإرسال تجنبًا للتكرار'
    WHERE m.status = 'processing' AND m.locked_until < now()
      AND EXISTS (SELECT 1 FROM whatsapp_message_attempts a WHERE a.message_id = m.id AND a.outcome = 'in_flight') RETURNING m.id`;
  await sql`UPDATE whatsapp_message_attempts SET outcome = 'uncertain', finished_at = now()
            WHERE outcome = 'in_flight' AND message_id = ANY(${uncertain.map((r) => r.id)}::bigint[])`;
  const requeued = await sql`
    UPDATE whatsapp_messages SET status = 'queued', locked_until = NULL, updated_at = now()
    WHERE status = 'processing' AND locked_until < now() RETURNING id`;
  return { expired: expired.length, uncertain: uncertain.length, requeued: requeued.length };
}

async function finishFailure(m: Claimed, err: ClassifiedError, s: SettingsRow, attemptId: string) {
  await sql`UPDATE whatsapp_message_attempts SET outcome = ${err.class}, finished_at = now(), http_status = ${err.httpStatus ?? null},
            error_code = ${err.code}, error_message = ${err.message} WHERE id = ${attemptId}::bigint`;
  const attempts = m.attempts + 1;
  if (isRetryable(err.class) && attempts < s.max_attempts) {
    const wait = Math.max(backoffSeconds(attempts, s.backoff_base_seconds, s.backoff_max_seconds), err.retryAfterSeconds ?? 0);
    await sql`UPDATE whatsapp_messages SET status = 'queued', locked_until = NULL, next_attempt_at = now() + (${wait} || ' seconds')::interval,
              error_class = ${err.class}, last_error_code = ${err.code}, last_error_message = ${err.message}, updated_at = now() WHERE id = ${m.id}::bigint`;
  } else {
    await sql`UPDATE whatsapp_messages SET status = 'failed', failed_at = now(), locked_until = NULL,
              error_class = ${err.class}, last_error_code = ${err.code}, last_error_message = ${err.message}, updated_at = now() WHERE id = ${m.id}::bigint`;
  }
}

async function cancel(id: string, code: string, message: string) {
  await sql`UPDATE whatsapp_messages SET status = 'cancelled', cancelled_at = now(), locked_until = NULL, error_class = 'policy',
            last_error_code = ${code}, last_error_message = ${message}, updated_at = now() WHERE id = ${id}::bigint`;
}

/**
 * Sends due messages. Stops early on a rate limit or a configuration error (no point hammering Meta).
 * The client is injectable so tests run against a mock Graph API.
 */
export async function sendDue(s: SettingsRow, opts: { client?: MetaClient; batch?: number } = {}) {
  const result = { sent: 0, failed: 0, retried: 0, cancelled: 0, stoppedBy: null as null | string };
  if (!s.enabled || s.paused) { result.stoppedBy = s.enabled ? 'paused' : 'disabled'; return result; }
  const cred = credentialsFrom(s);
  if (!cred) { result.stoppedBy = 'not_configured'; return result; }
  const capacity = Math.min(await remainingCapacity(s), opts.batch ?? 50);
  if (capacity <= 0) { result.stoppedBy = 'limit'; return result; }
  const client = opts.client ?? createMetaClient(cred);

  const claimed = await sql<Claimed[]>`
    WITH due AS (
      SELECT id FROM whatsapp_messages WHERE status = 'queued' AND next_attempt_at <= now() AND expires_at > now()
      ORDER BY next_attempt_at, id LIMIT ${capacity} FOR UPDATE SKIP LOCKED)
    UPDATE whatsapp_messages m SET status = 'processing', locked_until = now() + interval '2 minutes', updated_at = now()
    FROM due WHERE m.id = due.id
    RETURNING m.id, m.recipient_id, m.template_id, m.template_name, m.template_language, m.variables, m.attempts, m.event_type, m.is_test,
      (SELECT phone_encrypted FROM whatsapp_recipients r WHERE r.id = m.recipient_id) AS phone_encrypted,
      (SELECT opt_in_status FROM whatsapp_recipients r WHERE r.id = m.recipient_id) AS opt_in_status,
      (SELECT is_active FROM whatsapp_recipients r WHERE r.id = m.recipient_id) AS recipient_active,
      (SELECT u.is_active AND u.deleted_at IS NULL FROM whatsapp_recipients r JOIN users u ON u.id = r.user_id WHERE r.id = m.recipient_id) AS user_active,
      (SELECT meta_status FROM whatsapp_templates t WHERE t.id = m.template_id) AS template_status,
      (SELECT is_active FROM whatsapp_templates t WHERE t.id = m.template_id) AS template_active`;

  for (let i = 0; i < claimed.length; i++) {
    const m = claimed[i];
    // Re-check consent and template at send time: either may have changed since queuing.
    if (m.opt_in_status !== 'opted_in' || !m.recipient_active || !m.user_active) {
      await cancel(m.id, 'recipient_ineligible', 'المستلم لم يعد مؤهلًا (موافقة أو حالة الحساب)'); result.cancelled++; continue;
    }
    if (m.template_status !== 'approved' || !m.template_active) {
      await cancel(m.id, 'template_not_approved', 'القالب لم يعد معتمدًا أو مفعّلًا'); result.cancelled++; continue;
    }
    const [attempt] = await sql<{ id: string }[]>`
      INSERT INTO whatsapp_message_attempts (message_id, attempt_no) VALUES (${m.id}::bigint, ${m.attempts + 1}) RETURNING id`;
    await sql`UPDATE whatsapp_messages SET attempts = attempts + 1 WHERE id = ${m.id}::bigint`;
    const to = decryptJson<{ v: string }>(m.phone_encrypted).v;
    const r = await client.sendTemplate({ to, templateName: m.template_name, language: m.template_language, bodyParams: m.variables });
    if (r.ok) {
      await sql`UPDATE whatsapp_message_attempts SET outcome = 'accepted', finished_at = now(), http_status = 200, meta_message_id = ${r.data.messageId} WHERE id = ${attempt.id}::bigint`;
      await sql`UPDATE whatsapp_messages SET status = 'accepted', accepted_at = now(), meta_message_id = ${r.data.messageId}, locked_until = NULL,
                error_class = NULL, last_error_code = NULL, last_error_message = NULL, updated_at = now() WHERE id = ${m.id}::bigint`;
      result.sent++;
      continue;
    }
    await finishFailure(m, r.error, s, attempt.id);
    if (isRetryable(r.error.class) && m.attempts + 1 < s.max_attempts) result.retried++; else result.failed++;
    if (r.error.class === 'rate_limited' || r.error.class === 'config') {
      if (r.error.class === 'config') await recordIntegrationError(r.error.code, r.error.message);
      // Release the rest of the batch untouched (no attempt counted against them).
      const rest = claimed.slice(i + 1).map((x) => x.id);
      if (rest.length) await sql`UPDATE whatsapp_messages SET status = 'queued', locked_until = NULL, updated_at = now() WHERE id = ANY(${rest}::bigint[])`;
      result.stoppedBy = r.error.class;
      break;
    }
  }
  return result;
}
