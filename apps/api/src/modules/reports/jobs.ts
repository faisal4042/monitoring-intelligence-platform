/**
 * Background export jobs. A request is validated and estimated, then queued (idempotent per user + key).
 * The runner claims one job with FOR UPDATE SKIP LOCKED and a time lease, re-checks the requester's CURRENT
 * permissions, streams rows from one read-only snapshot into a provider, hashes while writing, and publishes the
 * file atomically (rename). Cancel is honoured between batches. A failed or abandoned job is retried from scratch
 * (the partial file is overwritten) up to 3 attempts. Files expire; download needs a short-lived signed link.
 */
import {createHash, createHmac, randomUUID, timingSafeEqual} from 'node:crypto';
import {createWriteStream, existsSync} from 'node:fs';
import {mkdir, rename, rm, stat} from 'node:fs/promises';
import {once} from 'node:events';
import os from 'node:os';
import path from 'node:path';
import {config} from '@mip/config';
import {sql} from '@mip/db';
import {workerCheckpoint} from '../../startup/worker-ownership.js';
import type {Actor} from '../tickets/state-machine.js';
import {SCHEMA_VERSION, reportType} from './definitions.js';
import {estimateRows, planReport, ReportError, streamRows, type ReportRequest} from './query.js';
import {PROVIDERS, type ExportColumn, type ExportProvider} from './export/providers.js';
import {ZipWriter} from './export/zip.js';

export type ExportFormat = ExportProvider['format'];
export interface ExportOptions { format: ExportFormat; jsonMode?: 'flat' | 'structured'; zip?: boolean; partRows?: number; sheetRows?: number }
export const JSON_MAX_ROWS = 200_000;

export const exportDir = () => config.REPORT_EXPORT_DIR || path.join(os.tmpdir(), 'mip-report-exports');
let tableAt = 0, tableOk = false;
export async function reportsActivated() {
  if (Date.now() - tableAt < 30_000) return tableOk;
  const [r] = await sql`SELECT to_regclass('public.report_exports') IS NOT NULL AS ok`;
  tableOk = !!r.ok; tableAt = Date.now(); return tableOk;
}

/**
 * Feature gates. Tables (0047) existing is NOT enough: creating, retrying and processing exports also needs
 * REPORT_EXPORTS_ENABLED, and creating/activating/running schedules needs REPORT_SCHEDULES_ENABLED. Checked in the
 * backend (routes, service functions and workers), never only in the UI. Callers check permissions first, so a user
 * without the permission gets 403 and learns nothing about the feature state.
 */
export const exportsEnabled = () => config.REPORT_EXPORTS_ENABLED;
export const schedulesEnabled = () => config.REPORT_SCHEDULES_ENABLED;
export async function exportsActivated() { return exportsEnabled() && (await reportsActivated()); }
export async function schedulesActivated() { return schedulesEnabled() && (await reportsActivated()); }
export function assertExportsEnabled() {
  if (!exportsEnabled()) throw new ReportError(503, 'EXPORTS_DISABLED', 'تصدير التقارير معطل حاليًا على هذا الخادم');
}
export function assertSchedulesEnabled() {
  if (!schedulesEnabled()) throw new ReportError(503, 'SCHEDULES_DISABLED', 'جدولة التقارير معطلة حاليًا على هذا الخادم');
}

/** Current permissions of a user from the database (role + per-user grants); null when inactive or deleted. */
export async function actorFromDb(userId: string): Promise<Actor | null> {
  const rows = await sql<{permission_key: string}[]>`
    SELECT rp.permission_key FROM users u JOIN role_permissions rp ON rp.role_id = u.role_id
      WHERE u.id = ${userId}::uuid AND u.is_active AND u.deleted_at IS NULL
    UNION SELECT up.permission_key FROM users u JOIN user_permissions up ON up.user_id = u.id
      WHERE u.id = ${userId}::uuid AND u.is_active AND u.deleted_at IS NULL`;
  return rows.length ? {id: userId, perms: new Set(rows.map((r) => r.permission_key))} : null;
}

