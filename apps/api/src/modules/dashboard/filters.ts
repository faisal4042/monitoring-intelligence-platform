/**
 * The dashboard's one filter model. Every section endpoint parses the same
 * query, so a number and its drill-down always use identical filters.
 *
 * Dates are Asia/Riyadh calendar ranges resolved by @mip/shared and compared
 * against UTC timestamptz columns as half-open [from, to) bounds.
 */
import { z } from 'zod';
import { sql } from '@mip/db';
import { comparisonWindows } from '@mip/shared';
import { badRequest } from '../../lib/errors.js';
import { dateBoundsFromQuery, rangeMeta } from '../../lib/date-range.js';
import { parse } from '../queue/validation.js';
import type { Fragment } from './base.js';

export const INTENTS = ['complaint', 'inquiry', 'suggestion', 'praise', 'news', 'experience', 'warning', 'issue', 'request', 'other'] as const;
export const SENTIMENT_GROUPS = ['positive', 'neutral', 'negative', 'unclassified'] as const;
const flag = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

export const filterSchema = z.object({
  // A program key (ejar) or id; absent = all programs.
  program: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'معرّف برنامج غير صالح').optional(),
  range: z.string().max(20).optional(), from: z.string().max(40).optional(), to: z.string().max(40).optional(),
  intent: z.enum(INTENTS).optional(),
  sentiment: z.enum(SENTIMENT_GROUPS).optional(),
  topicId: z.string().uuid().optional(),
  postType: z.enum(['original', 'reply', 'quote']).optional(),
  influencersOnly: flag.optional(),
  relevantOnly: flag.optional(),
  // Manual refresh skips the short server cache.
  fresh: flag.optional(),
}).strict();

export interface Program { id: string; key: string; name_ar: string; color: string | null }
export interface Window { from: string; to: string }
export interface Filters {
  program: Program | null;
  intent?: string; sentiment?: string; topicId?: string; postType?: string;
  influencersOnly: boolean; relevantOnly: boolean; fresh: boolean;
  range: ReturnType<typeof rangeMeta>;
  /** The selected window, as resolved (Riyadh calendar bounds). */
  current: Window;
  /** The equally long window just before it, or null for an unbounded range. */
  previous: Window | null;
  /** Stable text of the filters that change results — the cache key part. */
  key: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parses and resolves the shared filters; extra keys are rejected with 400. */
export async function parseFilters(query: unknown, extra?: z.ZodRawShape): Promise<Filters & Record<string, unknown>> {
  const schema = extra ? filterSchema.extend(extra) : filterSchema;
  const q = parse(schema, query) as z.infer<typeof filterSchema> & Record<string, unknown>;
  // The dashboard's default period; the shared parser alone would mean "all".
  const dates = dateBoundsFromQuery(q.range || q.from || q.to ? { range: q.range, from: q.from, to: q.to } : { range: '30d' });
  let program: Program | null = null;
  if (q.program) {
    const [row] = await sql<Program[]>`SELECT id,key,name_ar,color FROM programs
      WHERE deleted_at IS NULL AND (${UUID.test(q.program) ? q.program : null}::uuid IS NOT NULL AND id=${UUID.test(q.program) ? q.program : null}::uuid OR key=${q.program})`;
    if (!row) throw badRequest('البرنامج غير موجود', 'UNKNOWN_PROGRAM');
    program = row;
  }
  const windows = comparisonWindows(dates.range);
  // The current window runs to the range's real end (no future rows exist, and
  // capping at this server's clock could drop a row stamped by a slightly
  // faster database clock). "Now" only sizes the comparison: today until
  // 14:00 is compared with yesterday until 14:00.
  const current = { from: dates.from, to: dates.to };
  const previous = windows ? { from: windows.previous.from.toISOString(), to: windows.previous.to.toISOString() } : null;
  const { fresh: _f, ...rest } = q;
  const key = JSON.stringify({ ...rest, program: program?.id ?? null, current, previous });
  return {
    ...q, program, influencersOnly: q.influencersOnly ?? false, relevantOnly: q.relevantOnly ?? false, fresh: q.fresh ?? false,
    range: rangeMeta(dates.range), current, previous, key,
  };
}

/** True when the request narrows interactions beyond program and date. */
export const narrowsInteractions = (f: Filters) => Boolean(f.intent || f.sentiment || f.topicId || f.postType || f.influencersOnly || f.relevantOnly);

/** Program filter for tables that carry a program_id column (stories, news, queue). */
export const programIs = (column: Fragment, f: Filters) =>
  sql`(${f.program?.id ?? null}::uuid IS NULL OR ${column}=${f.program?.id ?? null}::uuid)`;
