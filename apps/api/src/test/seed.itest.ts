/**
 * The seed runs on every production start (db:push && db:seed). This runs the
 * real seed script in NODE_ENV=production against the local *_test database
 * and pins the behaviour production depends on.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createUser, sql } from './harness.js';

const DEMO = ['admin@mip.local', 'viewer@mip.local'];
let initialAdmin: { id: string; email: string };
let bystander: { id: string; email: string };
let excludedPost: string;
let keptPost: string;
const excludedUser = `seed_excluded_${Date.now().toString(36)}`;

function runSeed(env: Record<string, string>) {
  return spawnSync('pnpm run seed', {
    cwd: resolve(process.cwd(), '../../packages/db'),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    encoding: 'utf8',
  });
}

const fingerprint = async (ids: string[]) => {
  const [r] = await sql<{ fp: string }[]>`
    SELECT md5(string_agg(id || ':' || role_id || ':' || is_active || ':' || password_hash, ',' ORDER BY id)) AS fp
    FROM users WHERE id = ANY(${ids}::uuid[])`;
  return r.fp;
};

before(async () => {
  initialAdmin = await createUser('admin');
  bystander = await createUser('agent');
  // The configured initial admin has been demoted and disabled since the last start.
  await sql`UPDATE users SET role_id = (SELECT id FROM roles WHERE key = 'viewer'), is_active = false
            WHERE id = ${initialAdmin.id}::uuid`;
  // Both demo accounts are active and one has a live session.
  await sql`UPDATE users SET is_active = true, deleted_at = NULL WHERE lower(email) = ANY(${DEMO})`;
  const [demo] = await sql<{ id: string }[]>`SELECT id FROM users WHERE lower(email) = 'admin@mip.local'`;
  await sql`INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
            VALUES (${demo.id}::uuid, ${'seed-test-' + Date.now()}, now() + interval '1 day')`;
  // One post by an excluded account, one by someone else.
  const [ex] = await sql<{ id: string }[]>`INSERT INTO authors (x_author_id, username) VALUES (${excludedUser}, ${excludedUser}) RETURNING id`;
  const [ok] = await sql<{ id: string }[]>`INSERT INTO authors (x_author_id, username) VALUES (${excludedUser + '_ok'}, ${excludedUser + '_ok'}) RETURNING id`;
  for (const [author, xid] of [[ex.id, excludedUser], [ok.id, excludedUser + '_ok']] as const) {
    const id = crypto.randomUUID();
    await sql`INSERT INTO posts (id, x_post_id, x_author_id, author_id, text, text_normalized, posted_at, content_hash)
              VALUES (${id}, ${id}, ${xid}, ${author}::uuid, 'seed test', 'seed test', now(), '\\x00'::bytea)`;
    if (xid === excludedUser) excludedPost = id; else keptPost = id;
  }
});

after(async () => {
  // Leave the shared test database usable for other suites' demo logins.
  await sql`UPDATE users SET is_active = true WHERE lower(email) = ANY(${DEMO})`;
  await sql.end({ timeout: 5 });
});

test('production seed restores the initial admin, disables demo accounts, redacts excluded posts — and never blocks startup', async () => {
  const before = await fingerprint([bystander.id]);
  const r = runSeed({
    NODE_ENV: 'production',
    INITIAL_ADMIN_EMAIL: initialAdmin.email,
    AUTO_COLLECTION_EXCLUDED_USERS: `@${excludedUser}`,
  });
  assert.equal(r.status, 0, `seed must not fail production startup:\n${r.stdout}\n${r.stderr}`);

  // INITIAL_ADMIN_EMAIL: back to an active admin.
  const [admin] = await sql<{ key: string; is_active: boolean }[]>`
    SELECT r.key, u.is_active FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ${initialAdmin.id}::uuid`;
  assert.deepEqual({ ...admin }, { key: 'admin', is_active: true });

  // Demo accounts: disabled, sessions revoked — even though they were active.
  const demo = await sql<{ is_active: boolean; live: number }[]>`
    SELECT u.is_active, (SELECT count(*)::int FROM refresh_tokens t WHERE t.user_id = u.id AND t.revoked_at IS NULL) AS live
    FROM users u WHERE lower(u.email) = ANY(${DEMO})`;
  assert.equal(demo.length, 2);
  for (const d of demo) assert.deepEqual({ ...d }, { is_active: false, live: 0 });

  // Excluded accounts: existing posts redacted; other accounts untouched.
  const posts = await sql<{ id: string; is_redacted: boolean }[]>`
    SELECT id, is_redacted FROM posts WHERE id = ANY(${[excludedPost, keptPost]}::uuid[])`;
  assert.equal(posts.find((p) => p.id === excludedPost)?.is_redacted, true);
  assert.equal(posts.find((p) => p.id === keptPost)?.is_redacted, false);

  // Unrelated users are not touched at all.
  assert.equal(await fingerprint([bystander.id]), before);

  // Queue intake defaults exist and stay off.
  const settings = await sql<{ key: string; value: unknown }[]>`
    SELECT key, value FROM settings WHERE key IN ('queue.intake_enabled', 'queue.intake_starts_at') ORDER BY key`;
  assert.deepEqual(settings.map((s) => [s.key, s.value]), [['queue.intake_enabled', false], ['queue.intake_starts_at', null]]);
});

test('seed never overwrites intake settings an administrator changed', async () => {
  await sql`UPDATE settings SET value = 'true'::jsonb WHERE key = 'queue.intake_enabled'`;
  try {
    const r = runSeed({ NODE_ENV: 'test' });
    assert.equal(r.status, 0, r.stderr);
    const [s] = await sql<{ value: unknown }[]>`SELECT value FROM settings WHERE key = 'queue.intake_enabled'`;
    assert.equal(s.value, true);
  } finally {
    await sql`UPDATE settings SET value = 'false'::jsonb WHERE key = 'queue.intake_enabled'`;
  }
});
