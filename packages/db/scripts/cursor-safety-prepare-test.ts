import postgres from 'postgres';
import {readFile, readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {assertCursorTestTarget} from '../src/cursor-test-target.js';

const raw = process.env.CURSOR_TEST_DATABASE_URL ?? '', expected = process.env.CURSOR_TEST_DATABASE_NAME ?? '';
const marker = process.env.CURSOR_TEST_MARKER;
assertCursorTestTarget(raw, expected);
if (!marker) throw new Error('Fixture marker required');
const sql = postgres(raw, {max: 1, onnotice: () => {}});
try {
  const verifyDatabase = async () => {
    const [row] = await sql`SELECT current_database() AS name, inet_server_addr()::text AS address`;
    if (row.name !== expected) throw new Error('Wrong database; refuse all DDL');
  };
  await verifyDatabase();
  const [exists] = await sql`SELECT to_regclass('public.cursor_safety_fixture_marker') AS marker`;
  if (!exists.marker) {
    const [tables] = await sql`SELECT count(*)::integer AS count FROM pg_tables WHERE schemaname = 'public'`;
    if (tables.count !== 0) throw new Error('Refusing to initialize an existing database');
    await sql`CREATE TABLE cursor_safety_fixture_marker(token text PRIMARY KEY)`;
    await sql`INSERT INTO cursor_safety_fixture_marker(token) VALUES(${marker})`;
  }
  const verify = async () => {
    await verifyDatabase();
    const [row] = await sql`SELECT token FROM cursor_safety_fixture_marker`;
    if (row?.token !== marker) throw new Error('Fixture marker mismatch');
  };
  await verify();
  await sql`CREATE TABLE IF NOT EXISTS _migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const applied = new Set((await sql`SELECT name FROM _migrations`).map(row => row.name));
  const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const file of (await readdir(folder)).filter(file => file.endsWith('.sql')).sort()) {
    if (applied.has(file)) continue;
    await verify();
    await sql.unsafe(await readFile(folder + file, 'utf8'));
    await sql`INSERT INTO _migrations(name) VALUES(${file})`;
    console.log('Applied to independent fixture: ' + file);
  }
  console.log('Verified fixture database: ' + expected + '; no seed executed');
} finally { await sql.end(); }
