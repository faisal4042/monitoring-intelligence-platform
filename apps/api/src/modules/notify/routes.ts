import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '@mip/db';
import { PERMISSIONS } from '@mip/shared';
import { badRequest, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { encryptJson, decryptJson } from '../../lib/crypto.js';
import { dispatchToChannel, evaluateRules, createTelegramLink } from './service.js';
import { normalizeTelegramConfig, type TelegramConfig } from './providers.js';

const emailConfigSchema = z.object({
  host: z.string().min(1), port: z.coerce.number().int().min(1).max(65535),
  secure: z.boolean().default(true), user: z.string().min(1), pass: z.string().min(1),
  from: z.string().optional().default(''), to: z.string().email(),
});
const telegramConfigSchema = z.object({ botToken: z.string().min(1), chatIds: z.array(z.string()).default([]) });

const createChannelSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('email'), name: z.string().min(1).max(120), config: emailConfigSchema }),
  z.object({ type: z.literal('telegram'), name: z.string().min(1).max(120), config: telegramConfigSchema }),
]);

const createRuleSchema = z.object({
  name: z.string().min(1).max(150),
  conditionType: z.enum(['keyword_match', 'follower_threshold', 'influencer_activity', 'topic_rising']),
  condition: z.record(z.unknown()).default({}),
  programId: z.string().uuid().nullable().optional(),
  messageTemplate: z.string().min(1).max(2000),
  channelIds: z.array(z.string().uuid()).default([]),
});
const updateRuleSchema = createRuleSchema.partial().extend({ isActive: z.boolean().optional() });

