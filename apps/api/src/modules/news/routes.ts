/**
 * رصد الأخبار والمواقع — Phase 1: source registry + Test Connection only.
 * No fetching, no articles, no AI — see the Phase 1 plan for scope.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@mip/shared';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { dateBoundsFromQuery, hasDateRange } from '../../lib/date-range.js';
import * as newsService from './service.js';
import { queueNewsRefresh } from '../../workers/news-fetch.worker.js';
import { engineConfigured, getExtraction, reextractArticle } from './extraction/service.js';
import { extractionMetrics } from './extraction/metrics.js';
import { ExtractorUnavailable } from './extraction/client.js';

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

const EXTRACTION_MODES = ['off', 'shadow', 'static', 'dynamic'] as const;
const sourcePatchSchema = sourceSchema.partial().extend({ isActive: z.boolean().optional(), extractionMode: z.enum(EXTRACTION_MODES).optional() });

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
    const q = req.query as Record<string, string | undefined>;
    // `range`/`from`/`to` take precedence over the legacy `days` window.
    const dates = hasDateRange(q) ? dateBoundsFromQuery(q) : null;
    const items = await newsService.listArticles({
      sourceId: q.sourceId, programId: q.programId, limit: q.limit ? Number(q.limit) : undefined, cursor: q.cursor,
      days: q.days ? Number(q.days) : undefined,
      from: dates?.from, to: dates?.to,
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

  // ── Article extraction (Scrapling engine) ─────────────────────────────
  app.get('/extraction/metrics', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const hours = Math.min(Math.max(Number(q.hours ?? 24) || 24, 1), 24 * 30);
    return extractionMetrics(hours);
  });

  app.get('/articles/:id/extraction', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return { items: await getExtraction(id) };
  });

  app.post('/articles/:id/extract', {
    preHandler: [app.requirePermission(PERMISSIONS.NEWS_MANAGE_SOURCES)],
  }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!engineConfigured()) throw conflict('محرك استخراج المقالات غير مفعّل (NEWS_SCRAPLING_ENABLED أو NEWS_SCRAPLING_SHADOW_MODE)');
    let result;
    try {
      result = await reextractArticle(id);
    } catch (error) {
      if (error instanceof ExtractorUnavailable) throw conflict('خدمة استخراج المقالات غير متاحة حاليًا');
      throw error;
    }
    if (!result) throw notFound('الخبر غير موجود');
    await audit(req, {
      action: 'news_articles.reextract', entityType: 'news_article', entityId: id,
      entityLabel: 'إعادة استخراج نص الخبر', newValue: result,
    });
    return result;
  });

  app.post('/articles/fetch-now', {
    preHandler: [app.requirePermission(PERMISSIONS.NEWS_MANAGE_SOURCES)],
  }, async (req) => {
    const result = await queueNewsRefresh();
    await audit(req, {
      action: 'news_articles.fetch_now', entityType: 'news_source',
      entityLabel: 'تحديث جميع مصادر الأخبار', newValue: result,
    });
    return result;
  });
}
