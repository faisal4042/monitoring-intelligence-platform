/**
 * Processing of Meta webhook notifications (already signature-verified by the route).
 *  - statuses[]: move messages forward (sent → delivered → read, or failed), once per (message, status).
 *  - messages[]: an opt-out word from a registered recipient opts them out and cancels their queue.
 *    Inbound text is never stored.
 */
import { sql } from '@mip/db';
import { WHATSAPP_STATUSES, type WhatsAppStatus } from '@mip/shared';
import { lookupHash } from '../../lib/crypto.js';
import { canTransition, isOptOutText } from './policy.js';

interface StatusUpdate {
  id?: string; status?: string; timestamp?: string; recipient_id?: string;
  errors?: Array<{ code?: number; title?: string; message?: string }>;
}
interface InboundMessage { from?: string; id?: string; type?: string; text?: { body?: string }; button?: { text?: string } }
export interface WebhookPayload {
  object?: string;
  entry?: Array<{ id?: string; changes?: Array<{ field?: string; value?: { metadata?: { phone_number_id?: string }; statuses?: StatusUpdate[]; messages?: InboundMessage[] } }> }>;
}

const STATUS_COLUMN: Partial<Record<WhatsAppStatus, string>> = { sent: 'sent_at', delivered: 'delivered_at', read: 'read_at', failed: 'failed_at' };
export const phoneHash = (e164: string) => lookupHash('whatsapp-phone', e164);

export async function processWebhook(payload: WebhookPayload, expectedPhoneNumberId: string | null) {
  const result = { statuses: 0, applied: 0, optOuts: 0, ignored: 0 };
  if (payload.object !== 'whatsapp_business_account') return result;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages' || !change.value) { result.ignored++; continue; }
      // Another number on the same app is not ours to process.
      if (expectedPhoneNumberId && change.value.metadata?.phone_number_id !== expectedPhoneNumberId) { result.ignored++; continue; }
      for (const st of change.value.statuses ?? []) {
        result.statuses++;
        if (await applyStatus(st)) result.applied++;
      }
      for (const msg of change.value.messages ?? []) {
        const text = msg.type === 'button' ? msg.button?.text : msg.text?.body;
        if (msg.from && isOptOutText(text) && (await optOutByPhone(`+${msg.from.replace(/^\+/, '')}`))) result.optOuts++;
      }
    }
  }
  if (result.statuses || result.optOuts) await sql`UPDATE whatsapp_settings SET last_webhook_at = now() WHERE id`;
  return result;
}

async function applyStatus(st: StatusUpdate): Promise<boolean> {
  if (!st.id || !st.status || !(WHATSAPP_STATUSES as readonly string[]).includes(st.status)) return false;
  const next = st.status as WhatsAppStatus;
  if (!STATUS_COLUMN[next]) return false;
  const at = st.timestamp && /^\d+$/.test(st.timestamp) ? new Date(Number(st.timestamp) * 1000) : new Date();
  const err = st.errors?.[0];
  // Idempotent: the same (message, status) webhook delivered twice is applied once.
  const fresh = await sql`
    INSERT INTO whatsapp_status_events (meta_message_id, status, occurred_at, error_code)
    VALUES (${st.id}, ${next}, ${at.toISOString()}::timestamptz, ${err?.code !== undefined ? String(err.code) : null})
    ON CONFLICT (meta_message_id, status) DO NOTHING RETURNING meta_message_id`;
  if (!fresh.length) return false;
  const [m] = await sql<{ id: string; status: WhatsAppStatus }[]>`SELECT id, status FROM whatsapp_messages WHERE meta_message_id = ${st.id}`;
  if (!m || !canTransition(m.status, next)) return false;
  const col = STATUS_COLUMN[next]!;
  if (next === 'failed') {
    await sql`UPDATE whatsapp_messages SET status = 'failed', failed_at = ${at.toISOString()}::timestamptz, error_class = 'permanent',
              last_error_code = ${err?.code !== undefined ? String(err.code) : 'delivery_failed'},
              last_error_message = ${(err?.title ?? err?.message ?? 'أبلغت Meta بفشل التسليم').slice(0, 500)}, updated_at = now()
              WHERE id = ${m.id}::bigint`;
  } else {
    await sql`UPDATE whatsapp_messages SET status = ${next}, ${sql(col)} = ${at.toISOString()}::timestamptz, updated_at = now() WHERE id = ${m.id}::bigint`;
  }
  return true;
}

/** Opts a recipient out by number and cancels everything still queued for them. */
export async function optOutByPhone(e164: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE whatsapp_recipients SET opt_in_status = 'opted_out', opted_out_at = now(), opt_out_source = 'webhook', updated_at = now()
    WHERE phone_hash = ${phoneHash(e164)} AND opt_in_status <> 'opted_out' RETURNING id`;
  if (!rows.length) return false;
  await sql`UPDATE whatsapp_messages SET status = 'cancelled', cancelled_at = now(), error_class = 'policy', last_error_code = 'opted_out',
            last_error_message = 'ألغى المستلم اشتراكه', updated_at = now() WHERE recipient_id = ${rows[0].id}::uuid AND status = 'queued'`;
  return true;
}
