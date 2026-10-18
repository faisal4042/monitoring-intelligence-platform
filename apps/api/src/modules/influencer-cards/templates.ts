/**
 * Influencer card templates (migration 0048, pending approval): an editable
 * draft per template, immutable published versions, at most one default per
 * program plus one global default, and immutable identity images.
 *
 * Until 0048 is applied every management call answers 503
 * CARD_TEMPLATES_NOT_ACTIVATED and resolution falls back to the built-in card,
 * so the export keeps working exactly as in phase 2.
 */
import { createHash } from 'node:crypto';
import { sql } from '@mip/db';
import {
  CARD_TEMPLATE_SCHEMA_VERSION, BUILTIN_CARD_TEMPLATE, cardTemplateAssetIds, cardTemplateConfigSchema, cardTemplateIssues,
  type CardTemplateConfig,
} from '@mip/shared';
import { HttpError } from '../../lib/errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let activeCache: { at: number; ok: boolean } | null = null;
const NEGATIVE_TTL = process.env.NODE_ENV === 'test' ? 0 : 30_000;

/** Whether migration 0048's tables exist; once true it stays true for the process. */
export async function templatesActive(): Promise<boolean> {
  if (activeCache?.ok) return true;
  if (activeCache && Date.now() - activeCache.at < NEGATIVE_TTL) return false;
  const [r] = await sql<{ ok: boolean }[]>`SELECT (to_regclass('public.influencer_card_templates') IS NOT NULL
    AND to_regclass('public.influencer_card_template_versions') IS NOT NULL
    AND to_regclass('public.influencer_card_assets') IS NOT NULL) AS ok`;
  activeCache = { at: Date.now(), ok: r.ok };
  return r.ok;
}

export async function requireActive() {
  if (!(await templatesActive()))
    throw new HttpError(503, 'قوالب بطاقات المؤثرين غير مفعّلة بعد (بانتظار اعتماد Migration 0048)', 'CARD_TEMPLATES_NOT_ACTIVATED');
}

/** Parses a configuration; 400 with per-field messages when invalid, 400 when an image id is unknown or of the wrong kind. */
export async function validConfig(input: unknown): Promise<CardTemplateConfig> {
  const parsed = cardTemplateConfigSchema.safeParse(input);
  if (!parsed.success)
    throw new HttpError(400, 'إعدادات القالب غير صالحة', 'INVALID_TEMPLATE_CONFIG', { fields: cardTemplateIssues(parsed.error) });
  const c = parsed.data;
  const wanted = [
    ...(c.logo.assetId ? [{ id: c.logo.assetId, kind: 'logo', field: 'logo.assetId' }] : []),
    ...(c.background.imageAssetId ? [{ id: c.background.imageAssetId, kind: 'background', field: 'background.imageAssetId' }] : []),
  ];
  if (wanted.length) {
    const found = await sql<{ id: string; kind: string }[]>`SELECT id,kind FROM influencer_card_assets WHERE id = ANY(${cardTemplateAssetIds(c)}::uuid[])`;
    for (const w of wanted)
      if (!found.some((f) => f.id === w.id && f.kind === w.kind))
        throw new HttpError(400, 'صورة الهوية غير موجودة أو من نوع آخر', 'UNKNOWN_TEMPLATE_ASSET', { fields: { [w.field]: 'الصورة غير موجودة' } });
  }
  return c;
}

/** Stable hash of a validated configuration (zod output keeps the schema's key order). */
export const configHash = (c: CardTemplateConfig) => createHash('sha256').update(JSON.stringify(c)).digest('hex');

export async function programId(value: string | null | undefined): Promise<string | null> {
  if (!value) return null;
  const [p] = await sql<{ id: string }[]>`SELECT id FROM programs WHERE deleted_at IS NULL
    AND (${UUID.test(value) ? value : null}::uuid IS NOT NULL AND id = ${UUID.test(value) ? value : null}::uuid OR key = ${value})`;
  if (!p) throw new HttpError(400, 'البرنامج غير موجود', 'UNKNOWN_PROGRAM');
  return p.id;
}

