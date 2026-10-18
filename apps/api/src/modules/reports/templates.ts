/** Report templates: private by default; shared templates need reports:manage_templates. Every definition change is a new version. */
import {z} from 'zod';
import {sql} from '@mip/db';
import {workerCheckpoint} from '../../startup/worker-ownership.js';
import type {Actor} from '../tickets/state-machine.js';
import {planReport, reportRequestSchema, ReportError} from './query.js';

export const templateDefinitionSchema = z.object({
  request: reportRequestSchema,
  options: z.object({format: z.enum(['xlsx', 'csv', 'tsv', 'json', 'jsonl']), jsonMode: z.enum(['flat', 'structured']).optional(), zip: z.boolean().optional()}).strict(),
}).strict();
export type TemplateDefinition = z.infer<typeof templateDefinitionSchema>;

export async function listTemplates(actor: Actor) {
  return sql`SELECT t.id, t.name, t.report_type, t.visibility, t.version, t.definition, t.updated_at, t.owner_id = ${actor.id}::uuid AS is_owner, u.full_name AS owner_name
    FROM report_templates t JOIN users u ON u.id = t.owner_id
    WHERE t.deleted_at IS NULL AND (t.owner_id = ${actor.id}::uuid OR t.visibility = 'shared') ORDER BY t.updated_at DESC LIMIT 200`;
}
export async function getTemplate(actor: Actor, id: string) {
  const [t] = await sql<({owner_id: string; visibility: string} & Record<string, any>)[]>`SELECT * FROM report_templates WHERE id = ${id}::uuid AND deleted_at IS NULL AND (owner_id = ${actor.id}::uuid OR visibility = 'shared')`;
  if (!t) throw new ReportError(404, 'TEMPLATE_NOT_FOUND', 'القالب غير موجود');
  return t;
}
const canEdit = (actor: Actor, t: {owner_id: string; visibility: string}) =>
  t.owner_id === actor.id || (t.visibility === 'shared' && actor.perms.has('reports:manage_templates'));

export async function createTemplate(actor: Actor, input: {name: string; visibility: 'private' | 'shared'; definition: TemplateDefinition}) {
  if (input.visibility === 'shared' && !actor.perms.has('reports:manage_templates')) throw new ReportError(403, 'SHARE_FORBIDDEN', 'مشاركة القوالب تتطلب صلاحية إدارة القوالب');
  await planReport(actor, input.definition.request);
  await workerCheckpoint();
  return sql.begin(async (tx) => {
    const [t] = await tx`INSERT INTO report_templates (owner_id, name, report_type, visibility, definition)
      VALUES (${actor.id}::uuid, ${input.name.trim()}, ${input.definition.request.type}, ${input.visibility}, ${JSON.stringify(input.definition)}::jsonb) RETURNING *`;
    await tx`INSERT INTO report_template_versions (template_id, version, definition, created_by) VALUES (${t.id}, 1, ${JSON.stringify(input.definition)}::jsonb, ${actor.id}::uuid)`;
    return t;
  });
}
export async function updateTemplate(actor: Actor, id: string, input: {name?: string; visibility?: 'private' | 'shared'; definition?: TemplateDefinition}) {
  const t = await getTemplate(actor, id);
  if (!canEdit(actor, t)) throw new ReportError(403, 'TEMPLATE_FORBIDDEN', 'لا يمكنك تعديل هذا القالب');
  if (input.visibility === 'shared' && !actor.perms.has('reports:manage_templates')) throw new ReportError(403, 'SHARE_FORBIDDEN', 'مشاركة القوالب تتطلب صلاحية إدارة القوالب');
  if (input.definition) await planReport(actor, input.definition.request);
  await workerCheckpoint();
  return sql.begin(async (tx) => {
    const version = input.definition ? t.version + 1 : t.version;
    const [u] = await tx`UPDATE report_templates SET name = ${input.name?.trim() ?? t.name}, visibility = ${input.visibility ?? t.visibility},
        definition = ${JSON.stringify((input.definition ?? t.definition))}::jsonb, report_type = ${input.definition?.request.type ?? t.report_type},
        version = ${version}, updated_at = now() WHERE id = ${id}::uuid RETURNING *`;
    if (input.definition) await tx`INSERT INTO report_template_versions (template_id, version, definition, created_by) VALUES (${id}::uuid, ${version}, ${JSON.stringify(input.definition)}::jsonb, ${actor.id}::uuid)`;
    return u;
  });
}
export async function deleteTemplate(actor: Actor, id: string) {
  const t = await getTemplate(actor, id);
  if (!canEdit(actor, t)) throw new ReportError(403, 'TEMPLATE_FORBIDDEN', 'لا يمكنك حذف هذا القالب');
  const [{n}] = await sql`SELECT count(*)::int AS n FROM report_schedules WHERE template_id = ${id}::uuid AND is_active`;
  if (n) throw new ReportError(409, 'TEMPLATE_SCHEDULED', 'القالب مستخدم في جدولة نشطة؛ أوقف الجدولة أولًا');
  await workerCheckpoint();
  await sql`UPDATE report_templates SET deleted_at = now() WHERE id = ${id}::uuid`;
  return {id, deleted: true};
}
