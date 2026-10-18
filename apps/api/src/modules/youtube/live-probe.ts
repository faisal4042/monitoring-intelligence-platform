/**
 * First live YouTube Data API test: exactly ONE search.list request, nothing else.
 * - No videos.list follow-up, no pagination (nextPageToken is reported, never followed), no retries (maxAttempts=1).
 * - Ledger limits for this process: search=1, default=29, batch_stats=0 → hard ceiling 30 units; a second live search
 *   on the same PT day is refused by the quota manager before sending.
 * - Kill switch: resumed only around the single call and paused again in `finally`, even on error.
 * - Run only via run-live-probe.ps1 (decrypts the DPAPI key into this child's environment only) with the
 *   probe-egress-guard preload (sockets: 127.0.0.1:5462 and www.googleapis.com:443 only).
 * Requires YOUTUBE_MODE=live, YOUTUBE_LIVE_APPROVED=1 and YOUTUBE_PROBE_CONFIRMED=1. Prints no key and no URL.
 */
import {openYouTubeTestClient} from '@mip/db/src/youtube-test-client.js';
import {Run} from './collector.js';
import {YouTubeGateway} from './gateway.js';
import {QuotaManager} from './quota.js';
import {assertTestTarget} from './target.js';
import {LiveTransport} from './transport.js';

export const PROBE_QUERY = 'منصة إيجار';
export const PROBE_TOTAL_CEILING = 30;
/** YOUTUBE_PROBE_SEARCH_LIMIT: 1 (default) or 2 (owner-approved retry, 2026-10-16). Total stays ≤ 30 units. */
export function probeLimits(raw = process.env.YOUTUBE_PROBE_SEARCH_LIMIT) {
  const search = raw === undefined ? 1 : Number(raw);
  if (search !== 1 && search !== 2) throw new Error('YOUTUBE_PROBE_SEARCH_LIMIT must be 1 or 2');
  return {default: PROBE_TOTAL_CEILING - search, search, batch_stats: 0};
}
const PROBE_LIMITS = probeLimits();

async function main() {
  const env = process.env;
  if (env.YOUTUBE_MODE !== 'live' || env.YOUTUBE_LIVE_APPROVED !== '1' || env.YOUTUBE_PROBE_CONFIRMED !== '1')
    throw new Error('probe refused: YOUTUBE_MODE=live, YOUTUBE_LIVE_APPROVED=1 and YOUTUBE_PROBE_CONFIRMED=1 are all required');
  if (!env.YOUTUBE_API_KEY) throw new Error('probe refused: key not present in this process');
  const url = env.YOUTUBE_MVP_DATABASE_URL!;
  const sql = openYouTubeTestClient(url, 2);
  const out: Record<string, unknown> = {query: PROBE_QUERY, endpoint: 'search.list', limits: PROBE_LIMITS};
  try {
    await assertTestTarget(sql, url);
    const quota = new QuotaManager(sql, {...PROBE_LIMITS});
    const gw = new YouTubeGateway(sql, quota, {mode: 'live', transport: new LiveTransport(() => process.env.YOUTUBE_API_KEY), liveApproved: true, maxAttempts: 1});
    const before = await gw.controls();
    if (!before.paused) throw new Error('probe refused: kill switch was not paused before the test');
    const run = await Run.start(sql, 'discovery', 'live-probe:search.list', 'live');
    await gw.setPaused(false, 'live probe: one search.list request');
    let res;
    try {
      res = await run.call(gw, 'search.list', {part: 'snippet', type: 'video', q: PROBE_QUERY, regionCode: 'SA', relevanceLanguage: 'ar', maxResults: 10});
    } finally {
      await gw.setPaused(true, 'live probe finished — paused');
    }
    // Print Google's answer before any further database step can fail (no key, no content).
    console.log('LIVE_PROBE_RESULT ' + JSON.stringify(res.ok ? {ok: true, items: res.body?.items?.length ?? 0} : res));
    if (res.ok && !res.dryRun) {
      const items = (res.body?.items ?? []).filter((i: any) => i?.id?.videoId && i?.snippet?.publishedAt);
      for (const i of items) {
        const s = i.snippet;
        const [row] = await sql<{inserted: boolean}[]>`INSERT INTO youtube_videos (youtube_video_id, youtube_channel_id, channel_title, title, description, published_at, discovered_via)
          VALUES (${i.id.videoId}, ${s.channelId}, ${s.channelTitle ?? null}, ${s.title ?? null}, ${(s.description ?? '').slice(0, 5000)}, ${s.publishedAt}, ${['search']})
          ON CONFLICT (youtube_video_id) DO UPDATE SET api_refreshed_at = now() RETURNING (xmax = 0) AS inserted`;
        if (row.inserted) run.itemsNew++; else run.itemsUpdated++;
      }
      Object.assign(out, {ok: true, items: res.body?.items?.length ?? 0, stored: items.length,
        totalResultsApprox: res.body?.pageInfo?.totalResults ?? null, nextPageTokenPresent: !!res.body?.nextPageToken,
        kinds: [...new Set((res.body?.items ?? []).map((i: any) => i?.id?.kind))], regionCode: res.body?.regionCode ?? null,
        videoIds: items.map((i: any) => i.id.videoId)});
    } else Object.assign(out, {ok: false, result: res});
    const summary = await run.finish();
    const [call] = await sql`SELECT endpoint, bucket, units, mode, outcome, http_status, error_reason, latency_ms, attempt
      FROM youtube_api_calls WHERE run_id = ${summary.runId} ORDER BY id`;
    const [{n}] = await sql<{n: number}[]>`SELECT count(*)::int AS n FROM youtube_api_calls WHERE run_id = ${summary.runId} AND outcome <> 'denied'`;
    Object.assign(out, {run: summary, requestsSent: n, call, quota: await quota.status('live'), controls: await gw.controls()});
  } finally {
    await sql.end();
  }
  console.log('LIVE_PROBE ' + JSON.stringify(out));
}

main().catch(e => { console.error('LIVE_PROBE_ERROR ' + String(e?.message ?? e)); process.exit(1); });
