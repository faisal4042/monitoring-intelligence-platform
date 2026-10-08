/**
 * Shared setup for *.itest.ts: points the app at the local *_test database
 * BEFORE anything imports @mip/db, builds the app without rate limiting or
 * workers, and creates throwaway users per role. No X API call is reachable
 * from here: workers are never started and no collection route is invoked.
 */
import { testDatabaseUrl } from './test-db.js';

process.env.DATABASE_URL = testDatabaseUrl();
process.env.NODE_ENV = 'test';
// Never inherit live collection flags from the developer's .env in tests or previews.
process.env.LIVE_X_API = 'false';
process.env.AUTO_COLLECTION_ENABLED = 'false';
process.env.X_STREAM_ENABLED = 'false';
process.env.AUTO_CLASSIFICATION_ENABLED = 'false';

const { buildApp } = await import('../app.js');
const { sql, analyticsSql } = await import('@mip/db');
// Hard stop if @mip/db was loaded before this file switched DATABASE_URL (an
// import above the harness): every pool must be on the *_test database.
for (const pool of [sql, analyticsSql]) {
  const [{ db }] = await pool<{ db: string }[]>`SELECT current_database() AS db`;
  if (!db.endsWith('_test')) throw new Error(`Refusing to run: connected to "${db}", not a *_test database. Import ./harness.js before anything that loads @mip/db.`);
}
const { hashPassword } = await import('../plugins/auth.js');

export { sql, analyticsSql };
export type App = Awaited<ReturnType<typeof buildApp>>;

export async function makeApp(): Promise<App> {
  const app = await buildApp({ logger: false, rateLimit: false });
  await app.ready();
  return app;
}

const RUN = Date.now().toString(36);
let seq = 0;
export const PASSWORD = 'Test-Password-123!';

export interface TestUser { id: string; email: string; role: string }

/** Inserts an active user with a known password directly (test DB only). */
export async function createUser(role: string, opts: { active?: boolean; mustChange?: boolean } = {}): Promise<TestUser> {
  const email = `t-${RUN}-${++seq}-${role}@mip.test`;
  const [r] = await sql<{ id: string }[]>`SELECT id FROM roles WHERE key = ${role}`;
  if (!r) throw new Error(`role ${role} missing in test DB`);
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (email, full_name, password_hash, role_id, is_active, must_change_password)
    VALUES (${email}, ${'Test ' + role}, ${await hashPassword(PASSWORD)}, ${r.id}::uuid,
            ${opts.active ?? true}, ${opts.mustChange ?? false})
    RETURNING id`;
  return { id: u.id, email, role };
}

/** A role with no permissions at all — for proving default deny. */
export async function ensureEmptyRole(): Promise<string> {
  const [r] = await sql<{ id: string }[]>`
    INSERT INTO roles (key, name_ar, name_en, is_system) VALUES ('zz_test_none', 'اختبار بلا صلاحيات', 'Test none', false)
    ON CONFLICT (key) DO UPDATE SET name_ar = EXCLUDED.name_ar RETURNING id`;
  await sql`DELETE FROM role_permissions WHERE role_id = ${r.id}::uuid`;
  return 'zz_test_none';
}

export interface Session { accessToken: string; refreshCookie: string | null; user: { mustChangePassword: boolean; permissions: string[] } }

export async function login(app: App, email: string, password = PASSWORD): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login ${email} → ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'mip_rt');
  const body = res.json() as { accessToken: string; user: Session['user'] };
  return { accessToken: body.accessToken, refreshCookie: cookie?.value ?? null, user: body.user };
}

export function call(app: App, token: string | null, method: string, url: string, payload?: unknown, cookie?: string | null) {
  return app.inject({
    method: method as 'GET',
    url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    ...(cookie ? { cookies: { mip_rt: cookie } } : {}),
  });
}

export async function roleId(key: string) {
  const [r] = await sql<{ id: string }[]>`SELECT id FROM roles WHERE key = ${key}`;
  return r.id;
}
