/**
 * Pure rules of the WhatsApp channel — no I/O, so every decision here is unit-tested
 * (policy.test.ts): webhook signatures, retry timing, status transitions, template
 * variables and the personal-data scrub applied to every value sent to Meta.
 */
import crypto from 'node:crypto';
import { WHATSAPP_OPT_OUT_WORDS, WHATSAPP_STATUS_RANK, type WhatsAppStatus } from '@mip/shared';

/**
 * Meta signs every webhook POST with HMAC-SHA256 of the raw body using the App Secret,
 * sent as `X-Hub-Signature-256: sha256=<hex>`. Compared in constant time.
 */
export function verifyMetaSignature(rawBody: Buffer | string, header: string | undefined, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!match) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(match[1], 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** Exponential backoff with full jitter, capped. attempt is 1 for the first retry. */
export function backoffSeconds(attempt: number, baseSeconds: number, maxSeconds: number, random: () => number = Math.random): number {
  const ceiling = Math.min(maxSeconds, baseSeconds * 2 ** Math.max(0, attempt - 1));
  return Math.max(baseSeconds, Math.round(ceiling * (0.5 + random() / 2)));
}

/**
 * Whether a status webhook may move a message from `current` to `next`. Statuses only move
 * forward (a late 'sent' never overwrites 'delivered'); 'failed' is accepted until delivery
 * is confirmed; 'cancelled' and 'failed' are final.
 */
export function canTransition(current: WhatsAppStatus, next: WhatsAppStatus): boolean {
  if (current === next) return false;
  if (current === 'cancelled' || current === 'failed') return false;
  if (next === 'failed') return current !== 'delivered' && current !== 'read';
  return WHATSAPP_STATUS_RANK[next] > WHATSAPP_STATUS_RANK[current];
}

const URL_RE = /https?:\/\/\S+|www\.\S+/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const HANDLE_RE = /(^|[^\w])@\w{2,}/g;
const LONG_DIGITS_RE = /[+٠-٩0-9][٠-٩0-9\s-]{6,}[٠-٩0-9]/g;

/**
 * Makes one template parameter safe for Meta and for privacy:
 * no personal identifiers (handles, emails, phone/ID-like digit runs, links), no newlines/tabs
 * or runs of spaces (Meta rejects them in parameters), bounded length, never empty.
 * `allowUrl` keeps an internal link the platform built itself.
 */
export function cleanParam(value: string | number | null | undefined, opts: { max?: number; allowUrl?: boolean } = {}): string {
  let s = value === null || value === undefined ? '' : String(value);
  // Platform ticket numbers (MIP-YYYY-NNNNNN) are internal references, not personal digits: set aside, then restored.
  const tickets: string[] = [];
  s = s.replace(/MIP-\d{4}-\d{6,}/g, (m) => `\u0000${tickets.push(m) - 1}\u0000`);
  if (!opts.allowUrl) s = s.replace(URL_RE, ' ');
  s = s.replace(EMAIL_RE, ' ').replace(HANDLE_RE, '$1').replace(LONG_DIGITS_RE, ' ');
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => tickets[Number(i)] ?? '');
  s = s.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  const max = opts.max ?? 120;
  if (s.length > max) s = `${s.slice(0, max - 1).trimEnd()}…`;
  return s || '—';
}

/** Positional parameters for a template, in the order the template declares its variables. */
export function buildParams(variables: readonly string[], values: Record<string, string | number | null | undefined>): string[] {
  return variables.map((key) => cleanParam(values[key], { allowUrl: key === 'details_url', max: key === 'details_url' ? 300 : 120 }));
}

/** Local preview: replaces {{1}}…{{n}} with the given parameters. */
export function renderPreview(body: string, params: readonly string[]): string {
  return body.replace(/\{\{(\d{1,2})\}\}/g, (m, n: string) => params[Number(n) - 1] ?? m);
}

/** The highest {{n}} placeholder in a template body. */
export function placeholderCount(body: string): number {
  let max = 0;
  for (const m of body.matchAll(/\{\{(\d{1,2})\}\}/g)) max = Math.max(max, Number(m[1]));
  return max;
}

export function isOptOutText(text: string | undefined | null): boolean {
  const t = (text ?? '').trim().toLowerCase();
  return !!t && WHATSAPP_OPT_OUT_WORDS.includes(t);
}

/** The duplicate guard: one message per (detected event, recipient). */
export const idempotencyKey = (dedupeKey: string, recipientId: string) => `${dedupeKey}|${recipientId}`;

/** Riyadh date-time for template text, e.g. «2026-10-19 14:05». */
export function riyadhStamp(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}
