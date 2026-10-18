/**
 * Collection lanes. Every request goes through the gateway; every lane records a youtube_collection_runs row.
 * Idempotency: UNIQUE YouTube ids + ON CONFLICT DO UPDATE (collected_at keeps the first sighting).
 * No AI, no sentiment, no derived metrics: only original YouTube fields and statistics are stored.
 */
import type {YouTubeSql} from '@mip/db/src/youtube-test-client.js';
import {isShortCandidate, parseIsoDuration, type EndpointName} from './endpoints.js';
import type {CallResult, YouTubeGateway} from './gateway.js';
import type {Params} from './transport.js';
import {linkVideoProgram} from './relevance.js';

export type Lane = 'discovery' | 'channels' | 'comments' | 'stats' | 'retention';
export interface RunSummary { runId: string; lane: Lane; status: string; calls: number; itemsNew: number; itemsUpdated: number; error?: string }

/** Overlap for search windows: date-ordered search can lag indexing (search.list docs). */
export const SEARCH_OVERLAP_MS = 6 * 3_600_000;
export const INITIAL_SEARCH_WINDOW_MS = 7 * 86_400_000;
const MAX_PLAYLIST_PAGES = 2, MAX_COMMENT_PAGES = 3, MAX_REPLY_PAGES = 2;

export class Run {
  calls = 0; itemsNew = 0; itemsUpdated = 0; problem: string | null = null; denied = false;
  private constructor(readonly sql: YouTubeSql, readonly id: string, readonly lane: Lane) {}
  static async start(sql: YouTubeSql, lane: Lane, target: string | null, mode: string) {
    const [r] = await sql<{id: string}[]>`INSERT INTO youtube_collection_runs (lane, target, mode) VALUES (${lane}, ${target}, ${mode}) RETURNING id`;
    return new Run(sql, r.id, lane);
  }
  /** Calls the gateway; returns the body or null (and remembers why the run could not continue). */
  async call(gw: YouTubeGateway, endpoint: EndpointName, params: Params): Promise<CallResult> {
    const res = await gw.call(endpoint, params, this.id);
    this.calls++;
    if (!res.ok) { this.problem ??= res.kind === 'error' ? `${res.errorClass}:${res.reason}` : `${res.kind}:${res.reason}`; if (res.kind !== 'error') this.denied = true; }
    return res;
  }
  async finish(): Promise<RunSummary> {
    const status = this.problem ? (this.denied && !this.itemsNew && !this.itemsUpdated ? 'denied' : (this.itemsNew || this.itemsUpdated) ? 'partial' : 'failed') : 'succeeded';
    await this.sql`UPDATE youtube_collection_runs SET finished_at = now(), status = ${status}, calls = ${this.calls},
      units = (SELECT coalesce(sum(units), 0) FROM youtube_api_calls WHERE run_id = ${this.id}),
      items_new = ${this.itemsNew}, items_updated = ${this.itemsUpdated},
      error_code = ${this.problem?.split(':')[0] ?? null}, error_message = ${this.problem} WHERE id = ${this.id}`;
    return {runId: this.id, lane: this.lane, status, calls: this.calls, itemsNew: this.itemsNew, itemsUpdated: this.itemsUpdated, ...(this.problem ? {error: this.problem} : {})};
  }
}

// ── Storage ───────────────────────────────────────────────────────────────────────────────
async function upsertVideos(sql: YouTubeSql, run: Run, items: any[], via: 'search' | 'channel', queryId: string | null) {
  for (const v of items) {
    const sn = v.snippet ?? {}, secs = parseIsoDuration(v.contentDetails?.duration);
    const live = ['none', 'upcoming', 'live', 'completed'].includes(sn.liveBroadcastContent) ? sn.liveBroadcastContent : null;
    const [row] = await sql<{id: string; inserted: boolean}[]>`
      INSERT INTO youtube_videos (youtube_video_id, youtube_channel_id, channel_title, title, description, published_at, duration_seconds,
        short_candidate, live_state, discovered_via, first_search_query_id)
      VALUES (${v.id}, ${sn.channelId}, ${sn.channelTitle ?? null}, ${sn.title ?? null}, ${(sn.description ?? '').slice(0, 5000)},
        ${sn.publishedAt}, ${secs}, ${isShortCandidate(secs)}, ${live}, ${[via]}, ${queryId})
      ON CONFLICT (youtube_video_id) DO UPDATE SET channel_title = EXCLUDED.channel_title, title = EXCLUDED.title,
        description = EXCLUDED.description, duration_seconds = EXCLUDED.duration_seconds, short_candidate = EXCLUDED.short_candidate,
        live_state = EXCLUDED.live_state, status = 'active', purged_at = NULL, api_refreshed_at = now(),
        discovered_via = (SELECT array_agg(DISTINCT x) FROM unnest(youtube_videos.discovered_via || EXCLUDED.discovered_via) x),
        first_search_query_id = coalesce(youtube_videos.first_search_query_id, EXCLUDED.first_search_query_id)
      RETURNING id, (xmax = 0) AS inserted`;
    if (row.inserted) run.itemsNew++; else run.itemsUpdated++;
    if(queryId)await linkVideoProgram(sql,row.id,queryId,sn.title??'',sn.description??'');
    else if(via==='channel'){const [channel]=await sql`SELECT program_key FROM youtube_channels WHERE youtube_channel_id=${sn.channelId}`;if(channel?.program_key)await linkVideoProgram(sql,row.id,null,sn.title??'',sn.description??'',channel.program_key);}
    const st = v.statistics;
    if (st) await sql`INSERT INTO youtube_video_stats (video_id, view_count, like_count, comment_count)
      VALUES (${row.id}, ${st.viewCount ?? null}, ${st.likeCount ?? null}, ${st.commentCount ?? null}) ON CONFLICT DO NOTHING`;
  }
}

