/**
 * Postgres client for the isolated YouTube MVP database. Deliberately does NOT import @mip/config or ./client:
 * nothing here reads .env or opens a pool to the MIP database.
 */
import postgres from 'postgres';
export type YouTubeSql = postgres.Sql;
export function openYouTubeTestClient(url: string, max = 4): YouTubeSql {
  return postgres(url, {max, onnotice: () => {}, connect_timeout: 5,
    connection: {application_name: 'mip-youtube-mvp', statement_timeout: 15000, lock_timeout: 2000}});
}