export async function createExport(actor: Actor, input: {request: ReportRequest; options: ExportOptions; idempotencyKey: string; templateId?: string | null; templateVersion?: number | null; scheduleRunId?: string | null}) {
  if (!actor.perms.has('reports:export')) throw new ReportError(403, 'EXPORT_FORBIDDEN', 'تصدير التقارير يتطلب صلاحية reports:export');
  assertExportsEnabled();
  if (!(await reportsActivated())) throw new ReportError(503, 'REPORTS_NOT_ACTIVATED', 'محرك التصدير يتطلب تفعيل الترحيل 0047');
  if (!PROVIDERS[input.options.format]) throw new ReportError(400, 'FORMAT_UNSUPPORTED', 'صيغة غير مدعومة');
  const plan = await planReport(actor, input.request);
  const [existing] = await sql`SELECT * FROM report_exports WHERE requested_by = ${actor.id}::uuid AND idempotency_key = ${input.idempotencyKey}`;
  if (existing) return existing;
  const [{n}] = await sql`SELECT count(*)::int AS n FROM report_exports WHERE requested_by = ${actor.id}::uuid AND status IN ('queued','running')`;
  if (n >= config.REPORT_EXPORT_MAX_ACTIVE_PER_USER) throw new ReportError(429, 'TOO_MANY_EXPORTS', `لديك ${n} عمليات تصدير جارية؛ انتظر انتهاءها`);
  const estimate = await estimateRows(plan);
  if (estimate !== null && estimate > config.REPORT_EXPORT_MAX_ROWS) throw new ReportError(413, 'EXPORT_TOO_LARGE', `عدد السجلات (${estimate}) يتجاوز الحد ${config.REPORT_EXPORT_MAX_ROWS}. ضيّق الفترة أو الفلاتر.`);
  if (input.options.format === 'json' && (estimate === null || estimate > JSON_MAX_ROWS)) throw new ReportError(422, 'USE_JSONL', 'تصدير JSON الكبير غير مدعوم كملف واحد؛ استخدم JSONL');
  await workerCheckpoint();
  const definition = {request: input.request, options: input.options};
  const [row] = await sql`
    INSERT INTO report_exports (requested_by, report_type, format, definition, template_id, template_version, schema_version, rows_estimate, idempotency_key, schedule_run_id)
    VALUES (${actor.id}::uuid, ${plan.def.key}, ${input.options.format}, ${JSON.stringify(definition)}::jsonb, ${input.templateId ?? null}::uuid, ${input.templateVersion ?? null},
            ${SCHEMA_VERSION}, ${estimate}, ${input.idempotencyKey}, ${input.scheduleRunId ?? null}::uuid)
    ON CONFLICT (requested_by, idempotency_key) DO NOTHING RETURNING *`;
  if (row) return row;
  const [again] = await sql`SELECT * FROM report_exports WHERE requested_by = ${actor.id}::uuid AND idempotency_key = ${input.idempotencyKey}`;
  return again;
}

export async function listExports(actor: Actor, all: boolean) {
  return sql`SELECT e.id, e.report_type, e.format, e.status, e.rows_written, e.rows_estimate, e.file_name, e.file_bytes, e.parts, e.error,
      e.created_at, e.started_at, e.finished_at, e.expires_at, e.attempts, e.cancel_requested, e.template_id, u.full_name AS requested_by_name,
      e.requested_by = ${actor.id}::uuid AS is_owner,
      (SELECT count(*)::int FROM report_export_downloads d WHERE d.export_id = e.id) AS downloads
    FROM report_exports e JOIN users u ON u.id = e.requested_by
    WHERE ${all ? sql`true` : sql`e.requested_by = ${actor.id}::uuid`}
    ORDER BY e.created_at DESC LIMIT 100`;
}
async function ownExport(actor: Actor, id: string, all = false) {
  const [e] = await sql`SELECT * FROM report_exports WHERE id = ${id}::uuid AND (${all ? sql`true` : sql`requested_by = ${actor.id}::uuid`})`;
  if (!e) throw new ReportError(404, 'EXPORT_NOT_FOUND', 'عملية التصدير غير موجودة');
  return e;
}
export async function cancelExport(actor: Actor, id: string) {
  const e = await ownExport(actor, id);
  if (!['queued', 'running'].includes(e.status)) throw new ReportError(409, 'NOT_CANCELLABLE', 'لا يمكن إلغاء عملية منتهية');
  await workerCheckpoint();
  await sql`UPDATE report_exports SET cancel_requested = true,
    status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
    finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END WHERE id = ${id}::uuid`;
  return {id, cancelRequested: true, previousStatus: e.status as string, status: e.status === 'queued' ? 'cancelled' : e.status as string, reportType: e.report_type as string};
}
export async function retryExport(actor: Actor, id: string) {
  if (!actor.perms.has('reports:export')) throw new ReportError(403, 'EXPORT_FORBIDDEN', 'تصدير التقارير يتطلب صلاحية reports:export');
  assertExportsEnabled();
  const e = await ownExport(actor, id);
  if (!['failed', 'cancelled', 'expired'].includes(e.status)) throw new ReportError(409, 'NOT_RETRYABLE', 'يمكن إعادة المحاولة للعمليات الفاشلة أو الملغاة أو المنتهية فقط');
  const def = e.definition as {request: ReportRequest; options: ExportOptions};
  return createExport(actor, {request: def.request, options: def.options, idempotencyKey: `retry:${e.id}:${randomUUID()}`, templateId: e.template_id, templateVersion: e.template_version});
}