async function upsertComment(sql: YouTubeSql, run: Run, videoRowId: string, threadId: string, c: any) {
  const sn = c.snippet ?? {};
  const [row] = await sql<{inserted: boolean}[]>`
    INSERT INTO youtube_comments (youtube_comment_id, video_id, thread_id, parent_comment_id, author_channel_id, author_display_name,
      text_display, like_count, published_at, yt_updated_at)
    VALUES (${c.id}, ${videoRowId}, ${threadId}, ${sn.parentId ?? null}, ${sn.authorChannelId?.value ?? null}, ${sn.authorDisplayName ?? null},
      ${(sn.textDisplay ?? '').slice(0, 10000)}, ${sn.likeCount ?? null}, ${sn.publishedAt}, ${sn.updatedAt ?? null})
    ON CONFLICT (youtube_comment_id) DO UPDATE SET text_display = EXCLUDED.text_display, author_display_name = EXCLUDED.author_display_name,
      like_count = EXCLUDED.like_count, yt_updated_at = EXCLUDED.yt_updated_at, status = 'active', purged_at = NULL, api_refreshed_at = now()
    RETURNING (xmax = 0) AS inserted`;
  if (row.inserted) run.itemsNew++; else run.itemsUpdated++;
}

/** videos.list for up to 50 ids per call. */
async function fetchVideos(gw: YouTubeGateway, run: Run, ids: string[]): Promise<any[] | null> {
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const res = await run.call(gw, 'videos.list', {part: 'snippet,contentDetails,statistics,status', id: ids.slice(i, i + 50).join(',')});
    if (!res.ok) return out.length ? out : null;
    if (res.dryRun) return out;
    out.push(...(res.body?.items ?? []));
  }
  return out;
}

// ── Lane A: keyword discovery ────────────────────────────────────────────────────────────
export async function runDiscovery(sql: YouTubeSql, gw: YouTubeGateway, queryId: string, now = new Date(), options: {publishedAfter?: Date; maxResults?: number; advanceWatermark?: boolean} = {}): Promise<RunSummary> {
  const [q] = await sql<any[]>`SELECT * FROM youtube_search_queries WHERE id = ${queryId} AND is_active`;
  if (!q) throw new Error('search query not found or inactive');
  const run = await Run.start(sql, 'discovery', q.name, gw.mode);
  const persistent=options.advanceWatermark!==false;
  const after = options.publishedAfter ?? (q.pending_after?new Date(q.pending_after):q.published_after_watermark ? new Date(new Date(q.published_after_watermark).getTime() - SEARCH_OVERLAP_MS) : new Date(now.getTime() - 30*86_400_000));
  const before=persistent&&q.pending_before?new Date(q.pending_before):now;
  if(persistent)await sql`UPDATE youtube_search_queries SET last_attempt_at=${now.toISOString()}::timestamptz WHERE id=${q.id}`;
  const ids = new Set<string>();
  let token: string | undefined=persistent?q.pending_page_token??undefined:undefined, pages = 0, complete = true;
  do {
    const res = await run.call(gw, 'search.list', {part: 'snippet', type: 'video', q: q.q, regionCode: q.region_code, relevanceLanguage: q.relevance_language,
      order: 'date', maxResults: options.maxResults ?? 50, publishedAfter: after.toISOString(), publishedBefore: before.toISOString(),
      videoDuration: q.video_duration === 'any' ? undefined : q.video_duration, pageToken: token});
    pages++;
    if (!res.ok) { complete = false; break; }
    if (res.dryRun) { complete = false; break; }
    for (const it of res.body?.items ?? []) if (it?.id?.videoId) ids.add(it.id.videoId);
    token = res.body?.nextPageToken;
  } while (token && pages < q.max_pages_per_run);
  const hasMore=!!token;
  if (ids.size) {
    const videos = await fetchVideos(gw, run, [...ids]);
    if (videos) await upsertVideos(sql, run, videos, 'search', q.id);
    if (!videos || videos.length < ids.size) complete = false;
  }
  // The watermark advances only when every page and the metadata fetch succeeded (otherwise the next run re-covers it).
  if (complete && !run.problem && persistent){
   if(hasMore)await sql`UPDATE youtube_search_queries SET pending_page_token=${token!},pending_after=${after.toISOString()}::timestamptz,pending_before=${before.toISOString()}::timestamptz WHERE id=${q.id}`;
   else await sql`UPDATE youtube_search_queries SET published_after_watermark = ${before.toISOString()}::timestamptz,pending_page_token=NULL,pending_after=NULL,pending_before=NULL WHERE id = ${q.id}`;
  }
  return run.finish();
}

