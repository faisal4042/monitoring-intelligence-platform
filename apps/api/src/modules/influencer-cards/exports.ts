/**
 * /influencers/card-exports — the influencer card export log (migration 0048, pending approval).
 *
 * The file is produced in the requester's browser, so the log has three steps, never more:
 *   1. POST /             the REQUEST, before the file is made. The server resolves the window and the
 *                         published template version itself and records them — the log is the authority
 *                         on what was exported, not the client. If the template the preview used is no
 *                         longer the one that resolves, the request is refused (409) so the client redraws.
 *   2. POST /:id/events   the technical OUTCOME reported by the same user: `generated` (pages, size,
 *                         SHA-256 of the bytes) or `failed` (a short code) — exactly one of them.
 *   3. POST /:id/events   `handed_to_browser`: the download was handed to the browser. This is NOT proof the
 *                         file was saved on the device; nothing records that, because nothing can prove it.
 * No post text, image, figure or personal data is stored. Rows are immutable (database triggers).
 *
 * Access: the card's own rule (influencers:read + posts:read). With CARD_EXPORT_PERMISSION=enforce the
 * request also needs influencer_cards:export — off until the RBAC change is approved. Users see their own
 * log; audit:read sees everyone's. Before 0048 the endpoints answer 503 CARD_EXPORTS_NOT_ACTIVATED and the
 * export keeps working without a log, exactly as before.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '@mip/db';
import { CARD_PERMISSIONS, PERMISSIONS, canExportInfluencerCards } from '@mip/shared';
import { audit } from '../../lib/audit.js';
import { HttpError } from '../../lib/errors.js';
import { parseFilters } from '../dashboard/filters.js';
import { finiteWindow } from '../influencers.analytics.js';
import { CARD_RECENT_MAX, CARD_SCOPES, cardAccount, cardData } from '../influencers.card.js';
import { parse } from '../queue/validation.js';
import { resolveTemplate } from './templates.js';
import { beforeCardWrite, cardErrorHandler } from './write-guard.js';
import { cardMutation } from './mutation.js';
import { requireCardAccess } from './access.js';
import { sameExportRequest } from './export-request.js';

const RATE_PER_MINUTE = 30;
const PAGE_SIZE_MAX = 100;

/** Whether the request needs influencer_cards:export (an approved RBAC change turns this on). */
export const exportPermissionEnforced = () => process.env.CARD_EXPORT_PERMISSION === 'enforce';

let active = false;
async function exportsActive() {
  if (active) return true;
  const [r] = await sql<{ ok: boolean }[]>`SELECT (to_regclass('public.influencer_card_exports') IS NOT NULL
    AND to_regclass('public.influencer_card_export_events') IS NOT NULL) AS ok`;
  active = r.ok;
  return active;
}
async function requireExportsActive() {
  if (!(await exportsActive())) throw new HttpError(503, 'سجل تصدير البطاقات غير مفعّل بعد (بانتظار اعتماد Migration 0048)', 'CARD_EXPORTS_NOT_ACTIVATED');
}

const requestBody = z.object({
  influencerId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(120).regex(/^[A-Za-z0-9_-]+$/),
  format: z.enum(['png', 'a4-portrait', 'a4-landscape']),
  pngScale: z.union([z.literal(2), z.literal(3)]).optional(),
  range: z.string().max(20).optional(), from: z.string().max(40).optional(), to: z.string().max(40).optional(),
  program: z.string().max(64).optional(),
  scope: z.enum(CARD_SCOPES),
  limit: z.number().int().min(0).max(CARD_RECENT_MAX),
  templateId: z.string().uuid().optional(),
  /** What the preview was drawn with; the request is refused if the server now resolves something else. */
  expected: z.object({ source: z.enum(['template', 'builtin']), templateId: z.string().uuid().optional(), version: z.number().int().positive().optional() }).strict(),
}).strict().refine((b) => (b.format === 'png') === (b.pngScale !== undefined), { message: 'pngScale لصيغة PNG فقط ومطلوب لها', path: ['pngScale'] });

const eventBody = z.discriminatedUnion('event', [
  z.object({ event: z.literal('generated'), pages: z.number().int().min(1).max(500), fileBytes: z.number().int().min(1).max(209_715_200),
    fileSha256: z.string().regex(/^[0-9a-f]{64}$/), durationMs: z.number().int().min(0).max(600_000).optional() }).strict(),
  z.object({ event: z.literal('failed'), errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/), durationMs: z.number().int().min(0).max(600_000).optional() }).strict(),
  z.object({ event: z.literal('handed_to_browser') }).strict(),
]);

