/**
 * Unified ticketing (migration 0051): every monitored item becomes a numbered ticket, and every open ticket is
 * worked as exactly one queue card. Two bounded, idempotent passes run from the queue intake loop:
 *
 *  1. ticketizeSources — the items not yet ticketed, oldest first ACROSS sources (so numbers follow time):
 *       X     every relevant post (classification relevance='relevant'), one ticket per X conversation and author;
 *       news  every accepted article (the news page's own rule: is_relevant and score ≥ 90);
 *       YouTube every program-matched or team-confirmed video, and every comment on those videos.
 *     Each goes through ingestMessage (one engine; idempotent on provider + provider message id).
 *  2. attachCards — every open ticket without a card gets one (an existing card of the same post is reused),
 *     and every story card without a ticket gets one. Linking fires the 0051 trigger, so the ticket immediately
 *     mirrors the card (e.g. a card already assigned or completed).
 *
 * Nothing here calls an external provider; it reads what collection already stored.
 */
import {sql, type Transaction} from '@mip/db';
import {logger} from '@mip/logger';
import {ingestMessage, type IngestInput} from './ingestion.js';
import {xPostTicketInput} from './x-post-link.js';
import {queueLinksActive, ticketsActivated} from './service.js';
import {authoredByInfluencer, storyUnitOf} from '../queue/sections.js';

export type SourceKind = 'x' | 'news' | 'youtube_video' | 'youtube_comment';
const RELEVANT_VIDEO = sql`coalesce(vp.review_status, vp.suggested_status) IN ('matched','confirmed')`;
/** Snapshot text is plain: feed descriptions can carry HTML (Google News wraps the headline in a link). */
const plain = (v: unknown) => String(v ?? '').replace(/<[^>]*>/g, ' ').replace(/^(?:[a-z][a-z0-9]*(?:\s+[a-z-]+=[^<>]*)?)?>/i, ' ').replace(/<[^>]*$/, ' ').replace(/\S{60,}/g, ' ').replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) =>
  ({amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' '} as Record<string, string>)[e]).replace(/\s+/g, ' ').trim();
const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

/** True once 0047 and 0051 are applied (tickets and the ticket ↔ card links). */
export const unifiedTicketsActive = async () => (await ticketsActivated()) && (await queueLinksActive());

/** The next items with no ticket yet, oldest first across every source. */
export async function pendingSourceItems(limit: number) {
  return sql<{kind: SourceKind; ref: string; posted_at: string | null; event_at: Date}[]>`
    SELECT * FROM (
      SELECT 'x' AS kind, p.x_post_id AS ref, p.posted_at::text AS posted_at, p.posted_at AS event_at
      FROM posts p JOIN post_classifications c ON c.post_id = p.id AND c.posted_at = p.posted_at
      WHERE c.relevance = 'relevant' AND p.x_author_id IS NOT NULL AND NOT p.is_redacted
        AND p.status NOT IN ('duplicate','filtered_out') AND p.duplicate_of_id IS NULL AND p.duplicate_type IS NULL
        AND NOT EXISTS (SELECT 1 FROM ticket_messages m WHERE m.provider = 'x' AND m.provider_message_id = p.x_post_id)
      UNION ALL
      SELECT 'news', n.id::text, NULL, coalesce(n.published_at, n.discovered_at)
      FROM news_articles n
      WHERE n.is_relevant IS TRUE AND n.relevance_score >= 90 AND n.program_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM ticket_messages m WHERE m.provider = 'news' AND m.provider_message_id = n.id::text)
      UNION ALL
      SELECT 'youtube_video', v.id::text, NULL, v.published_at
      FROM youtube_videos v
      WHERE v.status = 'active' AND EXISTS (SELECT 1 FROM youtube_video_programs vp WHERE vp.video_id = v.id AND ${RELEVANT_VIDEO})
        AND NOT EXISTS (SELECT 1 FROM ticket_messages m WHERE m.provider = 'youtube' AND m.provider_message_id = 'video:' || v.youtube_video_id)
      UNION ALL
      SELECT 'youtube_comment', c.youtube_comment_id, NULL, c.published_at
      FROM youtube_comments c JOIN youtube_videos v ON v.id = c.video_id AND v.status = 'active'
      WHERE c.status = 'active' AND EXISTS (SELECT 1 FROM youtube_video_programs vp WHERE vp.video_id = v.id AND ${RELEVANT_VIDEO})
        AND NOT EXISTS (SELECT 1 FROM ticket_messages m WHERE m.provider = 'youtube' AND m.provider_message_id = c.youtube_comment_id)
    ) pending ORDER BY event_at, kind, ref LIMIT ${limit}`;
}