// ── Lane B: channel monitoring ───────────────────────────────────────────────────────────
export async function runChannel(sql: YouTubeSql, gw: YouTubeGateway, channelRowId: string): Promise<RunSummary> {
  const [ch] = await sql<any[]>`SELECT * FROM youtube_channels WHERE id = ${channelRowId} AND is_active`;
  if (!ch) throw new Error('channel not found or inactive');
  const run = await Run.start(sql, 'channels', ch.youtube_channel_id, gw.mode);
  let uploads: string | null = ch.uploads_playlist_id;
  if (!uploads) {
    const res = await run.call(gw, 'channels.list', {part: 'snippet,contentDetails', id: ch.youtube_channel_id});
    if (res.ok && !res.dryRun) {
      const item = res.body?.items?.[0];
      if (!item) { await sql`UPDATE youtube_channels SET status = 'not_found' WHERE id = ${ch.id}`; run.problem = 'not_found:channel'; return run.finish(); }
      uploads = item.contentDetails?.relatedPlaylists?.uploads ?? null;
      await sql`UPDATE youtube_channels SET uploads_playlist_id = ${uploads}, title = ${item.snippet?.title ?? null}, api_refreshed_at = now() WHERE id = ${ch.id}`;
    }
    if (!res.ok || res.dryRun || !uploads) return finishChannel(sql, run, ch.id);
  }
  const watermark: Date | null = ch.last_seen_published_at ? new Date(ch.last_seen_published_at) : null;
  const fresh: string[] = []; let newest = watermark, token: string | undefined, pages = 0, reachedOld = false;
  do {
    const res = await run.call(gw, 'playlistItems.list', {part: 'snippet,contentDetails', playlistId: uploads, maxResults: 50, pageToken: token});
    pages++;
    if (!res.ok || res.dryRun) break;
    for (const it of res.body?.items ?? []) {
      const id = it.contentDetails?.videoId ?? it.snippet?.resourceId?.videoId, at = new Date(it.contentDetails?.videoPublishedAt ?? it.snippet?.publishedAt);
      if (!id) continue;
      if (watermark && at <= watermark) { reachedOld = true; continue; }
      fresh.push(id);
      if (!newest || at > newest) newest = at;
    }
    token = res.body?.nextPageToken;
  } while (token && !reachedOld && pages < MAX_PLAYLIST_PAGES);
  if (fresh.length) {
    const videos = await fetchVideos(gw, run, fresh);
    if (videos) await upsertVideos(sql, run, videos, 'channel', null);
  }
  if (!run.problem && newest) await sql`UPDATE youtube_channels SET last_seen_published_at = ${newest.toISOString()}::timestamptz WHERE id = ${ch.id}`;
  return finishChannel(sql, run, ch.id);
}
async function finishChannel(sql: YouTubeSql, run: Run, id: string) {
  if (run.problem && !run.denied) await sql`UPDATE youtube_channels SET consecutive_failures = consecutive_failures + 1 WHERE id = ${id}`;
  else if (!run.problem) await sql`UPDATE youtube_channels SET consecutive_failures = 0, last_success_at = now() WHERE id = ${id}`;
  return run.finish();
}