export default async function notifyRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get('/channels', {
    preHandler: [app.requirePermission(PERMISSIONS.ALERTS_READ)],
  }, async () => {
    const rows = await sql<{
      id: string; type: 'email' | 'telegram'; name: string; is_active: boolean;
      last_test_at: string | null; last_test_ok: boolean | null; created_at: string; config_encrypted: string;
    }[]>`SELECT id, type, name, is_active, last_test_at, last_test_ok, created_at, config_encrypted
         FROM notification_channels ORDER BY created_at DESC`;
    return {
      items: rows.map(({ config_encrypted, ...c }) => {
        const linkedCount = c.type === 'telegram' ? normalizeTelegramConfig(decryptJson<TelegramConfig>(config_encrypted)).chatIds.length : null;
        return { ...c, is_linked: c.type === 'email' || (linkedCount ?? 0) > 0, linked_count: linkedCount };
      }),
    };
  });

  app.post('/channels', {
    preHandler: [app.requirePermission(PERMISSIONS.ALERTS_WRITE)],
  }, async (req) => {
    const parsed = createChannelSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const { type, name, config } = parsed.data;

    const [created] = await sql`
      INSERT INTO notification_channels (type, name, config_encrypted, created_by)
      VALUES (${type}, ${name}, ${encryptJson(config)}, ${req.user.id}::uuid)
      RETURNING id, type, name, is_active, created_at`;

    await audit(req, {
      action: 'notify_channel.create', entityType: 'notification_channel', entityId: created.id,
      entityLabel: `${created.name} (${created.type})`, severity: 'warning',
    });
    return created;
  });

  app.patch('/channels/:id', {
    preHandler: [app.requirePermission(PERMISSIONS.ALERTS_WRITE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { name?: string; isActive?: boolean; config?: unknown };

    const [before] = await sql`SELECT id, type FROM notification_channels WHERE id = ${id}::uuid`;
    if (!before) throw notFound('القناة غير موجودة');

    let configEncrypted: string | null = null;
    if (body.config) {
      const schema = before.type === 'email' ? emailConfigSchema : telegramConfigSchema;
      const parsed = schema.safeParse(body.config);
      if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
      configEncrypted = encryptJson(parsed.data);
    }

    const [after] = await sql`
      UPDATE notification_channels SET
        name = COALESCE(${body.name ?? null}, name),
        is_active = COALESCE(${body.isActive ?? null}, is_active),
        config_encrypted = COALESCE(${configEncrypted}, config_encrypted),
        updated_at = now()
      WHERE id = ${id}::uuid
      RETURNING id, type, name, is_active, updated_at`;

    await audit(req, {
      action: 'notify_channel.update', entityType: 'notification_channel', entityId: id,
      entityLabel: after.name, severity: 'warning',
    });
    return after;
  });

  app.post('/channels/:id/test', {
    preHandler: [app.requirePermission(PERMISSIONS.ALERTS_WRITE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    try {
      await dispatchToChannel(id, 'رسالة اختبار — منصة الرصد', 'هذه رسالة اختبار من مركز الإشعارات. إذا وصلتك، القناة تعمل بشكل صحيح.');
      await sql`UPDATE notification_channels SET last_test_at = now(), last_test_ok = true WHERE id = ${id}::uuid`;
      return { ok: true };
    } catch (err) {
      await sql`UPDATE notification_channels SET last_test_at = now(), last_test_ok = false WHERE id = ${id}::uuid`;
      throw badRequest(err instanceof Error ? err.message : 'تعذّر إرسال رسالة الاختبار');
    }
  });

  app.post('/channels/:id/telegram-link', {
    preHandler: [app.requirePermission(PERMISSIONS.ALERTS_WRITE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    try {
      return await createTelegramLink(id);
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : 'تعذّر إنشاء رابط الربط — تأكد من صحة Bot Token');
    }
  });

  app.delete('/channels/:id', {
    preHandler: [app.requirePermission(PERMISSIONS.ALERTS_WRITE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const [row] = await sql`DELETE FROM notification_channels WHERE id = ${id}::uuid RETURNING name`;
    if (!row) throw notFound('القناة غير موجودة');
    await audit(req, {
      action: 'notify_channel.delete', entityType: 'notification_channel', entityId: id,
      entityLabel: row.name, severity: 'warning',
    });
    return { ok: true };
  });

  app.get('/rules', {
    preHandler: [app.requirePermission(PERMISSIONS.ALERTS_READ)],
  }, async () => ({
    items: await sql`
      SELECT r.*, p.name_ar AS program_name,
             ARRAY(SELECT name FROM notification_channels WHERE id = ANY(r.channel_ids)) AS channel_names
      FROM alert_rules r
      LEFT JOIN programs p ON p.id = r.program_id
      ORDER BY r.created_at DESC`,
  }));

  app.post('/rules', {
    preHandler: [app.requirePermission(PERMISSIONS.ALERTS_WRITE)],
  }, async (req) => {
    const parsed = createRuleSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const b = parsed.data;

    const [created] = await sql`
      INSERT INTO alert_rules (name, condition_type, condition, program_id, message_template, channel_ids, created_by)
      VALUES (${b.name}, ${b.conditionType}, ${JSON.stringify(b.condition)}::jsonb, ${b.programId ?? null}::uuid,
              ${b.messageTemplate}, ${b.channelIds}, ${req.user.id}::uuid)
      RETURNING *`;

    await audit(req, {
      action: 'alert_rule.create', entityType: 'alert_rule', entityId: created.id,
      entityLabel: created.name, newValue: created, severity: 'warning',
    });
    return created;
  });

  app.patch('/rules/:id', {
    preHandler: [app.requirePermission(PERMISSIONS.ALERTS_WRITE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = updateRuleSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const b = parsed.data;

    const [before] = await sql`SELECT * FROM alert_rules WHERE id = ${id}::uuid`;
    if (!before) throw notFound('القاعدة غير موجودة');

    const [after] = await sql`
      UPDATE alert_rules SET
        name = COALESCE(${b.name ?? null}, name),
        condition_type = COALESCE(${b.conditionType ?? null}, condition_type),
        condition = COALESCE(${b.condition ? JSON.stringify(b.condition) : null}::jsonb, condition),
        program_id = COALESCE(${b.programId ?? null}::uuid, program_id),
        message_template = COALESCE(${b.messageTemplate ?? null}, message_template),
        channel_ids = COALESCE(${b.channelIds ?? null}, channel_ids),
        is_active = COALESCE(${b.isActive ?? null}, is_active),
        updated_at = now()
      WHERE id = ${id}::uuid
      RETURNING *`;

    await audit(req, {
      action: 'alert_rule.update', entityType: 'alert_rule', entityId: id,
      entityLabel: after.name, oldValue: before, newValue: after,
      severity: b.isActive === false ? 'warning' : 'info',
    });
    return after;
  });

  app.delete('/rules/:id', {
    preHandler: [app.requirePermission(PERMISSIONS.ALERTS_WRITE)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const [row] = await sql`DELETE FROM alert_rules WHERE id = ${id}::uuid RETURNING name`;
    if (!row) throw notFound('القاعدة غير موجودة');
    await audit(req, {
      action: 'alert_rule.delete', entityType: 'alert_rule', entityId: id,
      entityLabel: row.name, severity: 'warning',
    });
    return { ok: true };
  });

  app.post('/rules/run-now', {
    preHandler: [app.requirePermission(PERMISSIONS.ALERTS_WRITE)],
  }, async (req) => {
    // A generous look-back so "run now" finds something even right after
    // creating a rule, unlike the worker's tight rolling window.
    const result = await evaluateRules(6 * 3600);
    await audit(req, { action: 'alert_rule.run_now', entityType: 'alert_rule', newValue: result });
    return result;
  });

  app.get('/deliveries', {
    preHandler: [app.requirePermission(PERMISSIONS.ALERTS_READ)],
  }, async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(Number(q.limit ?? 50), 200);
    return {
      items: await sql`
        SELECT d.id, d.entity_type, d.entity_id, d.message, d.channel_results, d.created_at,
               r.name AS rule_name, r.condition_type
        FROM alert_deliveries d
        JOIN alert_rules r ON r.id = d.rule_id
        ORDER BY d.created_at DESC LIMIT ${limit}`,
    };
  });
}
