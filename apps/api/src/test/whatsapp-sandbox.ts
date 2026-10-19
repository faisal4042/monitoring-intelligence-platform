/**
 * Local WhatsApp sandbox for UI review — NEVER for production. Runs the API against an isolated test database
 * with a mock Graph API, seeds sample users/recipients/templates/messages, and drives the WhatsApp tick.
 * No request can reach Meta: WHATSAPP_GRAPH_BASE_URL must point at 127.0.0.1 or the script exits.
 *
 *   DATABASE_URL=…/wa_test WHATSAPP_GRAPH_BASE_URL=http://127.0.0.1:5498 APP_URL=http://127.0.0.1:5497 API_PORT=3499 \
 *   NODE_ENV=test JWT_SECRET=… JWT_REFRESH_SECRET=… SANDBOX_PASSWORD=… npx tsx src/test/whatsapp-sandbox.ts
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { sql } from '@mip/db';
import { config } from '@mip/config';
import { buildApp } from '../app.js';
import { hashPassword } from '../plugins/auth.js';
import { whatsappTick } from '../workers/whatsapp.worker.js';
import { encryptJson } from '../lib/crypto.js';
import { phoneHash } from '../modules/whatsapp/webhook.js';
import { encryptSecret } from '../modules/whatsapp/settings.js';

if (!/^http:\/\/127\.0\.0\.1:/.test(config.WHATSAPP_GRAPH_BASE_URL)) { console.error('sandbox refuses a non-local Graph API'); process.exit(1); }
const password = process.env.SANDBOX_PASSWORD;
if (!password || password.length < 16) { console.error('SANDBOX_PASSWORD (16+ chars) required'); process.exit(1); }

// ── Mock Graph API: accepts every send, reports two approved templates ──
let n = 0;
http.createServer((req, res) => {
  let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && /\/messages$/.test(req.url!)) {
      // Every fifth send fails permanently so the log shows a failure path.
      if (++n % 5 === 0) { res.statusCode = 400; return res.end(JSON.stringify({ error: { code: 131026, message: 'Message undeliverable' } })); }
      return res.end(JSON.stringify({ messages: [{ id: `wamid.SANDBOX${crypto.randomBytes(6).toString('hex')}` }] }));
    }
    if (/message_templates/.test(req.url!)) return res.end(JSON.stringify({ data: [
      { id: 't1', name: 'radar_monitoring_alert', language: 'ar', status: 'APPROVED', components: [{ type: 'BODY', text: 'رادار 360 | تنبيه رصد\nالبرنامج: {{1}}\nنوع التنبيه: {{2}}\nالأولوية: {{3}}\nتاريخ الرصد: {{4}}\nملخص: {{5}}\nرقم التذكرة: {{6}}\nرابط التفاصيل: {{7}}' }] },
      { id: 't2', name: 'radar_ops_alert', language: 'ar', status: 'PENDING', components: [{ type: 'BODY', text: 'رادار 360 | تنبيه تشغيل\n{{1}}\n{{2}}' }] },
      { id: 't3', name: 'radar_alert_en', language: 'en_US', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT' },
    ] }));
    res.end(JSON.stringify({ display_phone_number: '+966 11 000 0000', verified_name: 'Radar 360 (تجريبي)', quality_rating: 'GREEN' }));
  });
}).listen(Number(new URL(config.WHATSAPP_GRAPH_BASE_URL).port), '127.0.0.1');

async function seed() {
  const hash = await hashPassword(password!);
  for (const [key, ar] of [['admin', 'مدير النظام'], ['supervisor', 'مشرف'], ['agent', 'موظف رصد']])
    await sql`INSERT INTO roles (key, name_ar, name_en, is_system) VALUES (${key}, ${ar}, ${key}, true) ON CONFLICT (key) DO NOTHING`;
  const role = async (k: string) => (await sql<{ id: string }[]>`SELECT id FROM roles WHERE key = ${k}`)[0].id;
  const user = async (email: string, name: string, k: string) =>
    (await sql<{ id: string }[]>`INSERT INTO users (email, full_name, password_hash, role_id) VALUES (${email}, ${name}, ${hash}, ${await role(k)}::uuid) RETURNING id`)[0].id;
  const admin = await user('sandbox-admin@mip.invalid', 'مسؤول الإشعارات', 'admin');
  const agent = await user('sandbox-agent@mip.invalid', 'سارة العتيبي', 'agent');
  const agent2 = await user('sandbox-agent2@mip.invalid', 'خالد الشهري', 'agent');
  const sup = await user('sandbox-sup@mip.invalid', 'نورة القحطاني', 'supervisor');
  await user('sandbox-viewer@mip.invalid', 'مطّلع على الإعدادات', 'agent');
  await sql`INSERT INTO permissions (key, domain, description_ar) VALUES ('alerts:read','alerts','x'),('alerts:write','alerts','x'),('programs:read','programs','x') ON CONFLICT (key) DO NOTHING`;
  for (const p of ['alerts:read', 'alerts:write', 'programs:read', 'whatsapp:view', 'whatsapp:configure', 'whatsapp:toggle', 'whatsapp:recipients', 'whatsapp:templates', 'whatsapp:log', 'whatsapp:test_send'])
    await sql`INSERT INTO user_permissions (user_id, permission_key) VALUES (${admin}::uuid, ${p}) ON CONFLICT DO NOTHING`;
  const viewer = (await sql<{ id: string }[]>`SELECT id FROM users WHERE email = 'sandbox-viewer@mip.invalid'`)[0].id;
  await sql`INSERT INTO user_permissions (user_id, permission_key) VALUES (${viewer}::uuid, 'whatsapp:view') ON CONFLICT DO NOTHING`;
  const programs: string[] = [];
  for (const [k, ar] of [['ejar', 'إيجار'], ['rega', 'الهيئة العامة للعقار'], ['mullak', 'ملاك']])
    programs.push((await sql<{ id: string }[]>`INSERT INTO programs (key, name_ar, name_en) VALUES (${k}, ${ar}, ${k}) ON CONFLICT (key) DO UPDATE SET name_ar = EXCLUDED.name_ar RETURNING id`)[0].id);
  const team = (await sql<{ id: string }[]>`INSERT INTO teams (name) VALUES ('فريق إيجار') RETURNING id`)[0].id;
  await sql`INSERT INTO team_programs (team_id, program_id) VALUES (${team}::uuid, ${programs[0]}::uuid) ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO team_members (team_id, user_id, kind) VALUES (${team}::uuid, ${agent}::uuid, 'agent'), (${team}::uuid, ${sup}::uuid, 'supervisor')`;
  await sql`UPDATE whatsapp_settings SET waba_id = '102030405060', phone_number_id = '908070605040', api_version = 'v21.0',
    access_token_encrypted = ${encryptSecret('EAAG-sandbox-token-not-real-0000-ABCD')}, access_token_last4 = 'ABCD',
    app_secret_encrypted = ${encryptSecret('sandbox-app-secret-0123456789')}, verify_token_encrypted = ${encryptSecret('sandbox-verify-token-0123456789')},
    enabled = true, daily_limit = 500, monthly_limit = 10000, cost_estimate_per_message = 0.0124, cost_estimate_currency = 'USD',
    last_verified_at = now(), last_verified_ok = true, display_phone_number = '+966 11 000 0000', verified_name = 'Radar 360 (تجريبي)', webhook_verified_at = now() - interval '2 days', last_webhook_at = now() - interval '5 minutes'`;
  const tpl = (await sql<{ id: string }[]>`INSERT INTO whatsapp_templates (name, language, event_type, body_preview, variables, meta_status, meta_template_id, last_synced_at, created_by)
    VALUES ('radar_monitoring_alert', 'ar', 'interaction_assigned', ${'رادار 360 | تنبيه رصد\nالبرنامج: {{1}}\nنوع التنبيه: {{2}}\nالأولوية: {{3}}\nتاريخ الرصد: {{4}}\nملخص: {{5}}\nرقم التذكرة: {{6}}\nرابط التفاصيل: {{7}}'},
    ${['program', 'alert_type', 'priority', 'detected_at', 'summary', 'ticket_number', 'details_url']}, 'approved', 't1', now(), ${admin}::uuid) RETURNING id`)[0].id;
  await sql`INSERT INTO whatsapp_templates (name, language, body_preview, variables, meta_status, created_by) VALUES ('radar_ops_alert', 'ar', ${'رادار 360 | تنبيه تشغيل\n{{1}}\n{{2}}'}, ${['alert_type', 'summary']}, 'pending', ${admin}::uuid)`;
  for (const ev of ['interaction_assigned', 'ticket_escalated', 'ticket_urgent', 'sla_breached', 'x_collection_stopped'])
    await sql`INSERT INTO whatsapp_event_settings (event_type, enabled, template_id) VALUES (${ev}, true, ${tpl}::uuid)`;
  const rec = async (userId: string, phone: string, opts: { sup?: boolean; consent?: boolean }) => (await sql<{ id: string }[]>`
    INSERT INTO whatsapp_recipients (user_id, phone_encrypted, phone_hash, phone_last4, country_code, is_supervisor, opt_in_status, opt_in_at, opt_in_method, created_by)
    VALUES (${userId}::uuid, ${encryptJson({ v: phone })}, ${phoneHash(phone)}, ${phone.slice(-4)}, '+966', ${!!opts.sup}, ${opts.consent ? 'opted_in' : 'pending'},
            ${opts.consent ? sql`now() - interval '3 days'` : null}, ${opts.consent ? 'نموذج موافقة موقّع' : null}, ${admin}::uuid) RETURNING id`)[0].id;
  await rec(agent, '+966501112233', { consent: true });
  await rec(agent2, '+966502223344', {});
  await rec(sup, '+966503334455', { sup: true, consent: true });
  await sql`INSERT INTO whatsapp_routes (event_type, audience, created_by) VALUES ('ticket_escalated', 'supervisors', ${admin}::uuid)`;
  await sql`INSERT INTO whatsapp_routes (event_type, audience, program_id, created_by) VALUES ('sla_breached', 'program_team', ${programs[0]}::uuid, ${admin}::uuid)`;
  // Queue activity → real detection, queueing and (mock) sending.
  await whatsappTick(); // cursors at now
  const item = (await sql<{ id: string }[]>`INSERT INTO queue_items (interaction_type, post_id, post_posted_at, program_id, program_snapshot, team_id, status, assignee_id, section)
    VALUES ('post', gen_random_uuid(), now(), ${programs[0]}::uuid, '{"name":"إيجار"}'::jsonb, ${team}::uuid, 'assigned', ${agent}::uuid, 'general') RETURNING id`)[0].id;
  let v = 1;
  await sql`INSERT INTO queue_events (queue_item_id, event_type, to_status, version) VALUES (${item}::uuid, 'created', 'new', ${v})`;
  for (let i = 0; i < 6; i++) {
    await sql`INSERT INTO queue_events (queue_item_id, event_type, actor_id, from_status, to_status, to_assignee, reason, version, metadata)
      VALUES (${item}::uuid, ${i % 3 === 2 ? 'escalated' : 'assigned'}, ${sup}::uuid, 'new', 'assigned', ${agent}::uuid, ${i % 3 === 2 ? 'تصعيد للمراجعة' : null}, ${++v}, '{}'::jsonb)`;
    await whatsappTick();
  }
  // Statuses as Meta would report them.
  const accepted = await sql<{ id: string; meta_message_id: string }[]>`SELECT id, meta_message_id FROM whatsapp_messages WHERE status = 'accepted' ORDER BY id`;
  for (const [i, m] of accepted.entries()) {
    const next = i % 3 === 0 ? 'read' : i % 3 === 1 ? 'delivered' : 'sent';
    await sql`UPDATE whatsapp_messages SET status = ${next}, sent_at = now() - interval '4 minutes',
      delivered_at = ${next !== 'sent' ? sql`now() - interval '3 minutes'` : null}, read_at = ${next === 'read' ? sql`now() - interval '1 minute'` : null} WHERE id = ${m.id}::bigint`;
  }
  console.log(`seeded: ${accepted.length} delivered-path messages`);
}

const app = await buildApp({ rateLimit: false, logger: false });
await seed();
await app.listen({ host: '127.0.0.1', port: config.API_PORT });
console.log(`WHATSAPP_SANDBOX_READY http://127.0.0.1:${config.API_PORT}`);
setInterval(() => { void whatsappTick().catch((e) => console.error('tick', e)); }, 10_000);
