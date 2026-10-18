/**
 * YouTube MVP test server — a SEPARATE process, not part of MIP's backend (app.ts/server.ts are untouched).
 *   node --import tsx src/modules/youtube/server.ts --init     apply schema.sql + marker + seed queries (test DB only)
 *   node --import tsx src/modules/youtube/server.ts            serve on 127.0.0.1:${YOUTUBE_MVP_PORT:-3013}
 * Env: YOUTUBE_MVP_DATABASE_URL (guarded: 127.0.0.1:5462/mip_youtube_test only), YOUTUBE_MODE=mock|dry_run|live (default mock),
 *      YOUTUBE_LIVE_APPROVED=1 (required for live), YOUTUBE_API_KEY (live only; never logged, never returned),
 *      YOUTUBE_DAILY_UNITS_LIMIT=1000, YOUTUBE_DAILY_SEARCH_LIMIT=10, YOUTUBE_DAILY_BATCH_STATS_LIMIT=1000,
 *      YOUTUBE_RETENTION_DAYS=30, YOUTUBE_REFRESH_AFTER_DAYS=25.
 * No scheduler: every run is an explicit POST. The kill switch starts paused.
 */
import {readFileSync} from 'node:fs';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {openYouTubeTestClient, type YouTubeSql} from '@mip/db/src/youtube-test-client.js';
import {runChannel, runComments, runDiscovery, runStats, type Lane} from './collector.js';
import {buildSearchQ} from './endpoints.js';
import {YouTubeGateway} from './gateway.js';
import {limitsFromEnv, QuotaManager, type Mode} from './quota.js';
import {retentionFromEnv, runRetention} from './retention.js';
import {assertTestIdentity, assertTestTarget, YT_MARKER} from './target.js';
import {LiveTransport, MockTransport, type Transport} from './transport.js';

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const ALLOWED_ORIGINS = new Set(['http://127.0.0.1:5183', 'http://localhost:5183']);
const CHANNEL_ID = /^UC[0-9A-Za-z_-]{22}$/;

export interface AppDeps { sql: YouTubeSql; gateway: YouTubeGateway; quota: QuotaManager; retention: {days: number; refresh: number}; keyConfigured: boolean }

export function buildGateway(sql: YouTubeSql, env: NodeJS.ProcessEnv, transportOverride?: Transport) {
  const mode = (env.YOUTUBE_MODE ?? 'mock') as Mode;
  if (!['mock', 'dry_run', 'live'].includes(mode)) throw new Error('YOUTUBE_MODE must be mock, dry_run or live');
  const quota = new QuotaManager(sql, limitsFromEnv(env));
  const transport = transportOverride ?? (mode === 'mock' ? new MockTransport() : mode === 'live' ? new LiveTransport(() => process.env.YOUTUBE_API_KEY) : null);
  const gateway = new YouTubeGateway(sql, quota, {mode, transport, liveApproved: env.YOUTUBE_LIVE_APPROVED === '1'});
  return {gateway, quota};
}

export async function initSchema(sql: YouTubeSql, url: string) {
  await assertTestIdentity(sql, url);
  await sql.unsafe(readFileSync(here('./schema.sql'), 'utf8'));
  await sql`INSERT INTO youtube_test_marker (token) VALUES (${YT_MARKER}) ON CONFLICT DO NOTHING`;
  const seed = JSON.parse(readFileSync(here('./discovery-queries.json'), 'utf8'));
  for (const q of seed.queries) await sql`INSERT INTO youtube_search_queries (program_key, name, q)
    VALUES (${q.program}, ${q.name}, ${buildSearchQ(q.include, q.exclude)}) ON CONFLICT (name) DO UPDATE SET q = EXCLUDED.q`;
  for (const c of seed.channels ?? []) await sql`INSERT INTO youtube_channels (youtube_channel_id, program_key) VALUES (${c.id}, ${c.program ?? null}) ON CONFLICT DO NOTHING`;
}

