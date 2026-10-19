/**
 * WhatsApp administration API (/api/v1/whatsapp). Least privilege: each area has its own
 * permission (WHATSAPP_PERMISSIONS), none of which any role holds by default. Secrets are
 * write-only. Every administrative change is audited without secret values or phone numbers.
 * /me/* is self-service for any signed-in employee who is a registered recipient.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '@mip/db';
import {
  WHATSAPP_EVENTS, WHATSAPP_PERMISSIONS as W, WHATSAPP_TEMPLATE_VARIABLE_KEYS, maskPhone, normalizeE164, whatsappEvent,
  type TemplateMetaStatus,
} from '@mip/shared';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { encryptJson } from '../../lib/crypto.js';
import { createMetaClient } from './meta-client.js';
import { placeholderCount, renderPreview, buildParams } from './policy.js';
import { credentialsFrom, encryptSecret, loadSettings, publicSettings, recordIntegrationError, whatsappSchemaReady } from './settings.js';
import { enqueueTest } from './dispatch.js';
import { phoneHash } from './webhook.js';

const SAMPLE: Record<string, string> = {
  program: 'إيجار', alert_type: 'شكوى عالية الأولوية', priority: 'مرتفعة', detected_at: '2026-10-19 14:05',
  summary: 'تفاعل مُسند بانتظار المعالجة', ticket_number: 'MIP-2026-000123', details_url: 'https://radar.example/queue', count: '3',
};
const digits = (min: number, max: number) => z.string().regex(new RegExp(`^[0-9]{${min},${max}}$`), 'أرقام فقط');

const settingsSchema = z.object({
  wabaId: digits(5, 30).nullable().optional(),
  phoneNumberId: digits(5, 30).nullable().optional(),
  apiVersion: z.string().regex(/^v\d{1,3}\.\d{1,2}$/, 'صيغة الإصدار مثل v21.0').nullable().optional(),
  // Secrets: undefined = keep, null = clear, string = replace. Never echoed back.
  accessToken: z.string().min(20).max(1000).nullable().optional(),
  appSecret: z.string().min(16).max(200).nullable().optional(),
  verifyToken: z.string().min(16).max(200).nullable().optional(),
  limits: z.object({
    maxPerMinute: z.number().int().min(1).max(1000), dailyLimit: z.number().int().min(1).max(1_000_000).nullable(),
    monthlyLimit: z.number().int().min(1).max(10_000_000).nullable(), maxAttempts: z.number().int().min(1).max(10),
    backoffBaseSeconds: z.number().int().min(5).max(3600), backoffMaxSeconds: z.number().int().min(30).max(86400),
    retentionMinutes: z.number().int().min(5).max(10080),
  }).partial().optional(),
  thresholds: z.object({
    overdueDigestMinutes: z.number().int().min(30).max(10080), negativeMinFollowers: z.number().int().min(0).max(100_000_000),
    newsFailuresPerHour: z.number().int().min(1).max(1000), quotaAlertPercent: z.number().int().min(1).max(100),
  }).partial().optional(),
  costEstimate: z.object({ perMessage: z.number().min(0).max(1000), currency: z.string().regex(/^[A-Z]{3}$/) }).nullable().optional(),
});

const templateSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]{1,512}$/, 'اسم القالب كما سُجّل لدى Meta: أحرف إنجليزية صغيرة وأرقام وشرطة سفلية'),
  language: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, 'رمز اللغة مثل ar أو en_US'),
  eventType: z.string().nullable().optional(),
  category: z.enum(['UTILITY', 'MARKETING', 'AUTHENTICATION']).default('UTILITY'),
  bodyPreview: z.string().min(1).max(1024),
  variables: z.array(z.enum(WHATSAPP_TEMPLATE_VARIABLE_KEYS as [string, ...string[]])).max(10),
});

const META_STATUS: Record<string, TemplateMetaStatus> = {
  APPROVED: 'approved', PENDING: 'pending', IN_APPEAL: 'pending', PENDING_DELETION: 'disabled', REJECTED: 'rejected',
  PAUSED: 'paused', DISABLED: 'disabled', DELETED: 'disabled', LIMIT_EXCEEDED: 'disabled',
};

function assertTemplateShape(body: string, variables: readonly string[]) {
  const n = placeholderCount(body);
  if (n !== variables.length) throw badRequest(`القالب يحتوي ${n} متغير، بينما حُدّد ${variables.length}. يجب أن يتطابق العدد والترتيب ({{1}} … {{${Math.max(n, 1)}}}).`);
}

export default async function whatsappRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', async () => {
    if (!(await whatsappSchemaReady())) throw new HttpError(503, 'ميزة واتساب غير مفعّلة على قاعدة البيانات بعد (الترحيل 0055 لم يُطبَّق)', 'WHATSAPP_NOT_INSTALLED');
  });
  const can = (...p: string[]) => [app.requirePermission(...p)];

  // ── Settings and channel ──────────────────────────────────────────────
  app.get('/settings', { preHandler: can(W.VIEW, W.CONFIGURE, W.TOGGLE) }, async () => publicSettings(await loadSettings()));

  app.put('/settings', { preHandler: can(W.CONFIGURE) }, async (req) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const b = parsed.data; const l = b.limits ?? {}; const t = b.thresholds ?? {};
    const before = await loadSettings();
    if ((l.backoffBaseSeconds ?? before.backoff_base_seconds) > (l.backoffMaxSeconds ?? before.backoff_max_seconds)) throw badRequest('الحد الأقصى للانتظار يجب ألا يقل عن الانتظار الأساسي');
    const credentialsChanged = ['wabaId', 'phoneNumberId', 'apiVersion', 'accessToken'].some((k) => (b as Record<string, unknown>)[k] !== undefined);
    const enc = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : encryptSecret(v));
    const token = enc(b.accessToken), appSecret = enc(b.appSecret), verify = enc(b.verifyToken);
    await sql`
      UPDATE whatsapp_settings SET
        waba_id = ${b.wabaId === undefined ? before.waba_id : b.wabaId},
        phone_number_id = ${b.phoneNumberId === undefined ? before.phone_number_id : b.phoneNumberId},
        api_version = ${b.apiVersion === undefined ? before.api_version : b.apiVersion},
        access_token_encrypted = ${token === undefined ? before.access_token_encrypted : token},
        access_token_last4 = ${b.accessToken === undefined ? before.access_token_last4 : b.accessToken ? b.accessToken.slice(-4) : null},
        app_secret_encrypted = ${appSecret === undefined ? before.app_secret_encrypted : appSecret},
        verify_token_encrypted = ${verify === undefined ? before.verify_token_encrypted : verify},
        max_per_minute = ${l.maxPerMinute ?? before.max_per_minute},
        daily_limit = ${l.dailyLimit === undefined ? before.daily_limit : l.dailyLimit},
        monthly_limit = ${l.monthlyLimit === undefined ? before.monthly_limit : l.monthlyLimit},
        max_attempts = ${l.maxAttempts ?? before.max_attempts},
        backoff_base_seconds = ${l.backoffBaseSeconds ?? before.backoff_base_seconds},
        backoff_max_seconds = ${l.backoffMaxSeconds ?? before.backoff_max_seconds},
        retention_minutes = ${l.retentionMinutes ?? before.retention_minutes},
        overdue_digest_minutes = ${t.overdueDigestMinutes ?? before.overdue_digest_minutes},
        negative_min_followers = ${t.negativeMinFollowers ?? before.negative_min_followers},
        news_failures_per_hour = ${t.newsFailuresPerHour ?? before.news_failures_per_hour},
        quota_alert_percent = ${t.quotaAlertPercent ?? before.quota_alert_percent},
        cost_estimate_per_message = ${b.costEstimate === undefined ? before.cost_estimate_per_message : b.costEstimate?.perMessage ?? null},
        cost_estimate_currency = ${b.costEstimate === undefined ? before.cost_estimate_currency : b.costEstimate?.currency ?? null},
        last_verified_at = ${credentialsChanged ? null : before.last_verified_at}, last_verified_ok = ${credentialsChanged ? null : before.last_verified_ok},
        updated_by = ${req.user.id}::uuid, updated_at = now()
      WHERE id`;
    // Field names only — never a secret, never a value of a secret.
    const changed = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    await audit(req, { action: 'whatsapp.settings_update', entityType: 'whatsapp_settings', entityLabel: 'إعدادات واتساب', newValue: { fields: changed }, severity: 'warning' });
    return publicSettings(await loadSettings());
  });

  /** Read-only check against Meta: phone number + templates. Sends no message. */
  app.post('/settings/verify', { preHandler: can(W.CONFIGURE) }, async (req) => {
    const s = await loadSettings();
    const cred = credentialsFrom(s);
    if (!cred) throw badRequest('أكمل معرّف حساب الأعمال ومعرّف الرقم والإصدار ورمز الوصول أولًا');
    const client = createMetaClient(cred);
    const phone = await client.getPhoneNumber();
    if (!phone.ok) {
      await sql`UPDATE whatsapp_settings SET last_verified_at = now(), last_verified_ok = false WHERE id`;
      await recordIntegrationError(phone.error.code, phone.error.message);
      await audit(req, { action: 'whatsapp.verify', entityType: 'whatsapp_settings', newValue: { ok: false, code: phone.error.code } });
      return { ok: false, step: 'phone_number', error: phone.error };
    }
    const templates = await client.listTemplates();
    await sql`UPDATE whatsapp_settings SET last_verified_at = now(), last_verified_ok = ${templates.ok},
              display_phone_number = ${phone.data.display_phone_number ?? null}, verified_name = ${phone.data.verified_name ?? null} WHERE id`;
    if (!templates.ok) await recordIntegrationError(templates.error.code, templates.error.message);
    await audit(req, { action: 'whatsapp.verify', entityType: 'whatsapp_settings', newValue: { ok: templates.ok } });
    return {
      ok: templates.ok, step: templates.ok ? 'done' : 'templates',
      phone: { displayPhoneNumber: phone.data.display_phone_number, verifiedName: phone.data.verified_name, qualityRating: phone.data.quality_rating, codeVerificationStatus: phone.data.code_verification_status },
      templates: templates.ok ? { total: templates.data.length, approved: templates.data.filter((t) => t.status === 'APPROVED').length } : null,
      error: templates.ok ? null : templates.error,
    };
  });

  app.post('/channel', { preHandler: can(W.TOGGLE) }, async (req) => {
    const b = z.object({ enabled: z.boolean().optional(), paused: z.boolean().optional() }).parse(req.body ?? {});
    const before = await loadSettings();
    if (b.enabled && !credentialsFrom(before)) throw badRequest('لا يمكن تفعيل القناة قبل إكمال إعداد الاتصال');
    if (b.enabled && !before.enabled) {
      // A fresh start: detection resumes from now, never replaying what happened while disabled.
      await sql`DELETE FROM whatsapp_source_cursors`;
    }
    await sql`UPDATE whatsapp_settings SET enabled = COALESCE(${b.enabled ?? null}, enabled), paused = COALESCE(${b.paused ?? null}, paused),
              updated_by = ${req.user.id}::uuid, updated_at = now() WHERE id`;
    await audit(req, { action: 'whatsapp.channel', entityType: 'whatsapp_settings', oldValue: { enabled: before.enabled, paused: before.paused }, newValue: b, severity: 'warning' });
    return publicSettings(await loadSettings());
  });

  app.get('/stats', { preHandler: can(W.VIEW, W.LOG) }, async () => {
    const s = await loadSettings();
    const [c] = await sql<Record<string, number>[]>`
      SELECT
        count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh' AND NOT is_test)::int AS today_total,
        count(*) FILTER (WHERE accepted_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh')::int AS today_accepted,
        count(*) FILTER (WHERE failed_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh')::int AS today_failed,
        count(*) FILTER (WHERE accepted_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh')::int AS month_accepted,
        count(*) FILTER (WHERE failed_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh')::int AS month_failed,
        count(*) FILTER (WHERE status IN ('delivered','read') AND delivered_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Riyadh') AT TIME ZONE 'Asia/Riyadh')::int AS month_delivered,
        count(*) FILTER (WHERE status = 'queued')::int AS queued
      FROM whatsapp_messages WHERE created_at > now() - interval '32 days' OR status = 'queued'`;
    const estimate = s.cost_estimate_per_message === null ? null
      : { amount: Number((c.month_accepted * Number(s.cost_estimate_per_message)).toFixed(2)), currency: s.cost_estimate_currency, basis: 'تقدير مدخل يدويًا × الرسائل المقبولة هذا الشهر — ليس فاتورة Meta' };
    return { ...c, limits: { daily: s.daily_limit, monthly: s.monthly_limit, perMinute: s.max_per_minute }, costEstimate: estimate };
  });

  // ── Event types ───────────────────────────────────────────────────────
  app.get('/events', { preHandler: can(W.VIEW, W.CONFIGURE) }, async () => {
    const rows = await sql<{ event_type: string; enabled: boolean; template_id: string | null; template_name: string | null; template_status: string | null }[]>`
      SELECT es.event_type, es.enabled, es.template_id, t.name AS template_name, t.meta_status AS template_status
      FROM whatsapp_event_settings es LEFT JOIN whatsapp_templates t ON t.id = es.template_id`;
    const routes = await sql<{ event_type: string; n: number }[]>`SELECT event_type, count(*)::int AS n FROM whatsapp_routes WHERE is_active GROUP BY event_type`;
    return {
      items: WHATSAPP_EVENTS.map((d) => {
        const r = rows.find((x) => x.event_type === d.key);
        return { ...d, enabled: !!r?.enabled && d.availability !== 'unavailable', templateId: r?.template_id ?? null, templateName: r?.template_name ?? null,
          templateStatus: r?.template_status ?? null, routes: routes.find((x) => x.event_type === d.key)?.n ?? 0 };
      }),
    };
  });

  app.put('/events/:type', { preHandler: can(W.CONFIGURE) }, async (req) => {
    const { type } = req.params as { type: string };
    const def = whatsappEvent(type);
    if (!def) throw notFound('نوع التنبيه غير معروف');
    const b = z.object({ enabled: z.boolean(), templateId: z.string().uuid().nullable() }).parse(req.body);
    if (b.enabled && def.availability === 'unavailable') throw badRequest('هذا التنبيه غير متوفر في النظام بعد ولا يمكن تفعيله');
    if (b.enabled && !b.templateId) throw badRequest('اختر قالبًا قبل تفعيل التنبيه');
    if (b.templateId) {
      const [t] = await sql`SELECT id FROM whatsapp_templates WHERE id = ${b.templateId}::uuid AND is_active`;
      if (!t) throw badRequest('القالب غير موجود أو معطل');
    }
    await sql`
      INSERT INTO whatsapp_event_settings (event_type, enabled, template_id, updated_by) VALUES (${type}, ${b.enabled}, ${b.templateId}::uuid, ${req.user.id}::uuid)
      ON CONFLICT (event_type) DO UPDATE SET enabled = EXCLUDED.enabled, template_id = EXCLUDED.template_id, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    await audit(req, { action: 'whatsapp.event_update', entityType: 'whatsapp_event', entityLabel: def.label, newValue: b });
    return { ok: true };
  });

  // ── Templates ─────────────────────────────────────────────────────────
  app.get('/templates', { preHandler: can(W.VIEW, W.TEMPLATES, W.CONFIGURE) }, async () => ({
    items: await sql`SELECT id, name, language, event_type, category, body_preview, variables, meta_status, meta_template_id, meta_reason,
                     last_synced_at, is_active, updated_at FROM whatsapp_templates ORDER BY is_active DESC, name, language`,
    variables: WHATSAPP_TEMPLATE_VARIABLE_KEYS,
  }));

  app.post('/templates', { preHandler: can(W.TEMPLATES) }, async (req) => {
    const parsed = templateSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const b = parsed.data;
    assertTemplateShape(b.bodyPreview, b.variables);
    if (b.eventType && !whatsappEvent(b.eventType)) throw badRequest('نوع التنبيه غير معروف');
    const [row] = await sql`
      INSERT INTO whatsapp_templates (name, language, event_type, category, body_preview, variables, created_by)
      VALUES (${b.name}, ${b.language}, ${b.eventType ?? null}, ${b.category}, ${b.bodyPreview}, ${b.variables}, ${req.user.id}::uuid)
      ON CONFLICT (name, language) DO NOTHING RETURNING id`;
    if (!row) throw conflict('يوجد قالب بنفس الاسم واللغة');
    await audit(req, { action: 'whatsapp.template_create', entityType: 'whatsapp_template', entityId: row.id, entityLabel: `${b.name} (${b.language})` });
    return { id: row.id, metaStatus: 'draft' };
  });

  app.patch('/templates/:id', { preHandler: can(W.TEMPLATES) }, async (req) => {
    const { id } = req.params as { id: string };
    const b = templateSchema.partial().extend({ isActive: z.boolean().optional() }).parse(req.body);
    const [before] = await sql<{ name: string; language: string; body_preview: string; variables: string[]; meta_status: string }[]>`SELECT name, language, body_preview, variables, meta_status FROM whatsapp_templates WHERE id = ${id}::uuid`;
    if (!before) throw notFound('القالب غير موجود');
    if (b.name || b.language) throw badRequest('لا يمكن تغيير اسم القالب أو لغته؛ أنشئ قالبًا جديدًا');
    const body = b.bodyPreview ?? before.body_preview; const vars = b.variables ?? before.variables;
    assertTemplateShape(body, vars);
    // Changing the text or variables locally no longer matches what Meta approved: back to draft until a sync confirms.
    const reset = (b.bodyPreview !== undefined && b.bodyPreview !== before.body_preview) || (b.variables !== undefined && b.variables.join() !== before.variables.join());
    await sql`UPDATE whatsapp_templates SET body_preview = ${body}, variables = ${vars}, event_type = ${b.eventType === undefined ? sql`event_type` : b.eventType},
              category = COALESCE(${b.category ?? null}, category), is_active = COALESCE(${b.isActive ?? null}, is_active),
              meta_status = ${reset ? 'draft' : before.meta_status}, updated_at = now() WHERE id = ${id}::uuid`;
    await audit(req, { action: 'whatsapp.template_update', entityType: 'whatsapp_template', entityId: id, entityLabel: `${before.name} (${before.language})`,
      newValue: { fields: Object.keys(b), statusReset: reset } });
    return { ok: true, statusReset: reset };
  });

  app.delete('/templates/:id', { preHandler: can(W.TEMPLATES) }, async (req) => {
    const { id } = req.params as { id: string };
    const [used] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM whatsapp_messages WHERE template_id = ${id}::uuid`;
    const rows = used.n
      ? await sql`UPDATE whatsapp_templates SET is_active = false, updated_at = now() WHERE id = ${id}::uuid RETURNING name`
      : await sql`DELETE FROM whatsapp_templates WHERE id = ${id}::uuid RETURNING name`;
    if (!rows.length) throw notFound('القالب غير موجود');
    await audit(req, { action: used.n ? 'whatsapp.template_disable' : 'whatsapp.template_delete', entityType: 'whatsapp_template', entityId: id, entityLabel: rows[0].name });
    return { ok: true, disabled: !!used.n };
  });

  app.get('/templates/:id/preview', { preHandler: can(W.VIEW, W.TEMPLATES) }, async (req) => {
    const { id } = req.params as { id: string };
    const [t] = await sql<{ body_preview: string; variables: string[] }[]>`SELECT body_preview, variables FROM whatsapp_templates WHERE id = ${id}::uuid`;
    if (!t) throw notFound('القالب غير موجود');
    const params = buildParams(t.variables, SAMPLE);
    return { preview: renderPreview(t.body_preview, params), params };
  });

  /** Pulls review status (and the approved body) from Meta. Read-only on Meta's side. */
  app.post('/templates/sync', { preHandler: can(W.TEMPLATES) }, async (req) => {
    const cred = credentialsFrom(await loadSettings());
    if (!cred) throw badRequest('أكمل إعداد الاتصال أولًا');
    const r = await createMetaClient(cred).listTemplates();
    if (!r.ok) { await recordIntegrationError(r.error.code, r.error.message); throw badRequest(`تعذّر جلب القوالب من Meta: ${r.error.message}`); }
    const local = await sql<{ id: string; name: string; language: string; variables: string[] }[]>`SELECT id, name, language, variables FROM whatsapp_templates`;
    let updated = 0;
    const unregistered: Array<{ name: string; language: string; status: string; body: string | null }> = [];
    for (const m of r.data) {
      const body = m.components?.find((c) => c.type === 'BODY')?.text ?? null;
      const mine = local.find((t) => t.name === m.name && t.language === m.language);
      if (!mine) { unregistered.push({ name: m.name, language: m.language, status: META_STATUS[m.status] ?? 'pending', body }); continue; }
      let status: TemplateMetaStatus = META_STATUS[m.status] ?? 'pending';
      let reason = m.rejected_reason && m.rejected_reason !== 'NONE' ? m.rejected_reason : null;
      // An approved template whose placeholders do not match our variables would fail every send: keep it out of use.
      if (status === 'approved' && body && placeholderCount(body) !== mine.variables.length) { status = 'pending'; reason = 'عدد متغيرات القالب في Meta لا يطابق المتغيرات المحددة هنا'; }
      await sql`UPDATE whatsapp_templates SET meta_status = ${status}, meta_template_id = ${m.id}, meta_reason = ${reason},
                body_preview = COALESCE(${body}, body_preview), last_synced_at = now(), updated_at = now() WHERE id = ${mine.id}::uuid`;
      updated++;
    }
    const missing = local.filter((t) => !r.data.some((m) => m.name === t.name && m.language === t.language)).map((t) => t.id);
    if (missing.length) await sql`UPDATE whatsapp_templates SET meta_status = 'draft', last_synced_at = now() WHERE id = ANY(${missing}::uuid[]) AND meta_status <> 'draft'`;
    await audit(req, { action: 'whatsapp.template_sync', entityType: 'whatsapp_template', newValue: { updated, unregistered: unregistered.length, missing: missing.length } });
    return { updated, unregistered, missingAtMeta: missing.length };
  });

  // ── Recipients ────────────────────────────────────────────────────────
  app.get('/recipients', { preHandler: can(W.RECIPIENTS) }, async () => {
    const rows = await sql<{ id: string; user_id: string; full_name: string; email: string; role_name_ar: string; phone_last4: string; country_code: string;
      is_supervisor: boolean; is_active: boolean; user_active: boolean; opt_in_status: string; opt_in_at: string | null; opt_in_method: string | null;
      opted_out_at: string | null; opt_out_source: string | null; disabled_alerts: number }[]>`
      SELECT r.id, r.user_id, u.full_name, u.email, ro.name_ar AS role_name_ar, r.phone_last4, r.country_code, r.is_supervisor, r.is_active,
             (u.is_active AND u.deleted_at IS NULL) AS user_active, r.opt_in_status, r.opt_in_at, r.opt_in_method, r.opted_out_at, r.opt_out_source,
             (SELECT count(*)::int FROM whatsapp_recipient_subscriptions s WHERE s.recipient_id = r.id AND NOT s.enabled) AS disabled_alerts
      FROM whatsapp_recipients r JOIN users u ON u.id = r.user_id JOIN roles ro ON ro.id = u.role_id ORDER BY u.full_name`;
    return { items: rows.map((r) => ({ ...r, phone: maskPhone(null, r.phone_last4), countryCode: r.country_code })) };
  });

  app.get('/recipients/candidates', { preHandler: can(W.RECIPIENTS) }, async (req) => {
    const q = String((req.query as { q?: string }).q ?? '').trim().slice(0, 80);
    return { items: await sql`
      SELECT u.id, u.full_name, u.email, ro.name_ar AS role_name_ar FROM users u JOIN roles ro ON ro.id = u.role_id
      WHERE u.is_active AND u.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM whatsapp_recipients r WHERE r.user_id = u.id)
        AND (${q} = '' OR u.full_name ILIKE ${'%' + q + '%'} OR u.email ILIKE ${'%' + q + '%'})
      ORDER BY u.full_name LIMIT 20` };
  });

  const optInSchema = z.object({ method: z.string().trim().min(3, 'صف طريقة الموافقة (مثلاً: نموذج موقّع، رسالة بريد)').max(200) });

  app.post('/recipients', { preHandler: can(W.RECIPIENTS) }, async (req) => {
    const b = z.object({ userId: z.string().uuid(), phone: z.string().max(40), isSupervisor: z.boolean().default(false), optIn: optInSchema.nullable().optional() }).parse(req.body);
    const phone = normalizeE164(b.phone);
    if (!phone) throw badRequest('رقم غير صالح: اكتبه بالصيغة الدولية مع رمز الدولة، مثل ‎+9665XXXXXXXX');
    const [user] = await sql<{ full_name: string }[]>`SELECT full_name FROM users WHERE id = ${b.userId}::uuid AND is_active AND deleted_at IS NULL`;
    if (!user) throw badRequest('المستخدم غير موجود أو غير نشط');
    const cc = /^\+(1|7|2\d|3\d|4\d|5[1-8]|6[0-6]|8[1246]|9[0-58]|\d{3})/.exec(phone)?.[0] ?? phone.slice(0, 4);
    const rows = await sql`
      INSERT INTO whatsapp_recipients (user_id, phone_encrypted, phone_hash, phone_last4, country_code, is_supervisor,
                                       opt_in_status, opt_in_at, opt_in_method, opt_in_recorded_by, created_by)
      VALUES (${b.userId}::uuid, ${encryptJson({ v: phone })}, ${phoneHash(phone)}, ${phone.slice(-4)}, ${cc}, ${b.isSupervisor},
              ${b.optIn ? 'opted_in' : 'pending'}, ${b.optIn ? sql`now()` : null}, ${b.optIn?.method ?? null}, ${b.optIn ? req.user.id : null}::uuid, ${req.user.id}::uuid)
      ON CONFLICT DO NOTHING RETURNING id`;
    if (!rows.length) throw conflict('هذا المستخدم أو هذا الرقم مسجّل مسبقًا');
    await audit(req, { action: 'whatsapp.recipient_create', entityType: 'whatsapp_recipient', entityId: rows[0].id, entityLabel: user.full_name,
      newValue: { last4: phone.slice(-4), optIn: !!b.optIn, isSupervisor: b.isSupervisor } });
    return { id: rows[0].id };
  });

  app.patch('/recipients/:id', { preHandler: can(W.RECIPIENTS) }, async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ phone: z.string().max(40).optional(), isSupervisor: z.boolean().optional(), isActive: z.boolean().optional() }).parse(req.body);
    const [r] = await sql<{ full_name: string }[]>`SELECT u.full_name FROM whatsapp_recipients r JOIN users u ON u.id = r.user_id WHERE r.id = ${id}::uuid`;
    if (!r) throw notFound('المستلم غير موجود');
    if (b.phone !== undefined) {
      const phone = normalizeE164(b.phone);
      if (!phone) throw badRequest('رقم غير صالح: اكتبه بالصيغة الدولية مع رمز الدولة');
      // Consent belongs to a number: a new number starts without it.
      const rows = await sql`UPDATE whatsapp_recipients SET phone_encrypted = ${encryptJson({ v: phone })}, phone_hash = ${phoneHash(phone)}, phone_last4 = ${phone.slice(-4)},
                opt_in_status = 'pending', opt_in_at = NULL, opt_in_method = NULL, opted_out_at = NULL, opt_out_source = NULL, updated_at = now()
                WHERE id = ${id}::uuid AND NOT EXISTS (SELECT 1 FROM whatsapp_recipients x WHERE x.phone_hash = ${phoneHash(phone)} AND x.id <> ${id}::uuid) RETURNING id`;
      if (!rows.length) throw conflict('هذا الرقم مسجّل لمستلم آخر');
    }
    await sql`UPDATE whatsapp_recipients SET is_supervisor = COALESCE(${b.isSupervisor ?? null}, is_supervisor), is_active = COALESCE(${b.isActive ?? null}, is_active), updated_at = now() WHERE id = ${id}::uuid`;
    if (b.isActive === false) await sql`UPDATE whatsapp_messages SET status = 'cancelled', cancelled_at = now(), error_class = 'policy', last_error_code = 'recipient_inactive', last_error_message = 'عُطّل المستلم', updated_at = now() WHERE recipient_id = ${id}::uuid AND status = 'queued'`;
    await audit(req, { action: 'whatsapp.recipient_update', entityType: 'whatsapp_recipient', entityId: id, entityLabel: r.full_name,
      newValue: { fields: Object.keys(b), phoneChanged: b.phone !== undefined } });
    return { ok: true, optInReset: b.phone !== undefined };
  });

  app.post('/recipients/:id/opt-in', { preHandler: can(W.RECIPIENTS) }, async (req) => {
    const { id } = req.params as { id: string };
    const b = optInSchema.parse(req.body);
    const rows = await sql<{ id: string }[]>`UPDATE whatsapp_recipients SET opt_in_status = 'opted_in', opt_in_at = now(), opt_in_method = ${b.method},
              opt_in_recorded_by = ${req.user.id}::uuid, opted_out_at = NULL, opt_out_source = NULL, updated_at = now()
              WHERE id = ${id}::uuid AND opt_in_status <> 'opted_in' RETURNING id`;
    if (!rows.length) throw badRequest('المستلم غير موجود أو موافقته مسجّلة مسبقًا');
    await audit(req, { action: 'whatsapp.recipient_opt_in', entityType: 'whatsapp_recipient', entityId: id, newValue: { method: b.method }, severity: 'warning' });
    return { ok: true };
  });

  app.post('/recipients/:id/opt-out', { preHandler: can(W.RECIPIENTS) }, async (req) => {
    const { id } = req.params as { id: string };
    const rows = await sql`UPDATE whatsapp_recipients SET opt_in_status = 'opted_out', opted_out_at = now(), opt_out_source = 'admin', updated_at = now()
              WHERE id = ${id}::uuid AND opt_in_status <> 'opted_out' RETURNING id`;
    if (!rows.length) throw badRequest('المستلم غير موجود أو ألغى اشتراكه مسبقًا');
    await sql`UPDATE whatsapp_messages SET status = 'cancelled', cancelled_at = now(), error_class = 'policy', last_error_code = 'opted_out', last_error_message = 'أُلغي الاشتراك', updated_at = now() WHERE recipient_id = ${id}::uuid AND status = 'queued'`;
    await audit(req, { action: 'whatsapp.recipient_opt_out', entityType: 'whatsapp_recipient', entityId: id, severity: 'warning' });
    return { ok: true };
  });

  app.delete('/recipients/:id', { preHandler: can(W.RECIPIENTS) }, async (req) => {
    const { id } = req.params as { id: string };
    const [used] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM whatsapp_messages WHERE recipient_id = ${id}::uuid`;
    // With history, the row stays (deactivated) so the log keeps its masked recipient.
    const rows = used.n
      ? await sql`UPDATE whatsapp_recipients SET is_active = false, updated_at = now() WHERE id = ${id}::uuid RETURNING id`
      : await sql`DELETE FROM whatsapp_recipients WHERE id = ${id}::uuid RETURNING id`;
    if (!rows.length) throw notFound('المستلم غير موجود');
    if (used.n) await sql`UPDATE whatsapp_messages SET status = 'cancelled', cancelled_at = now(), error_class = 'policy', last_error_code = 'recipient_inactive', last_error_message = 'حُذف المستلم', updated_at = now() WHERE recipient_id = ${id}::uuid AND status = 'queued'`;
    await audit(req, { action: used.n ? 'whatsapp.recipient_disable' : 'whatsapp.recipient_delete', entityType: 'whatsapp_recipient', entityId: id, severity: 'warning' });
    return { ok: true, disabled: !!used.n };
  });

  const subsSchema = z.object({ subscriptions: z.array(z.object({ eventType: z.string(), enabled: z.boolean() })).max(100) });
  async function writeSubscriptions(req: FastifyRequest, recipientId: string, subs: Array<{ eventType: string; enabled: boolean }>, self: boolean) {
    for (const s of subs) {
      const def = whatsappEvent(s.eventType);
      if (!def) throw badRequest('نوع تنبيه غير معروف');
      if (self && !def.optional && !s.enabled) throw forbidden(`«${def.label}» تنبيه تشغيلي إلزامي لا يمكن إيقافه`);
      await sql`INSERT INTO whatsapp_recipient_subscriptions (recipient_id, event_type, enabled, updated_by) VALUES (${recipientId}::uuid, ${s.eventType}, ${s.enabled}, ${req.user.id}::uuid)
                ON CONFLICT (recipient_id, event_type) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    }
  }
  const subscriptionsOf = async (recipientId: string) => {
    const rows = await sql<{ event_type: string; enabled: boolean }[]>`SELECT event_type, enabled FROM whatsapp_recipient_subscriptions WHERE recipient_id = ${recipientId}::uuid`;
    return WHATSAPP_EVENTS.filter((d) => d.availability !== 'unavailable').map((d) => ({
      eventType: d.key, label: d.label, group: d.group, optional: d.optional, enabled: rows.find((r) => r.event_type === d.key)?.enabled ?? true,
    }));
  };

  app.get('/recipients/:id/subscriptions', { preHandler: can(W.RECIPIENTS) }, async (req) => ({ items: await subscriptionsOf((req.params as { id: string }).id) }));
  app.put('/recipients/:id/subscriptions', { preHandler: can(W.RECIPIENTS) }, async (req) => {
    const { id } = req.params as { id: string };
    const b = subsSchema.parse(req.body);
    await writeSubscriptions(req, id, b.subscriptions, false);
    await audit(req, { action: 'whatsapp.subscriptions_update', entityType: 'whatsapp_recipient', entityId: id, newValue: { count: b.subscriptions.length } });
    return { ok: true };
  });

  // ── Routing ───────────────────────────────────────────────────────────
  app.get('/routes', { preHandler: can(W.RECIPIENTS, W.VIEW) }, async () => ({
    items: await sql`
      SELECT rt.id, rt.event_type, rt.audience, rt.role_key, ro.name_ar AS role_name, rt.program_id, p.name_ar AS program_name, rt.recipient_id, u.full_name AS recipient_name
      FROM whatsapp_routes rt LEFT JOIN roles ro ON ro.key = rt.role_key LEFT JOIN programs p ON p.id = rt.program_id
      LEFT JOIN whatsapp_recipients r ON r.id = rt.recipient_id LEFT JOIN users u ON u.id = r.user_id
      WHERE rt.is_active ORDER BY rt.event_type, rt.created_at`,
  }));
  app.post('/routes', { preHandler: can(W.RECIPIENTS) }, async (req) => {
    const b = z.object({ eventType: z.string(), audience: z.enum(['assignee', 'supervisors', 'role', 'program_team', 'recipient']),
      roleKey: z.string().nullable().optional(), programId: z.string().uuid().nullable().optional(), recipientId: z.string().uuid().nullable().optional() }).parse(req.body);
    if (!whatsappEvent(b.eventType)) throw badRequest('نوع تنبيه غير معروف');
    if (b.audience === 'role' && !b.roleKey) throw badRequest('اختر الدور');
    if (b.audience === 'program_team' && !b.programId) throw badRequest('اختر البرنامج');
    if (b.audience === 'recipient' && !b.recipientId) throw badRequest('اختر المستلم');
    const [row] = await sql`INSERT INTO whatsapp_routes (event_type, audience, role_key, program_id, recipient_id, created_by)
      VALUES (${b.eventType}, ${b.audience}, ${b.roleKey ?? null}, ${b.programId ?? null}::uuid, ${b.recipientId ?? null}::uuid, ${req.user.id}::uuid) RETURNING id`;
    await audit(req, { action: 'whatsapp.route_create', entityType: 'whatsapp_route', entityId: row.id, newValue: b });
    return { id: row.id };
  });
  app.delete('/routes/:id', { preHandler: can(W.RECIPIENTS) }, async (req) => {
    const { id } = req.params as { id: string };
    const rows = await sql`DELETE FROM whatsapp_routes WHERE id = ${id}::uuid RETURNING id`;
    if (!rows.length) throw notFound('المسار غير موجود');
    await audit(req, { action: 'whatsapp.route_delete', entityType: 'whatsapp_route', entityId: id });
    return { ok: true };
  });

  // ── Log ───────────────────────────────────────────────────────────────
  app.get('/messages', { preHandler: can(W.LOG) }, async (req) => {
    const q = z.object({
      status: z.string().optional(), eventType: z.string().optional(), programId: z.string().uuid().optional(), recipientId: z.string().uuid().optional(),
      from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(),
      before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(req.query);
    const rows = await sql<Record<string, unknown>[]>`
      SELECT m.id, m.event_type, m.status, m.attempts, m.template_name, m.template_language, m.error_class, m.last_error_code, m.last_error_message,
             m.meta_message_id, m.is_test, m.created_at, m.accepted_at, m.sent_at, m.delivered_at, m.read_at, m.failed_at, m.cancelled_at,
             m.program_id, p.name_ar AS program_name, u.full_name AS recipient_name, r.phone_last4
      FROM whatsapp_messages m JOIN whatsapp_recipients r ON r.id = m.recipient_id JOIN users u ON u.id = r.user_id
      LEFT JOIN programs p ON p.id = m.program_id
      WHERE (${q.status ?? null}::text IS NULL OR m.status = ${q.status ?? null})
        AND (${q.eventType ?? null}::text IS NULL OR m.event_type = ${q.eventType ?? null})
        AND (${q.programId ?? null}::uuid IS NULL OR m.program_id = ${q.programId ?? null}::uuid)
        AND (${q.recipientId ?? null}::uuid IS NULL OR m.recipient_id = ${q.recipientId ?? null}::uuid)
        AND (${q.from ?? null}::timestamptz IS NULL OR m.created_at >= ${q.from ?? null}::timestamptz)
        AND (${q.to ?? null}::timestamptz IS NULL OR m.created_at < ${q.to ?? null}::timestamptz)
        AND (${q.before ?? null}::bigint IS NULL OR m.id < ${q.before ?? null}::bigint)
      ORDER BY m.id DESC LIMIT ${q.limit + 1}`;
    const items = rows.slice(0, q.limit).map(({ phone_last4, ...m }) => ({ ...m, recipient_phone: maskPhone(null, phone_last4 as string) }));
    return { items, nextBefore: rows.length > q.limit ? (rows[q.limit - 1].id as string) : null };
  });

  app.get('/messages/:id/attempts', { preHandler: can(W.LOG) }, async (req) => ({
    items: await sql`SELECT attempt_no, started_at, finished_at, outcome, http_status, error_code, error_message, meta_message_id
                     FROM whatsapp_message_attempts WHERE message_id = ${(req.params as { id: string }).id}::bigint ORDER BY attempt_no`,
  }));

  app.post('/messages/:id/retry', { preHandler: can(W.TOGGLE) }, async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ acknowledgeDuplicateRisk: z.boolean().default(false) }).parse(req.body ?? {});
    const [m] = await sql<{ status: string; error_class: string | null; expires_at: Date; meta_message_id: string | null }[]>`
      SELECT status, error_class, expires_at, meta_message_id FROM whatsapp_messages WHERE id = ${id}::bigint`;
    if (!m) throw notFound('الرسالة غير موجودة');
    if (m.status !== 'failed' || m.meta_message_id) throw badRequest('لا يُعاد إلا ما فشل قبل أن تقبله Meta');
    if (m.error_class === 'permanent' || m.error_class === 'policy') throw badRequest('هذا الفشل نهائي؛ إعادة المحاولة لن تنجح');
    if (m.error_class === 'uncertain' && !b.acknowledgeDuplicateRisk) throw new HttpError(409, 'قد تكون الرسالة وصلت فعلًا؛ تأكيد إعادة الإرسال مطلوب', 'DUPLICATE_RISK');
    if (new Date(m.expires_at) <= new Date()) throw badRequest('انتهت صلاحية هذا الإشعار؛ لا يُرسل متأخرًا');
    await sql`UPDATE whatsapp_messages SET status = 'queued', next_attempt_at = now(), failed_at = NULL, updated_at = now() WHERE id = ${id}::bigint`;
    await audit(req, { action: 'whatsapp.message_retry', entityType: 'whatsapp_message', entityLabel: `#${id}`, newValue: { acknowledgeDuplicateRisk: b.acknowledgeDuplicateRisk }, severity: 'warning' });
    return { ok: true };
  });

  app.post('/test-send', { preHandler: can(W.TEST_SEND) }, async (req) => {
    const b = z.object({ recipientId: z.string().uuid(), templateId: z.string().uuid() }).parse(req.body);
    const s = await loadSettings();
    if (!s.enabled || s.paused) throw badRequest('القناة معطلة أو موقوفة مؤقتًا؛ فعّلها أولًا');
    const r = await enqueueTest(b.recipientId, b.templateId, SAMPLE, s, req.user.id);
    if ('error' in r) throw badRequest(r.error!);
    await audit(req, { action: 'whatsapp.test_send', entityType: 'whatsapp_message', entityLabel: `#${r.id}`, newValue: { templateId: b.templateId }, severity: 'warning' });
    return { id: r.id, queued: true };
  });

  // ── Self-service (any signed-in employee) ─────────────────────────────
  const myRecipient = async (req: FastifyRequest) => {
    const [r] = await sql<{ id: string; phone_last4: string; opt_in_status: string; opt_in_at: string | null; is_active: boolean }[]>`
      SELECT id, phone_last4, opt_in_status, opt_in_at, is_active FROM whatsapp_recipients WHERE user_id = ${req.user.id}::uuid`;
    return r ?? null;
  };
  app.get('/me', { config: { access: 'self' } }, async (req) => {
    const r = await myRecipient(req);
    if (!r) return { registered: false };
    return { registered: true, phone: maskPhone(null, r.phone_last4), optInStatus: r.opt_in_status, optInAt: r.opt_in_at, isActive: r.is_active, subscriptions: await subscriptionsOf(r.id) };
  });
  app.put('/me/subscriptions', { config: { access: 'self' } }, async (req) => {
    const r = await myRecipient(req);
    if (!r) throw notFound('لم يُسجَّل رقم واتساب لحسابك');
    const b = subsSchema.parse(req.body);
    await writeSubscriptions(req, r.id, b.subscriptions, true);
    await audit(req, { action: 'whatsapp.self_subscriptions', entityType: 'whatsapp_recipient', entityId: r.id, newValue: { count: b.subscriptions.length } });
    return { ok: true };
  });
  app.post('/me/opt-in', { config: { access: 'self' } }, async (req) => {
    const r = await myRecipient(req);
    if (!r) throw notFound('لم يُسجَّل رقم واتساب لحسابك');
    await sql`UPDATE whatsapp_recipients SET opt_in_status = 'opted_in', opt_in_at = now(), opt_in_method = 'موافقة ذاتية من حساب الموظف في المنصة',
              opt_in_recorded_by = ${req.user.id}::uuid, opted_out_at = NULL, opt_out_source = NULL, updated_at = now() WHERE id = ${r.id}::uuid`;
    await audit(req, { action: 'whatsapp.self_opt_in', entityType: 'whatsapp_recipient', entityId: r.id });
    return { ok: true };
  });
  app.post('/me/opt-out', { config: { access: 'self' } }, async (req) => {
    const r = await myRecipient(req);
    if (!r) throw notFound('لم يُسجَّل رقم واتساب لحسابك');
    await sql`UPDATE whatsapp_recipients SET opt_in_status = 'opted_out', opted_out_at = now(), opt_out_source = 'self', updated_at = now() WHERE id = ${r.id}::uuid`;
    await sql`UPDATE whatsapp_messages SET status = 'cancelled', cancelled_at = now(), error_class = 'policy', last_error_code = 'opted_out', last_error_message = 'ألغى المستلم اشتراكه', updated_at = now() WHERE recipient_id = ${r.id}::uuid AND status = 'queued'`;
    await audit(req, { action: 'whatsapp.self_opt_out', entityType: 'whatsapp_recipient', entityId: r.id });
    return { ok: true };
  });
}
