/**
 * Route authorization coverage. Every route the app registers is either
 * explicitly public, explicitly self-only, or behind a permission — and the
 * last group is proven behaviourally: with no session it answers 401, and
 * with a valid session that holds no permissions it answers 403.
 *
 * Adding an endpoint without a permission check makes this suite fail.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { call, createUser, ensureEmptyRole, login, makeApp, sql, type App } from './harness.js';

const PUBLIC = [
  'GET /health',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/logout',
  'POST /api/v1/auth/refresh',
  'POST /api/v1/notify/telegram-webhook',
].sort();

const SELF = [
  'GET /api/v1/auth/me',
  'PATCH /api/v1/auth/me/preferences',
  'POST /api/v1/auth/me/password',
].sort();

let app: App;
let noneToken: string;

before(async () => {
  app = await makeApp();
  const role = await ensureEmptyRole();
  const user = await createUser(role);
  noneToken = (await login(app, user.email)).accessToken;
});
after(async () => { await app.close(); await sql.end({ timeout: 5 }); });

const concrete = (url: string) => url.replace(/:(\w+)/g, (_m, name: string) =>
  name === 'permission' ? 'posts:read' : crypto.randomUUID());

test('only the expected routes are public or self-only', () => {
  const key = (r: { method: string; url: string }) => `${r.method} ${r.url}`;
  assert.deepEqual(app.routeCatalog.filter((r) => r.access === 'public').map(key).sort(), PUBLIC);
  assert.deepEqual(app.routeCatalog.filter((r) => r.access === 'self').map(key).sort(), SELF);
  assert.ok(app.routeCatalog.length > 100, `expected the full route table, got ${app.routeCatalog.length}`);
});

test('every protected route answers 401 without a session', async () => {
  const leaks: string[] = [];
  for (const r of app.routeCatalog.filter((x) => x.access !== 'public')) {
    const res = await call(app, null, r.method, concrete(r.url), r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
    if (res.statusCode !== 401) leaks.push(`${r.method} ${r.url} → ${res.statusCode}`);
  }
  assert.deepEqual(leaks, []);
});

test('every permission route answers 403 to a signed-in user holding no permissions', async () => {
  const leaks: string[] = [];
  const routes = app.routeCatalog.filter((x) => x.access === 'permission');
  for (const r of routes) {
    const res = await call(app, noneToken, r.method, concrete(r.url), r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
    if (res.statusCode !== 403) leaks.push(`${r.method} ${r.url} → ${res.statusCode}`);
  }
  assert.deepEqual(leaks, [], `routes reachable without a permission:\n${leaks.join('\n')}`);
  assert.ok(routes.length >= 100);
});

test('self-only routes work for that same user', async () => {
  const me = await call(app, noneToken, 'GET', '/api/v1/auth/me');
  assert.equal(me.statusCode, 200);
  assert.deepEqual(me.json().user.permissions, []);
});
