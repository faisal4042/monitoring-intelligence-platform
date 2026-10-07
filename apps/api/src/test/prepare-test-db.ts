/**
 * Creates (if needed) the local *_test database, then runs the real migrations
 * and seed against it — the same code path production uses. Development data
 * in the main local database is never touched.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { testDatabaseUrl } from './test-db.js';

const url = testDatabaseUrl();
const target = new URL(url);
const dbName = target.pathname.replace(/^\//, '');
const admin = new URL(url);
admin.pathname = '/postgres';

// @mip/db reads DATABASE_URL on import: point it at the local maintenance
// database (same host the guard in test-db.ts has already checked) to create
// the test database, then hand the real work to the db package scripts.
process.env.DATABASE_URL = admin.toString();
const { sql } = await import('@mip/db');
const [exists] = await sql`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
if (!exists) {
  await sql.unsafe(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`);
  console.log(`created ${dbName}`);
}
await sql.end();

const env = { ...process.env, DATABASE_URL: url, NODE_ENV: 'test' };
const dbPkg = resolve(process.cwd(), '../../packages/db');
for (const script of ['push', 'seed']) {
  const r = spawnSync(`pnpm run ${script}`, { cwd: dbPkg, env, stdio: ['ignore', 'pipe', 'inherit'], shell: true });
  if (r.status !== 0) throw new Error(`db ${script} failed on ${dbName}`);
}
console.log(`${dbName} migrated and seeded`);