export const templateSummary = sql`
  SELECT t.id,t.name,t.description,t.program_id,p.name_ar AS program_name,t.status,t.is_default,t.draft_revision,
    t.published_version,t.created_at,t.updated_at,u.full_name AS updated_by_name,
    (t.published_version IS NULL OR v.config IS DISTINCT FROM t.draft_config) AS has_unpublished_changes
  FROM influencer_card_templates t
  LEFT JOIN programs p ON p.id = t.program_id
  LEFT JOIN influencer_card_template_versions v ON v.template_id = t.id AND v.version = t.published_version
  LEFT JOIN users u ON u.id = coalesce(t.updated_by, t.created_by)`;

export async function getTemplate(id: string) {
  const [t] = await sql`${templateSummary} WHERE t.id = ${id}::uuid`;
  if (!t) throw new HttpError(404, 'القالب غير موجود', 'NOT_FOUND');
  const [{ draft_config }] = await sql<{ draft_config: unknown }[]>`SELECT draft_config FROM influencer_card_templates WHERE id = ${id}::uuid`;
  const versions = await sql`SELECT v.version,v.schema_version,v.config_sha256,v.note,v.published_at,u.full_name AS published_by_name
    FROM influencer_card_template_versions v LEFT JOIN users u ON u.id = v.published_by
    WHERE v.template_id = ${id}::uuid ORDER BY v.version DESC`;
  return { ...t, draft_config, versions };
}

export type Resolved =
  | { source: 'template'; activated: true; template: { id: string; name: string; version: number; program_id: string | null }; config: CardTemplateConfig }
  | { source: 'builtin'; activated: boolean; template: null; config: CardTemplateConfig };

/**
 * The template an export uses: an explicitly chosen active published template
 * (404 when missing/unpublished/disabled, 409 TEMPLATE_VERSION_INVALID when its
 * published version is invalid — never a fallback), else the program's default,
 * else the global default, else the built-in card.
 * Always the published version, never a draft.
 */
export async function resolveTemplate(opts: { templateId?: string | null; programId?: string | null }): Promise<Resolved> {
  if (!(await templatesActive())) return { source: 'builtin', activated: false, template: null, config: BUILTIN_CARD_TEMPLATE };
  const rows = await sql<{ id: string; name: string; version: number; program_id: string | null; config: unknown; rank: number }[]>`
    SELECT t.id,t.name,v.version,t.program_id,v.config,
      CASE WHEN t.id = ${opts.templateId ?? null}::uuid THEN 0 WHEN t.is_default AND t.program_id = ${opts.programId ?? null}::uuid THEN 1 ELSE 2 END AS rank
    FROM influencer_card_templates t
    JOIN influencer_card_template_versions v ON v.template_id = t.id AND v.version = t.published_version
    WHERE t.status = 'active' AND (t.id = ${opts.templateId ?? null}::uuid
      OR (t.is_default AND (t.program_id = ${opts.programId ?? null}::uuid OR t.program_id IS NULL)))
    ORDER BY rank,t.id`;
  const hit = rows[0];
  if (opts.templateId) {
    // An explicit choice is used as chosen or refused; it never silently becomes another template.
    if (hit?.id !== opts.templateId) throw new HttpError(404, 'القالب غير موجود أو غير منشور أو موقوف', 'NOT_FOUND');
    const parsed = cardTemplateConfigSchema.safeParse(hit.config);
    if (!parsed.success)
      throw new HttpError(409, 'الإصدار المنشور للقالب المختار غير صالح؛ اختر قالباً آخر أو أعد نشره', 'TEMPLATE_VERSION_INVALID');
    return { source: 'template', activated: true, template: { id: hit.id, name: hit.name, version: hit.version, program_id: hit.program_id }, config: parsed.data };
  }
  // Defaults only: a corrupt candidate gives way to the next one, then to the built-in card.
  for (const candidate of rows) {
    const parsed = cardTemplateConfigSchema.safeParse(candidate.config);
    if (!parsed.success) continue;
    return { source: 'template', activated: true, template: { id: candidate.id, name: candidate.name, version: candidate.version, program_id: candidate.program_id }, config: parsed.data };
  }
  return { source: 'builtin', activated: true, template: null, config: BUILTIN_CARD_TEMPLATE };
}

export { CARD_TEMPLATE_SCHEMA_VERSION };