/** The ingestion input for one pending item, or null when its source vanished meanwhile. */
export async function sourceInput(kind: SourceKind, ref: string, postedAt: string | null): Promise<IngestInput | null> {
  if (kind === 'x') {
    const [r] = await sql`SELECT p.id, p.posted_at, p.collected_at, p.x_post_id, p.x_author_id, p.conversation_id, p.author_id,
        a.username, a.display_name, c.program_id
      FROM posts p LEFT JOIN authors a ON a.id = p.author_id
      JOIN post_classifications c ON c.post_id = p.id AND c.posted_at = p.posted_at
      WHERE p.x_post_id = ${ref} AND p.posted_at = ${postedAt}::timestamptz`;
    if (!r) return null;
    return xPostTicketInput({id: r.id, postedAt: r.posted_at, collectedAt: r.collected_at, xPostId: r.x_post_id, xAuthorId: r.x_author_id,
      conversationId: r.conversation_id, programId: r.program_id, authorId: r.author_id, handle: r.username, displayName: r.display_name});
  }
  if (kind === 'news') {
    const [n] = await sql`SELECT n.id, n.title, n.url, n.program_id, coalesce(n.published_at, n.discovered_at) AS event_at, s.id AS source_id, s.name_ar
      FROM news_articles n JOIN news_sources s ON s.id = n.source_id WHERE n.id = ${ref}::uuid`;
    if (!n) return null;
    return {channel: 'news_article', provider: 'news', managedAccount: 'news-monitoring', providerRootId: n.id, providerMessageId: n.id,
      customer: {providerCustomerId: n.source_id, displayName: n.name_ar}, programId: n.program_id, eventAt: new Date(n.event_at).toISOString(),
      body: `${n.title}\n${n.url}`.slice(0, 20000), correlationId: `news:${n.id}`};
  }
  if (kind === 'youtube_video') {
    const [v] = await sql`SELECT v.youtube_video_id, v.youtube_channel_id, v.channel_title, v.title, v.published_at, p.id AS program_id
      FROM youtube_videos v JOIN LATERAL (SELECT vp.program_key FROM youtube_video_programs vp WHERE vp.video_id = v.id AND ${RELEVANT_VIDEO}
        ORDER BY (vp.review_status = 'confirmed') DESC NULLS LAST, vp.created_at LIMIT 1) vp ON true
      JOIN programs p ON p.key = vp.program_key WHERE v.id = ${ref}::uuid`;
    if (!v) return null;
    return {channel: 'youtube_video', provider: 'youtube', managedAccount: 'youtube-monitoring', providerRootId: v.youtube_video_id,
      providerMessageId: `video:${v.youtube_video_id}`, customer: {providerCustomerId: v.youtube_channel_id, displayName: v.channel_title},
      programId: v.program_id, eventAt: new Date(v.published_at).toISOString(),
      body: `${v.title ?? ''}\n${watchUrl(v.youtube_video_id)}`.slice(0, 20000), correlationId: `youtube-video:${v.youtube_video_id}`};
  }
  const [c] = await sql`SELECT c.youtube_comment_id, c.thread_id, c.author_channel_id, c.author_display_name, c.text_display, c.published_at,
      v.youtube_video_id, p.id AS program_id
    FROM youtube_comments c JOIN youtube_videos v ON v.id = c.video_id
    JOIN LATERAL (SELECT vp.program_key FROM youtube_video_programs vp WHERE vp.video_id = v.id AND ${RELEVANT_VIDEO}
      ORDER BY (vp.review_status = 'confirmed') DESC NULLS LAST, vp.created_at LIMIT 1) vp ON true
    JOIN programs p ON p.key = vp.program_key WHERE c.youtube_comment_id = ${ref}`;
  if (!c) return null;
  return {channel: 'youtube_comment', provider: 'youtube', managedAccount: `youtube-video:${c.youtube_video_id}`, providerRootId: c.thread_id,
    providerMessageId: c.youtube_comment_id,
    // A comment without an author channel id cannot be tied to a person: it stands alone (fallback, flagged for review).
    customer: {providerCustomerId: c.author_channel_id ?? `unknown-author:${c.youtube_comment_id}`, displayName: c.author_display_name},
    programId: c.program_id, eventAt: new Date(c.published_at).toISOString(), body: (c.text_display ?? '').slice(0, 20000),
    correlationId: `youtube-comment:${c.youtube_comment_id}`};
}

