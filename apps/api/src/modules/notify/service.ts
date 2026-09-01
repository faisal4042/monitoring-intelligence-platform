import crypto from 'node:crypto';
import { config } from '@mip/config';
import { sql } from '@mip/db';
import { encryptJson, decryptJson, telegramWebhookSecret } from '../../lib/crypto.js';
import {
  sendEmail, sendTelegram, telegramGetMe, telegramSetWebhook,
  type EmailConfig, type TelegramConfig,
} from './providers.js';
import { alertLogger as log } from '@mip/logger';

const LINK_CODE_TTL_MINUTES = 15;

/** Registers the bot's webhook (idempotent — Telegram just overwrites) and issues a one-time /start code for this channel. */
export async function createTelegramLink(channelId: string): Promise<{ botUsername: string; deepLink: string; expiresInMinutes: number }> {
  const [channel] = await sql<{ config_encrypted: string }[]>`
    SELECT config_encrypted FROM notification_channels WHERE id = ${channelId}::uuid AND type = 'telegram'`;
  if (!channel) throw new Error('القناة غير موجودة');

  const cfg = decryptJson<TelegramConfig>(channel.config_encrypted);
  const me = await telegramGetMe(cfg.botToken);
  const webhookUrl = `${config.APP_URL.replace(/\/$/, '')}/api/v1/notify/telegram-webhook`;
  await telegramSetWebhook(cfg.botToken, webhookUrl, telegramWebhookSecret);

  const code = crypto.randomBytes(16).toString('base64url');
  await sql`DELETE FROM telegram_link_codes WHERE channel_id = ${channelId}::uuid`;
  await sql`
    INSERT INTO telegram_link_codes (code, channel_id, expires_at)
    VALUES (${code}, ${channelId}::uuid, now() + (${LINK_CODE_TTL_MINUTES} || ' minutes')::interval)`;

  return { botUsername: me.username, deepLink: `https://t.me/${me.username}?start=${code}`, expiresInMinutes: LINK_CODE_TTL_MINUTES };
}

/** Called from the (unauthenticated, secret-header-verified) Telegram webhook route. */
export async function resolveTelegramStart(startCode: string, chatId: number): Promise<boolean> {
  const [pending] = await sql<{ channel_id: string }[]>`
    DELETE FROM telegram_link_codes WHERE code = ${startCode} AND expires_at > now() RETURNING channel_id`;
  if (!pending) return false;

  const [channel] = await sql<{ config_encrypted: string }[]>`
    SELECT config_encrypted FROM notification_channels WHERE id = ${pending.channel_id}::uuid`;
  if (!channel) return false;

  const cfg = decryptJson<TelegramConfig>(channel.config_encrypted);
  const updated: TelegramConfig = { ...cfg, chatId: String(chatId) };
  await sql`
    UPDATE notification_channels SET config_encrypted = ${encryptJson(updated)}, updated_at = now()
    WHERE id = ${pending.channel_id}::uuid`;

  try {
    await sendTelegram(updated, '✅ تم ربط حسابك بنجاح — من الآن بتوصلك تنبيهات منصة الرصد هنا.');
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'telegram link confirmation send failed');
  }
  return true;
}

export type ChannelType = 'email' | 'telegram';

export async function dispatchToChannel(channelId: string, subject: string, body: string): Promise<void> {
  const [channel] = await sql<{ type: ChannelType; config_encrypted: string }[]>`
    SELECT type, config_encrypted FROM notification_channels WHERE id = ${channelId}::uuid AND is_active`;
  if (!channel) throw new Error('القناة غير موجودة أو معطّلة');

  if (channel.type === 'email') {
    await sendEmail(decryptJson<EmailConfig>(channel.config_encrypted), subject, body);
  } else {
    await sendTelegram(decryptJson<TelegramConfig>(channel.config_encrypted), body);
  }
}

/** {{placeholder}} substitution — unknown placeholders are left as-is rather than silently blanked. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => vars[key] ?? match);
}

interface Rule {
  id: string; name: string; condition_type: string; condition: Record<string, unknown>;
  program_id: string | null; message_template: string; channel_ids: string[];
}

interface CandidatePost {
  id: string; text: string; url: string; posted_at: string;
  username: string | null; display_name: string | null; followers_count: number | null;
  is_influencer: boolean; program_name: string | null; program_id: string | null;
  relevance: string | null;
}

function postVars(p: CandidatePost, rule: Rule): Record<string, string> {
  return {
    rule: rule.name,
    author: p.display_name ?? p.username ?? 'حساب غير معروف',
    username: p.username ?? '',
    text: p.text,
    followers: String(p.followers_count ?? 0),
    url: p.url,
    program: p.program_name ?? '',
  };
}

/** Recent posts joined the same way posts.routes.ts already does — see that file for the reference query. */
async function recentPosts(sinceSeconds: number): Promise<CandidatePost[]> {
  return sql<CandidatePost[]>`
    SELECT p.id, p.text, p.url, p.posted_at,
           a.username, a.display_name, a.followers_count,
           (ti.id IS NOT NULL) AS is_influencer,
           pr.id AS program_id, pr.name_ar AS program_name,
           c.relevance
    FROM posts p
    LEFT JOIN authors a ON a.id = p.author_id
    LEFT JOIN post_classifications c ON c.post_id = p.id AND c.posted_at = p.posted_at
    LEFT JOIN programs pr ON pr.id = c.program_id
    LEFT JOIN tracked_influencers ti ON ti.username = a.username AND ti.is_active
    WHERE p.is_redacted = false AND p.status NOT IN ('filtered_out', 'duplicate')
      AND p.collected_at > now() - (${sinceSeconds} || ' seconds')::interval
    ORDER BY p.posted_at DESC
    LIMIT 500`;
}

