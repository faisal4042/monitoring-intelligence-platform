/**
 * /influencers/card-templates — template studio and template resolution for
 * the card export. Registered by influencers.routes.ts (inherits its
 * authentication hook).
 *
 * Permissions (proposed in 0048, granted to no role by this change):
 *   influencer_card_templates:read    list and view templates, versions, images
 *   influencer_card_templates:manage  create, edit, publish, duplicate, default, disable, upload
 * Export users (influencers:read + posts:read, as for the card data) may
 * resolve and list published templates and load their images — nothing else.
 * Every change is audited. No influencer data is ever stored in a template.
 */
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sql } from '@mip/db';
import { CARD_PERMISSIONS, CARD_TEMPLATE_SCHEMA_VERSION, BUILTIN_CARD_TEMPLATE, PERMISSIONS } from '@mip/shared';
import { audit } from '../../lib/audit.js';
import { HttpError } from '../../lib/errors.js';
import { parse } from '../queue/validation.js';
import { CardImageError, inspectCardImage } from './images.js';
import { beforeCardWrite, cardErrorHandler } from './write-guard.js';
import { requireCardAccess } from './access.js';
import { cardMutation } from './mutation.js';
import {
  configHash, getTemplate, programId, requireActive, resolveTemplate, templatesActive, templateSummary, validConfig,
} from './templates.js';

const READ = [CARD_PERMISSIONS.TEMPLATES_READ, CARD_PERMISSIONS.TEMPLATES_MANAGE];
const MANAGE = CARD_PERMISSIONS.TEMPLATES_MANAGE;
const ENTITY = 'influencer_card_template';

const idParams = z.object({ id: z.string().uuid() }).strict();
const name = z.string().trim().min(1, 'اسم القالب مطلوب').max(120)
  .refine((s) => !/[<>{}`\\]/.test(s), 'لا يُسمح برموز الوسوم أو الأكواد');
const description = z.string().trim().max(500).refine((s) => !/[<>{}`\\]/.test(s), 'لا يُسمح برموز الوسوم أو الأكواد').nullable();
const createBody = z.object({ name, description: description.optional(), programId: z.string().max(64).nullable().optional(), config: z.unknown().optional() }).strict();
const updateBody = z.object({
  revision: z.number().int().positive(),
  name: name.optional(), description: description.optional(), programId: z.string().max(64).nullable().optional(), config: z.unknown().optional(),
}).strict();
const revisionBody = z.object({ revision: z.number().int().positive(), note: z.string().trim().max(300).optional() }).strict();
const assetBody = z.object({
  kind: z.enum(['logo', 'background']),
  fileName: z.string().trim().max(200).optional(),
  data: z.string().min(1).max(1_500_000).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'بيانات الملف ليست Base64 صالحة'),
}).strict();