export async function ticketizeSources(limit = 300) {
  const out = {scanned: 0, created: 0, attached: 0, late_review: 0, duplicate: 0, skipped: 0, failed: 0};
  if (!(await unifiedTicketsActive())) return out;
  for (const item of await pendingSourceItems(limit)) {
    out.scanned++;
    try {
      const input = await sourceInput(item.kind, item.ref, item.posted_at);
      if (!input) { out.skipped++; continue; }
      out[(await ingestMessage(input)).outcome]++;
    } catch (error) {
      out.failed++;
      logger.warn({err: error, kind: item.kind, ref: item.ref, event: 'unified_ticket_failed'}, 'unified ticket ingestion failed; next pass retries');
    }
  }
  return out;
}

const programSnapshot = sql`jsonb_build_object('id',pr.id,'key',pr.key,'name',pr.name_ar,'color',pr.color)`;
/** The active team that owns a programme (first by name when several do). */
const teamOf = (programId: unknown) => sql`(SELECT tp.team_id FROM team_programs tp JOIN teams tm ON tm.id = tp.team_id AND tm.is_active
  WHERE tp.program_id = ${programId as string}::uuid ORDER BY tm.name, tm.id LIMIT 1)`;

/** Card for one open ticket: reuse the card of its post if one exists, else create the card of its source kind. */
async function cardFor(ticket: {id: string; program_id: string | null; channel: string}) {
  return sql.begin(async (tx) => {
    const [m] = await tx`SELECT provider, provider_message_id, post_id, post_posted_at FROM ticket_messages WHERE ticket_id = ${ticket.id}
      ORDER BY event_at, id LIMIT 1`;
    if (!m || !ticket.program_id) return null;
    let itemId: string | null = null;
    if (m.post_id) {
      const [existing] = await tx`SELECT q.id FROM ticket_messages tm JOIN queue_items q ON q.interaction_type = 'post' AND q.post_id = tm.post_id
        WHERE tm.ticket_id = ${ticket.id} AND q.merged_into_id IS NULL AND NOT EXISTS (SELECT 1 FROM queue_item_tickets l WHERE l.queue_item_id = q.id)
        ORDER BY (q.status <> 'new') DESC, q.entered_at, q.id LIMIT 1`;
      itemId = existing?.id ?? null;
      if (!itemId) {
        const [created] = await tx`INSERT INTO queue_items (post_id, post_posted_at, program_id, program_snapshot, team_id, section, story_item_id)
          SELECT p.id, p.posted_at, pr.id, ${programSnapshot}, t.id,
            CASE WHEN ${storyUnitOf} IS NOT NULL THEN 'story' WHEN ${authoredByInfluencer} THEN 'influencer' ELSE 'general' END, ${storyUnitOf}
          FROM posts p JOIN programs pr ON pr.id = ${ticket.program_id}::uuid JOIN teams t ON t.id = ${teamOf(ticket.program_id)}
          WHERE p.id = ${m.post_id} AND p.posted_at = ${m.post_posted_at}
          ON CONFLICT (post_id) WHERE interaction_type = 'post' DO NOTHING RETURNING id`;
        itemId = created?.id ?? null;
      }
    } else {
      const source = await snapshotOf(tx, ticket.channel, m.provider_message_id);
      if (!source) return null;
      const [created] = await tx`INSERT INTO queue_items (interaction_type, program_id, program_snapshot, team_id, section, source_ref, source_snapshot)
        SELECT ${source.kind}, pr.id, ${programSnapshot}, t.id, 'general', ${source.ref}, ${JSON.stringify(source.snapshot)}::jsonb
        FROM programs pr JOIN teams t ON t.id = ${teamOf(ticket.program_id)} WHERE pr.id = ${ticket.program_id}::uuid
        ON CONFLICT (interaction_type, source_ref) WHERE source_ref IS NOT NULL DO NOTHING RETURNING id`;
      itemId = created?.id ?? null;
    }
    if (!itemId) return null;
    const [fresh] = await tx`SELECT version FROM queue_items WHERE id = ${itemId}`;
    if (fresh.version === 1) await tx`INSERT INTO queue_events (queue_item_id, event_type, to_status, version)
      SELECT ${itemId}, 'created', 'new', 1 WHERE NOT EXISTS (SELECT 1 FROM queue_events WHERE queue_item_id = ${itemId} AND event_type = 'created')`;
    await tx`INSERT INTO queue_item_tickets (ticket_id, queue_item_id) VALUES (${ticket.id}, ${itemId}) ON CONFLICT DO NOTHING`;
    return itemId;
  });
}