// ── Comments and replies ─────────────────────────────────────────────────────────────────
export async function runComments(sql: YouTubeSql, gw: YouTubeGateway, videoRowId: string): Promise<RunSummary> {
  const [v] = await sql<any[]>`SELECT id, youtube_video_id, comments_state, comments_newest_published_at FROM youtube_videos WHERE id = ${videoRowId} AND status = 'active'`;
  if (!v) throw new Error('video not found or not active');
  const run = await Run.start(sql, 'comments', v.youtube_video_id, gw.mode);
  if (v.comments_state === 'disabled') { run.problem = 'comments_disabled:skipped'; return run.finish(); }
  const watermark: Date | null = v.comments_newest_published_at ? new Date(v.comments_newest_published_at) : null;
  let newest = watermark, token: string | undefined, pages = 0, reachedOld = false;
  const needReplies: Array<{threadId: string; total: number}> = [];
  do {
    const res = await run.call(gw, 'commentThreads.list', {part: 'snippet,replies', videoId: v.youtube_video_id, order: 'time',
      maxResults: 100, textFormat: 'plainText', pageToken: token});
    pages++;
    if (!res.ok) {
      if (res.kind === 'error' && res.errorClass === 'comments_disabled') await sql`UPDATE youtube_videos SET comments_state = 'disabled' WHERE id = ${v.id}`;
      break;
    }
    if (res.dryRun) break;
    for (const t of res.body?.items ?? []) {
      const top = t.snippet?.topLevelComment, at = new Date(top?.snippet?.publishedAt);
      if (!top) continue;
      if (watermark && at <= watermark && !(t.snippet?.totalReplyCount > 0)) { reachedOld = true; continue; }
      await upsertComment(sql, run, v.id, t.id, top);
      await sql`UPDATE youtube_comments SET total_reply_count = ${t.snippet?.totalReplyCount ?? 0} WHERE youtube_comment_id = ${top.id}`;
      const included = t.replies?.comments ?? [];
      for (const r of included) await upsertComment(sql, run, v.id, t.id, r);
      // `replies` may be a subset (commentThreads resource docs): fetch the rest with comments.list?parentId=.
      if ((t.snippet?.totalReplyCount ?? 0) > included.length) needReplies.push({threadId: t.id, total: t.snippet.totalReplyCount});
      if (!newest || at > newest) newest = at;
      if (watermark && at <= watermark) reachedOld = true;
    }
    token = res.body?.nextPageToken;
  } while (token && !reachedOld && pages < MAX_COMMENT_PAGES);
  for (const n of needReplies) {
    let rt: string | undefined, rp = 0;
    do {
      const res = await run.call(gw, 'comments.list', {part: 'snippet', parentId: n.threadId, maxResults: 100, textFormat: 'plainText', pageToken: rt});
      rp++;
      if (!res.ok || res.dryRun) break;
      for (const r of res.body?.items ?? []) await upsertComment(sql, run, v.id, n.threadId, r);
      rt = res.body?.nextPageToken;
    } while (rt && rp < MAX_REPLY_PAGES);
    if (run.problem) break;
  }
  if (!run.problem) await sql`UPDATE youtube_videos SET comments_state = 'tracking', comments_newest_published_at = ${newest?.toISOString() ?? null}::timestamptz WHERE id = ${v.id}`;
  return run.finish();
}

// ── Original statistics refresh (separate Google bucket) ─────────────────────────────────
export async function runStats(sql: YouTubeSql, gw: YouTubeGateway, limit = 50): Promise<RunSummary> {
  const run = await Run.start(sql, 'stats', null, gw.mode);
  const vids = await sql<{id: string; youtube_video_id: string}[]>`
    SELECT id, youtube_video_id FROM youtube_videos WHERE status = 'active' ORDER BY published_at DESC LIMIT ${Math.min(limit, 500)}`;
  for (let i = 0; i < vids.length; i += 50) {
    const chunk = vids.slice(i, i + 50);
    const res = await run.call(gw, 'videos.list', {part: 'statistics', id: chunk.map(v => v.youtube_video_id).join(',')});
    if (!res.ok || res.dryRun) break;
    for (const it of res.body?.items ?? []) {
      const row = chunk.find(v => v.youtube_video_id === it.id), st = it.statistics;
      if (!row || !st) continue;
      await sql`INSERT INTO youtube_video_stats (video_id, view_count, like_count, comment_count)
        VALUES (${row.id}, ${st.viewCount ?? null}, ${st.likeCount ?? null}, ${st.commentCount ?? null}) ON CONFLICT DO NOTHING`;
      run.itemsUpdated++;
    }
  }
  return run.finish();
}