export default async function cardTemplateRoutes(app: FastifyInstance) {
  // Scoped to this plugin: 413 for an over-limit upload, 503 for a fenced write; anything else goes on unchanged.
  app.setErrorHandler(cardErrorHandler);

  const readers = { preHandler: [app.requirePermission(...READ), requireCardAccess('studio-read')] };
  const managers = { preHandler: [app.requirePermission(MANAGE), requireCardAccess('manage')] };
  // The card's own data rule: influencers:read and posts:read.
  const exporters = { preHandler: [app.requirePermission(PERMISSIONS.INFLUENCERS_READ), app.requirePermission(PERMISSIONS.POSTS_READ), requireCardAccess('read')] };

  // ── Resolution for the export (works before 0048: built-in card) ──
  app.get('/resolve', exporters, async (req) => {
    const q = parse(z.object({ program: z.string().max(64).optional(), templateId: z.string().uuid().optional() }).strict(), req.query);
    return resolveTemplate({ templateId: q.templateId, programId: await programId(q.program) });
  });

  app.get('/published', exporters, async () => {
    if (!(await templatesActive())) return { activated: false, items: [] };
    return {
      activated: true,
      items: await sql`SELECT t.id,t.name,t.program_id,p.name_ar AS program_name,t.published_version,t.is_default
        FROM influencer_card_templates t LEFT JOIN programs p ON p.id = t.program_id
        WHERE t.status = 'active' AND t.published_version IS NOT NULL ORDER BY t.is_default DESC, lower(t.name)`,
    };
  });

  // ── Images ──
  app.get('/assets', readers, async () => {
    await requireActive();
    return { items: await sql`SELECT id,kind,mime,width,height,byte_size,original_name,created_at FROM influencer_card_assets ORDER BY created_at DESC LIMIT 100` };
  });

  app.post('/assets', { ...managers, bodyLimit: 1_600_000 }, async (req, reply) => {
    await requireActive();
    await beforeCardWrite();
    const body = parse(assetBody, req.body);
    const bytes = Buffer.from(body.data, 'base64');
    let info;
    try { info = inspectCardImage(bytes); }
    catch (e) { if (e instanceof CardImageError) throw new HttpError(400, e.message, 'INVALID_IMAGE'); throw e; }
    const extension = info.mime === 'image/png' ? /\.png$/i : info.mime === 'image/jpeg' ? /\.jpe?g$/i : /\.webp$/i;
    if (body.fileName && (!extension.test(body.fileName) || /[\\/\x00-\x1f]/.test(body.fileName)))
      throw new HttpError(400, 'اسم الصورة لا يطابق محتواها أو يحتوي مساراً غير مسموح', 'INVALID_IMAGE_NAME');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const { created, asset } = await cardMutation(async tx => {
    const [created] = await tx`INSERT INTO influencer_card_assets (kind,mime,bytes,byte_size,width,height,sha256,original_name,created_by)
      VALUES (${body.kind},${info.mime},${bytes},${bytes.length},${info.width},${info.height},${sha256},${body.fileName ?? null},${req.user.id}::uuid)
      ON CONFLICT (kind, sha256) DO NOTHING
      RETURNING id,kind,mime,width,height,byte_size,original_name,created_at`;
    const asset = created ?? (await tx`SELECT id,kind,mime,width,height,byte_size,original_name,created_at FROM influencer_card_assets WHERE kind=${body.kind} AND sha256=${sha256}`)[0];
    if (created) await audit(req, { action: 'card_asset.upload', entityType: 'influencer_card_asset', entityId: asset.id, entityLabel: body.fileName ?? asset.id,
      newValue: { kind: body.kind, mime: info.mime, width: info.width, height: info.height, bytes: bytes.length, sha256 } }, tx);
    return { created, asset };
    });
    return reply.code(created ? 201 : 200).send(asset);
  });

  app.get('/assets/:id', { preHandler: [app.requirePermission(...READ, PERMISSIONS.POSTS_READ), requireCardAccess('asset')] }, async (req, reply) => {
    await requireActive();
    const { id } = parse(idParams, req.params);
    // Template readers/managers see every uploaded image. Anyone else (an exporter) only images a published
    // version of an active template uses — never a draft's or an unused upload; an unknown id and a hidden one look the same.
    const studio = READ.some((p) => req.user.permissions.includes(p));
    const [a] = await sql<{ mime: string; bytes: Buffer; sha256: string }[]>`SELECT a.mime,a.bytes,a.sha256 FROM influencer_card_assets a
      WHERE a.id=${id}::uuid AND (${studio} OR EXISTS (
        SELECT 1 FROM influencer_card_templates t JOIN influencer_card_template_versions v ON v.template_id=t.id AND v.version=t.published_version
        WHERE t.status='active' AND (v.config->'logo'->>'assetId' = a.id::text OR v.config->'background'->>'imageAssetId' = a.id::text)))`;
    if (!a) throw new HttpError(404, 'الصورة غير موجودة', 'NOT_FOUND');
    return reply.header('content-type', a.mime).header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'").header('cache-control', 'private, max-age=86400, immutable')
      .header('etag', `"${a.sha256}"`).send(a.bytes);
  });

  // ── Templates ──
  app.get('/', readers, async () => {
    await requireActive();
    return { items: await sql`${templateSummary} ORDER BY t.is_default DESC, lower(t.name)`, schemaVersion: CARD_TEMPLATE_SCHEMA_VERSION };
  });

  app.post('/', managers, async (req, reply) => {
    await requireActive();
    await beforeCardWrite();
    const body = parse(createBody, req.body);
    const config = await validConfig(body.config ?? BUILTIN_CARD_TEMPLATE);
    const program = await programId(body.programId);
    const row = await cardMutation(async tx => {
    const [row] = await tx<{ id: string }[]>`INSERT INTO influencer_card_templates (name,description,program_id,draft_config,created_by)
      VALUES (${body.name},${body.description ?? null},${program},${JSON.stringify(config)}::jsonb,${req.user.id}::uuid)
      ON CONFLICT DO NOTHING RETURNING id`;
    if (!row) throw new HttpError(409, 'يوجد قالب بهذا الاسم', 'TEMPLATE_NAME_TAKEN');
    await audit(req, { action: 'card_template.create', entityType: ENTITY, entityId: row.id, entityLabel: body.name, newValue: { programId: program, configSha256: configHash(config) } }, tx);
    return row;
    });
    return reply.code(201).send(await getTemplate(row.id));
  });

  app.get('/:id', readers, async (req) => {
    await requireActive();
    return getTemplate(parse(idParams, req.params).id);
  });

  app.get('/:id/versions/:version', readers, async (req) => {
    await requireActive();
    const p = parse(z.object({ id: z.string().uuid(), version: z.coerce.number().int().positive() }).strict(), req.params);
    const [v] = await sql`SELECT v.template_id,v.version,v.config,v.schema_version,v.config_sha256,v.note,v.published_at,u.full_name AS published_by_name
      FROM influencer_card_template_versions v LEFT JOIN users u ON u.id=v.published_by WHERE v.template_id=${p.id}::uuid AND v.version=${p.version}`;
    if (!v) throw new HttpError(404, 'الإصدار غير موجود', 'NOT_FOUND');
    return v;
  });

  /** Edits the draft only. A stale revision is refused (409) instead of overwriting someone else's edit. */
  app.patch('/:id', managers, async (req) => {
    await requireActive();
    await beforeCardWrite();
    const { id } = parse(idParams, req.params);
    const body = parse(updateBody, req.body);
    const config = body.config === undefined ? undefined : await validConfig(body.config);
    const program = body.programId === undefined ? undefined : await programId(body.programId);
    await cardMutation(async (tx) => {
      const [t] = await tx<{ name: string; program_id: string | null; is_default: boolean; draft_revision: number; draft_config: unknown }[]>`
        SELECT name,program_id,is_default,draft_revision,draft_config FROM influencer_card_templates WHERE id=${id}::uuid FOR UPDATE`;
      if (!t) throw new HttpError(404, 'القالب غير موجود', 'NOT_FOUND');
      if (t.draft_revision !== body.revision) throw new HttpError(409, 'عُدّل القالب في مكان آخر؛ أعد تحميله قبل الحفظ', 'STALE_REVISION');
      if (program !== undefined && program !== t.program_id && t.is_default)
        throw new HttpError(409, 'ألغِ تعيين القالب افتراضياً قبل تغيير برنامجه', 'DEFAULT_PROGRAM_CHANGE');
      const clash = body.name ? await tx`SELECT 1 FROM influencer_card_templates WHERE lower(trim(name))=lower(trim(${body.name})) AND id<>${id}::uuid` : [];
      if (clash.length) throw new HttpError(409, 'يوجد قالب بهذا الاسم', 'TEMPLATE_NAME_TAKEN');
      await tx`UPDATE influencer_card_templates SET
          name=${body.name ?? t.name},
          description=CASE WHEN ${body.description === undefined} THEN description ELSE ${body.description ?? null} END,
          program_id=${program === undefined ? t.program_id : program},
          draft_config=${JSON.stringify(config ?? t.draft_config)}::jsonb,
          draft_revision=draft_revision+1, updated_by=${req.user.id}::uuid, updated_at=now()
        WHERE id=${id}::uuid`;
    await audit(req, { action: 'card_template.update', entityType: ENTITY, entityId: id, entityLabel: body.name ?? t.name,
      oldValue: { revision: t.draft_revision, programId: t.program_id },
      newValue: { revision: t.draft_revision + 1, programId: program === undefined ? t.program_id : program, configSha256: config ? configHash(config) : undefined } }, tx);
    });
    return getTemplate(id);
  });

  /** Freezes the current draft as the next version. Earlier versions are never touched (and the database refuses to). */
  app.post('/:id/publish', managers, async (req) => {
    await requireActive();
    await beforeCardWrite();
    const { id } = parse(idParams, req.params);
    const body = parse(revisionBody, req.body);
    await cardMutation(async (tx) => {
      const [t] = await tx<{ name: string; draft_revision: number; draft_config: unknown; status: string }[]>`
        SELECT name,draft_revision,draft_config,status FROM influencer_card_templates WHERE id=${id}::uuid FOR UPDATE`;
      if (!t) throw new HttpError(404, 'القالب غير موجود', 'NOT_FOUND');
      if (t.draft_revision !== body.revision) throw new HttpError(409, 'عُدّل القالب في مكان آخر؛ أعد تحميله قبل النشر', 'STALE_REVISION');
      const config = await validConfig(t.draft_config);
      const [{ next }] = await tx<{ next: number }[]>`SELECT coalesce(max(version),0)+1 AS next FROM influencer_card_template_versions WHERE template_id=${id}::uuid`;
      const sha = configHash(config);
      await tx`INSERT INTO influencer_card_template_versions (template_id,version,config,schema_version,config_sha256,note,published_by)
        VALUES (${id}::uuid,${next},${JSON.stringify(config)}::jsonb,${config.schemaVersion},${sha},${body.note ?? null},${req.user.id}::uuid)`;
      await tx`UPDATE influencer_card_templates SET published_version=${next}, updated_by=${req.user.id}::uuid, updated_at=now() WHERE id=${id}::uuid`;
    await audit(req, { action: 'card_template.publish', entityType: ENTITY, entityId: id, entityLabel: t.name,
      newValue: { version: next, configSha256: sha, note: body.note ?? null } }, tx);
    });
    return getTemplate(id);
  });

  /** A new, unpublished, non-default template from the source's current draft. */
  app.post('/:id/duplicate', managers, async (req, reply) => {
    await requireActive();
    await beforeCardWrite();
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ name: name.optional() }).strict(), req.body ?? {});
    const [src] = await sql<{ name: string; description: string | null; program_id: string | null; draft_config: unknown }[]>`
      SELECT name,description,program_id,draft_config FROM influencer_card_templates WHERE id=${id}::uuid`;
    if (!src) throw new HttpError(404, 'القالب غير موجود', 'NOT_FOUND');
    const config = await validConfig(src.draft_config);
    let copyName = body.name ?? `${src.name} (نسخة)`;
    for (let n = 2; !body.name && (await sql`SELECT 1 FROM influencer_card_templates WHERE lower(trim(name))=lower(trim(${copyName}))`).length; n++)
      copyName = `${src.name} (نسخة ${n})`.slice(0, 120);
    const row = await cardMutation(async tx => {
    const [row] = await tx<{ id: string }[]>`INSERT INTO influencer_card_templates (name,description,program_id,draft_config,created_by)
      VALUES (${copyName},${src.description},${src.program_id},${JSON.stringify(config)}::jsonb,${req.user.id}::uuid) ON CONFLICT DO NOTHING RETURNING id`;
    if (!row) throw new HttpError(409, 'يوجد قالب بهذا الاسم', 'TEMPLATE_NAME_TAKEN');
    await audit(req, { action: 'card_template.duplicate', entityType: ENTITY, entityId: row.id, entityLabel: copyName, newValue: { sourceId: id } }, tx);
    return row;
    });
    return reply.code(201).send(await getTemplate(row.id));
  });

  /** Copies a published version back into the draft (the version itself stays as it is). */
  app.post('/:id/restore', managers, async (req) => {
    await requireActive();
    await beforeCardWrite();
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ revision: z.number().int().positive(), version: z.number().int().positive() }).strict(), req.body);
    await cardMutation(async (tx) => {
      const [t] = await tx<{ name: string; draft_revision: number }[]>`SELECT name,draft_revision FROM influencer_card_templates WHERE id=${id}::uuid FOR UPDATE`;
      if (!t) throw new HttpError(404, 'القالب غير موجود', 'NOT_FOUND');
      if (t.draft_revision !== body.revision) throw new HttpError(409, 'عُدّل القالب في مكان آخر؛ أعد تحميله', 'STALE_REVISION');
      const [v] = await tx<{ config: unknown }[]>`SELECT config FROM influencer_card_template_versions WHERE template_id=${id}::uuid AND version=${body.version}`;
      if (!v) throw new HttpError(404, 'الإصدار غير موجود', 'NOT_FOUND');
      await tx`UPDATE influencer_card_templates SET draft_config=${JSON.stringify(v.config)}::jsonb, draft_revision=draft_revision+1,
        updated_by=${req.user.id}::uuid, updated_at=now() WHERE id=${id}::uuid`;
    await audit(req, { action: 'card_template.restore', entityType: ENTITY, entityId: id, entityLabel: t.name, newValue: { fromVersion: body.version } }, tx);
    });
    return getTemplate(id);
  });

  /** Makes this the default for its program (or the global default when it has none); the previous default is unset. */
  app.post('/:id/default', managers, async (req) => {
    await requireActive();
    await beforeCardWrite();
    const { id } = parse(idParams, req.params);
    const { isDefault } = parse(z.object({ isDefault: z.boolean() }).strict(), req.body);
    await cardMutation(async (tx) => {
      const [t] = await tx<{ name: string; program_id: string | null; status: string; published_version: number | null }[]>`
        SELECT name,program_id,status,published_version FROM influencer_card_templates WHERE id=${id}::uuid FOR UPDATE`;
      if (!t) throw new HttpError(404, 'القالب غير موجود', 'NOT_FOUND');
      if (isDefault && (t.status !== 'active' || t.published_version === null))
        throw new HttpError(409, 'لا يُعيَّن افتراضياً إلا قالب نشط له إصدار منشور', 'DEFAULT_REQUIRES_PUBLISHED');
      if (isDefault) await tx`UPDATE influencer_card_templates SET is_default=false, updated_at=now()
        WHERE is_default AND program_id IS NOT DISTINCT FROM ${t.program_id}::uuid AND id<>${id}::uuid`;
      await tx`UPDATE influencer_card_templates SET is_default=${isDefault}, updated_by=${req.user.id}::uuid, updated_at=now() WHERE id=${id}::uuid`;
    await audit(req, { action: 'card_template.default', entityType: ENTITY, entityId: id, entityLabel: t.name, newValue: { isDefault } }, tx);
    });
    return getTemplate(id);
  });

  /** Disables (or re-enables) a template without deleting it; a disabled template is never resolved and stops being a default. */
  app.post('/:id/status', managers, async (req) => {
    await requireActive();
    await beforeCardWrite();
    const { id } = parse(idParams, req.params);
    const { status } = parse(z.object({ status: z.enum(['active', 'disabled']) }).strict(), req.body);
    await cardMutation(async tx => {
    const [t] = await tx<{ name: string; status: string }[]>`SELECT name,status FROM influencer_card_templates WHERE id=${id}::uuid FOR UPDATE`;
    if (!t) throw new HttpError(404, 'القالب غير موجود', 'NOT_FOUND');
    await tx`UPDATE influencer_card_templates SET status=${status}, is_default=CASE WHEN ${status}='disabled' THEN false ELSE is_default END,
      updated_by=${req.user.id}::uuid, updated_at=now() WHERE id=${id}::uuid`;
    await audit(req, { action: 'card_template.status', entityType: ENTITY, entityId: id, entityLabel: t.name, oldValue: { status: t.status }, newValue: { status } }, tx);
    });
    return getTemplate(id);
  });
}
