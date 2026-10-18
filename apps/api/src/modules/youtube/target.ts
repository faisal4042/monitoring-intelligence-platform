/**
 * Identity guard for the YouTube MVP database. Every entry point calls it before the first write.
 * Accepts ONLY 127.0.0.1:5462/mip_youtube_test that (a) is not the MIP database (different system identifier,
 * no MIP tables such as users/posts) and (b) carries the synthetic marker. MIP's mip (5433) always throws.
 */
import type {YouTubeSql} from '@mip/db/src/youtube-test-client.js';

export const MIP_SYSTEM_IDENTIFIER = '7678829486367178790';
export const YT_TEST = {host: '127.0.0.1', port: '5462', database: 'mip_youtube_test'} as const;
export const YT_MARKER = 'mip-youtube-mvp-synthetic-20261016';
const MIP_TABLES = ['users', 'posts', 'authors', 'tickets', 'news_articles', 'roles'];

export function assertTestUrl(databaseUrl: string): URL {
  const u = new URL(databaseUrl);
  if (u.hostname !== YT_TEST.host) throw new Error('YOUTUBE_TARGET_REFUSED: loopback 127.0.0.1 only');
  if (u.port !== YT_TEST.port) throw new Error(`YOUTUBE_TARGET_REFUSED: port ${u.port || '5432'} is not the YouTube test port`);
  if (u.pathname !== `/${YT_TEST.database}`) throw new Error('YOUTUBE_TARGET_REFUSED: database must be mip_youtube_test');
  return u;
}

/** For `--init` (marker not yet created): identity + emptiness of MIP tables. */
export async function assertTestIdentity(sql: YouTubeSql, databaseUrl: string): Promise<{system: string}> {
  assertTestUrl(databaseUrl);
  const [id] = await sql<{name: string; system: string}[]>`
    SELECT current_database() AS name, (SELECT system_identifier::text FROM pg_control_system()) AS system`;
  if (id.name !== YT_TEST.database) throw new Error('YOUTUBE_TARGET_REFUSED: connected database name mismatch');
  if (id.system === MIP_SYSTEM_IDENTIFIER) throw new Error('YOUTUBE_TARGET_REFUSED: this is the MIP cluster');
  const present = await sql<{t: string}[]>`
    SELECT t FROM unnest(${MIP_TABLES}::text[]) t WHERE to_regclass('public.' || t) IS NOT NULL`;
  if (present.length) throw new Error(`YOUTUBE_TARGET_REFUSED: MIP tables present (${present.map(r => r.t).join(',')})`);
  return {system: id.system};
}

/** For every run after init: identity + synthetic marker row. */
export async function assertTestTarget(sql: YouTubeSql, databaseUrl: string): Promise<{system: string}> {
  const id = await assertTestIdentity(sql, databaseUrl);
  const [m] = await sql<{token: string}[]>`
    SELECT token FROM youtube_test_marker WHERE to_regclass('public.youtube_test_marker') IS NOT NULL LIMIT 1`
    .catch(() => [] as {token: string}[]);
  if (m?.token !== YT_MARKER) throw new Error('YOUTUBE_TARGET_REFUSED: synthetic marker missing');
  return id;
}
