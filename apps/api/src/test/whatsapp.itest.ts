/**
 * WhatsApp channel integration tests — isolated database + mock Graph API. No real Meta call is possible:
 * WHATSAPP_GRAPH_BASE_URL points at the local mock below, and the DB is a throwaway container with
 * migrations 0001–0055 (0046 fencing excluded).
 *
 * Run (see docs/whatsapp/README.md):
 *   DATABASE_URL=postgres://…@127.0.0.1:5499/wa_test WHATSAPP_GRAPH_BASE_URL=http://127.0.0.1:5498 NODE_ENV=test \
 *   JWT_SECRET=… JWT_REFRESH_SECRET=… npx tsx --test --test-concurrency=1 src/test/whatsapp.itest.ts
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from '@mip/db';
import { config } from '@mip/config';
import { buildApp } from '../app.js';
import { whatsappTick } from '../workers/whatsapp.worker.js';
import { resetSchemaCache } from '../modules/whatsapp/settings.js';
import { evaluateRules } from '../modules/notify/service.js';

// ── Mock Graph API ─────────────────────────────────────────────────────
type Behaviour = { status: number; body?: unknown; headers?: Record<string, string> } | 'reset';
const mock = { sendQueue: [] as Behaviour[], requests: [] as Array<{ method: string; url: string; auth?: string; body?: any }>,
  phone: { status: 200, body: { display_phone_number: '+966 11 000 0000', verified_name: 'Radar Test', quality_rating: 'GREEN' } } as { status: number; body: unknown },
  templates: [] as Array<Record<string, unknown>>, counter: 0 };
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
    const body = raw ? JSON.parse(raw) : undefined;
    mock.requests.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
    const json = (status: number, b: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(b)); };
    if (req.method === 'POST' && /\/messages$/.test(req.url!)) {
      const b = mock.sendQueue.shift() ?? { status: 200 };
      if (b === 'reset') { req.socket.destroy(); return; }
      return json(b.status, b.body ?? { messaging_product: 'whatsapp', messages: [{ id: `wamid.TEST${++mock.counter}` }] }, b.headers);
    }
    if (req.method === 'GET' && /message_templates/.test(req.url!)) return json(200, { data: mock.templates });
    if (req.method === 'GET') return json(mock.phone.status, mock.phone.body);
    json(404, { error: { code: 100, message: 'not found' } });
  });
});

let app: Awaited<ReturnType<typeof buildApp>>;
const ids: Record<string, string> = {};
const token = (userId: string) => app.jwt.sign({ sub: userId, pwd: 0 });
const call = async (userId: string | null, method: string, url: string, payload?: unknown) => {
  const r = await app.inject({ method: method as 'GET', url: `/api/v1/whatsapp${url}`, payload: payload as object,
    headers: userId ? { authorization: `Bearer ${token(userId)}` } : {} });
  if (r.statusCode >= 500) console.error(`500 ${method} ${url}: ${r.body}`);
  return { status: r.statusCode, body: r.body ? (() => { try { return JSON.parse(r.body); } catch { return r.body; } })() : null, raw: r.body };
};
const APP_SECRET = 'app-secret-for-tests-0123456789';
const VERIFY = 'verify-token-for-tests-0123456789';
const ACCESS = 'EAAG-test-access-token-abcdefghijklmnop-WXYZ';
const sign = (body: string) => `sha256=${crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
const webhook = (payload: unknown, signature?: string | null) => {
  const body = JSON.stringify(payload);
  return app.inject({ method: 'POST', url: '/api/v1/whatsapp/webhook', payload: body,
    headers: { 'content-type': 'application/json', ...(signature === null ? {} : { 'x-hub-signature-256': signature ?? sign(body) }) } });
};
const msgs = () => sql<{ id: string; status: string; attempts: number; error_class: string | null; meta_message_id: string | null; event_type: string; recipient_id: string }[]>`
  SELECT id, status, attempts, error_class, meta_message_id, event_type, recipient_id FROM whatsapp_messages ORDER BY id`;
let version = 1;
async function queueEvent(type: 'assigned' | 'escalated' | 'priority_changed', assignee: string, actor: string | null = null, meta: object = {}) {
  await sql`INSERT INTO queue_events (queue_item_id, event_type, actor_id, from_status, to_status, to_assignee, reason, version, metadata, created_at)
            VALUES (${ids.item}::uuid, ${type}, ${actor}::uuid, 'new', 'assigned', ${assignee}::uuid, ${type === 'escalated' ? 'سبب' : null}, ${++version}, ${JSON.stringify(meta)}::jsonb, now())`;
}

before(async () => {
  assert.match(config.WHATSAPP_GRAPH_BASE_URL, /^http:\/\/127\.0\.0\.1:/, 'tests must never point at Meta');
  await new Promise<void>((r) => server.listen(Number(new URL(config.WHATSAPP_GRAPH_BASE_URL).port), '127.0.0.1', () => r()));
  assert.ok((server.address() as AddressInfo).port);
  app = await buildApp({ rateLimit: false, logger: false });
  await app.ready();
  // Seed: roles, users, a program, a team, a queue item.
  for (const [key, ar] of [['admin', 'مدير النظام'], ['supervisor', 'مشرف'], ['agent', 'موظف رصد']])
    await sql`INSERT INTO roles (key, name_ar, name_en, is_system) VALUES (${key}, ${ar}, ${key}, true) ON CONFLICT (key) DO NOTHING`;
  const role = async (k: string) => (await sql<{ id: string }[]>`SELECT id FROM roles WHERE key = ${k}`)[0].id;
  const user = async (email: string, name: string, roleKey: string) =>
    (await sql<{ id: string }[]>`INSERT INTO users (email, full_name, password_hash, role_id) VALUES (${email}, ${name}, 'x', ${await role(roleKey)}::uuid) RETURNING id`)[0].id;
  ids.admin = await user('wa-admin@test.invalid', 'مسؤول واتساب', 'admin');
  ids.noperm = await user('wa-noperm@test.invalid', 'بلا صلاحية', 'admin');
  ids.viewer = await user('wa-viewer@test.invalid', 'مطّلع', 'agent');
  ids.agent = await user('wa-agent@test.invalid', 'موظف أول', 'agent');
  ids.agent2 = await user('wa-agent2@test.invalid', 'موظف ثانٍ', 'agent');
  ids.sup = await user('wa-sup@test.invalid', 'مشرف أول', 'supervisor');
  for (const p of ['whatsapp:view', 'whatsapp:configure', 'whatsapp:toggle', 'whatsapp:recipients', 'whatsapp:templates', 'whatsapp:log', 'whatsapp:test_send'])
    await sql`INSERT INTO user_permissions (user_id, permission_key) VALUES (${ids.admin}::uuid, ${p})`;
  await sql`INSERT INTO user_permissions (user_id, permission_key) VALUES (${ids.viewer}::uuid, 'whatsapp:view')`;
  ids.program = (await sql<{ id: string }[]>`INSERT INTO programs (key, name_ar, name_en) VALUES ('wa_test', 'إيجار', 'Ejar') RETURNING id`)[0].id;
  ids.team = (await sql<{ id: string }[]>`INSERT INTO teams (name) VALUES ('فريق الاختبار') RETURNING id`)[0].id;
  await sql`INSERT INTO team_programs (team_id, program_id) VALUES (${ids.team}::uuid, ${ids.program}::uuid)`;
  await sql`INSERT INTO team_members (team_id, user_id, kind) VALUES (${ids.team}::uuid, ${ids.agent}::uuid, 'agent'), (${ids.team}::uuid, ${ids.sup}::uuid, 'supervisor')`;
  ids.item = (await sql<{ id: string }[]>`INSERT INTO queue_items (interaction_type, post_id, post_posted_at, program_id, program_snapshot, team_id, status, assignee_id, section)
    VALUES ('post', gen_random_uuid(), now(), ${ids.program}::uuid, '{"name":"إيجار"}'::jsonb, ${ids.team}::uuid, 'assigned', ${ids.agent}::uuid, 'general') RETURNING id`)[0].id;
  await sql`INSERT INTO queue_events (queue_item_id, event_type, to_status, version) VALUES (${ids.item}::uuid, 'created', 'new', 1)`;
  resetSchemaCache();
});

after(async () => {
  await app?.close();
  if (server.listening) server.close();
  await sql.end({ timeout: 2 });
});

test('1. permissions: no grant → 403 on every area; view-only cannot change anything', async () => {
  for (const [m, u] of [['GET', '/settings'], ['PUT', '/settings'], ['GET', '/recipients'], ['GET', '/templates'], ['GET', '/messages'], ['POST', '/test-send'], ['POST', '/channel']])
    assert.equal((await call(ids.noperm, m, u, {})).status, 403, `${m} ${u} without permission`);
  assert.equal((await call(ids.viewer, 'GET', '/settings')).status, 200);
  assert.equal((await call(ids.viewer, 'PUT', '/settings', { apiVersion: 'v21.0' })).status, 403);
  assert.equal((await call(ids.viewer, 'POST', '/channel', { enabled: true })).status, 403);
  assert.equal((await call(ids.viewer, 'GET', '/messages')).status, 403);
  assert.equal((await call(null, 'GET', '/settings')).status, 401);
});

test('2. settings: secrets are write-only, encrypted at rest, absent from responses and audit', async () => {
  const r = await call(ids.admin, 'PUT', '/settings', { wabaId: '1234567890', phoneNumberId: '9876543210', apiVersion: 'v21.0', accessToken: ACCESS, appSecret: APP_SECRET, verifyToken: VERIFY });
  assert.equal(r.status, 200);
  for (const secret of [ACCESS, APP_SECRET, VERIFY]) assert.ok(!r.raw.includes(secret), 'secret echoed in response');
  assert.equal(r.body.accessTokenLast4, 'WXYZ');
  assert.equal(r.body.state, 'disabled', 'configured but not enabled');
  const [row] = await sql`SELECT access_token_encrypted, app_secret_encrypted FROM whatsapp_settings`;
  assert.ok(!String(row.access_token_encrypted).includes('EAAG') && !String(row.app_secret_encrypted).includes('app-secret'), 'stored encrypted');
  const audits = await sql`SELECT new_value::text AS v FROM audit_log WHERE action = 'whatsapp.settings_update'`;
  assert.ok(audits.length > 0 && audits.every((a) => ![ACCESS, APP_SECRET, VERIFY].some((s) => a.v.includes(s))), 'audit carries field names only');
  assert.equal((await call(ids.admin, 'PUT', '/settings', { apiVersion: '21' })).status, 400, 'version format');
});

test('3. verification is read-only against Meta and records health', async () => {
  mock.requests = [];
  mock.templates = [];
  const ok = await call(ids.admin, 'POST', '/settings/verify');
  assert.equal(ok.body.ok, true);
  assert.ok(mock.requests.every((q) => q.method === 'GET'), 'no POST to Meta during verification');
  assert.equal(mock.requests[0].auth, `Bearer ${ACCESS}`);
  mock.phone = { status: 401, body: { error: { code: 190, message: 'Invalid OAuth access token' } } };
  const bad = await call(ids.admin, 'POST', '/settings/verify');
  assert.equal(bad.body.ok, false);
  assert.equal(bad.body.error.class, 'config');
  assert.equal((await call(ids.admin, 'GET', '/settings')).body.state, 'error');
  mock.phone = { status: 200, body: { display_phone_number: '+966 11 000 0000', verified_name: 'Radar Test' } };
  assert.equal((await call(ids.admin, 'POST', '/settings/verify')).body.ok, true);
});

test('4. templates: shape validated; sending status only from Meta sync', async () => {
  const bad = await call(ids.admin, 'POST', '/templates', { name: 'radar_alert', language: 'ar', bodyPreview: 'تنبيه {{1}} {{2}}', variables: ['program'] });
  assert.equal(bad.status, 400, 'placeholder count mismatch refused');
  const ok = await call(ids.admin, 'POST', '/templates', { name: 'radar_alert', language: 'ar', eventType: 'interaction_assigned',
    bodyPreview: 'رادار 360 | تنبيه رصد\nالبرنامج: {{1}}\nنوع التنبيه: {{2}}\nالأولوية: {{3}}\nرابط التفاصيل: {{4}}', variables: ['program', 'alert_type', 'priority', 'details_url'] });
  assert.equal(ok.status, 200); ids.template = ok.body.id;
  assert.equal(ok.body.metaStatus, 'draft');
  const draft2 = await call(ids.admin, 'POST', '/templates', { name: 'radar_pending', language: 'ar', bodyPreview: 'تنبيه {{1}}', variables: ['program'] });
  ids.pendingTemplate = draft2.body.id;
  const prev = await call(ids.admin, 'GET', `/templates/${ids.template}/preview`);
  assert.match(prev.body.preview, /البرنامج: إيجار/);
  // Meta reports one approved (matching variables) and one still pending.
  mock.templates = [
    { id: 'm1', name: 'radar_alert', language: 'ar', status: 'APPROVED', components: [{ type: 'BODY', text: 'رادار 360 | تنبيه رصد البرنامج: {{1}} نوع التنبيه: {{2}} الأولوية: {{3}} رابط التفاصيل: {{4}}' }] },
    { id: 'm2', name: 'radar_pending', language: 'ar', status: 'PENDING', components: [{ type: 'BODY', text: 'تنبيه {{1}}' }] },
    { id: 'm3', name: 'not_here', language: 'en_US', status: 'APPROVED' },
  ];
  const sync = await call(ids.admin, 'POST', '/templates/sync');
  assert.equal(sync.body.updated, 2);
  assert.equal(sync.body.unregistered.length, 1);
  const list = (await call(ids.admin, 'GET', '/templates')).body.items;
  assert.equal(list.find((t: any) => t.name === 'radar_alert').meta_status, 'approved');
  assert.equal(list.find((t: any) => t.name === 'radar_pending').meta_status, 'pending');
});

test('5. recipients: E.164 validation, duplicates, consent, number change resets consent', async () => {
  assert.equal((await call(ids.admin, 'POST', '/recipients', { userId: ids.agent, phone: '0501234567' })).status, 400, 'no country code');
  const a = await call(ids.admin, 'POST', '/recipients', { userId: ids.agent, phone: '+966 50 123 4567', optIn: { method: 'نموذج موافقة موقّع' } });
  assert.equal(a.status, 200); ids.rAgent = a.body.id;
  assert.equal((await call(ids.admin, 'POST', '/recipients', { userId: ids.agent2, phone: '+966501234567' })).status, 409, 'same number twice');
  const b = await call(ids.admin, 'POST', '/recipients', { userId: ids.agent2, phone: '+966502222222' });
  ids.rAgent2 = b.body.id; // pending consent
  const s = await call(ids.admin, 'POST', '/recipients', { userId: ids.sup, phone: '+966503333333', isSupervisor: true, optIn: { method: 'بريد موافقة' } });
  ids.rSup = s.body.id;
  const list = await call(ids.admin, 'GET', '/recipients');
  assert.ok(!list.raw.includes('501234567'), 'full number never returned');
  assert.equal(list.body.items.find((r: any) => r.id === ids.rAgent).phone, '••••4567');
  const [db] = await sql`SELECT phone_encrypted FROM whatsapp_recipients WHERE id = ${ids.rAgent}::uuid`;
  assert.ok(!String(db.phone_encrypted).includes('966'), 'number encrypted at rest');
});

test('6. channel cannot be enabled before configuration; enabling starts from now (no replay)', async () => {
  await queueEvent('assigned', ids.agent); // happened while disabled
  const en = await call(ids.admin, 'POST', '/channel', { enabled: true });
  assert.equal(en.status, 200); assert.equal(en.body.enabled, true);
  assert.equal((await call(ids.admin, 'PUT', '/events/interaction_assigned', { enabled: true, templateId: ids.template })).status, 200);
  assert.equal((await call(ids.admin, 'PUT', '/events/crisis_potential', { enabled: true, templateId: ids.template })).status, 400, 'unavailable event refused');
  await whatsappTick(); // first sight of each source: cursor = now, nothing replayed
  assert.equal((await msgs()).length, 0, 'event from before enabling is not sent');
});

test('7. detection → queue → send through mock; second pass sends nothing (idempotent)', async () => {
  mock.requests = [];
  await queueEvent('assigned', ids.agent, ids.sup);
  const r1 = await whatsappTick();
  assert.equal((r1 as any).queued, 1);
  const [m] = await msgs();
  assert.equal(m.status, 'accepted', 'accepted = Meta took the request, not delivered');
  assert.match(m.meta_message_id!, /^wamid\.TEST/);
  const sent = mock.requests.find((q) => q.method === 'POST')!;
  assert.equal(sent.body.type, 'template');
  assert.equal(sent.body.template.name, 'radar_alert');
  assert.equal(sent.body.to, '966501234567');
  const params = sent.body.template.components[0].parameters.map((p: any) => p.text);
  assert.equal(params[0], 'إيجار');
  assert.ok(params.every((p: string) => !/\n/.test(p) && p.length > 0));
  await whatsappTick();
  assert.equal((await msgs()).length, 1, 'no duplicate on re-run');
});

test('8. self-claim, pending consent and unapproved template produce no message', async () => {
  await queueEvent('assigned', ids.agent, ids.agent); // self-claim
  await queueEvent('assigned', ids.agent2, ids.sup); // agent2 has no consent
  await call(ids.admin, 'PUT', '/events/ticket_escalated', { enabled: true, templateId: ids.pendingTemplate }); // template not approved
  await queueEvent('escalated', ids.agent, ids.agent);
  await whatsappTick();
  assert.equal((await msgs()).length, 1);
  const s = (await call(ids.admin, 'GET', '/settings')).body;
  assert.equal(s.lastErrorCode, 'template_not_approved');
});

test('9. rate limit → backoff and retry; permanent error → no retry', async () => {
  mock.sendQueue = [{ status: 429, body: { error: { code: 130429, message: 'Rate limit hit' } } }];
  await queueEvent('assigned', ids.agent, ids.sup);
  await whatsappTick();
  let m = (await msgs()).at(-1)!;
  assert.equal(m.status, 'queued'); assert.equal(m.error_class, 'rate_limited'); assert.equal(m.attempts, 1);
  await sql`UPDATE whatsapp_messages SET next_attempt_at = now() WHERE id = ${m.id}::bigint`;
  await whatsappTick();
  m = (await msgs()).at(-1)!;
  assert.equal(m.status, 'accepted'); assert.equal(m.attempts, 2);
  const attempts = await sql`SELECT outcome FROM whatsapp_message_attempts WHERE message_id = ${m.id}::bigint ORDER BY attempt_no`;
  assert.deepEqual(attempts.map((a) => a.outcome), ['rate_limited', 'accepted']);
  mock.sendQueue = [{ status: 400, body: { error: { code: 131026, message: 'Message undeliverable' } } }];
  await queueEvent('assigned', ids.agent, ids.sup);
  await whatsappTick();
  m = (await msgs()).at(-1)!;
  assert.equal(m.status, 'failed'); assert.equal(m.error_class, 'permanent'); assert.equal(m.attempts, 1);
  assert.equal((await call(ids.admin, 'POST', `/messages/${m.id}/retry`)).status, 400, 'permanent failures cannot be retried');
});

test('10. connection dropped mid-send → uncertain, never resent automatically', async () => {
  mock.sendQueue = ['reset'];
  await queueEvent('assigned', ids.agent, ids.sup);
  await whatsappTick();
  const m = (await msgs()).at(-1)!;
  assert.equal(m.status, 'failed'); assert.equal(m.error_class, 'uncertain');
  await whatsappTick();
  assert.equal((await msgs()).at(-1)!.attempts, 1, 'not retried');
  const r = await call(ids.admin, 'POST', `/messages/${m.id}/retry`, {});
  assert.equal(r.status, 409, 'explicit acknowledgement of duplicate risk required');
  assert.equal((await call(ids.admin, 'POST', `/messages/${m.id}/retry`, { acknowledgeDuplicateRisk: true })).status, 200);
});

test('11. webhook: verification handshake, signature enforcement, idempotent forward-only statuses', async () => {
  const good = await app.inject({ method: 'GET', url: `/api/v1/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=12345` });
  assert.equal(good.statusCode, 200); assert.equal(good.body, '12345');
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong-token-0000000000&hub.challenge=1' })).statusCode, 403);
  const [m] = await msgs();
  const status = (s: string, ts: number) => ({ object: 'whatsapp_business_account', entry: [{ id: '1234567890', changes: [{ field: 'messages',
    value: { metadata: { phone_number_id: '9876543210' }, statuses: [{ id: m.meta_message_id, status: s, timestamp: String(ts), recipient_id: '966501234567' }] } }] }] });
  assert.equal((await webhook(status('delivered', 1760000000), null)).statusCode, 401, 'unsigned');
  assert.equal((await webhook(status('delivered', 1760000000), 'sha256=' + '0'.repeat(64))).statusCode, 401, 'forged');
  assert.equal((await webhook(status('delivered', 1760000000))).statusCode, 200);
  assert.equal((await msgs())[0].status, 'delivered');
  assert.equal((await webhook(status('sent', 1759999990))).statusCode, 200, 'late «sent»');
  assert.equal((await msgs())[0].status, 'delivered', 'never moves backwards');
  await webhook(status('delivered', 1760000000)); // replay
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM whatsapp_status_events WHERE meta_message_id = ${m.meta_message_id}`;
  assert.equal(n, 2, 'one row per (message, status)');
  await webhook(status('read', 1760000100));
  assert.equal((await msgs())[0].status, 'read');
});

test('12. opt-out via inbound «إيقاف» cancels queued messages; opted-out receives nothing', async () => {
  await call(ids.admin, 'POST', '/channel', { paused: true });
  await queueEvent('assigned', ids.agent, ids.sup);
  await whatsappTick();
  const queued = (await msgs()).at(-1)!;
  assert.equal(queued.status, 'queued', 'paused: waits');
  const inbound = { object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '9876543210' },
    messages: [{ from: '966501234567', id: 'wamid.IN1', type: 'text', text: { body: 'إيقاف' } }] } }] }] };
  assert.equal((await webhook(inbound)).statusCode, 200);
  const [r] = await sql`SELECT opt_in_status, opt_out_source FROM whatsapp_recipients WHERE id = ${ids.rAgent}::uuid`;
  assert.equal(r.opt_in_status, 'opted_out'); assert.equal(r.opt_out_source, 'webhook');
  assert.equal((await msgs()).at(-1)!.status, 'cancelled');
  await call(ids.admin, 'POST', '/channel', { paused: false });
  await queueEvent('assigned', ids.agent, ids.sup);
  const before = (await msgs()).length;
  await whatsappTick();
  assert.equal((await msgs()).length, before, 'opted-out recipient gets nothing');
  await call(ids.admin, 'POST', `/recipients/${ids.rAgent}/opt-in`, { method: 'موافقة جديدة مكتوبة' });
});

test('13. paused beyond retention → cancelled, never sent late', async () => {
  await call(ids.admin, 'POST', '/channel', { paused: true });
  await queueEvent('assigned', ids.agent, ids.sup);
  await whatsappTick();
  const m = (await msgs()).at(-1)!;
  await sql`UPDATE whatsapp_messages SET expires_at = now() - interval '1 second' WHERE id = ${m.id}::bigint`;
  await call(ids.admin, 'POST', '/channel', { paused: false });
  mock.requests = [];
  await whatsappTick();
  assert.equal((await msgs()).find((x) => x.id === m.id)!.status, 'cancelled');
  assert.equal(mock.requests.filter((q) => q.method === 'POST').length, 0);
});

test('14. per-minute limit caps sends; the rest wait', async () => {
  await call(ids.admin, 'PUT', '/settings', { limits: { maxPerMinute: 1 } });
  await sql`UPDATE whatsapp_messages SET accepted_at = accepted_at - interval '2 minutes' WHERE accepted_at IS NOT NULL`;
  await queueEvent('assigned', ids.agent, ids.sup);
  await queueEvent('assigned', ids.agent, ids.sup);
  await whatsappTick();
  const recent = (await msgs()).slice(-2);
  assert.deepEqual(recent.map((m) => m.status).sort(), ['accepted', 'queued']);
  await call(ids.admin, 'PUT', '/settings', { limits: { maxPerMinute: 20 } });
});

test('15. self-service: optional alert can be switched off, mandatory cannot', async () => {
  const me = await app.inject({ method: 'GET', url: '/api/v1/whatsapp/me', headers: { authorization: `Bearer ${token(ids.agent)}` } });
  assert.equal(JSON.parse(me.body).registered, true);
  assert.ok(!me.body.includes('501234567'));
  const put = (subs: unknown) => app.inject({ method: 'PUT', url: '/api/v1/whatsapp/me/subscriptions', payload: { subscriptions: subs }, headers: { authorization: `Bearer ${token(ids.agent)}` } });
  assert.equal((await put([{ eventType: 'interaction_assigned', enabled: false }])).statusCode, 200);
  assert.equal((await put([{ eventType: 'ticket_escalated', enabled: false }])).statusCode, 403, 'mandatory');
  await queueEvent('assigned', ids.agent, ids.sup);
  const before = (await msgs()).length;
  await whatsappTick();
  assert.equal((await msgs()).length, before, 'switched-off optional alert not sent');
  await put([{ eventType: 'interaction_assigned', enabled: true }]);
});

test('16. log masks numbers and filters; test send needs approved template and consent', async () => {
  const log = await call(ids.admin, 'GET', '/messages?status=read');
  assert.equal(log.status, 200);
  assert.ok(log.body.items.length >= 1 && log.body.items.every((m: any) => m.status === 'read'));
  assert.ok(!log.raw.includes('501234567'));
  assert.equal(log.body.items[0].recipient_phone, '••••4567');
  assert.equal((await call(ids.admin, 'POST', '/test-send', { recipientId: ids.rAgent2, templateId: ids.template })).status, 400, 'no consent');
  assert.equal((await call(ids.admin, 'POST', '/test-send', { recipientId: ids.rAgent, templateId: ids.pendingTemplate })).status, 400, 'not approved');
  const t = await call(ids.admin, 'POST', '/test-send', { recipientId: ids.rAgent, templateId: ids.template });
  assert.equal(t.status, 200);
});

test('17. isolation: Meta unreachable never throws out of the tick; alerts (Telegram/email) run independently', async () => {
  const savedPhone = mock.phone; server.close(); // Meta gone
  await queueEvent('assigned', ids.agent, ids.sup);
  await assert.doesNotReject(whatsappTick());
  const m = (await msgs()).at(-1)!;
  assert.ok(['queued', 'failed'].includes(m.status));
  assert.deepEqual(await evaluateRules(60), { evaluated: 0, sent: 0 }, 'alerts engine unaffected');
  mock.phone = savedPhone;
});

test('18. every detection source is valid SQL; kill switch, failed news source and SLA breach become events', async () => {
  const { detectEvents } = await import('../modules/whatsapp/detect.js');
  const { loadSettings } = await import('../modules/whatsapp/settings.js');
  const { WHATSAPP_EVENTS } = await import('@mip/shared');
  for (const e of WHATSAPP_EVENTS.filter((x) => x.availability !== 'unavailable'))
    await sql`INSERT INTO whatsapp_event_settings (event_type, enabled, template_id) VALUES (${e.key}, true, ${ids.template}::uuid)
              ON CONFLICT (event_type) DO UPDATE SET enabled = true, template_id = EXCLUDED.template_id`;
  const errors: string[] = [];
  const onError = (source: string, err: unknown) => errors.push(`${source}: ${err instanceof Error ? err.message : String(err)}`);
  await sql`DELETE FROM whatsapp_source_cursors`;
  await detectEvents(await loadSettings(), onError); // initializes every cursor at now
  // Source rows created after the cursors.
  await sql`INSERT INTO kill_switches (scope, reason, activated_by) VALUES ('global', 'سبب داخلي لا يُرسل', ${ids.admin}::uuid)`;
  const [src] = await sql<{ id: string }[]>`INSERT INTO news_sources (name_ar, base_url) VALUES ('صحيفة اختبار', 'https://news.example') RETURNING id`;
  await sql`INSERT INTO news_source_health (source_id, state, consecutive_failures, updated_at) VALUES (${src.id}::uuid, 'failed', 6, now())`;
  for (let i = 0; i < 5; i++) await sql`INSERT INTO news_fetch_jobs (source_id, status, error) VALUES (${src.id}::uuid, 'failed', 'timeout')`;
  await sql`UPDATE whatsapp_source_cursors SET position = now() - interval '2 hours', started_at = now() - interval '2 hours' WHERE source = 'sla_breaches'`;
  const [slaItem] = await sql<{ id: string }[]>`INSERT INTO queue_items (interaction_type, post_id, post_posted_at, program_id, program_snapshot, team_id, status, section, entered_at)
    VALUES ('post', gen_random_uuid(), now(), ${ids.program}::uuid, '{"name":"إيجار"}'::jsonb, ${ids.team}::uuid, 'new', 'general', now() - interval '90 minutes') RETURNING id`;
  const events = await detectEvents(await loadSettings(), onError);
  assert.deepEqual(errors, [], 'no adapter failed');
  const types = new Set(events.map((e) => e.eventType));
  for (const t of ['x_collection_stopped', 'source_failed', 'news_jobs_failed', 'sla_breached', 'tickets_overdue']) assert.ok(types.has(t), `${t} detected`);
  const stop = events.find((e) => e.eventType === 'x_collection_stopped')!;
  assert.ok(!JSON.stringify(stop.values).includes('سبب داخلي'), 'operator free text never leaves the platform');
  assert.ok(events.find((e) => e.dedupeKey === `sla:${slaItem.id}`));
  const again = await detectEvents(await loadSettings(), onError);
  assert.equal(again.filter((e) => ['x_collection_stopped', 'source_failed', 'sla_breached', 'tickets_overdue', 'news_jobs_failed'].includes(e.eventType)).length, 0, 'second pass records nothing new');
});
