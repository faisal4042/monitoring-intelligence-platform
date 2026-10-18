/**
 * X public posts → Ticket Engine (no parallel engine: everything goes through ingestMessage).
 *
 * Rule (approved): every public X post that collection SAVES gets a ticket automatically — no classification,
 * sentiment, AI result, assignee or human step is required. Off unless X_POST_TICKETS_ENABLED, and only for posts
 * saved on or after X_POST_TICKETS_SINCE (no backfill of historical posts, ever).
 *
 * Identity (conversation-identity.ts, family "x_public"): key = X conversation_id (root post) + post author id.
 *   - a standalone post has conversation_id = its own id → its own conversation/ticket;
 *   - the same author replying in that thread → same conversation → attached to the open ticket;
 *   - a different author in the same thread → different customer → separate ticket (never merged on conversation_id alone);
 *   - the same author's new standalone post → new conversation → new ticket;
 *   - no conversation_id → fallback per message (own ticket, flagged for review) — never a guessed merge.
 * Channel (label only): conversation_id ≠ post id → x_reply, otherwise x_mention ("public X post", as Konnect's Mentions).
 * Idempotency: provider 'x' + provider_message_id = X post id (UNIQUE in ticket_messages). The message stores no copy of
 * the text: post_id/post_posted_at point to the saved post, so text, author, classification and program stay in posts.
 * Original publication time (posts.posted_at → ticket_messages.event_at) and collection time (posts.collected_at;
 * ticket_messages.received_at) are kept separately.
 */
import {config} from '@mip/config';
import {sql} from '@mip/db';
import {logger} from '@mip/logger';
import {ingestMessage, type IngestInput, type IngestOutcome} from './ingestion.js';
import {ticketsActivated} from './service.js';

/** The "managed account" part of the key: MIP's public monitoring scope (posts are not addressed to one inbox). */
export const X_PUBLIC_SCOPE = 'x-public-monitoring';

export interface SavedXPost {
  id: string; postedAt: string | Date; collectedAt: string | Date;
  xPostId: string; xAuthorId: string; conversationId: string | null;
  programId: string | null; authorId: string | null; handle?: string | null; displayName?: string | null;
}
export type LinkResult = IngestOutcome | {outcome: 'skipped'; reason: 'disabled' | 'not_activated' | 'before_since' | 'no_author'} | {outcome: 'failed'; error: string};

const iso = (v: string | Date) => new Date(v).toISOString();

/** Start of the linking window, or null when linking is off. Misconfiguration (on without a valid start) stays off. */
export function xPostTicketsSince(): Date | null {
  if (!config.X_POST_TICKETS_ENABLED || !config.X_POST_TICKETS_SINCE) return null;
  const d = new Date(config.X_POST_TICKETS_SINCE);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function xPostTicketInput(p: SavedXPost): IngestInput {
  const root = p.conversationId?.trim() || null;
  const isReply = !!root && root !== p.xPostId;
  return {
    channel: isReply ? 'x_reply' : 'x_mention', provider: 'x', managedAccount: X_PUBLIC_SCOPE,
    providerRootId: root, providerMessageId: p.xPostId,
    customer: {providerCustomerId: p.xAuthorId, authorId: p.authorId, handle: p.handle ?? null, displayName: p.displayName ?? null},
    programId: p.programId, eventAt: iso(p.postedAt), body: null,
    post: {id: p.id, postedAt: iso(p.postedAt)}, correlationId: `x-post:${p.xPostId}`,
  };
}

/** Links one saved post. Idempotent: a second call (re-collection, retry, concurrent delivery) returns `duplicate`. */
export async function linkSavedPost(p: SavedXPost): Promise<LinkResult> {
  const since = xPostTicketsSince();
  if (!since) return {outcome: 'skipped', reason: 'disabled'};
  if (new Date(p.collectedAt).getTime() < since.getTime()) return {outcome: 'skipped', reason: 'before_since'};
  if (!p.xAuthorId) return {outcome: 'skipped', reason: 'no_author'};
  if (!(await ticketsActivated())) return {outcome: 'skipped', reason: 'not_activated'};
  return ingestMessage(xPostTicketInput(p));
}

/** Collection must never fail because of ticketing: errors are logged and healed by the sweep. */
export async function linkSavedPostSafely(p: SavedXPost): Promise<LinkResult> {
  try { return await linkSavedPost(p); } catch (error) {
    logger.warn({err: error, xPostId: p.xPostId, event: 'x_post_ticket_link_failed'}, 'X post ticket link failed; the sweep will retry');
    return {outcome: 'failed', error: error instanceof Error ? error.message : String(error)};
  }
}

/** Loads the saved post (by its partition key) in the shape linkSavedPost needs. */
export async function loadSavedXPost(xPostId: string, postedAt: string | Date): Promise<SavedXPost | null> {
  const [r] = await sql`SELECT p.id, p.posted_at, p.collected_at, p.x_post_id, p.x_author_id, p.conversation_id, p.author_id,
      a.username, a.display_name, coalesce(pc.program_id, q.program_id) AS program_id
    FROM posts p LEFT JOIN authors a ON a.id = p.author_id LEFT JOIN queries q ON q.id = p.query_id
    LEFT JOIN LATERAL (SELECT c.program_id FROM post_classifications c WHERE c.post_id = p.id AND c.posted_at = p.posted_at ORDER BY c.stage DESC LIMIT 1) pc ON true
    WHERE p.x_post_id = ${xPostId} AND p.posted_at = ${iso(postedAt)}::timestamptz`;
  return r ? toSaved(r) : null;
}
const toSaved = (r: Record<string, any>): SavedXPost => ({id: r.id, postedAt: r.posted_at, collectedAt: r.collected_at, xPostId: r.x_post_id,
  xAuthorId: r.x_author_id, conversationId: r.conversation_id, programId: r.program_id, authorId: r.author_id, handle: r.username, displayName: r.display_name});

/**
 * Retry path: links posts saved inside the window that have no ticket message yet (a crash or error between saving the
 * post and linking it). Oldest first, bounded. Never looks before X_POST_TICKETS_SINCE.
 */
export async function sweepUnlinkedXPosts(limit = 200) {
  const since = xPostTicketsSince();
  const out = {scanned: 0, created: 0, attached: 0, late_review: 0, duplicate: 0, failed: 0, skipped: 0};
  if (!since || !(await ticketsActivated())) return out;
  // Eligibility is collection time only: even an older publication saved for the first time in the window must heal.
  const rows = await sql`SELECT p.id, p.posted_at, p.collected_at, p.x_post_id, p.x_author_id, p.conversation_id, p.author_id,
      a.username, a.display_name, coalesce(pc.program_id, q.program_id) AS program_id
    FROM posts p LEFT JOIN authors a ON a.id = p.author_id LEFT JOIN queries q ON q.id = p.query_id
    LEFT JOIN LATERAL (SELECT c.program_id FROM post_classifications c WHERE c.post_id = p.id AND c.posted_at = p.posted_at ORDER BY c.stage DESC LIMIT 1) pc ON true
    WHERE p.collected_at >= ${since.toISOString()}::timestamptz
      AND NOT EXISTS (SELECT 1 FROM ticket_messages m WHERE m.provider = 'x' AND m.provider_message_id = p.x_post_id)
    ORDER BY p.posted_at, p.id LIMIT ${limit}`;
  for (const r of rows) {
    out.scanned++;
    const res = await linkSavedPostSafely(toSaved(r));
    if (res.outcome === 'skipped') out.skipped++; else out[res.outcome]++;
  }
  return out;
}
