/**
 * Monthly partition maintenance against the local *_test database (migrated
 * with the real migrations, including 0033). Boundary inserts run inside a
 * transaction that is always rolled back, so no row is left behind.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { call, createUser, login, makeApp, sql, type App } from './harness.js';
import {
  CRITICAL_DAYS, MONTHS_AHEAD, PARTITIONED_TABLES, WARNING_DAYS,
  coverageStatus, ensurePartitions, partitionCoverage,
} from '../lib/partitions.js';
import { startPartitionMaintenanceWorker } from '../workers/partition-maintenance.worker.js';

let app: App;
before(async () => { app = await makeApp(); });
after(async () => { await app.close(); await sql.end({ timeout: 5 }); });

const monthStartUtc = (offset: number, from = new Date()) =>
  new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + offset, 1));

async function partitionNames() {
  const rows = await sql<{ parent: string; name: string; bound: string }[]>`
    SELECT i.inhparent::regclass::text AS parent, c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent::regclass::text = ANY(${PARTITIONED_TABLES as unknown as string[]})
    ORDER BY 2`;
  return rows;
}

async function dataFingerprint() {
  const [r] = await sql<Record<string, string>[]>`
    SELECT
      (SELECT count(*) || ':' || coalesce(md5(string_agg(id::text || posted_at, ',' ORDER BY id)), '') FROM posts) AS posts,
      (SELECT count(*) || ':' || coalesce(md5(string_agg(post_id::text || posted_at, ',' ORDER BY post_id)), '') FROM post_classifications) AS cls,
      (SELECT count(*) || ':' || coalesce(md5(string_agg(post_id::text || posted_at, ',' ORDER BY post_id)), '') FROM post_sentiments) AS sent,
      (SELECT count(*) || ':' || coalesce(md5(string_agg(post_id::text || captured_at, ',' ORDER BY post_id, captured_at)), '') FROM post_metrics) AS metrics,
      (SELECT count(*) || ':' || coalesce(md5(string_agg(id::text || occurred_at, ',' ORDER BY id)), '') FROM api_usage) AS usage`;
  return r;
}

test('migrations 0001…0033 are all applied, in order, and the function exists', async () => {
  const rows = await sql<{ name: string }[]>`SELECT name FROM _migrations ORDER BY name`;
  const names = rows.map((r) => r.name);
  assert.ok(names.includes('0001_init.sql') && names.includes('0033_partition_maintenance.sql'));
  for (let n = 1; n <= 33; n++) {
    assert.ok(names.some((x) => x.startsWith(String(n).padStart(4, '0'))), `migration ${n} missing`);
  }
  const [fn] = await sql<{ sig: string }[]>`
    SELECT oid::regprocedure::text AS sig FROM pg_proc WHERE proname = 'ensure_monthly_partitions'`;
  assert.equal(fn.sig, 'ensure_monthly_partitions(integer)');
});

test(`covers the current month + ${MONTHS_AHEAD} for all five tables, identically`, async () => {
  const result = await ensurePartitions('manual');
  assert.equal(result.ok, true);
  const cov = await partitionCoverage();
  const required = monthStartUtc(MONTHS_AHEAD + 1);
  for (const t of cov.tables) {
    assert.ok(t.coverageUntil, `${t.table} has no partitions`);
    assert.ok(new Date(t.coverageUntil) >= required, `${t.table} covers only to ${t.coverageUntil}`);
  }
  assert.equal(new Set(cov.tables.map((t) => t.coverageUntil)).size, 1, 'every table ends at the same bound');
  assert.equal(new Set(cov.tables.map((t) => t.partitions)).size, 1, 'every table has the same number of partitions');
  assert.equal(cov.status, 'ok');
  assert.ok(cov.daysRemaining! >= 180);
});

test('every partition bound is midnight UTC on the 1st', async () => {
  for (const p of await partitionNames()) {
    assert.match(p.bound, /^FOR VALUES FROM \('\d{4}-\d{2}-01 00:00:00\+00'\) TO \('\d{4}-\d{2}-01 00:00:00\+00'\)$/, `${p.name}: ${p.bound}`);
  }
});

test('idempotent: repeated runs create nothing and change nothing', async () => {
  await ensurePartitions('manual');
  const before = (await partitionNames()).map((p) => p.name);
  const fpBefore = await dataFingerprint();
  for (let i = 0; i < 3; i++) {
    const r = await ensurePartitions('manual');
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.created, []);
  }
  assert.deepEqual((await partitionNames()).map((p) => p.name), before);
  assert.deepEqual(await dataFingerprint(), fpBefore);
});

test('boundary instants land in the right partition of every table', async () => {
  await ensurePartitions('manual');
  const cases: Array<[string, string]> = [
    ['2026-10-31T23:59:59Z', '2026_10'],
    ['2026-11-01T00:00:00Z', '2026_11'],
    ['2027-01-01T00:00:00Z', '2027_01'],
  ];
  const seen: string[] = [];
  const ROLLBACK = new Error('rollback');
  await sql.begin(async (tx) => {
    for (const [at, suffix] of cases) {
      const id = crypto.randomUUID();
      const [p] = await tx<{ part: string }[]>`
        INSERT INTO posts (x_post_id, x_author_id, text, text_normalized, posted_at, content_hash)
        VALUES (${'boundary-' + at}, 'boundary', 'boundary', 'boundary', ${at}::timestamptz, '\\x00'::bytea)
        RETURNING tableoid::regclass::text AS part`;
      const [c] = await tx<{ part: string }[]>`
        INSERT INTO post_classifications (post_id, posted_at, relevance, stage)
        VALUES (${id}::uuid, ${at}::timestamptz, 'unknown', 1) RETURNING tableoid::regclass::text AS part`;
      const [s] = await tx<{ part: string }[]>`
        INSERT INTO post_sentiments (post_id, posted_at, label, stage)
        VALUES (${id}::uuid, ${at}::timestamptz, 'neutral', 1) RETURNING tableoid::regclass::text AS part`;
      const [m] = await tx<{ part: string }[]>`
        INSERT INTO post_metrics (post_id, posted_at) VALUES (${id}::uuid, ${at}::timestamptz)
        RETURNING tableoid::regclass::text AS part`;
      const [u] = await tx<{ part: string }[]>`
        INSERT INTO api_usage (endpoint, purpose, unit_price, occurred_at)
        VALUES ('boundary-test', 'manual', 0, ${at}::timestamptz) RETURNING tableoid::regclass::text AS part`;
      for (const [table, row] of [['posts', p], ['post_classifications', c], ['post_sentiments', s], ['post_metrics', m], ['api_usage', u]] as const) {
        assert.equal(row.part, `${table}_${suffix}`, `${at} in ${table}`);
        seen.push(row.part);
      }
    }
    throw ROLLBACK;
  }).catch((e) => { if (e !== ROLLBACK) throw e; });
  assert.equal(seen.length, 15);
  const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM posts WHERE x_author_id = 'boundary'`;
  assert.equal(n, 0, 'boundary rows were rolled back');
});

test('concurrent runs that all create new months do not race', async () => {
  // Extend past the current horizon from many connections at once, so every
  // call has partitions to create — the case that raced before 0033.
  const cov = await partitionCoverage();
  const until = new Date(cov.coverageUntil!);
  const now = new Date();
  const monthsAheadNow = (until.getUTCFullYear() - now.getUTCFullYear()) * 12 + until.getUTCMonth() - now.getUTCMonth();
  const target = monthsAheadNow + 3;
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => sql`SELECT ensure_monthly_partitions(${target}::int)`),
  );
  const failures = results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason));
  assert.deepEqual(failures, []);
  const after = await partitionCoverage();
  assert.equal(new Set(after.tables.map((t) => t.partitions)).size, 1);
  assert.equal(new Date(after.coverageUntil!).getTime(), monthStartUtc(target + 1).getTime());
});

test('bounds stay midnight UTC even when the session time zone is Asia/Riyadh', async () => {
  const cov = await partitionCoverage();
  const until = new Date(cov.coverageUntil!);
  const now = new Date();
  const ahead = (until.getUTCFullYear() - now.getUTCFullYear()) * 12 + until.getUTCMonth() - now.getUTCMonth();
  const conn = await sql.reserve();
  try {
    await conn`SET TIME ZONE 'Asia/Riyadh'`;
    await conn`SELECT ensure_monthly_partitions(${ahead}::int)`; // creates exactly one new month per table
  } finally {
    conn.release();
  }
  const newest = (await partitionNames()).filter((p) => p.name.endsWith(
    `_${until.getUTCFullYear()}_${String(until.getUTCMonth() + 1).padStart(2, '0')}`));
  assert.equal(newest.length, 5);
  for (const p of newest) {
    assert.match(p.bound, /^FOR VALUES FROM \('\d{4}-\d{2}-01 00:00:00\+00'\) TO \('\d{4}-\d{2}-01 00:00:00\+00'\)$/, p.bound);
  }
});

test('the worker runs a startup pass, then repeats on its interval', async () => {
  const passes: string[] = [];
  const stop = await startPartitionMaintenanceWorker(150, (trigger, result) => {
    assert.equal(result.ok, true);
    passes.push(trigger);
  });
  assert.deepEqual(passes, ['startup'], 'startup pass completes before the worker returns');
  await new Promise((r) => setTimeout(r, 700));
  stop();
  const daily = passes.filter((p) => p === 'daily').length;
  assert.ok(daily >= 2, `expected repeated passes, got ${daily}`);
});

test('coverage status thresholds', () => {
  assert.equal(coverageStatus(null), 'critical');
  assert.equal(coverageStatus(CRITICAL_DAYS - 1), 'critical');
  assert.equal(coverageStatus(WARNING_DAYS - 1), 'warning');
  assert.equal(coverageStatus(WARNING_DAYS), 'ok');
});

test('system-health reports coverage to admin:system only', async () => {
  const admin = await createUser('admin');
  const res = await call(app, (await login(app, admin.email)).accessToken, 'GET', '/api/v1/admin/system-health');
  assert.equal(res.statusCode, 200);
  const p = res.json().partitions;
  assert.equal(p.status, 'ok');
  assert.equal(p.tables.length, 5);
  assert.ok(p.coverageUntil);
  const viewer = await createUser('viewer');
  assert.equal((await call(app, (await login(app, viewer.email)).accessToken, 'GET', '/api/v1/admin/system-health')).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/health' })).json().partitions, undefined, 'not exposed publicly');
});
