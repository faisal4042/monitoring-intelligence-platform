/**
 * YouTube Developer Policies III.E.4: non-authorized API data must be refreshed or deleted within 30 days, statistics
 * must not be kept longer than 30 days, and stored videos must be re-checked for deletion every 30 days.
 * 1 refresh: rows older than REFRESH_AFTER_DAYS are re-read (videos.list / comments.list by id, 50 per unit);
 *   ids YouTube no longer returns become 'unavailable' and their text is purged at once.
 * 2 purge: anything not refreshed within RETENTION_DAYS loses its text (ids kept for dedup); old stats rows deleted.
 * Purge needs no API call, so it also runs in dry-run, when the switch is paused, or when quota is exhausted.
 */
import type {YouTubeSql} from '@mip/db/src/youtube-test-client.js';
import {Run, type RunSummary} from './collector.js';
import type {YouTubeGateway} from './gateway.js';

export const RETENTION_DAYS_MAX = 30;
export function retentionFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const days = Number(env.YOUTUBE_RETENTION_DAYS ?? RETENTION_DAYS_MAX), refresh = Number(env.YOUTUBE_REFRESH_AFTER_DAYS ?? 25);
  if (!Number.isInteger(days) || days < 1 || days > RETENTION_DAYS_MAX) throw new Error(`YOUTUBE_RETENTION_DAYS must be 1..${RETENTION_DAYS_MAX}`);
  if (!Number.isInteger(refresh) || refresh < 1 || refresh >= days) throw new Error('YOUTUBE_REFRESH_AFTER_DAYS must be ≥1 and below the retention days');
  return {days, refresh};
}

const PURGE_VIDEO = (sql: YouTubeSql) => sql`title = NULL, description = NULL, channel_title = NULL, purged_at = now()`;

export async function runRetention(sql: YouTubeSql, gw: YouTubeGateway, opts: {days: number; refresh: number; now?: Date}): Promise<RunSummary & {purged: Record<string, number>}> {
  const now = opts.now ?? new Date(), refreshBefore = new Date(now.getTime() - opts.refresh * 86_400_000), purgeBefore = new Date(now.getTime() - opts.days * 86_400_000);
  const run = await Run.start(sql, 'retention', null, gw.mode);
  const canRefresh = gw.mode !== 'dry_run' && !(await gw.controls()).paused;

  if (canRefresh) {
    const due = await sql<{youtube_video_id: string}[]>`SELECT youtube_video_id FROM youtube_videos
      WHERE status = 'active' AND api_refreshed_at < ${refreshBefore.toISOString()}::timestamptz AND api_refreshed_at >= ${purgeBefore.toISOString()}::timestamptz ORDER BY api_refreshed_at LIMIT 500`;
    for (let i = 0; i < due.length; i += 50) {
      const ids = due.slice(i, i + 50).map(r => r.youtube_video_id);
      const res = await run.call(gw, 'videos.list', {part: 'snippet,contentDetails,statistics,status', id: ids.join(',')});
      if (!res.ok || res.dryRun) break;
      const back = new Map<string, any>((res.body?.items ?? []).map((v: any) => [v.id, v]));
      for (const id of ids) {
        const v = back.get(id);
        if (v) {
          await sql`UPDATE youtube_videos SET title = ${v.snippet?.title ?? null}, description = ${(v.snippet?.description ?? '').slice(0, 5000)},
            channel_title = ${v.snippet?.channelTitle ?? null}, api_refreshed_at = ${now.toISOString()}::timestamptz WHERE youtube_video_id = ${id}`;
          if (v.statistics) await sql`INSERT INTO youtube_video_stats (video_id, captured_at, view_count, like_count, comment_count)
            SELECT id, ${now.toISOString()}::timestamptz, ${v.statistics.viewCount ?? null}, ${v.statistics.likeCount ?? null}, ${v.statistics.commentCount ?? null}
            FROM youtube_videos WHERE youtube_video_id = ${id} ON CONFLICT DO NOTHING`;
          run.itemsUpdated++;
        } else {
          // Deleted, private or otherwise unavailable: keep only the id.
          await sql`UPDATE youtube_videos SET status = 'unavailable', ${PURGE_VIDEO(sql)} WHERE youtube_video_id = ${id}`;
          await sql`UPDATE youtube_comments SET status = 'unavailable', text_display = NULL, author_display_name = NULL, purged_at = now()
                    WHERE video_id = (SELECT id FROM youtube_videos WHERE youtube_video_id = ${id})`;
          run.itemsUpdated++;
        }
      }
    }
    const dueComments = await sql<{youtube_comment_id: string}[]>`SELECT youtube_comment_id FROM youtube_comments
      WHERE status = 'active' AND api_refreshed_at < ${refreshBefore.toISOString()}::timestamptz AND api_refreshed_at >= ${purgeBefore.toISOString()}::timestamptz ORDER BY api_refreshed_at LIMIT 1000`;
    for (let i = 0; i < dueComments.length && !run.problem; i += 50) {
      const ids = dueComments.slice(i, i + 50).map(r => r.youtube_comment_id);
      const res = await run.call(gw, 'comments.list', {part: 'snippet', id: ids.join(','), textFormat: 'plainText'});
      if (!res.ok || res.dryRun) break;
      const back = new Map<string, any>((res.body?.items ?? []).map((c: any) => [c.id, c]));
      for (const id of ids) {
        const c = back.get(id);
        if (c) await sql`UPDATE youtube_comments SET text_display = ${(c.snippet?.textDisplay ?? '').slice(0, 10000)},
          author_display_name = ${c.snippet?.authorDisplayName ?? null}, like_count = ${c.snippet?.likeCount ?? null}, api_refreshed_at = ${now.toISOString()}::timestamptz
          WHERE youtube_comment_id = ${id}`;
        else await sql`UPDATE youtube_comments SET status = 'unavailable', text_display = NULL, author_display_name = NULL, purged_at = now()
          WHERE youtube_comment_id = ${id}`;
        run.itemsUpdated++;
      }
    }
  }

  // Hard deadline: purge whatever was not refreshed in time. Ids stay (dedup, future ticket references).
  const v = await sql`UPDATE youtube_videos SET status = 'purged', ${PURGE_VIDEO(sql)} WHERE status <> 'purged' AND api_refreshed_at < ${purgeBefore.toISOString()}::timestamptz`;
  const c = await sql`UPDATE youtube_comments SET status = 'purged', text_display = NULL, author_display_name = NULL, purged_at = now()
                      WHERE status <> 'purged' AND api_refreshed_at < ${purgeBefore.toISOString()}::timestamptz`;
  const ch = await sql`UPDATE youtube_channels SET status = 'purged', title = NULL WHERE status <> 'purged' AND api_refreshed_at < ${purgeBefore.toISOString()}::timestamptz`;
  const s = await sql`DELETE FROM youtube_video_stats WHERE captured_at < ${purgeBefore.toISOString()}::timestamptz`;
  const summary = await run.finish();
  return {...summary, purged: {videos: v.count, comments: c.count, channels: ch.count, statsRows: s.count}};
}