/** What a news/YouTube card shows; kept on the card so it survives retention of the source row. */
async function snapshotOf(tx: Transaction, channel: string, messageId: string) {
  if (channel === 'news_article') {
    const [n] = await tx`SELECT n.id, n.title, n.url, n.description, n.published_at, n.discovered_at, s.name_ar AS source_name
      FROM news_articles n JOIN news_sources s ON s.id = n.source_id WHERE n.id = ${messageId}::uuid`;
    return n ? {kind: 'news', ref: n.id as string, snapshot: {title: plain(n.title), url: n.url, description: plain(n.description).slice(0, 600) || null,
      sourceName: n.source_name, publishedAt: n.published_at ?? n.discovered_at}} : null;
  }
  if (channel === 'youtube_video') {
    const [v] = await tx`SELECT v.id, v.youtube_video_id, v.youtube_channel_id, v.channel_title, v.title, v.description, v.published_at, v.duration_seconds
      FROM youtube_videos v WHERE v.youtube_video_id = ${messageId.replace(/^video:/, '')}`;
    return v ? {kind: 'youtube_video', ref: v.id as string, snapshot: {title: v.title, url: watchUrl(v.youtube_video_id), videoId: v.youtube_video_id,
      channelTitle: v.channel_title, channelUrl: `https://www.youtube.com/channel/${v.youtube_channel_id}`, description: plain(v.description).slice(0, 600) || null,
      publishedAt: v.published_at, durationSeconds: v.duration_seconds}} : null;
  }
  if (channel === 'youtube_comment') {
    const [c] = await tx`SELECT c.youtube_comment_id, c.author_display_name, c.author_channel_id, c.text_display, c.published_at, c.parent_comment_id,
        v.youtube_video_id, v.title AS video_title
      FROM youtube_comments c JOIN youtube_videos v ON v.id = c.video_id WHERE c.youtube_comment_id = ${messageId}`;
    return c ? {kind: 'youtube_comment', ref: c.youtube_comment_id as string, snapshot: {title: c.video_title, text: c.text_display?.slice(0, 4000) ?? '',
      author: c.author_display_name, url: `${watchUrl(c.youtube_video_id)}&lc=${encodeURIComponent(c.youtube_comment_id)}`, videoId: c.youtube_video_id,
      isReply: !!c.parent_comment_id, publishedAt: c.published_at}} : null;
  }
  return null;
}

/** One ticket per story card, created when the card has none. */
async function storyTicket(card: {id: string; story_id: string; program_id: string; story_snapshot: Record<string, any> | null; entered_at: Date}) {
  const title = String(card.story_snapshot?.title ?? 'قصة');
  const res = await ingestMessage({channel: 'x_story', provider: 'other', managedAccount: 'stories', providerRootId: card.story_id,
    providerMessageId: `story:${card.story_id}`, customer: {providerCustomerId: `story:${card.story_id}`, displayName: title},
    programId: card.program_id, eventAt: new Date(card.story_snapshot?.firstSeenAt ?? card.entered_at).toISOString(),
    body: title.slice(0, 20000), correlationId: `story:${card.story_id}`});
  await sql`INSERT INTO queue_item_tickets (ticket_id, queue_item_id) VALUES (${res.ticketId}, ${card.id}) ON CONFLICT DO NOTHING`;
}

const RANK = sql`CASE WHEN q.status IN ('assigned','in_progress','escalated') THEN 2 WHEN q.status = 'completed' THEN 1 ELSE 0 END`;

/**
 * One card per ticket. A post card with no ticket (an older card, or one a supervisor added by hand):
 *  - its post has no ticket yet → the post is ticketed and the card becomes that ticket's card when it has none;
 *  - its ticket already has a card → the two are merged: the card someone is working (else the older) keeps the
 *    ticket, the other is merged into it (hidden like a merged story card) with a 'ticket_merged' event.
 */
