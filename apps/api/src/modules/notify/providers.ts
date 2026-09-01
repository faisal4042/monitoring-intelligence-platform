/** Sends a message through one configured channel. Each provider throws on failure — callers catch per-channel. */
import nodemailer from 'nodemailer';

export interface EmailConfig {
  host: string; port: number; secure: boolean;
  user: string; pass: string; from: string; to: string;
}
export interface TelegramConfig {
  botToken: string; chatId: string;
}

export async function sendEmail(cfg: EmailConfig, subject: string, body: string): Promise<void> {
  const transport = nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  await transport.sendMail({ from: cfg.from || cfg.user, to: cfg.to, subject, text: body });
}

export async function sendTelegram(cfg: TelegramConfig, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: cfg.chatId, text, disable_web_page_preview: true }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram API ${res.status}: ${body.slice(0, 200)}`);
  }
}
