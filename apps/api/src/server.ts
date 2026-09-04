import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config, collectionMode } from '@mip/config';
import { logger } from '@mip/logger';
import { sql } from '@mip/db';

import authPlugin from './plugins/auth.js';
import authRoutes from './modules/auth.routes.js';
import catalogRoutes from './modules/catalog.routes.js';
import queryRoutes from './modules/queries/routes.js';
import costRoutes from './modules/cost.routes.js';
import postRoutes from './modules/posts.routes.js';
import topicsRoutes from './modules/classification/topics.routes.js';
import topicManagementRoutes from './modules/classification/topic-management.routes.js';
import influencersRoutes from './modules/influencers.routes.js';
import adminRoutes from './modules/admin.routes.js';
import signalRoutes from './modules/signals/routes.js';
import newsRoutes from './modules/news/routes.js';
import notifyRoutes from './modules/notify/routes.js';
import notifyWebhookRoutes from './modules/notify/webhook.routes.js';
import { HttpError } from './lib/errors.js';
import { ensureAutomaticQueries, startCollectionWorker } from './workers/collection.worker.js';
import { startClassificationWorker } from './workers/classification.worker.js';
import { startNewsFetchWorker } from './workers/news-fetch.worker.js';
import { startAlertsWorker } from './workers/alerts.worker.js';
import { startXStreamWorker } from './workers/x-stream.worker.js';

const app = Fastify({ loggerInstance: logger, trustProxy: true });
let stopCollectionWorker: (() => void) | null = null;
let stopClassificationWorker: (() => void) | null = null;
let stopNewsFetchWorker: (() => void) | null = null;
let stopAlertsWorker: (() => void) | null = null;
let stopXStreamWorker: (() => void) | null = null;

async function main() {
  await app.register(cors, { origin: [config.APP_URL], credentials: true });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(authPlugin);

  // Fastify rejects an empty body when Content-Type is application/json.
  // Action endpoints like /promote legitimately take no body, so treat an
  // empty payload as {} rather than a client error.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const raw = (body as string).trim();
    if (!raw) return done(null, {});
    try { done(null, JSON.parse(raw)); }
    catch (e) { done(e as Error, undefined); }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message, code: err.code });
    }
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 401) {
      return reply.code(401).send({ error: 'الجلسة منتهية، سجّل الدخول مرة أخرى' });
    }
    if (statusCode === 403) {
      return reply.code(403).send({ error: 'لا تملك صلاحية تنفيذ هذه العملية' });
    }
    if (statusCode === 429) {
      return reply.code(429).send({ error: 'عدد الطلبات كبير جداً، حاول بعد قليل' });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'حدث خطأ في الخادم' });
  });

  app.get('/health', async () => {
    let db = true;
    try { await sql`SELECT 1`; } catch { db = false; }
    return { ok: db, mode: collectionMode, time: new Date().toISOString() };
  });

  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(catalogRoutes, { prefix: '/api/v1' });
  await app.register(queryRoutes, { prefix: '/api/v1/queries' });
  await app.register(costRoutes, { prefix: '/api/v1/cost' });
  await app.register(postRoutes, { prefix: '/api/v1/posts' });
  await app.register(topicsRoutes, { prefix: '/api/v1' });
  await app.register(topicManagementRoutes, { prefix: '/api/v1' });
  await app.register(influencersRoutes, { prefix: '/api/v1/influencers' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(signalRoutes, { prefix: '/api/v1/signals' });
  await app.register(newsRoutes, { prefix: '/api/v1/news' });
  await app.register(notifyRoutes, { prefix: '/api/v1/notify' });
  await app.register(notifyWebhookRoutes, { prefix: '/api/v1/notify' });

  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });

  const automaticQueries = await ensureAutomaticQueries();
  stopCollectionWorker = startCollectionWorker();
  stopXStreamWorker = startXStreamWorker();
  stopClassificationWorker = startClassificationWorker();
  stopNewsFetchWorker = startNewsFetchWorker();
  stopAlertsWorker = startAlertsWorker();

  const banner =
    collectionMode === 'demo'
      ? 'DEMO MODE — no connection to the X API is possible (LIVE_X_API=false)'
      : collectionMode === 'dry_run'
        ? 'DRY RUN — queries are compiled and budgeted but never sent'
        : 'LIVE — real X API calls will be made and real quota consumed';

  logger.info(`API ready on :${config.API_PORT}`);
  logger.info(banner);
  logger.info({ automaticQueries }, 'automatic dictionary queries ready');
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    logger.info('shutting down');
    stopCollectionWorker?.();
    stopXStreamWorker?.();
    stopClassificationWorker?.();
    stopNewsFetchWorker?.();
    stopAlertsWorker?.();
    await app.close();
    await sql.end({ timeout: 5 }).catch(() => {});
    process.exit(0);
  });
}