interface RisingStory { id: string; title_ar: string; why_ar: string; program_id: string; program_name: string }

async function risingStories(sinceSeconds: number): Promise<RisingStory[]> {
  return sql<RisingStory[]>`
    SELECT s.id, s.title_ar, s.why_ar, s.program_id, pr.name_ar AS program_name
    FROM signal_stories s
    JOIN programs pr ON pr.id = s.program_id
    WHERE s.state = 'rising' AND s.updated_at > now() - (${sinceSeconds} || ' seconds')::interval`;
}

async function alreadyDelivered(ruleId: string, entityType: 'post' | 'story'): Promise<Set<string>> {
  const rows = await sql<{ entity_id: string }[]>`
    SELECT entity_id FROM alert_deliveries WHERE rule_id = ${ruleId}::uuid AND entity_type = ${entityType}`;
  return new Set(rows.map((r) => r.entity_id));
}

/**
 * Claims the (rule, entity) pair before sending — the unique constraint is
 * the real guard (two overlapping ticks could both pass the in-memory
 * `alreadyDelivered` check), and INSERT returning nothing means "someone
 * else already claimed it, don't send."
 */
async function claim(ruleId: string, entityType: 'post' | 'story', entityId: string): Promise<boolean> {
  const rows = await sql`
    INSERT INTO alert_deliveries (rule_id, entity_type, entity_id, message, channel_results)
    VALUES (${ruleId}::uuid, ${entityType}, ${entityId}::uuid, '', '[]'::jsonb)
    ON CONFLICT (rule_id, entity_type, entity_id) DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

async function finalize(ruleId: string, entityType: 'post' | 'story', entityId: string, message: string, results: unknown[]) {
  await sql`
    UPDATE alert_deliveries SET message = ${message}, channel_results = ${JSON.stringify(results)}::jsonb
    WHERE rule_id = ${ruleId}::uuid AND entity_type = ${entityType} AND entity_id = ${entityId}::uuid`;
}

async function fanOut(rule: Rule, message: string): Promise<Array<{ channelId: string; ok: boolean; error?: string }>> {
  const results: Array<{ channelId: string; ok: boolean; error?: string }> = [];
  for (const channelId of rule.channel_ids) {
    try {
      await dispatchToChannel(channelId, `تنبيه: ${rule.name}`, message);
      results.push({ channelId, ok: true });
    } catch (err) {
      results.push({ channelId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

/** Runs one evaluation pass over active rules against posts/stories touched in the last `windowSeconds`. */
export async function evaluateRules(windowSeconds: number): Promise<{ evaluated: number; sent: number }> {
  const rules = await sql<Rule[]>`SELECT * FROM alert_rules WHERE is_active AND array_length(channel_ids, 1) > 0`;
  if (!rules.length) return { evaluated: 0, sent: 0 };

  const posts = await recentPosts(windowSeconds);
  const stories = await risingStories(windowSeconds);
  let sent = 0;

  for (const rule of rules) {
    if (rule.condition_type === 'topic_rising') {
      const done = await alreadyDelivered(rule.id, 'story');
      for (const story of stories) {
        if (done.has(story.id)) continue;
        if (rule.program_id && rule.program_id !== story.program_id) continue;
        if (!(await claim(rule.id, 'story', story.id))) continue;

        const message = renderTemplate(rule.message_template, {
          rule: rule.name, program: story.program_name, topic: story.title_ar, text: story.why_ar, author: '', username: '', followers: '', url: '',
        });
        const results = await fanOut(rule, message);
        await finalize(rule.id, 'story', story.id, message, results);
        sent++;
      }
      continue;
    }

    const done = await alreadyDelivered(rule.id, 'post');
    for (const post of posts) {
      if (done.has(post.id)) continue;
      if (post.relevance !== 'relevant') continue;
      if (rule.program_id && rule.program_id !== post.program_id) continue;

      let matches = false;
      if (rule.condition_type === 'influencer_activity') {
        matches = post.is_influencer;
      } else if (rule.condition_type === 'follower_threshold') {
        const min = Number(rule.condition.minFollowers ?? 0);
        matches = (post.followers_count ?? 0) >= min;
      } else if (rule.condition_type === 'keyword_match') {
        const keywords = Array.isArray(rule.condition.keywords) ? (rule.condition.keywords as string[]) : [];
        matches = keywords.some((k) => k && post.text.includes(k));
      }
      if (!matches) continue;
      if (!(await claim(rule.id, 'post', post.id))) continue;

      const message = renderTemplate(rule.message_template, postVars(post, rule));
      const results = await fanOut(rule, message);
      await finalize(rule.id, 'post', post.id, message, results);
      sent++;
    }
  }

  log.info({ rules: rules.length, posts: posts.length, stories: stories.length, sent }, 'alert rules evaluated');
  return { evaluated: rules.length, sent };
}