export async function consolidateCards(limit = 200) {
  const out = {ticketed: 0, linked: 0, merged: 0, failed: 0};
  if (!(await unifiedTicketsActive())) return out;
  const loose = await sql<{id: string; post_id: string; x_post_id: string; posted_at: string}[]>`
    SELECT q.id, q.post_id, p.x_post_id, p.posted_at::text AS posted_at FROM queue_items q JOIN posts p ON p.id = q.post_id AND p.posted_at = q.post_posted_at
    WHERE q.interaction_type = 'post' AND q.merged_into_id IS NULL AND NOT EXISTS (SELECT 1 FROM queue_item_tickets l WHERE l.queue_item_id = q.id)
    ORDER BY q.entered_at, q.id LIMIT ${limit}`;
  for (const card of loose) {
    try {
      let [t] = await sql`SELECT m.ticket_id FROM ticket_messages m WHERE m.provider = 'x' AND m.provider_message_id = ${card.x_post_id}`;
      if (!t) {
        const input = await sourceInput('x', card.x_post_id, card.posted_at);
        if (!input) continue;
        t = {ticket_id: (await ingestMessage(input)).ticketId}; out.ticketed++;
      }
      const action = await sql.begin(async (tx) => {
        const [link] = await tx`SELECT queue_item_id FROM queue_item_tickets WHERE ticket_id = ${t.ticket_id} FOR UPDATE`;
        if (!link) {
          await tx`INSERT INTO queue_item_tickets (ticket_id, queue_item_id) VALUES (${t.ticket_id}, ${card.id}) ON CONFLICT DO NOTHING`;
          return 'linked';
        }
        const [keeper] = await tx`SELECT q.id FROM queue_items q WHERE q.id IN (${link.queue_item_id}, ${card.id})
          ORDER BY ${RANK} DESC, q.entered_at, q.id LIMIT 1`;
        const mergedId = keeper.id === card.id ? link.queue_item_id : card.id;
        if (keeper.id === card.id) await tx`UPDATE queue_item_tickets SET queue_item_id = ${card.id} WHERE ticket_id = ${t.ticket_id}`;
        const [m] = await tx<{version: number; status: string}[]>`UPDATE queue_items SET merged_into_id = ${keeper.id}, version = version + 1,
          updated_at = clock_timestamp() WHERE id = ${mergedId} AND merged_into_id IS NULL RETURNING version, status`;
        if (m) await tx`INSERT INTO queue_events (queue_item_id, event_type, from_status, to_status, version, metadata)
          VALUES (${mergedId}, 'ticket_merged', ${m.status}, ${m.status}, ${m.version}, ${JSON.stringify({into: keeper.id, ticketId: t.ticket_id})}::jsonb)`;
        return 'merged';
      });
      out[action]++;
    } catch (error) {
      out.failed++; logger.warn({err: error, queueItemId: card.id, event: 'unified_card_consolidate_failed'}, 'card consolidation failed; next pass retries');
    }
  }
  return out;
}

export async function attachCards(limit = 300) {
  const out = {cards: 0, linked: 0, stories: 0, failed: 0};
  if (!(await unifiedTicketsActive())) return out;
  const open = await sql<{id: string; program_id: string | null; channel: string}[]>`SELECT t.id, t.program_id, t.channel FROM tickets t
    WHERE t.status <> 'closed' AND NOT EXISTS (SELECT 1 FROM queue_item_tickets l WHERE l.ticket_id = t.id)
    ORDER BY t.ticket_number::bigint LIMIT ${limit}`;
  for (const t of open) {
    try { if (await cardFor(t)) out.linked++; } catch (error) {
      out.failed++; logger.warn({err: error, ticketId: t.id, event: 'unified_card_failed'}, 'card for ticket failed; next pass retries');
    }
  }
  const stories = await sql<{id: string; story_id: string; program_id: string; story_snapshot: Record<string, any> | null; entered_at: Date}[]>`
    SELECT q.id, q.story_id, q.program_id, q.story_snapshot, q.entered_at FROM queue_items q
    WHERE q.interaction_type = 'story' AND q.merged_into_id IS NULL AND NOT EXISTS (SELECT 1 FROM queue_item_tickets l WHERE l.queue_item_id = q.id)
    ORDER BY q.entered_at, q.id LIMIT ${limit}`;
  for (const s of stories) {
    try { await storyTicket(s); out.stories++; } catch (error) {
      out.failed++; logger.warn({err: error, queueItemId: s.id, event: 'unified_story_ticket_failed'}, 'story ticket failed; next pass retries');
    }
  }
  out.cards = out.linked + out.stories;
  return out;
}
