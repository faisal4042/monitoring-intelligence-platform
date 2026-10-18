/**
 * Message → ticket ingestion. One transaction per message:
 *   1. upsert the customer identity (provider + provider customer id; never by name);
 *   2. upsert the conversation by its key with ON CONFLICT DO UPDATE — the row lock serializes every
 *      ingestion of the same conversation until COMMIT (different conversations run in parallel);
 *   3. idempotency under that lock: (provider, provider_message_id) already stored → return it, no new ticket;
 *   4. active ticket (status <> 'closed') → attach; otherwise
 *        late message (event_at <= closed_at of the latest closed ticket) → stored on that closed ticket as
 *        `late_review`, ticket flagged for review, NOT reopened, no new ticket;
 *        else → a NEW ticket (closed tickets are never reused or reopened by messaging).
 * Backstops in PostgreSQL: UNIQUE (provider, provider_message_id) and the partial unique index
 * "one non-closed ticket per conversation". A 23505 from a redelivery that raced through a different
 * conversation key is re-read as a duplicate. 40001/40P01 are retried (bounded).
 * Exactly-once delivery from an external provider is NOT claimed: redelivery is absorbed, loss upstream is not detectable here.
 */
import {randomUUID} from 'node:crypto';
import {sql, type Transaction} from '@mip/db';
import {workerCheckpoint} from '../../startup/worker-ownership.js';
import {conversationKey, type Channel, type ConversationInput} from './conversation-identity.js';
import {statusAfterCustomerMessage, type TicketStatus} from './state-machine.js';

export interface IngestInput extends Omit<ConversationInput, 'customerId'> {
  customer: { providerCustomerId: string; displayName?: string | null; handle?: string | null; authorId?: string | null };
  programId?: string | null;
  teamId?: string | null;
  direction?: 'inbound' | 'outbound';
  eventAt: string;                       // provider event time (ISO)
  body?: string | null;                  // only for channels whose content is not already stored in posts
  post?: { id: string; postedAt: string } | null;
  correlationId?: string;
}
export type IngestOutcome =
  | { outcome: 'created'; ticketId: string; ticketNumber: string; messageId: string; review: boolean }
  | { outcome: 'attached'; ticketId: string; ticketNumber: string; messageId: string; status: TicketStatus }
  | { outcome: 'late_review'; ticketId: string; ticketNumber: string; messageId: string }
  | { outcome: 'duplicate'; ticketId: string; ticketNumber: string; messageId: string };

/** Visible number: a plain running number starting at 1 (migration 0051), never reused. */
export function formatTicketNumber(seq: bigint | number | string) {
  const n = BigInt(seq);
  if (n < 1n) throw new Error('ticket sequence must be positive');
  return n.toString();
}

async function existing(tx: Transaction | typeof sql, provider: string, providerMessageId: string) {
  const [row] = await tx`SELECT m.id, m.ticket_id, t.ticket_number FROM ticket_messages m JOIN tickets t ON t.id = m.ticket_id
    WHERE m.provider = ${provider} AND m.provider_message_id = ${providerMessageId}`;
  return row as { id: string; ticket_id: string; ticket_number: string } | undefined;
}

