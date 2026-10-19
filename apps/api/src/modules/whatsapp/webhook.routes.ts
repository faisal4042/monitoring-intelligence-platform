/**
 * Public Meta webhook — outside the authenticated routes because Meta's servers carry no session.
 *  GET  /webhook  Meta's subscription handshake: echoes hub.challenge only when hub.verify_token matches
 *                 the stored Verify Token (constant-time compare).
 *  POST /webhook  Accepted only with a valid X-Hub-Signature-256 (HMAC-SHA256 of the raw body with the
 *                 App Secret). Anything unsigned or mis-signed gets 401 and changes nothing.
 * Both answer 503 while migration 0055 is absent or the matching secret is not configured.
 */
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from '@mip/db';
import { alertLogger as log } from '@mip/logger';
import { verifyMetaSignature } from './policy.js';
import { appSecretFrom, loadSettings, verifyTokenFrom, whatsappSchemaReady } from './settings.js';
import { processWebhook, type WebhookPayload } from './webhook.js';

const sameText = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export default async function whatsappWebhookRoutes(app: FastifyInstance) {
  // Keep the exact bytes Meta signed. Replaces the JSON parser for this plugin's routes only (encapsulated).
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 1_048_576 }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: Buffer }).rawBody = body as Buffer;
    try { done(null, JSON.parse((body as Buffer).toString('utf8') || '{}')); } catch (err) { done(err as Error, undefined); }
  });

  app.get('/webhook', { config: { access: 'public' } }, async (req, reply) => {
    if (!(await whatsappSchemaReady())) return reply.code(503).send();
    const q = req.query as Record<string, string | undefined>;
    const s = await loadSettings();
    const expected = verifyTokenFrom(s);
    if (!expected) return reply.code(503).send();
    if (q['hub.mode'] !== 'subscribe' || !q['hub.verify_token'] || !sameText(q['hub.verify_token'], expected) || !q['hub.challenge']) {
      return reply.code(403).send();
    }
    await sql`UPDATE whatsapp_settings SET webhook_verified_at = now() WHERE id`;
    return reply.code(200).type('text/plain').send(q['hub.challenge']);
  });

  app.post('/webhook', { config: { access: 'public' } }, async (req, reply) => {
    if (!(await whatsappSchemaReady())) return reply.code(503).send();
    const s = await loadSettings();
    const appSecret = appSecretFrom(s);
    if (!appSecret) return reply.code(503).send();
    const raw = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
    if (!raw || !verifyMetaSignature(raw, req.headers['x-hub-signature-256'] as string | undefined, appSecret)) {
      log.warn('whatsapp webhook rejected: bad or missing signature');
      return reply.code(401).send();
    }
    try {
      const result = await processWebhook(req.body as WebhookPayload, s.phone_number_id);
      log.info(result, 'whatsapp webhook processed');
    } catch (err) {
      // 500 makes Meta redeliver; processing is idempotent, so a retry is safe.
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'whatsapp webhook processing failed');
      return reply.code(500).send();
    }
    return reply.code(200).send({ ok: true });
  });
}
