import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {badRequest} from './errors.js';

export const CURSOR_TTL_SECONDS = 3600;
const uuid = z.string().uuid();
const exactTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/).refine(value => {
  const millis = value.slice(0, 23) + 'Z';
  return Number.isFinite(Date.parse(millis)) && new Date(millis).toISOString() === millis;
});
const bound = z.union([z.literal('-infinity'), z.literal('infinity'), z.string().datetime()]);
const base = {
  v: z.literal(1), scope: z.string().regex(/^[a-f0-9]{64}$/),
  window: z.object({from: bound, to: bound}).strict(),
  issued: z.number().int().nonnegative(), expires: z.number().int().nonnegative(),
};
const news = z.object({...base, kind: z.literal('news'), order: z.literal('effective_weight_discovered_id_desc_v1'),
  futureMax: exactTime,
  last: z.object({effective: exactTime, weight: z.number().int().min(-32768).max(32767), discovered: exactTime, id: uuid}).strict(),
}).strict();
const classification = z.object({...base, kind: z.literal('classification'), order: z.literal('posted_id_desc_v1'),
  last: z.object({time: exactTime, id: uuid}).strict(),
}).strict();
const schema = z.discriminatedUnion('kind', [news, classification]);
export type BrowsingCursor = z.infer<typeof schema>;
export type CursorKind = BrowsingCursor['kind'];
export type CursorContext = Pick<BrowsingCursor, 'v' | 'scope' | 'window' | 'issued' | 'expires'>;
const invalid = () => badRequest('Invalid or expired browsing cursor. Restart from the first page.', 'INVALID_CURSOR');
function signature(body: string, secret: string) {
  const key = createHmac('sha256', secret).update('mip/browsing-cursor/v1/key').digest();
  return createHmac('sha256', key).update('v1.' + body).digest();
}
export function encodeCursor(cursor: BrowsingCursor, secret: string): string {
  const body = Buffer.from(JSON.stringify(schema.parse(cursor))).toString('base64url');
  const result = `v1.${body}.${signature(body, secret).toString('base64url')}`;
  if (result.length > 4096) throw invalid();
  return result;
}
export function decodeCursor(raw: string, kind: CursorKind, scope: string, secret: string, now = Date.now()): BrowsingCursor {
  if (typeof raw !== 'string' || raw.length > 4096) throw invalid();
  const parts = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(raw);
  if (!parts) throw invalid();
  const [, body, mac] = parts;
  const bytes = Buffer.from(body, 'base64url'), received = Buffer.from(mac, 'base64url');
  if (bytes.toString('base64url') !== body || received.toString('base64url') !== mac || !timingSafeEqual(received, signature(body, secret))) throw invalid();
  let decoded: unknown;
  try { decoded = JSON.parse(bytes.toString('utf8')); } catch { throw invalid(); }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) throw invalid();
  const c = parsed.data, seconds = Math.floor(now / 1000);
  const from = c.window.from === '-infinity' ? -Infinity : Date.parse(c.window.from);
  const to = c.window.to === 'infinity' ? Infinity : Date.parse(c.window.to);
  if (c.kind !== kind || c.scope !== scope || c.issued > seconds || c.expires <= seconds || c.expires - c.issued !== CURSOR_TTL_SECONDS || !(from < to)) throw invalid();
  return c;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
}
export function cursorScope(kind: CursorKind, subject: string, filters: Record<string, unknown>): string {
  return createHash('sha256').update(canonical({kind, subject, filters})).digest('hex');
}
export function cursorContext(kind: CursorKind, subject: string, filters: Record<string, unknown>, window: {from: string; to: string}, raw: string | undefined, secret: string, now = Date.now()): {context: CursorContext; cursor: BrowsingCursor | null} {
  const scope = cursorScope(kind, subject, filters);
  const cursor = raw === undefined ? null : decodeCursor(raw, kind, scope, secret, now);
  const issued = Math.floor(now / 1000);
  return {cursor, context: cursor ?? {v: 1, scope, window: {from: window.from, to: window.to}, issued, expires: issued + CURSOR_TTL_SECONDS}};
}
export function periodScope(q: Record<string, string | undefined>, fallback: string) {
  return q.from || q.to ? {range: q.range ?? 'custom', from: q.from ?? '', to: q.to ?? ''} : {range: q.range || fallback};
}
export function pageLimit(raw: string | undefined, fallback: number): number {
  const limit = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw badRequest('limit must be an integer between 1 and 200', 'INVALID_LIMIT');
  return limit;
}
export function optionalUuid(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null;
  if (!uuid.safeParse(raw).success) throw badRequest('Invalid filter identifier', 'INVALID_FILTER');
  return raw.toLowerCase();
}