export async function ingestMessage(input: IngestInput, attempt = 0): Promise<IngestOutcome> {
  if (!input.providerMessageId?.trim()) throw new Error('providerMessageId is required');
  const eventAt = new Date(input.eventAt);
  if (Number.isNaN(eventAt.getTime())) throw new Error('eventAt must be a valid timestamp');
  const correlationId = input.correlationId ?? randomUUID();
  const conv = conversationKey({...input, customerId: input.customer.providerCustomerId});
  const direction = input.direction ?? 'inbound';
  await workerCheckpoint();
  try {
    return await sql.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '5s'`;
      const [customer] = await tx`
        INSERT INTO customer_identities (provider, provider_customer_id, author_id, display_name, handle, first_seen_at, last_seen_at)
        VALUES (${input.provider}, ${input.customer.providerCustomerId}, ${input.customer.authorId ?? null}::uuid,
                ${input.customer.displayName ?? null}, ${input.customer.handle ?? null}, ${eventAt.toISOString()}, ${eventAt.toISOString()})
        ON CONFLICT (provider, provider_customer_id) DO UPDATE SET
          last_seen_at = GREATEST(customer_identities.last_seen_at, EXCLUDED.last_seen_at),
          display_name = COALESCE(EXCLUDED.display_name, customer_identities.display_name),
          handle = COALESCE(EXCLUDED.handle, customer_identities.handle),
          author_id = COALESCE(customer_identities.author_id, EXCLUDED.author_id), updated_at = now()
        RETURNING id`;
      const [conversation] = await tx`
        INSERT INTO conversations (conversation_key, channel, provider, program_id, managed_account, customer_identity_id, provider_thread_id, identity_confidence, last_message_at)
        VALUES (${conv.key}, ${input.channel as Channel}, ${input.provider}, ${input.programId ?? null}::uuid, ${input.managedAccount ?? null},
                ${customer.id}, ${conv.threadId}, ${conv.confidence}, ${eventAt.toISOString()})
        ON CONFLICT (conversation_key) DO UPDATE SET last_message_at = GREATEST(conversations.last_message_at, EXCLUDED.last_message_at)
        RETURNING id, program_id, identity_confidence`;
      // Under the conversation lock: a redelivery of the same message is answered from storage.
      const dup = await existing(tx, input.provider, input.providerMessageId);
      if (dup) return {outcome: 'duplicate', ticketId: dup.ticket_id, ticketNumber: dup.ticket_number, messageId: dup.id} as const;

      const insertMessage = async (ticketId: string, disposition: 'attached' | 'late_review') => {
        const [m] = await tx`
          INSERT INTO ticket_messages (ticket_id, conversation_id, provider, provider_message_id, direction, author_kind, post_id, post_posted_at, body, event_at, disposition, correlation_id)
          VALUES (${ticketId}, ${conversation.id}, ${input.provider}, ${input.providerMessageId}, ${direction}, ${direction === 'inbound' ? 'customer' : 'system'},
                  ${input.post?.id ?? null}::uuid, ${input.post?.postedAt ?? null}::timestamptz, ${input.body ?? null}, ${eventAt.toISOString()}, ${disposition}, ${correlationId})
          RETURNING id`;
        return m.id as string;
      };
      const event = (ticketId: string, version: number, type: string, from: string | null, to: string, payload: object, reason: string | null = null) => tx`
        INSERT INTO ticket_events (ticket_id, version, event_type, from_status, to_status, actor_kind, reason, correlation_id, payload)
        VALUES (${ticketId}, ${version}, ${type}, ${from}, ${to}, 'ingestion', ${reason}, ${correlationId}, ${JSON.stringify(payload)}::jsonb)`;

      const [active] = await tx<{id: string; ticket_number: string; status: TicketStatus; assignee_id: string | null; version: number}[]>`SELECT id, ticket_number, status, assignee_id, version FROM tickets
        WHERE conversation_id = ${conversation.id} AND status <> 'closed' FOR UPDATE`;
      if (active) {
        const messageId = await insertMessage(active.id, 'attached');
        const next = direction === 'inbound' ? statusAfterCustomerMessage(active) : active.status;
        const version = active.version + 1;
        await tx`UPDATE tickets SET status = ${next}, version = ${version}, message_count = message_count + 1,
            customer_message_count = customer_message_count + ${direction === 'inbound' ? 1 : 0},
            last_customer_message_at = CASE WHEN ${direction === 'inbound'} THEN GREATEST(coalesce(last_customer_message_at, ${eventAt.toISOString()}::timestamptz), ${eventAt.toISOString()}::timestamptz) ELSE last_customer_message_at END,
            last_activity_at = GREATEST(last_activity_at, ${eventAt.toISOString()}::timestamptz),
            resolved_at = CASE WHEN ${next} <> 'resolved' THEN NULL ELSE resolved_at END
          WHERE id = ${active.id}`;
        await event(active.id, version, 'message_attached', active.status, next, {messageId, providerMessageId: input.providerMessageId, eventAt: eventAt.toISOString()});
        return {outcome: 'attached', ticketId: active.id, ticketNumber: active.ticket_number, messageId, status: next} as const;
      }

      const [lastClosed] = await tx`SELECT id, ticket_number, version, closed_at FROM tickets
        WHERE conversation_id = ${conversation.id} AND status = 'closed' ORDER BY closed_at DESC LIMIT 1 FOR UPDATE`;
      if (lastClosed && eventAt.getTime() <= new Date(lastClosed.closed_at).getTime()) {
        const messageId = await insertMessage(lastClosed.id, 'late_review');
        const version = lastClosed.version + 1;
        await tx`UPDATE tickets SET version = ${version}, message_count = message_count + 1, customer_message_count = customer_message_count + 1,
            needs_review = true, review_reason = 'late_message' WHERE id = ${lastClosed.id}`;
        await event(lastClosed.id, version, 'late_message', 'closed', 'closed',
          {messageId, providerMessageId: input.providerMessageId, eventAt: eventAt.toISOString(), closedAt: new Date(lastClosed.closed_at).toISOString()},
          'رسالة وقعت قبل الإغلاق ووصلت بعده: تحتاج مراجعة بشرية');
        return {outcome: 'late_review', ticketId: lastClosed.id, ticketNumber: lastClosed.ticket_number, messageId} as const;
      }

      const [{seq}] = await tx`SELECT nextval('ticket_number_seq')::text AS seq`;
      const ticketNumber = formatTicketNumber(seq);
      const review = conversation.identity_confidence === 'fallback_message';
      const [ticket] = await tx`
        INSERT INTO tickets (ticket_number, conversation_id, customer_identity_id, program_id, team_id, channel, opened_at, last_activity_at,
          last_customer_message_at, message_count, customer_message_count, needs_review, review_reason)
        VALUES (${ticketNumber}, ${conversation.id}, ${customer.id}, ${input.programId ?? conversation.program_id ?? null}::uuid, ${input.teamId ?? null}::uuid,
          ${input.channel}, ${eventAt.toISOString()}, ${eventAt.toISOString()}, ${direction === 'inbound' ? eventAt.toISOString() : null},
          1, ${direction === 'inbound' ? 1 : 0}, ${review}, ${review ? 'fallback_identity' : null})
        RETURNING id`;
      await tx`UPDATE conversations SET ticket_count = ticket_count + 1 WHERE id = ${conversation.id}`;
      const messageId = await insertMessage(ticket.id, 'attached');
      await event(ticket.id, 1, 'created', null, 'open', {messageId, providerMessageId: input.providerMessageId, conversationKeyVersion: 1,
        identityConfidence: conversation.identity_confidence, previousTicketId: lastClosed?.id ?? null});
      return {outcome: 'created', ticketId: ticket.id, ticketNumber, messageId, review} as const;
    });
  } catch (error) {
    const code = (error as {code?: string}).code;
    if (code === '23505') {
      const dup = await existing(sql, input.provider, input.providerMessageId);
      if (dup) return {outcome: 'duplicate', ticketId: dup.ticket_id, ticketNumber: dup.ticket_number, messageId: dup.id};
    }
    if ((code === '40001' || code === '40P01' || code === '23505') && attempt < 3) return ingestMessage(input, attempt + 1);
    throw error;
  }
}