const listQuery = z.object({
  all: z.enum(['true', 'false']).default('false'),
  influencerId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(5).max(PAGE_SIZE_MAX).default(25),
}).strict();

export default async function cardExportRoutes(app: FastifyInstance) {
  app.setErrorHandler(cardErrorHandler);
  // The card data rule; the extra export permission is checked inside the request route when enforced.
  const readerHooks = [app.requirePermission(PERMISSIONS.INFLUENCERS_READ), app.requirePermission(PERMISSIONS.POSTS_READ), requireCardAccess('read')];
  const exporters = { preHandler: [...readerHooks, requireCardAccess('export')] };

  app.get('/policy', { preHandler: readerHooks }, async (req) => ({
    activated: await exportsActive(),
    requiresPermission: exportPermissionEnforced(),
    permission: CARD_PERMISSIONS.EXPORT,
    allowed: canExportInfluencerCards(req.user, exportPermissionEnforced()),
  }));

  app.post('/', exporters, async (req, reply) => {
    await requireExportsActive();
    if (exportPermissionEnforced() && !req.user.permissions.includes(CARD_PERMISSIONS.EXPORT))
      throw new HttpError(403, `تتطلب هذه العملية صلاحية: ${CARD_PERMISSIONS.EXPORT}`, 'FORBIDDEN');
    const b = parse(requestBody, req.body);
    const account = await cardAccount(b.influencerId);
    if (!account) throw new HttpError(404, 'الحساب غير موجود في القائمة', 'NOT_FOUND');
    const f = await finiteWindow(await parseFilters({ range: b.range, from: b.from, to: b.to, program: b.program, influencersOnly: 'true' }));
    // The same program the dialog resolves its template for: the period filter, else the most linked program.
    const programId = f.program?.id ?? (await cardData(f, account, 0)).program?.id ?? null;
    const resolved = await resolveTemplate({ templateId: b.templateId ?? null, programId });
    const now = resolved.source === 'template' ? { source: 'template' as const, templateId: resolved.template.id, version: resolved.template.version } : { source: 'builtin' as const };
    if (b.expected.source !== now.source || (now.source === 'template' && (b.expected.templateId !== now.templateId || b.expected.version !== now.version)))
      throw new HttpError(409, 'تغيّر القالب المنشور منذ المعاينة؛ أعد المعاينة قبل التصدير', 'TEMPLATE_CHANGED', { resolved: now });

    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM influencer_card_exports
      WHERE requested_by=${req.user.id}::uuid AND requested_at > now() - interval '1 minute'`;
    if (n >= RATE_PER_MINUTE) throw new HttpError(429, 'طلبات تصدير كثيرة خلال دقيقة؛ حاول بعد قليل', 'RATE_LIMITED');

    await beforeCardWrite();
    const tpl = resolved.source === 'template' ? resolved.template : null;
    const result = await cardMutation(async tx => {
    const [row] = await tx<{ id: string; requested_at: string }[]>`INSERT INTO influencer_card_exports
        (requested_by,idempotency_key,influencer_id,program_id,program_filter_id,template_id,template_version,builtin_template,
         format,png_scale,range_preset,range_from,range_to,scope,recent_limit)
      VALUES (${req.user.id}::uuid,${b.idempotencyKey},${account.id}::uuid,${programId},${f.program?.id ?? null},${tpl?.id ?? null},${tpl?.version ?? null},${!tpl},
         ${b.format},${b.pngScale ?? null},${f.range.preset},${f.current.from}::timestamptz,${f.current.to}::timestamptz,${b.scope},${b.limit})
      ON CONFLICT (requested_by, idempotency_key) DO NOTHING RETURNING id,requested_at`;
    if (!row) {
      // A retry of the same request returns the original one; a reused key for something else is refused.
      const [prev] = await tx<({ id: string; requested_at: string } & Record<string, unknown>)[]>`SELECT id,requested_at,
          influencer_id,format,png_scale,program_id,program_filter_id,template_id,template_version,builtin_template,
          range_preset,range_from,range_to,scope,recent_limit
        FROM influencer_card_exports WHERE requested_by=${req.user.id}::uuid AND idempotency_key=${b.idempotencyKey}`;
      if (!prev || !sameExportRequest(prev, { influencer_id: account.id, format: b.format, png_scale: b.pngScale ?? null,
        program_id: programId, program_filter_id: f.program?.id ?? null, template_id: tpl?.id ?? null,
        template_version: tpl?.version ?? null, builtin_template: !tpl, range_preset: f.range.preset,
        range_from: f.current.from, range_to: f.current.to, scope: b.scope, recent_limit: b.limit }))
        throw new HttpError(409, 'مفتاح الطلب مستخدم لتصدير آخر', 'IDEMPOTENCY_KEY_REUSED');
      return { row: prev, replay: true };
    }
    await audit(req, { action: 'card_export.request', entityType: 'influencer_card_export', entityId: row.id, entityLabel: account.username,
      newValue: { influencerId: account.id, format: b.format, template: now, programId, from: f.current.from, to: f.current.to, scope: b.scope, limit: b.limit } }, tx);
    return { row, replay: false };
    });
    return reply.code(result.replay ? 200 : 201).send({ exportId: result.row.id, requestedAt: result.row.requested_at, template: now, replay: result.replay });
  });

  app.post('/:exportId/events', exporters, async (req, reply) => {
    await requireExportsActive();
    const { exportId } = parse(z.object({ exportId: z.string().uuid() }).strict(), req.params);
    const b = parse(eventBody, req.body);
    // Someone else's request looks exactly like a missing one.
    const [own] = await sql`SELECT 1 FROM influencer_card_exports WHERE id=${exportId}::uuid AND requested_by=${req.user.id}::uuid`;
    if (!own) throw new HttpError(404, 'طلب التصدير غير موجود', 'NOT_FOUND');
    await beforeCardWrite();
    // The event row is itself the immutable record, so no general audit row is added. Order and uniqueness stay with
    // the database (unique outcome/hand-off indexes and the requester/hand-off trigger); a refusal is not retried.
    try {
      await cardMutation(async tx => {
        await tx`INSERT INTO influencer_card_export_events (export_id,event,pages,file_bytes,file_sha256,error_code,duration_ms,recorded_by)
          VALUES (${exportId}::uuid,${b.event},${b.event === 'generated' ? b.pages : null},${b.event === 'generated' ? b.fileBytes : null},
            ${b.event === 'generated' ? b.fileSha256 : null},${b.event === 'failed' ? b.errorCode : null},
            ${b.event !== 'handed_to_browser' ? b.durationMs ?? null : null},${req.user.id}::uuid)`;
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23505') throw new HttpError(409, 'سُجّلت نتيجة هذا الطلب من قبل', 'EVENT_ALREADY_RECORDED');
      if (code === '23514') throw new HttpError(409, 'لا يُسجَّل التسليم للمتصفح قبل توليد الملف بنجاح', 'HANDOFF_WITHOUT_FILE');
      throw e;
    }
    return reply.code(201).send({ exportId, event: b.event });
  });

  app.get('/', exporters, async (req) => {
    await requireExportsActive();
    const q = parse(listQuery, req.query);
    const everyone = q.all === 'true';
    if (everyone && !req.user.permissions.includes(PERMISSIONS.AUDIT_READ)) throw new HttpError(403, 'عرض سجل الجميع يتطلب صلاحية audit:read', 'FORBIDDEN');
    const where = sql`WHERE (${everyone} OR e.requested_by=${req.user.id}::uuid) AND (${q.influencerId ?? null}::uuid IS NULL OR e.influencer_id=${q.influencerId ?? null}::uuid)`;
    const [items, [{ total }]] = await Promise.all([
      sql`SELECT e.id,e.requested_at,e.format,e.png_scale,e.scope,e.recent_limit,e.range_preset,e.range_from,e.range_to,
          e.builtin_template,e.template_id,e.template_version,t.name AS template_name,
          e.program_id,p.name_ar AS program_name,e.influencer_id,ti.username,e.requested_by,u.full_name AS requested_by_name,
          coalesce(o.event,'requested') AS status,o.recorded_at AS outcome_at,o.pages,o.file_bytes,o.error_code,
          h.recorded_at AS handed_to_browser_at
        FROM influencer_card_exports e
        JOIN tracked_influencers ti ON ti.id=e.influencer_id
        JOIN users u ON u.id=e.requested_by
        LEFT JOIN programs p ON p.id=e.program_id
        LEFT JOIN influencer_card_templates t ON t.id=e.template_id
        LEFT JOIN influencer_card_export_events o ON o.export_id=e.id AND o.event IN ('generated','failed')
        LEFT JOIN influencer_card_export_events h ON h.export_id=e.id AND h.event='handed_to_browser'
        ${where} ORDER BY e.requested_at DESC, e.id LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`,
      sql<{ total: number }[]>`SELECT count(*)::int AS total FROM influencer_card_exports e ${where}`,
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize, savedOnDevice: 'not_recorded' };
  });
}

