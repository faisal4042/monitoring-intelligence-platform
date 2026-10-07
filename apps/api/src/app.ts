/**
 * Builds the HTTP app: plugins, error handling and every route — but no
 * listener and no background workers. server.ts adds those; tests drive this
 * directly through app.inject().
 */
import Fastify, { type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config, collectionMode } from '@mip/config';
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
import userRoutes from './modules/users.routes.js';
import signalRoutes from './modules/signals/routes.js';
import newsRoutes from './modules/news/routes.js';
import notifyRoutes from './modules/notify/routes.js';
import notifyWebhookRoutes from './modules/notify/webhook.routes.js';
import { HttpError } from './lib/errors.js';
import { getXStreamStatus } from './workers/x-stream.worker.js';

export interface RouteEntry { method: string; url: string; access: 'public' | 'self' | 'permission' }

declare module 'fastify' {
  interface FastifyInstance {
    /** Every registered route and how it is authorized — read by routes.itest.ts. */
    routeCatalog: RouteEntry[];
  }
}

export async function buildApp(opts: FastifyServerOptions & { rateLimit?: boolean } = {}) {
  const { rateLimit: withRateLimit = true, ...fastifyOpts } = opts;
  const app = Fastify({ trustProxy: true, ...fastifyOpts });

  app.decorate('routeCatalog', [] as RouteEntry[]);
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      app.routeCatalog.push({ method, url: route.url, access: route.config?.access ?? 'permission' });
    }
  });

  await app.register(cors, { origin: [config.APP_URL], credentials: true });
  if (withRateLimit) await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
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

  app.get('/health', { config: { access: 'public' } }, async () => {
    let db = true;
    try { await sql`SELECT 1`; } catch { db = false; }
    let collectionLatency = null;
    if (db) {
      const [row] = await sql`
        SELECT round(extract(epoch FROM (collected_at - posted_at)))::int AS latest_seconds,
               collected_at AS latest_collected_at, posted_at AS latest_posted_at
        FROM posts ORDER BY collected_at DESC LIMIT 1`;
      collectionLatency = row ?? null;
    }
    const stream = getXStreamStatus();
    return {
      ok: db, mode: collectionMode, time: new Date().toISOString(),
      xStream: {
        state: stream.state, rules: stream.rules,
        connectedAt: stream.connectedAt, lastEventAt: stream.lastEventAt,
        hasError: Boolean(stream.lastError),
      },
      collectionLatency,
    };
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
  await app.register(userRoutes, { prefix: '/api/v1/admin' });
  await app.register(signalRoutes, { prefix: '/api/v1/signals' });
  await app.register(newsRoutes, { prefix: '/api/v1/news' });
  await app.register(notifyRoutes, { prefix: '/api/v1/notify' });
  await app.register(notifyWebhookRoutes, { prefix: '/api/v1/notify' });

  return app;
}