export function createHandler(d: AppDeps) {
  let busy: string | null = null;
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(body));
  };
  const readBody = (req: http.IncomingMessage) => new Promise<any>((ok, no) => {
    let s = ''; req.on('data', c => { s += c; if (s.length > 10_000) { no(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { no(new Error('invalid JSON')); } });
  });

  async function exclusive<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (busy) throw Object.assign(new Error(`another run is in progress (${busy})`), {status: 409});
    busy = label; try { return await fn(); } finally { busy = null; }
  }

  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname.replace(/^\/yt-api/, '');
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && !ALLOWED_ORIGINS.has(origin)) return json(res, 403, {error: 'origin not allowed'});
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, {error: 'application/json required'});
      }
      const {sql, gateway: gw} = d;

      if (req.method === 'GET' && path === '/status') {
        const [controls, quota, runs, errors, lastLive] = await Promise.all([
          gw.controls(), d.quota.status(gw.mode),
          sql`SELECT id, lane, target, mode, status, calls, units, items_new, items_updated, error_message, started_at, finished_at
              FROM youtube_collection_runs ORDER BY started_at DESC LIMIT 15`,
          sql`SELECT occurred_at, endpoint, mode, outcome, http_status, error_reason, attempt FROM youtube_api_calls
              WHERE outcome IN ('error','denied') ORDER BY occurred_at DESC LIMIT 20`,
          sql`SELECT outcome, http_status, error_reason, occurred_at FROM youtube_api_calls WHERE mode = 'live' AND outcome <> 'denied' ORDER BY occurred_at DESC LIMIT 1`,
        ]);
        const connection = gw.mode !== 'live' ? gw.mode : !lastLive.length ? 'not_tested' : lastLive[0].outcome === 'ok' ? 'ok' : `error:${lastLive[0].error_reason}`;
        return json(res, 200, {mode: gw.mode, keyConfigured: d.keyConfigured, controls, quota, runs, errors, connection, busy,
          retention: d.retention, scheduler: 'disabled', derivedMetrics: 'disabled'});
      }
      if (req.method === 'GET' && path === '/videos') {
        const rows = await sql`SELECT v.id, v.youtube_video_id, v.youtube_channel_id, v.channel_title, v.title, v.published_at, v.duration_seconds,
            v.short_candidate, v.live_state, v.discovered_via, v.status, v.comments_state, v.collected_at, v.api_refreshed_at,
            s.view_count, s.like_count, s.comment_count, s.captured_at AS stats_at,
            (SELECT count(*)::int FROM youtube_comments c WHERE c.video_id = v.id AND NOT c.is_reply) AS stored_threads,
            (SELECT count(*)::int FROM youtube_comments c WHERE c.video_id = v.id AND c.is_reply) AS stored_replies
          FROM youtube_videos v LEFT JOIN LATERAL (SELECT * FROM youtube_video_stats s WHERE s.video_id = v.id ORDER BY captured_at DESC LIMIT 1) s ON true
          ORDER BY v.published_at DESC LIMIT ${Math.min(Number(url.searchParams.get('limit') ?? 100), 500)}`;
        return json(res, 200, {items: rows});
      }
      const commentsMatch = /^\/videos\/([0-9a-f-]{36})\/comments$/.exec(path);
      if (req.method === 'GET' && commentsMatch) {
        const rows = await sql`SELECT youtube_comment_id, thread_id, parent_comment_id, is_reply, author_channel_id, author_display_name, text_display,
            like_count, total_reply_count, published_at, status FROM youtube_comments WHERE video_id = ${commentsMatch[1]}
          ORDER BY thread_id, is_reply, published_at LIMIT 2000`;
        return json(res, 200, {items: rows});
      }
      if (req.method === 'GET' && path === '/channels') return json(res, 200, {items: await sql`SELECT * FROM youtube_channels ORDER BY created_at`});
      if (req.method === 'GET' && path === '/queries') return json(res, 200, {items: await sql`SELECT * FROM youtube_search_queries ORDER BY program_key, name`});

      if (req.method === 'POST' && path === '/controls') {
        const b = await readBody(req);
        if (typeof b.paused !== 'boolean') return json(res, 400, {error: 'paused (boolean) required'});
        await gw.setPaused(b.paused, String(b.reason ?? (b.paused ? 'manual pause' : 'manual resume')));
        return json(res, 200, {controls: await gw.controls()});
      }
      if (req.method === 'POST' && path === '/channels') {
        const b = await readBody(req);
        if (!CHANNEL_ID.test(String(b.youtubeChannelId ?? ''))) return json(res, 400, {error: 'youtubeChannelId must be a UC… channel id'});
        const [row] = await sql`INSERT INTO youtube_channels (youtube_channel_id, program_key) VALUES (${b.youtubeChannelId}, ${b.programKey ?? null})
          ON CONFLICT (youtube_channel_id) DO UPDATE SET is_active = true RETURNING *`;
        return json(res, 200, {channel: row});
      }
      if (req.method === 'POST' && path === '/run') {
        const b = await readBody(req), lane = b.lane as Lane;
        const result = await exclusive(lane, async () => {
          switch (lane) {
            case 'discovery': return runDiscovery(sql, gw, String(b.targetId));
            case 'channels': return runChannel(sql, gw, String(b.targetId));
            case 'comments': return runComments(sql, gw, String(b.targetId));
            case 'stats': return runStats(sql, gw, Number(b.limit ?? 50));
            case 'retention': return runRetention(sql, gw, d.retention);
            default: throw Object.assign(new Error('unknown lane'), {status: 400});
          }
        });
        return json(res, 200, {result});
      }
      return json(res, 404, {error: 'not found'});
    } catch (e: any) {
      return json(res, e?.status ?? 500, {error: String(e?.message ?? e)});
    }
  };
}

async function main() {
  const url = process.env.YOUTUBE_MVP_DATABASE_URL;
  if (!url) throw new Error('YOUTUBE_MVP_DATABASE_URL is required');
  const sql = openYouTubeTestClient(url);
  if (process.argv.includes('--init')) { await initSchema(sql, url); console.log('youtube MVP schema ready'); await sql.end(); return; }
  await assertTestTarget(sql, url);
  const {gateway, quota} = buildGateway(sql, process.env);
  const handler = createHandler({sql, gateway, quota, retention: retentionFromEnv(), keyConfigured: !!process.env.YOUTUBE_API_KEY});
  const port = Number(process.env.YOUTUBE_MVP_PORT ?? 3013);
  http.createServer(handler).listen(port, '127.0.0.1', () => console.log(`youtube MVP server mode=${gateway.mode} on 127.0.0.1:${port}`));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(e => { console.error(String(e?.message ?? e)); process.exit(1); });
