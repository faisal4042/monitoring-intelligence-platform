/** Sends a message through one configured channel. Each provider throws on failure — callers catch per-channel. */
import nodemailer from 'nodemailer';

export interface EmailConfig {
  host: string; port: number; secure: boolean;
  user: string; pass: string; from: string; to: string;
}
export interface TelegramConfig {
  botToken: string; chatIds: string[];
}

/** Normalizes a decrypted config that may still be in the pre-multi-recipient shape ({ chatId: string }). */
export function normalizeTelegramConfig(raw: { botToken: string; chatIds?: string[]; chatId?: string }): TelegramConfig {
  if (Array.isArray(raw.chatIds)) return { botToken: raw.botToken, chatIds: raw.chatIds };
  return { botToken: raw.botToken, chatIds: raw.chatId ? [raw.chatId] : [] };
}

export async function sendEmail(cfg: EmailConfig, subject: string, body: string): Promise<void> {
  const transport = nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  await transport.sendMail({ from: cfg.from || cfg.user, to: cfg.to, subject, text: body });
}

async function sendTelegramTo(botToken: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram API ${res.status}: ${body.slice(0, 200)}`);
  }
}

/** One channel can fan out to several linked people. Succeeds if at least one recipient got it; throws the first error only if every recipient failed. */
export async function sendTelegram(cfg: TelegramConfig, text: string): Promise<void> {
  if (!cfg.chatIds.length) throw new Error('لم يُربط أي شخص بهذي القناة بعد — استخدم زر "ربط شخص"');
  const results = await Promise.allSettled(cfg.chatIds.map((id) => sendTelegramTo(cfg.botToken, id, text)));
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failures.length === results.length) {
    throw failures[0].reason instanceof Error ? failures[0].reason : new Error(String(failures[0].reason));
  }
}

async function telegramApi<T>(botToken: string, method: string, params?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params ?? {}),
  });
  const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!body.ok) throw new Error(body.description ?? `Telegram API ${method} failed`);
  return body.result as T;
}

export async function telegramGetMe(botToken: string): Promise<{ username: string }> {
  return telegramApi<{ username: string }>(botToken, 'getMe');
}

export async function telegramSetWebhook(botToken: string, url: string, secretToken: string): Promise<void> {
  await telegramApi(botToken, 'setWebhook', { url, secret_token: secretToken, allowed_updates: ['message'] });
}