// ── Signed download links ─────────────────────────────────────────────────
const linkKey = () => createHmac('sha256', config.JWT_SECRET).update('mip:report-download:v1').digest();
export function signLink(exportId: string, userId: string, ttlSeconds = 300) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${exportId}.${userId}.${exp}`;
  const sig = createHmac('sha256', linkKey()).update(payload).digest('base64url');
  return {token: `${Buffer.from(payload).toString('base64url')}.${sig}`, expiresAt: new Date(exp * 1000).toISOString()};
}
export function verifyLink(exportId: string, token: string): string | null {
  const [p, sig] = token.split('.');
  if (!p || !sig) return null;
  const payload = Buffer.from(p, 'base64url').toString('utf8');
  // Canonical encoding only: base64 decoding ignores stray trailing characters, so a re-encoded mismatch is a forgery.
  if (Buffer.from(payload, 'utf8').toString('base64url') !== p) return null;
  const expected = createHmac('sha256', linkKey()).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const [id, userId, exp] = payload.split('.');
  if (id !== exportId || Number(exp) * 1000 < Date.now()) return null;
  return userId;
}
export async function linkForExport(actor: Actor, id: string) {
  const e = await ownExport(actor, id);
  if (e.status !== 'succeeded') throw new ReportError(409, 'NOT_READY', 'الملف غير جاهز للتنزيل');
  if (e.expires_at && new Date(e.expires_at) < new Date()) throw new ReportError(410, 'EXPIRED', 'انتهت صلاحية الملف؛ أعد إنشاء التصدير');
  return signLink(e.id, actor.id);
}
/** Resolves a download: token valid, requester still active with reports:export and the report's data permission, file present. */
export async function resolveDownload(id: string, token: string) {
  const userId = verifyLink(id, token);
  if (!userId) throw new ReportError(403, 'LINK_INVALID', 'رابط التنزيل غير صالح أو منتهي');
  const actor = await actorFromDb(userId);
  if (!actor || !actor.perms.has('reports:export')) throw new ReportError(403, 'EXPORT_FORBIDDEN', 'لم تعد تملك صلاحية التنزيل');
  const [e] = await sql`SELECT * FROM report_exports WHERE id = ${id}::uuid AND requested_by = ${userId}::uuid AND status = 'succeeded'`;
  if (!e) throw new ReportError(404, 'EXPORT_NOT_FOUND', 'الملف غير موجود');
  const def = reportType(e.report_type);
  if (!def || !def.dataPermissions.some((p) => actor.perms.has(p))) throw new ReportError(403, 'REPORT_FORBIDDEN', 'لم تعد تملك صلاحية بيانات هذا التقرير');
  if (e.expires_at && new Date(e.expires_at) < new Date()) throw new ReportError(410, 'EXPIRED', 'انتهت صلاحية الملف');
  if (!e.file_path || !existsSync(e.file_path) || !path.resolve(e.file_path).startsWith(path.resolve(exportDir()))) throw new ReportError(410, 'FILE_MISSING', 'الملف غير متاح');
  await workerCheckpoint();
  await sql`INSERT INTO report_export_downloads (export_id, user_id) VALUES (${e.id}, ${userId}::uuid)`;
  return {export: e, contentType: e.file_name?.endsWith('.zip') ? 'application/zip' : PROVIDERS[e.format as ExportFormat].contentType};
}

// ── Runner ────────────────────────────────────────────────────────────────
export async function claimNextExport(owner: string) {
  // Never pick up queued work while exports are disabled, whoever calls this.
  if (!exportsEnabled()) return null;
  await workerCheckpoint();
  const [job] = await sql`
    UPDATE report_exports SET status = 'running', attempts = attempts + 1, lease_owner = ${owner}::uuid, lease_until = now() + interval '10 minutes',
      started_at = coalesce(started_at, now()), rows_written = 0, error = NULL
    WHERE id = (SELECT id FROM report_exports
                WHERE (status = 'queued' OR (status = 'running' AND lease_until < now())) AND NOT cancel_requested AND attempts < 3
                ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING *`;
  return job ?? null;
}

const safeName = (s: string) => s.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/-+/g, '-').slice(0, 60);

export async function runExport(job: Record<string, any>, owner: string): Promise<'succeeded' | 'failed' | 'cancelled'> {
  const def = job.definition as {request: ReportRequest; options: ExportOptions};
  const dir = path.join(exportDir(), job.id);
  try {
    const actor = await actorFromDb(job.requested_by);
    if (!actor) throw new ReportError(403, 'REQUESTER_INACTIVE', 'صاحب الطلب لم يعد نشطًا');
    const plan = await planReport(actor, def.request);
    if (!actor.perms.has('reports:export')) throw new ReportError(403, 'EXPORT_FORBIDDEN', 'صاحب الطلب لم يعد يملك صلاحية التصدير');
    const provider = PROVIDERS[def.options.format];
    const lang = def.request.headerLang;
    const columns: ExportColumn[] = plan.columns.map((c) => ({key: c.key, label: lang === 'en' ? c.en : c.ar, type: c.type, group: c.group}));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const baseName = `${safeName(lang === 'en' ? plan.def.en : plan.def.ar)}-${stamp}`;
    const zipped = provider.format === 'xlsx' || !!def.options.zip;
    const fileName = provider.format === 'xlsx' ? `${baseName}.xlsx` : zipped ? `${baseName}.zip` : `${baseName}.${provider.extension}`;
    await mkdir(dir, {recursive: true});
    const tmp = path.join(dir, fileName + '.part');
    const out = createWriteStream(tmp, {flags: 'w'});
    const hash = createHash('sha256');
    const origWrite = out.write.bind(out);
    (out as unknown as {write: (c: Buffer | string) => boolean}).write = (c: Buffer | string) => { hash.update(c); return origWrite(c); };
    const zip = zipped ? new ZipWriter(out) : null;
    const write = async (chunk: string | Buffer) => { if (!out.write(chunk)) await once(out, 'drain'); };
    const meta = {schemaVersion: SCHEMA_VERSION, reportType: plan.def.key, reportLabel: lang === 'en' ? plan.def.en : plan.def.ar,
      generatedAt: new Date().toISOString(), filters: {period: def.request.period, ...def.request.filters}, headerLang: lang, rowsEstimate: job.rows_estimate};
    const writer = await provider.open({write, zip}, columns, meta, {jsonMode: def.options.jsonMode, partRows: def.options.partRows, sheetRows: def.options.sheetRows, baseName});
    let written = 0, sinceUpdate = 0, cancelled = false;
    await streamRows(plan, async (rows) => {
      await writer.rows(rows);
      written += rows.length; sinceUpdate += rows.length;
      if (sinceUpdate >= 5000) {
        sinceUpdate = 0;
        await workerCheckpoint();
        const [s] = await sql`UPDATE report_exports SET rows_written = ${written}, lease_until = now() + interval '10 minutes'
          WHERE id = ${job.id} AND lease_owner = ${owner}::uuid RETURNING cancel_requested`;
        if (!s) throw new Error('EXPORT_LEASE_LOST');
        if (s.cancel_requested) { cancelled = true; return 'stop'; }
      }
    });
    if (!cancelled) {
      const [c] = await sql`SELECT cancel_requested FROM report_exports WHERE id = ${job.id}`;
      cancelled = c.cancel_requested;
    }
    const {parts} = await writer.close();
    if (zip) await zip.finish();
    out.end(); await once(out, 'finish');
    if (cancelled) {
      await rm(dir, {recursive: true, force: true});
      await workerCheckpoint();
      await sql`UPDATE report_exports SET status = 'cancelled', finished_at = now(), rows_written = ${written}, lease_owner = NULL WHERE id = ${job.id}`;
      return 'cancelled';
    }
    const finalPath = path.join(dir, fileName);
    await rename(tmp, finalPath);
    const size = (await stat(finalPath)).size;
    await workerCheckpoint();
    await sql`UPDATE report_exports SET status = 'succeeded', rows_written = ${written}, file_name = ${fileName}, file_path = ${finalPath},
        file_bytes = ${size}, file_sha256 = ${hash.digest('hex')}, parts = ${parts}, finished_at = now(),
        expires_at = now() + ${config.REPORT_EXPORT_TTL_HOURS} * interval '1 hour', lease_owner = NULL, lease_until = NULL
      WHERE id = ${job.id} AND lease_owner = ${owner}::uuid`;
    return 'succeeded';
  } catch (error) {
    const message = error instanceof ReportError ? error.message : `فشل التصدير: ${(error as Error).message}`.slice(0, 500);
    await rm(dir, {recursive: true, force: true}).catch(() => {});
    const permanent = error instanceof ReportError;
    await workerCheckpoint().catch(() => {});
    await sql`UPDATE report_exports SET status = ${permanent || job.attempts >= 3 ? 'failed' : 'queued'}, error = ${message},
        finished_at = CASE WHEN ${permanent || job.attempts >= 3} THEN now() ELSE NULL END, lease_owner = NULL, lease_until = NULL
      WHERE id = ${job.id}`.catch(() => {});
    return 'failed';
  }
}

/** Marks expired files and removes them from disk. Rows are kept for the download history. */
export async function expireExports() {
  await workerCheckpoint();
  const rows = await sql`UPDATE report_exports SET status = 'expired' WHERE status = 'succeeded' AND expires_at < now() RETURNING id, file_path`;
  for (const r of rows) if (r.file_path && path.resolve(r.file_path).startsWith(path.resolve(exportDir()))) await rm(path.dirname(r.file_path), {recursive: true, force: true});
  return rows.length;
}
