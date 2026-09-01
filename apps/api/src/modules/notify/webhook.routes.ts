/**
 * Public Telegram webhook — deliberately outside notifyRoutes' `onRequest:
 * app.authenticate` hook (Telegram's servers can't carry our session JWT).
 * Authenticity instead comes from the `X-Telegram-Bot-Api-Secret-Token`
 * header, which only we and Telegram (because we set it via setWebhook) know.
 */
import type { FastifyInstance } from 'fastify';
import { telegramWebhookSecret } from '../../lib/crypto.js';
import { resolveTelegramStart } from './service.js';
import { alertLogger as log } from '@mip/logger';

interface TelegramUpdate {
  message?: { text?: string; chat?: { id?: number } };
}

export default async function notifyWebhookRoutes(app: FastifyInstance) {
  app.post('/telegram-webhook', async (req, reply) => {
    if (req.headers['x-telegram-bot-api-secret-token'] !== telegramWebhookSecret) {
      return reply.code(401).send();
    }
    const body = req.body as TelegramUpdate;
    const text = body.message?.text ?? '';
    const chatId = body.message?.chat?.id;
    const match = /^\/start\s+(\S+)/.exec(text);

    if (match && chatId) {
      const linked = await resolveTelegramStart(match[1], chatId).catch((err) => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'telegram start-link failed');
        return false;
      });
      log.info({ linked, chatId }, 'telegram webhook /start');
    }
    // Telegram only cares that we returned 200 — it doesn't read the body.
    return reply.code(200).send({ ok: true });
  });
}
