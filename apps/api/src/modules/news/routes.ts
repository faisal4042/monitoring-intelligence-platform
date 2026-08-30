/**
 * رصد الأخبار والمواقع — Phase 1: source registry + Test Connection only.
 * No fetching, no articles, no AI — see the Phase 1 plan for scope.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@mip/shared';
import { badRequest } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import * as newsService from './service.js';

const SOURCE_TYPES = ['newspaper', 'news_site', 'government', 'real_estate', 'blog', 'magazine', 'other'] as const;
const CONNECTOR_TYPES = ['auto', 'rss', 'atom', 'api', 'sitemap', 'crawler', 'manual'] as const;

const sourceSchema = z.object({
  programId: z.string().uuid().optional().nullable(),
  nameAr: z.string().min(1).max(200),
  nameEn: z.string().max(200).optional().nullable(),
  baseUrl: z.string().url(),
  logoUrl: z.string().url().optional().nullable(),
  country: z.string().max(100).optional().nullable(),
  language: z.string().max(10).optional(),
  sourceType: z.enum(SOURCE_TYPES),
  connectorType: z.enum(CONNECTOR_TYPES).default('auto'),
  rssUrl: z.string().url().optional().nullable(),
  sitemapUrl: z.string().url().optional().nullable(),
  apiUrl: z.string().url().optional().nullable(),
  sourceWeight: z.number().int().min(1).max(100).optional(),
  checkIntervalMinutes: z.number().int().min(5).max(1440).optional(),
});

const sourcePatchSchema = sourceSchema.partial().extend({ isActive: z.boolean().optional() });

const testConnectionSchema = z.object({ url: z.string().url() });

export default async function newsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requirePermission(PERMISSIONS.NEWS_READ));

  app.get('/sources', async (req) => {
    const { programId } = req.query as { programId?: string };
    return { items: await newsService.listSources(programId) };
  });

  app.post('/sources', {
    preHandler: [app.requirePermission(PERMISSIONS.NEWS_MANAGE_SOURCES)],
  }, async (req) => {
    const parsed = sourceSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    const row = await newsService.createSource(parsed.data, req.user.id);
    await audit(req, {
      action: 'news_source.create', entityType: 'news_source', entityId: row.id,
      entityLabel: parsed.data.nameAr, newValue: parsed.data,
    });
    return row;
  });

  app.patch('/sources/:id', {
    preHandler: [app.requirePermission(PERMISSIONS.NEWS_MANAGE_SOURCES)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = sourcePatchSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    const { before, after } = await newsService.updateSource(id, parsed.data);
    await audit(req, {
      action: 'news_source.update', entityType: 'news_source', entityId: id,
      entityLabel: after.name_ar, oldValue: before, newValue: after,
    });
    return after;
  });

  app.delete('/sources/:id', {
    preHandler: [app.requirePermission(PERMISSIONS.NEWS_MANAGE_SOURCES)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await newsService.disableSource(id);
    await audit(req, {
      action: 'news_source.disable', entityType: 'news_source', entityId: id,
      entityLabel: row.name_ar,
    });
    return { ok: true };
  });

  app.post('/sources/test-connection', {
    preHandler: [app.requirePermission(PERMISSIONS.NEWS_MANAGE_SOURCES)],
  }, async (req) => {
    const parsed = testConnectionSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    return newsService.testConnection(parsed.data.url);
  });

  app.post('/sources/:id/test-connection', {
    preHandler: [app.requirePermission(PERMISSIONS.NEWS_MANAGE_SOURCES)],
  }, async (req) => {
    const { id } = req.params as { id: string };
    return newsService.testSourceConnection(id);
  });

  app.get('/articles', async (req) => {
    const q = req.query as { sourceId?: string; programId?: string; limit?: string; cursor?: string; includeIrrelevant?: string; days?: string };
    const items = await newsService.listArticles({
      sourceId: q.sourceId, programId: q.programId, limit: q.limit ? Number(q.limit) : undefined, cursor: q.cursor,
      days: q.days ? Number(q.days) : undefined,
      includeIrrelevant: q.includeIrrelevant === 'true',
    });
    const last = items[items.length - 1] as { effective_at?: Date | string } | undefined;
    const nextCursor = last?.effective_at
      ? (last.effective_at instanceof Date ? last.effective_at.toISOString() : String(last.effective_at))
      : null;
    return { items, nextCursor };
  });

  app.post('/articles/reclassify', {
    preHandler: [app.requirePermission(PERMISSIONS.NEWS_MANAGE_SOURCES)],
  }, async (req) => {
    const result = await newsService.reclassifyArticles();
    await audit(req, {
      action: 'news_articles.reclassify', entityType: 'news_article',
      entityLabel: 'إعادة تصنيف أرشيف الأخبار', newValue: result,
    });
    return result;
  });
}
