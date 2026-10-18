/**
 * Reporting Center API (/api/v1/reports). reports:read to see the catalogue and preview; each report type also
 * needs its own data permission (checked in planReport); reports:export to create and download files;
 * reports:write to schedule; reports:manage_templates to share templates. Preview/estimate are read-only and work
 * on the current schema; exports, templates and schedules need migration 0047 (503 until then). Creating/retrying exports
 * also needs REPORT_EXPORTS_ENABLED (503 EXPORTS_DISABLED); creating/activating schedules needs REPORT_SCHEDULES_ENABLED
 * (503 SCHEDULES_DISABLED). Permission checks run first, so the 503 is only ever seen by users who hold the permission.
 * Download: a 5-minute HMAC link bound to export + user; the server re-checks the user's current permissions.
 */
import {createReadStream} from 'node:fs';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {PERMISSIONS as P} from '@mip/shared';
import {audit} from '../../lib/audit.js';
import {HttpError} from '../../lib/errors.js';
import {parse, idParams} from '../queue/validation.js';
import {actorOf} from '../tickets/routes.js';
import {ticketsActivated} from '../tickets/service.js';
import {REPORT_TYPES, UNAVAILABLE_REPORTS, SCHEMA_VERSION} from './definitions.js';
import {columnAllowed, estimateRows, planReport, previewRows, reportRequestSchema, ReportError, typeAllowed} from './query.js';
import {assertExportsEnabled, assertSchedulesEnabled, cancelExport, createExport, exportsActivated, linkForExport, listExports, reportsActivated, resolveDownload, retryExport, schedulesActivated} from './jobs.js';
import {createTemplate, deleteTemplate, listTemplates, templateDefinitionSchema, updateTemplate} from './templates.js';
import {createSchedule, listSchedules, setScheduleActive} from './schedules.js';

const wrap = async <T>(fn: () => Promise<T>) => {
  try { return await fn(); } catch (error) {
    if (error instanceof ReportError) throw new HttpError(error.status, error.message, error.code);
    throw error;
  }
};
const needTables = async () => { if (!(await reportsActivated())) throw new HttpError(503, 'محرك التصدير والقوالب يتطلب تفعيل الترحيل 0047', 'REPORTS_NOT_ACTIVATED'); };
const optionsSchema = z.object({format: z.enum(['xlsx', 'csv', 'tsv', 'json', 'jsonl']), jsonMode: z.enum(['flat', 'structured']).optional(), zip: z.boolean().optional()}).strict();

export default async function reportRoutes(root: FastifyInstance) {
  await root.register(async (app) => {
  // Authenticated by the signed link only (a browser download carries no bearer token); permissions are re-checked.
  app.get('/exports/:id/file', {config: {access: 'public'}}, async (req, reply) => wrap(async () => {
    await needTables();
    const {id} = parse(idParams, req.params);
    const {token} = parse(z.object({token: z.string().min(20).max(600)}).strict(), req.query);
    const {export: e, contentType} = await resolveDownload(id, token);
    await audit(req, {action: 'report.export_downloaded', entityType: 'report_export', entityId: e.id, entityLabel: e.report_type,
      newValue: {rows: Number(e.rows_written), format: e.format}, actor: {id: e.requested_by, email: null}});
    reply.header('Content-Type', contentType).header('Cache-Control', 'no-store')
      .header('Content-Disposition', `attachment; filename="export.${String(e.file_name).split('.').pop()}"; filename*=UTF-8''${encodeURIComponent(e.file_name)}`);
    return reply.send(createReadStream(e.file_path));
  }));

  });
  await root.register(authenticatedReportRoutes);
}

