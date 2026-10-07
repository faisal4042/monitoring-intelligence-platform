/**
 * RBAC, user management and session behaviour against the real app and a
 * local *_test database. No X API is reachable: workers never start and no
 * collection route is called.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { PERMISSIONS, ROLE_PERMISSIONS } from '@mip/shared';
import { call, createUser, login, makeApp, PASSWORD, roleId, sql, type App, type TestUser } from './harness.js';

let app: App;
let admin: TestUser;
let adminToken: string;
const tempPasswords: string[] = [];
const touchedUsers: string[] = [];

before(async () => {
  app = await makeApp();
  admin = await createUser('admin');
  adminToken = (await login(app, admin.email)).accessToken;
});
after(async () => { await app.close(); await sql.end({ timeout: 5 }); });

const tokenFor = async (role: string) => {
  const u = await createUser(role);
  touchedUsers.push(u.id);
  const s = await login(app, u.email);
  return { user: u, accessToken: s.accessToken, refreshCookie: s.refreshCookie };
};

describe('role permissions over HTTP', () => {
  test('agent: reads posts, news, topics and customer history; nothing else', async () => {
    const { accessToken: t, user } = await tokenFor('agent');
    const me = (await call(app, t, 'GET', '/api/v1/auth/me')).json().user;
    assert.deepEqual([...me.permissions].sort(), [...ROLE_PERMISSIONS.agent].sort());
    for (const url of ['/api/v1/posts?limit=1', '/api/v1/posts/stats', '/api/v1/news/articles?limit=1', '/api/v1/topics', '/api/v1/programs', `/api/v1/posts/authors/${user.id}/history`]) {
      const res = await call(app, t, 'GET', url);
      assert.ok(res.statusCode === 200 || res.statusCode === 404, `${url} → ${res.statusCode}`);
    }
    for (const url of ['/api/v1/cost/overview', '/api/v1/admin/users', '/api/v1/admin/audit-log', '/api/v1/keywords', '/api/v1/queries']) {
      assert.equal((await call(app, t, 'GET', url)).statusCode, 403, url);
    }
    assert.equal((await call(app, t, 'POST', '/api/v1/classification/run', {})).statusCode, 403);
    assert.equal((await call(app, t, 'POST', '/api/v1/news/articles/fetch-now', {})).statusCode, 403);
  });

  test('viewer: read-only, no cost, no customer history, no writes', async () => {
    const { accessToken: t } = await tokenFor('viewer');
    assert.equal((await call(app, t, 'GET', '/api/v1/posts?limit=1')).statusCode, 200);
    assert.equal((await call(app, t, 'GET', '/api/v1/cost/overview')).statusCode, 403);
    assert.equal((await call(app, t, 'GET', '/api/v1/cost/queries')).statusCode, 403);
    assert.equal((await call(app, t, 'GET', '/api/v1/posts/authors/123/history')).statusCode, 403);
    assert.equal((await call(app, t, 'POST', '/api/v1/keywords', {})).statusCode, 403);
    assert.equal((await call(app, t, 'GET', '/api/v1/admin/users')).statusCode, 403);
  });

  test('supervisor: sees users, cannot create, edit, reset or re-role them', async () => {
    const { accessToken: t } = await tokenFor('supervisor');
    const target = await createUser('agent');
    assert.equal((await call(app, t, 'GET', '/api/v1/cost/overview')).statusCode, 200);
    assert.equal((await call(app, t, 'GET', '/api/v1/admin/users')).statusCode, 200);
    assert.equal((await call(app, t, 'POST', '/api/v1/admin/users', { email: 'x@mip.test', fullName: 'X Y', roleId: await roleId('agent') })).statusCode, 403);
    assert.equal((await call(app, t, 'PATCH', `/api/v1/admin/users/${target.id}`, { fullName: 'New' })).statusCode, 403);
    assert.equal((await call(app, t, 'POST', `/api/v1/admin/users/${target.id}/reset-password`, {})).statusCode, 403);
    assert.equal((await call(app, t, 'PUT', `/api/v1/admin/users/${target.id}/role`, { roleId: await roleId('viewer') })).statusCode, 403);
    assert.equal((await call(app, t, 'POST', `/api/v1/admin/users/${target.id}/disable`, {})).statusCode, 403);
  });

  test('admin: every permission', async () => {
    const me = (await call(app, adminToken, 'GET', '/api/v1/auth/me')).json().user;
    assert.deepEqual([...me.permissions].sort(), [...ROLE_PERMISSIONS.admin].sort());
    for (const url of ['/api/v1/admin/users', '/api/v1/admin/roles', '/api/v1/admin/audit-log', '/api/v1/cost/overview']) {
      assert.equal((await call(app, adminToken, 'GET', url)).statusCode, 200, url);
    }
  });
});

describe('401 vs 403', () => {
  test('no or invalid token is 401; valid token without permission is 403', async () => {
    assert.equal((await call(app, null, 'GET', '/api/v1/admin/users')).statusCode, 401);
    assert.equal((await call(app, 'not-a-jwt', 'GET', '/api/v1/admin/users')).statusCode, 401);
    const { accessToken } = await tokenFor('agent');
    const res = await call(app, accessToken, 'GET', '/api/v1/admin/users');
    assert.equal(res.statusCode, 403);
  });
});

describe('user management guards', () => {
  test('self role change and self disable are refused', async () => {
    const me = admin.id;
    assert.equal((await call(app, adminToken, 'PUT', `/api/v1/admin/users/${me}/role`, { roleId: await roleId('viewer') })).statusCode, 403);
    assert.equal((await call(app, adminToken, 'POST', `/api/v1/admin/users/${me}/disable`, {})).statusCode, 403);
    assert.equal((await call(app, adminToken, 'POST', `/api/v1/admin/users/${me}/reset-password`, {})).statusCode, 403);
  });

  test('users:assign_roles is required to change a role or create a user', async () => {
    // A supervisor granted users:write (but not assign_roles) per user.
    const { user, accessToken } = await tokenFor('supervisor');
    await sql`INSERT INTO user_permissions (user_id, permission_key) VALUES (${user.id}::uuid, ${PERMISSIONS.USERS_WRITE})`;
    const target = await createUser('agent');
    assert.equal((await call(app, accessToken, 'PUT', `/api/v1/admin/users/${target.id}/role`, { roleId: await roleId('viewer') })).statusCode, 403);
    assert.equal((await call(app, accessToken, 'POST', '/api/v1/admin/users', { email: `w-${Date.now()}@mip.test`, fullName: 'No Assign', roleId: await roleId('viewer') })).statusCode, 403);
  });

  test('privilege escalation: cannot grant or act on permissions you lack', async () => {
    // Supervisor + users:write + users:assign_roles, still not an admin.
    const { user, accessToken: t } = await tokenFor('supervisor');
    await sql`INSERT INTO user_permissions (user_id, permission_key) VALUES (${user.id}::uuid, ${PERMISSIONS.USERS_WRITE}), (${user.id}::uuid, ${PERMISSIONS.USERS_ASSIGN_ROLES})`;
    const agent = await createUser('agent');
    const otherAdmin = await createUser('admin');
    // Promote someone (or themself) to admin: refused.
    assert.equal((await call(app, t, 'PUT', `/api/v1/admin/users/${agent.id}/role`, { roleId: await roleId('admin') })).statusCode, 403);
    assert.equal((await call(app, t, 'POST', '/api/v1/admin/users', { email: `e-${Date.now()}@mip.test`, fullName: 'Esc', roleId: await roleId('admin') })).statusCode, 403);
    // Grant a permission they do not hold: refused.
    assert.equal((await call(app, t, 'PUT', `/api/v1/admin/users/${agent.id}/permissions/${PERMISSIONS.BUDGET_WRITE}`)).statusCode, 403);
    // Take over a more privileged account (reset an admin's password, disable or re-role it): refused.
    assert.equal((await call(app, t, 'POST', `/api/v1/admin/users/${otherAdmin.id}/reset-password`, {})).statusCode, 403);
    assert.equal((await call(app, t, 'POST', `/api/v1/admin/users/${otherAdmin.id}/disable`, {})).statusCode, 403);
    assert.equal((await call(app, t, 'PUT', `/api/v1/admin/users/${otherAdmin.id}/role`, { roleId: await roleId('viewer') })).statusCode, 403);
    // Within their own permissions they can act: agent → viewer.
    assert.equal((await call(app, t, 'PUT', `/api/v1/admin/users/${agent.id}/role`, { roleId: await roleId('viewer') })).statusCode, 200);
  });

  test('the last active admin can be neither demoted nor disabled', async () => {
    // Isolate: one target admin, every other admin disabled (test DB only).
    const target = await createUser('admin');
    const actor = await createUser('supervisor');
    const allPerms = Object.values(PERMISSIONS);
    for (const p of allPerms) {
      await sql`INSERT INTO user_permissions (user_id, permission_key) VALUES (${actor.id}::uuid, ${p}) ON CONFLICT DO NOTHING`;
    }
    const others = await sql<{ id: string }[]>`
      UPDATE users SET is_active = false
      WHERE role_id = (SELECT id FROM roles WHERE key = 'admin') AND is_active AND id <> ${target.id}::uuid
      RETURNING id`;
    try {
      const t = (await login(app, actor.email)).accessToken;
      const demote = await call(app, t, 'PUT', `/api/v1/admin/users/${target.id}/role`, { roleId: await roleId('viewer') });
      assert.equal(demote.statusCode, 409, demote.body);
      const disable = await call(app, t, 'POST', `/api/v1/admin/users/${target.id}/disable`, {});
      assert.equal(disable.statusCode, 409, disable.body);
      const [still] = await sql<{ is_active: boolean; key: string }[]>`
        SELECT u.is_active, r.key FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ${target.id}::uuid`;
      assert.deepEqual({ ...still }, { is_active: true, key: 'admin' });
    } finally {
      if (others.length) await sql`UPDATE users SET is_active = true WHERE id = ANY(${others.map((o) => o.id)}::uuid[])`;
    }
  });
});

describe('passwords and sessions', () => {
  test('create user: temporary password returned once, only a hash stored, change forced', async () => {
    const email = `new-${Date.now()}@mip.test`;
    const res = await call(app, adminToken, 'POST', '/api/v1/admin/users', { email, fullName: 'New Agent', roleId: await roleId('agent') });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['cache-control'], 'no-store');
    const { user, temporaryPassword } = res.json() as { user: { id: string }; temporaryPassword: string };
    tempPasswords.push(temporaryPassword);
    touchedUsers.push(user.id);
    assert.ok(temporaryPassword.length >= 20);
    assert.match(temporaryPassword, /[A-Z]/); assert.match(temporaryPassword, /[a-z]/);
    assert.match(temporaryPassword, /[0-9]/); assert.match(temporaryPassword, /[^A-Za-z0-9]/);

    const [row] = await sql<{ password_hash: string; must_change_password: boolean; created_by: string }[]>`
      SELECT password_hash, must_change_password, created_by FROM users WHERE id = ${user.id}::uuid`;
    assert.notEqual(row.password_hash, temporaryPassword);
    assert.match(row.password_hash, /^\$argon2id\$/);
    assert.ok(await argon2.verify(row.password_hash, temporaryPassword));
    assert.equal(row.must_change_password, true);
    assert.equal(row.created_by, admin.id);

    // Listing users never exposes it again.
    const list = await call(app, adminToken, 'GET', '/api/v1/admin/users');
    assert.ok(!list.body.includes(temporaryPassword));
    assert.ok(!list.body.includes('password_hash'));
  });

  test('must_change_password blocks everything but /me and changing the password', async () => {
    const u = await createUser('agent', { mustChange: true });
    touchedUsers.push(u.id);
    const s = await login(app, u.email);
    assert.equal(s.user.mustChangePassword, true);
    const blocked = await call(app, s.accessToken, 'GET', '/api/v1/posts?limit=1');
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.json().code, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal((await call(app, s.accessToken, 'GET', '/api/v1/auth/me')).statusCode, 200);

    const short = await call(app, s.accessToken, 'POST', '/api/v1/auth/me/password', { currentPassword: PASSWORD, newPassword: 'short' });
    assert.equal(short.statusCode, 400);
    const wrong = await call(app, s.accessToken, 'POST', '/api/v1/auth/me/password', { currentPassword: 'nope-nope-nope', newPassword: 'A-Brand-New-Pass-42' });
    assert.equal(wrong.statusCode, 400);

    const ok = await call(app, s.accessToken, 'POST', '/api/v1/auth/me/password', { currentPassword: PASSWORD, newPassword: 'A-Brand-New-Pass-42' }, s.refreshCookie);
    assert.equal(ok.statusCode, 200, ok.body);
    const fresh = ok.json() as { accessToken: string; user: { mustChangePassword: boolean } };
    assert.equal(fresh.user.mustChangePassword, false);
    assert.equal((await call(app, fresh.accessToken, 'GET', '/api/v1/posts?limit=1')).statusCode, 200);
  });

  test('password change invalidates every earlier JWT and refresh token', async () => {
    const u = await createUser('agent');
    touchedUsers.push(u.id);
    const a = await login(app, u.email);
    const b = await login(app, u.email); // a second device
    assert.equal((await call(app, b.accessToken, 'GET', '/api/v1/posts?limit=1')).statusCode, 200);

    const res = await call(app, a.accessToken, 'POST', '/api/v1/auth/me/password', { currentPassword: PASSWORD, newPassword: 'Another-Strong-Pass-77' }, a.refreshCookie);
    assert.equal(res.statusCode, 200, res.body);
    const fresh = res.json() as { accessToken: string };

    assert.equal((await call(app, a.accessToken, 'GET', '/api/v1/auth/me')).statusCode, 401, 'old token of the changing session');
    assert.equal((await call(app, b.accessToken, 'GET', '/api/v1/auth/me')).statusCode, 401, 'old token of another device');
    const refreshB = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', cookies: { mip_rt: b.refreshCookie! } });
    assert.equal(refreshB.statusCode, 401, 'other device refresh token revoked');
    assert.equal((await call(app, fresh.accessToken, 'GET', '/api/v1/auth/me')).statusCode, 200, 'new token works');
  });

  test('admin reset: new temporary password, sessions revoked, old JWT void', async () => {
    const u = await createUser('agent');
    touchedUsers.push(u.id);
    const s = await login(app, u.email);
    const res = await call(app, adminToken, 'POST', `/api/v1/admin/users/${u.id}/reset-password`, {});
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['cache-control'], 'no-store');
    const { temporaryPassword } = res.json() as { temporaryPassword: string };
    tempPasswords.push(temporaryPassword);

    assert.equal((await call(app, s.accessToken, 'GET', '/api/v1/auth/me')).statusCode, 401);
    const refresh = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', cookies: { mip_rt: s.refreshCookie! } });
    assert.equal(refresh.statusCode, 401);
    const [live] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id = ${u.id}::uuid AND revoked_at IS NULL AND expires_at > now()`;
    assert.equal(live.n, 0);

    await assert.rejects(login(app, u.email, PASSWORD), /401/);
    const again = await login(app, u.email, temporaryPassword);
    assert.equal(again.user.mustChangePassword, true);
  });

  test('disabled user cannot authenticate in any way; enable restores access', async () => {
    const u = await createUser('agent');
    touchedUsers.push(u.id);
    const s = await login(app, u.email);
    assert.equal((await call(app, adminToken, 'POST', `/api/v1/admin/users/${u.id}/disable`, {})).statusCode, 200);

    const [row] = await sql<{ is_active: boolean; disabled_at: Date | null; disabled_by: string | null }[]>`
      SELECT is_active, disabled_at, disabled_by FROM users WHERE id = ${u.id}::uuid`;
    assert.equal(row.is_active, false);
    assert.ok(row.disabled_at);
    assert.equal(row.disabled_by, admin.id);

    assert.equal((await call(app, s.accessToken, 'GET', '/api/v1/auth/me')).statusCode, 401);
    const refresh = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', cookies: { mip_rt: s.refreshCookie! } });
    assert.equal(refresh.statusCode, 401);
    await assert.rejects(login(app, u.email), /401/);

    assert.equal((await call(app, adminToken, 'POST', `/api/v1/admin/users/${u.id}/enable`, {})).statusCode, 200);
    const [back] = await sql<{ disabled_at: Date | null }[]>`SELECT disabled_at FROM users WHERE id = ${u.id}::uuid`;
    assert.equal(back.disabled_at, null);
    await login(app, u.email);
  });

  test('a user is never hard-deleted through the API', async () => {
    const u = await createUser('agent');
    const res = await call(app, adminToken, 'DELETE', `/api/v1/admin/users/${u.id}`);
    assert.equal(res.statusCode, 404);
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE id = ${u.id}::uuid AND deleted_at IS NULL`;
    assert.equal(row.n, 1);
  });
});

describe('customer history', () => {
  test('requires customers:read', async () => {
    const viewer = await tokenFor('viewer');
    const agent = await tokenFor('agent');
    const url = '/api/v1/posts/authors/does-not-exist/history';
    assert.equal((await call(app, viewer.accessToken, 'GET', url)).statusCode, 403);
    assert.equal((await call(app, agent.accessToken, 'GET', url)).statusCode, 404);
  });
});

describe('audit', () => {
  test('user lifecycle and auth events are recorded with an IP', async () => {
    const u = await createUser('agent');
    await assert.rejects(login(app, u.email, 'wrong-password-1'), /401/);
    const s = await login(app, u.email);
    await app.inject({ method: 'POST', url: '/api/v1/auth/logout', cookies: { mip_rt: s.refreshCookie! } });
    await call(app, adminToken, 'PUT', `/api/v1/admin/users/${u.id}/role`, { roleId: await roleId('viewer') });
    await call(app, adminToken, 'PUT', `/api/v1/admin/users/${u.id}/permissions/${PERMISSIONS.NEWS_READ}`);
    await call(app, adminToken, 'DELETE', `/api/v1/admin/users/${u.id}/permissions/${PERMISSIONS.NEWS_READ}`);
    await call(app, adminToken, 'POST', `/api/v1/admin/users/${u.id}/disable`, {});
    await call(app, adminToken, 'POST', `/api/v1/admin/users/${u.id}/enable`, {});
    touchedUsers.push(u.id);

    const rows = await sql<{ action: string; ip: string | null }[]>`
      SELECT action, host(ip_address) AS ip FROM audit_log WHERE entity_id = ${u.id}::uuid`;
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ['auth.login_failed', 'auth.login', 'auth.logout', 'user.role_change', 'user.permission_grant',
      'user.permission_revoke', 'user.disable', 'user.enable']) {
      assert.ok(actions.has(a), `missing audit ${a}`);
    }
    const all = await sql<{ action: string }[]>`
      SELECT DISTINCT action FROM audit_log WHERE entity_id = ANY(${touchedUsers}::uuid[])`;
    const allActions = new Set(all.map((r) => r.action));
    for (const a of ['user.create', 'user.reset_password', 'user.password_change', 'auth.sessions_revoked']) {
      assert.ok(allActions.has(a), `missing audit ${a}`);
    }
    assert.ok(rows.every((r) => r.ip), 'every row has an ip_address');
  });

  test('no password, hash, token or temporary password ever reaches the audit log', async () => {
    assert.ok(tempPasswords.length >= 2, 'earlier tests issued temporary passwords');
    const rows = await sql<{ blob: string }[]>`
      SELECT coalesce(old_value::text, '') || ' ' || coalesce(new_value::text, '') || ' ' || coalesce(reason, '') AS blob
      FROM audit_log WHERE entity_id = ANY(${touchedUsers}::uuid[]) OR user_id = ANY(${touchedUsers}::uuid[])`;
    assert.ok(rows.length > 0);
    const blob = rows.map((r) => r.blob).join('\n');
    for (const secret of [...tempPasswords, PASSWORD, 'A-Brand-New-Pass-42', 'Another-Strong-Pass-77']) {
      assert.ok(!blob.includes(secret), 'a password reached the audit log');
    }
    assert.doesNotMatch(blob, /\$argon2/);
    assert.doesNotMatch(blob, /password_hash|passwordHash|token_hash|accessToken|temporaryPassword/i);
  });
});