async function authenticatedReportRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);
  app.get('/catalog', {preHandler: [app.requirePermission(P.REPORTS_READ)]}, async (req) => {
    const actor = actorOf(req);
    const [tickets, tablesReady, exportsOn, schedulesOn] = await Promise.all([ticketsActivated(), reportsActivated(), exportsActivated(), schedulesActivated()]);
    return {
      schemaVersion: SCHEMA_VERSION, timezone: 'Asia/Riyadh', ticketsActivated: tickets, reportTablesReady: tablesReady,
      exportsActivated: exportsOn, schedulesActivated: schedulesOn,
      canExport: actor.perms.has(P.REPORTS_EXPORT), canSchedule: actor.perms.has(P.REPORTS_WRITE), canShareTemplates: actor.perms.has(P.REPORTS_MANAGE_TEMPLATES),
      formats: ['xlsx', 'csv', 'tsv', 'json', 'jsonl'],
      types: REPORT_TYPES.map((t) => {
        const allowed = typeAllowed(t, actor);
        const available = allowed && (t.needs === 'core' || tickets);
        return {key: t.key, ar: t.ar, en: t.en, section: t.section, descriptionAr: t.descriptionAr, dateLabelAr: t.dateLabelAr, aggregated: !!t.groupBy,
          filters: Object.keys(t.filters), available,
          reason: !allowed ? 'لا تملك صلاحية بيانات هذا التقرير' : !available ? 'يتطلب تفعيل نظام التذاكر (الترحيل 0047)' : null,
          columns: t.columns.map((c) => ({key: c.key, ar: c.ar, en: c.en, type: c.type, group: c.group, default: !!c.default, allowed: columnAllowed(c, actor)}))};
      }),
      unavailable: UNAVAILABLE_REPORTS,
    };
  });

  app.post('/preview', {preHandler: [app.requirePermission(P.REPORTS_READ)]}, async (req) => wrap(async () => {
    const body = parse(reportRequestSchema, req.body);
    const plan = await planReport(actorOf(req), body);
    const [rows, estimate] = await Promise.all([previewRows(plan, 50), estimateRows(plan)]);
    return {columns: plan.columns.map((c) => ({key: c.key, label: body.headerLang === 'en' ? c.en : c.ar, type: c.type})), rows, estimate,
      period: {from: plan.from, to: plan.to}, timezone: 'Asia/Riyadh'};
  }));

  app.post('/exports', {preHandler: [app.requirePermission(P.REPORTS_EXPORT)]}, async (req) => wrap(async () => {
    assertExportsEnabled();
    await needTables();
    const body = parse(z.object({request: reportRequestSchema, options: optionsSchema, idempotencyKey: z.string().min(8).max(120),
      templateId: z.string().uuid().optional()}).strict(), req.body);
    const e = await createExport(actorOf(req), body);
    await audit(req, {action: 'report.export_requested', entityType: 'report_export', entityId: e.id, entityLabel: e.report_type,
      newValue: {format: body.options.format, columns: body.request.columns.length, period: body.request.period, filters: body.request.filters}});
    return e;
  }));
  app.get('/exports', {preHandler: [app.requirePermission(P.REPORTS_EXPORT)]}, async (req) => {
    await needTables();
    const q = parse(z.object({all: z.enum(['1']).optional()}).strict(), req.query);
    return {items: await listExports(actorOf(req), !!q.all && req.user.permissions.includes(P.ADMIN_SYSTEM))};
  });
  app.post('/exports/:id/cancel', {preHandler: [app.requirePermission(P.REPORTS_EXPORT)]}, async (req) => wrap(async () => {
    await needTables(); const {id} = parse(idParams, req.params);
    const c = await cancelExport(actorOf(req), id);
    await audit(req, {action: 'report.export_cancelled', entityType: 'report_export', entityId: id, entityLabel: c.reportType,
      oldValue: {status: c.previousStatus}, newValue: {status: c.status, cancelRequested: true}});
    return c;
  }));
  app.post('/exports/:id/retry', {preHandler: [app.requirePermission(P.REPORTS_EXPORT)]}, async (req) => wrap(async () => {
    assertExportsEnabled();
    await needTables(); const {id} = parse(idParams, req.params);
    const e = await retryExport(actorOf(req), id);
    await audit(req, {action: 'report.export_retried', entityType: 'report_export', entityId: e.id, entityLabel: e.report_type, newValue: {retryOf: id, format: e.format}});
    return e;
  }));
  app.post('/exports/:id/link', {preHandler: [app.requirePermission(P.REPORTS_EXPORT)]}, async (req) => wrap(async () => {
    await needTables(); const {id} = parse(idParams, req.params);
    const link = await linkForExport(actorOf(req), id);
    return {url: `/api/v1/reports/exports/${id}/file?token=${encodeURIComponent(link.token)}`, expiresAt: link.expiresAt};
  }));
  app.get('/templates', {preHandler: [app.requirePermission(P.REPORTS_READ)]}, async (req) => { await needTables(); return {items: await listTemplates(actorOf(req))}; });
  app.post('/templates', {preHandler: [app.requirePermission(P.REPORTS_READ)]}, async (req) => wrap(async () => {
    await needTables();
    const body = parse(z.object({name: z.string().min(1).max(120), visibility: z.enum(['private', 'shared']).default('private'), definition: templateDefinitionSchema}).strict(), req.body);
    const t = await createTemplate(actorOf(req), body);
    await audit(req, {action: 'report.template_created', entityType: 'report_template', entityId: t.id, entityLabel: t.name, newValue: {visibility: t.visibility, type: t.report_type}});
    return t;
  }));
  app.patch('/templates/:id', {preHandler: [app.requirePermission(P.REPORTS_READ)]}, async (req) => wrap(async () => {
    await needTables(); const {id} = parse(idParams, req.params);
    const body = parse(z.object({name: z.string().min(1).max(120).optional(), visibility: z.enum(['private', 'shared']).optional(), definition: templateDefinitionSchema.optional()}).strict(), req.body);
    const t = await updateTemplate(actorOf(req), id, body);
    await audit(req, {action: 'report.template_updated', entityType: 'report_template', entityId: t.id, entityLabel: t.name, newValue: {version: t.version, visibility: t.visibility}});
    return t;
  }));
  app.delete('/templates/:id', {preHandler: [app.requirePermission(P.REPORTS_READ)]}, async (req) => wrap(async () => {
    await needTables(); const {id} = parse(idParams, req.params);
    const r = await deleteTemplate(actorOf(req), id);
    await audit(req, {action: 'report.template_deleted', entityType: 'report_template', entityId: id});
    return r;
  }));

  app.get('/schedules', {preHandler: [app.requirePermission(P.REPORTS_WRITE)]}, async (req) => { await needTables(); return {items: await listSchedules(actorOf(req))}; });
  app.post('/schedules', {preHandler: [app.requirePermission(P.REPORTS_WRITE)]}, async (req) => wrap(async () => {
    assertSchedulesEnabled();
    await needTables();
    const body = parse(z.object({templateId: z.string().uuid(), name: z.string().min(1).max(120), cadence: z.enum(['daily', 'weekly', 'monthly']),
      runAtLocal: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), weekday: z.number().int().min(0).max(6).nullable().optional(),
      monthday: z.number().int().min(1).max(28).nullable().optional(), format: z.enum(['xlsx', 'csv', 'tsv', 'json', 'jsonl'])}).strict(), req.body);
    const s = await createSchedule(actorOf(req), body);
    await audit(req, {action: 'report.schedule_created', entityType: 'report_schedule', entityId: s.id, entityLabel: s.name, newValue: {cadence: s.cadence, format: s.format}});
    return s;
  }));
  app.post('/schedules/:id/:state', {preHandler: [app.requirePermission(P.REPORTS_WRITE)]}, async (req) => wrap(async () => {
    await needTables();
    const {id, state} = parse(z.object({id: z.string().uuid(), state: z.enum(['activate', 'deactivate'])}).strict(), req.params);
    if (state === 'activate') assertSchedulesEnabled();
    const s = await setScheduleActive(actorOf(req), id, state === 'activate');
    await audit(req, {action: `report.schedule_${state}d`, entityType: 'report_schedule', entityId: s.id, entityLabel: s.name});
    return s;
  }));
}
