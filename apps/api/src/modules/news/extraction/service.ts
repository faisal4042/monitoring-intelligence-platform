/**
 * Article extraction around the existing news pipeline.
 *
 * Discovery (RSS / sitemap / homepage) and news_articles stay exactly as they
 * are. For a source opted in (news_sources.extraction_mode) this adds:
 *
 *   live   — before a new article is inserted, its page is fetched and parsed;
 *            the page's own canonical URL and body catch duplicates the feed URL
 *            cannot, and missing published_at / author / image / language are
 *            filled from the page. Never overwrites a value the feed gave.
 *   shadow — the article is inserted by the current pipeline unchanged and the
 *            page is extracted afterwards into news_article_extractions only,
 *            so the two can be compared without touching production news.
 *
 * Idempotency: one extraction row per (url_hash, mode), upserted; queue rows
 * are claimed with a lease (FOR UPDATE SKIP LOCKED), so a restart or a second
 * worker resumes the same rows instead of duplicating them.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql as databaseSql } from '@mip/db';
import { isBreakerOpen, retryAllowed, serializeSource, type ExtractionMode, type BreakerEvent } from './policy.js';
import { config } from '@mip/config';
import { newsLogger as log } from '@mip/logger';
import { canonicalizeUrl, hashUrl } from '../lib/url-canonicalize.js';
import { callExtractor, ExtractorUnavailable, newCorrelationId, type ExtractResult } from './client.js';

const connectionContext = new AsyncLocalStorage<Awaited<ReturnType<typeof databaseSql.reserve>>>();
// All queries during a guarded extraction reuse its reserved connection.
// Holding a lock must not consume a pool slot while waiting for another slot.
const sql: typeof databaseSql = new Proxy(databaseSql, {
  apply(target, thisArg, args) { return Reflect.apply(connectionContext.getStore() ?? target, thisArg, args); },
});

export type SourceMode = 'off' | 'shadow' | 'static' | 'dynamic';
export interface Engine { mode: 'off' | 'live' | 'shadow'; allowDynamic: boolean }

const OFF: Engine = { mode: 'off', allowDynamic: false };
const LEASE_MINUTES = 5;
const EXPIRE_PENDING_DAYS = 3;

/** Global flags × the source's own setting. Off unless both say on. */
export function engineFor(sourceMode: string | null | undefined): Engine {
  const mode = (sourceMode ?? 'off') as SourceMode;
  if (mode === 'off') return OFF;
  const allowDynamic = mode === 'dynamic' && config.NEWS_SCRAPLING_DYNAMIC_ENABLED;
  if (config.NEWS_SCRAPLING_SHADOW_MODE) return { mode: 'shadow', allowDynamic };
  if (!config.NEWS_SCRAPLING_ENABLED) return OFF;
  return { mode: mode === 'shadow' ? 'shadow' : 'live', allowDynamic };
}

export const engineConfigured = () => config.NEWS_SCRAPLING_ENABLED || config.NEWS_SCRAPLING_SHADOW_MODE;

function hashOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try { return hashUrl(canonicalizeUrl(url)); } catch { return null; }
}

/** Exponential backoff with full jitter: base 2 min, ×2 per attempt, capped at 6 h. */
export function backoffMs(attempt: number, random = Math.random): number {
  const ceiling = Math.min(6 * 3_600_000, 120_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

// ── Circuit breaker ────────────────────────────────────────────────────────
/** Open when the last N finished extractions of a source all failed, until the cooldown passes. */
export async function breakerOpen(sourceId: string, mode: ExtractionMode = 'shadow'): Promise<boolean> {
  // Stored outcomes survive pending/running transitions. Legacy completed rows
  // remain readable; queue expiry is not a failed fetch.
  const events = await sql<BreakerEvent[]>`
    SELECT event->>'status' AS status, event->>'at' AS at, event->>'cid' AS cid
    FROM news_article_extractions e
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_array_length(COALESCE(e.metadata->'breaker_events', '[]'::jsonb)) > 0
        THEN e.metadata->'breaker_events'
        WHEN e.status IN ('complete','partial','empty','failed','dead','duplicate') AND e.reason IS DISTINCT FROM 'expired'
        THEN jsonb_build_array(jsonb_build_object('status', CASE WHEN e.status = 'duplicate' THEN 'complete' ELSE e.status END,
          'at', e.updated_at, 'cid', e.correlation_id)) ELSE '[]'::jsonb END
    ) AS event
    WHERE e.source_id = ${sourceId}::uuid AND e.mode = ${mode}
    ORDER BY (event->>'at')::timestamptz DESC LIMIT ${config.NEWS_EXTRACTION_BREAKER_FAILURES}`;
  return isBreakerOpen(events, config.NEWS_EXTRACTION_BREAKER_FAILURES,
    config.NEWS_EXTRACTION_BREAKER_COOLDOWN_MINUTES * 60_000);
}

async function guardedExtraction<T>(sourceId: string, mode: ExtractionMode, blocked: T, work: () => Promise<T>): Promise<T> {
  return serializeSource(`${sourceId}:${mode}`, async () => {
    const connection = await sql.reserve();
    const key = `news-extraction:${sourceId}:${mode}`;
    let locked = false;
    try {
      const [lock] = await connection<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(hashtextextended(${key}, 0)) AS locked`;
      locked = lock.locked;
      if (!locked) return blocked;
      return await connectionContext.run(connection, async () => {
        if (await breakerOpen(sourceId, mode)) return blocked;
        return work();
      });
    } finally {
      try { if (locked) await connection`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`; }
      finally { connection.release(); }
    }
  });
}

// ── Duplicate detection ────────────────────────────────────────────────────
/**
 * The article this page duplicates, if any: same canonical URL as a stored
 * article (any source), or byte-identical normalised body from the same
 * source. Cross-source near-duplicates (syndicated copies) are only noted —
 * they are separate publications and stay separate articles.
 */
export async function findDuplicate(sourceId: string, ownUrlHash: string, r: ExtractResult): Promise<string | null> {
  const canon = hashOf(r.canonical_url);
  if (canon && canon !== ownUrlHash) {
    const [hit] = await sql<{ id: string }[]>`
      SELECT id FROM news_articles WHERE url_hash = ${canon}
      UNION ALL
      SELECT article_id FROM news_article_extractions
      WHERE canonical_hash = ${canon} AND mode = 'live' AND article_id IS NOT NULL AND url_hash <> ${ownUrlHash}
      LIMIT 1`;
    if (hit) return hit.id;
  }
  if (r.content_hash && r.char_count >= 200) {
    const [hit] = await sql<{ id: string }[]>`
      SELECT article_id AS id FROM news_article_extractions
      WHERE content_hash = ${r.content_hash} AND source_id = ${sourceId}::uuid AND mode = 'live'
        AND article_id IS NOT NULL AND url_hash <> ${ownUrlHash}
      LIMIT 1`;
    if (hit) return hit.id;
  }
  return null;
}

async function nearDuplicate(ownUrlHash: string, simhash: number | null): Promise<string | null> {
  if (simhash === null) return null;
  const [hit] = await sql<{ article_id: string }[]>`
    SELECT article_id FROM news_article_extractions
    WHERE simhash IS NOT NULL AND article_id IS NOT NULL AND url_hash <> ${ownUrlHash}
      AND updated_at >= now() - interval '7 days'
      AND bit_count((simhash # ${String(simhash)}::bigint)::bit(64)) <= 3
    LIMIT 1`;
  return hit?.article_id ?? null;
}

// ── Persistence ────────────────────────────────────────────────────────────
interface Row { mode: 'live' | 'shadow'; sourceId: string; articleId: string | null; url: string; urlHash: string }

export async function saveResult(row: Row, r: ExtractResult, extra: { status?: string; duplicateOf?: string | null; attempts?: number; nextAttemptAt?: Date | null; metadata?: Record<string, unknown> } = {}) {
  const status = extra.status ?? r.status;
  const near = status === 'complete' || status === 'partial' ? await nearDuplicate(row.urlHash, r.simhash) : null;
  const metadata = { ...r.metadata, ...(extra.metadata ?? {}), ...(near ? { near_duplicate_of: near } : {}),
    publisher: r.publisher, final_url: r.final_url,
    content_rank: r.content && r.status === 'complete' ? 2 : r.content && r.status === 'partial' ? 1 : 0,
    breaker_events: ['complete', 'partial', 'empty', 'failed'].includes(r.status)
      ? [{ status: r.status, at: new Date().toISOString(), cid: r.correlation_id }] : [] };
  await sql`
    INSERT INTO news_article_extractions (
      mode, source_id, article_id, url, url_hash, canonical_url, canonical_hash, status, method, reason, error_kind,
      http_status, attempts, next_attempt_at, locked_until, title, summary, content, content_hash, simhash, char_count,
      word_count, language, published_at, modified_at, authors, image_url, categories, tags, metadata, duplicate_of,
      fetch_ms, extract_ms, dynamic_used, correlation_id, extractor_version
    ) VALUES (
      ${row.mode}, ${row.sourceId}::uuid, ${row.articleId}::uuid, ${row.url}, ${row.urlHash}, ${r.canonical_url},
      ${hashOf(r.canonical_url)}, ${status}, ${r.method}, ${r.reason}, ${r.error_kind}, ${r.http_status},
      ${extra.attempts ?? Math.max(1, r.attempts)}, ${extra.nextAttemptAt ? extra.nextAttemptAt.toISOString() : null}::timestamptz, NULL,
      ${r.title}, ${r.summary}, ${r.content}, ${r.content_hash}, ${r.simhash === null ? null : String(r.simhash)}::bigint,
      ${r.char_count}, ${r.word_count}, ${r.language}, ${r.published_at}::timestamptz, ${r.modified_at}::timestamptz,
      ${r.authors}, ${r.image_url}, ${r.categories}, ${r.tags}, ${JSON.stringify(metadata)}::jsonb, ${extra.duplicateOf ?? null}::uuid,
      ${r.fetch_ms}, ${r.extract_ms}, ${r.dynamic_used}, ${r.correlation_id}, ${r.extractor_version}
    )
    ON CONFLICT (url_hash, mode) DO UPDATE SET
      article_id = COALESCE(EXCLUDED.article_id, news_article_extractions.article_id),
      canonical_url = COALESCE(EXCLUDED.canonical_url, news_article_extractions.canonical_url),
      canonical_hash = COALESCE(EXCLUDED.canonical_hash, news_article_extractions.canonical_hash), status = EXCLUDED.status,
      method = EXCLUDED.method, reason = EXCLUDED.reason, error_kind = EXCLUDED.error_kind, http_status = EXCLUDED.http_status,
      attempts = EXCLUDED.attempts, next_attempt_at = EXCLUDED.next_attempt_at, locked_until = NULL,
      title = COALESCE(NULLIF(btrim(EXCLUDED.title), ''), news_article_extractions.title),
      summary = COALESCE(NULLIF(btrim(EXCLUDED.summary), ''), news_article_extractions.summary),
      -- A failed retry never erases text that an earlier attempt extracted.
      content = CASE WHEN EXCLUDED.content IS NOT NULL AND (EXCLUDED.metadata->>'content_rank')::int >= COALESCE((news_article_extractions.metadata->>'content_rank')::int, CASE WHEN news_article_extractions.content IS NULL THEN 0 ELSE 2 END)
        AND ((EXCLUDED.metadata->>'content_rank')::int > COALESCE((news_article_extractions.metadata->>'content_rank')::int, CASE WHEN news_article_extractions.content IS NULL THEN 0 ELSE 2 END)
          OR EXCLUDED.char_count > news_article_extractions.char_count OR news_article_extractions.content IS NULL) THEN EXCLUDED.content
        ELSE COALESCE(news_article_extractions.content, EXCLUDED.content) END,
      content_hash = CASE WHEN EXCLUDED.content IS NOT NULL AND (EXCLUDED.metadata->>'content_rank')::int >= COALESCE((news_article_extractions.metadata->>'content_rank')::int, CASE WHEN news_article_extractions.content IS NULL THEN 0 ELSE 2 END)
        AND ((EXCLUDED.metadata->>'content_rank')::int > COALESCE((news_article_extractions.metadata->>'content_rank')::int, CASE WHEN news_article_extractions.content IS NULL THEN 0 ELSE 2 END)
          OR EXCLUDED.char_count > news_article_extractions.char_count OR news_article_extractions.content IS NULL) THEN EXCLUDED.content_hash ELSE COALESCE(news_article_extractions.content_hash, EXCLUDED.content_hash) END,
      simhash = CASE WHEN EXCLUDED.content IS NOT NULL AND (EXCLUDED.metadata->>'content_rank')::int >= COALESCE((news_article_extractions.metadata->>'content_rank')::int, CASE WHEN news_article_extractions.content IS NULL THEN 0 ELSE 2 END)
        AND ((EXCLUDED.metadata->>'content_rank')::int > COALESCE((news_article_extractions.metadata->>'content_rank')::int, CASE WHEN news_article_extractions.content IS NULL THEN 0 ELSE 2 END)
          OR EXCLUDED.char_count > news_article_extractions.char_count OR news_article_extractions.content IS NULL) THEN EXCLUDED.simhash ELSE COALESCE(news_article_extractions.simhash, EXCLUDED.simhash) END,
      char_count = CASE WHEN EXCLUDED.content IS NOT NULL AND (EXCLUDED.metadata->>'content_rank')::int >= COALESCE((news_article_extractions.metadata->>'content_rank')::int, CASE WHEN news_article_extractions.content IS NULL THEN 0 ELSE 2 END)
        AND ((EXCLUDED.metadata->>'content_rank')::int > COALESCE((news_article_extractions.metadata->>'content_rank')::int, CASE WHEN news_article_extractions.content IS NULL THEN 0 ELSE 2 END)
          OR EXCLUDED.char_count > news_article_extractions.char_count OR news_article_extractions.content IS NULL) THEN EXCLUDED.char_count ELSE news_article_extractions.char_count END,
      word_count = CASE WHEN EXCLUDED.content IS NOT NULL AND (EXCLUDED.metadata->>'content_rank')::int >= COALESCE((news_article_extractions.metadata->>'content_rank')::int, CASE WHEN news_article_extractions.content IS NULL THEN 0 ELSE 2 END)
        AND ((EXCLUDED.metadata->>'content_rank')::int > COALESCE((news_article_extractions.metadata->>'content_rank')::int, CASE WHEN news_article_extractions.content IS NULL THEN 0 ELSE 2 END)
          OR EXCLUDED.char_count > news_article_extractions.char_count OR news_article_extractions.content IS NULL) THEN EXCLUDED.word_count ELSE news_article_extractions.word_count END,
      language = COALESCE(EXCLUDED.language, news_article_extractions.language), published_at = COALESCE(EXCLUDED.published_at, news_article_extractions.published_at), modified_at = COALESCE(EXCLUDED.modified_at, news_article_extractions.modified_at),
      authors = CASE WHEN cardinality(EXCLUDED.authors) > 0 THEN EXCLUDED.authors ELSE news_article_extractions.authors END,
      image_url = COALESCE(EXCLUDED.image_url, news_article_extractions.image_url),
      categories = CASE WHEN cardinality(EXCLUDED.categories) > 0 THEN EXCLUDED.categories ELSE news_article_extractions.categories END,
      tags = CASE WHEN cardinality(EXCLUDED.tags) > 0 THEN EXCLUDED.tags ELSE news_article_extractions.tags END,
      metadata = news_article_extractions.metadata || EXCLUDED.metadata
        || jsonb_build_object('previous_content_hash', news_article_extractions.content_hash,
          'content_rank', CASE WHEN EXCLUDED.content IS NOT NULL AND (EXCLUDED.metadata->>'content_rank')::int >= COALESCE((news_article_extractions.metadata->>'content_rank')::int, CASE WHEN news_article_extractions.content IS NULL THEN 0 ELSE 2 END)
        AND ((EXCLUDED.metadata->>'content_rank')::int > COALESCE((news_article_extractions.metadata->>'content_rank')::int, CASE WHEN news_article_extractions.content IS NULL THEN 0 ELSE 2 END)
          OR EXCLUDED.char_count > news_article_extractions.char_count OR news_article_extractions.content IS NULL) THEN EXCLUDED.metadata->'content_rank'
            ELSE COALESCE(news_article_extractions.metadata->'content_rank', to_jsonb(CASE WHEN news_article_extractions.content IS NULL THEN 0 ELSE 2 END)) END,
          'breaker_events', CASE
            WHEN EXCLUDED.metadata->'breaker_events' = '[]'::jsonb
              OR news_article_extractions.metadata->'breaker_events'->-1->>'cid' = EXCLUDED.correlation_id
            THEN COALESCE(news_article_extractions.metadata->'breaker_events', '[]'::jsonb)
            ELSE (SELECT COALESCE(jsonb_agg(item ORDER BY ord), '[]'::jsonb) FROM
              jsonb_array_elements(COALESCE(news_article_extractions.metadata->'breaker_events',
                CASE WHEN news_article_extractions.status IN ('complete','partial','empty','failed','dead','duplicate')
                  AND news_article_extractions.reason IS DISTINCT FROM 'expired'
                THEN jsonb_build_array(jsonb_build_object('status', CASE WHEN news_article_extractions.status = 'duplicate'
                  THEN 'complete' ELSE news_article_extractions.status END,
                  'at', news_article_extractions.updated_at, 'cid', news_article_extractions.correlation_id))
                ELSE '[]'::jsonb END) || (EXCLUDED.metadata->'breaker_events')) WITH ORDINALITY AS history(item, ord)
              WHERE ord > jsonb_array_length(COALESCE(news_article_extractions.metadata->'breaker_events', '[]'::jsonb))
                + 1 - ${config.NEWS_EXTRACTION_BREAKER_FAILURES}) END),
      duplicate_of = EXCLUDED.duplicate_of, fetch_ms = EXCLUDED.fetch_ms, extract_ms = EXCLUDED.extract_ms,
      dynamic_used = EXCLUDED.dynamic_used, correlation_id = EXCLUDED.correlation_id,
      extractor_version = EXCLUDED.extractor_version, updated_at = now()`;
}

/** Queue an article for extraction later (shadow, over the per-run budget, or extractor down). */
export async function queueExtraction(row: Row, input: { title: string; summary: string | null; publishedAt: string | null; language: string | null; contentHtml?: string | null }) {
  await sql`
    INSERT INTO news_article_extractions (mode, source_id, article_id, url, url_hash, status, next_attempt_at, metadata)
    VALUES (${row.mode}, ${row.sourceId}::uuid, ${row.articleId}::uuid, ${row.url}, ${row.urlHash}, 'pending', now(),
            ${JSON.stringify({ input: { title: input.title, summary: input.summary?.slice(0, 20_000) ?? null,
              published_at: input.publishedAt, language: input.language, rss_content_html: input.contentHtml?.slice(0, 500_000) ?? null } })}::jsonb)
    ON CONFLICT (url_hash, mode) DO NOTHING`;
}

// ── Inline (live) path used by ingestArticles ──────────────────────────────
export interface InlineOutcome { duplicateOf?: string; result?: ExtractResult; unavailable?: boolean; blocked?: boolean }

/** What the live engine already knows about this URL: stored, a known duplicate of a stored article, or nothing. */
export async function urlState(urlHash: string): Promise<'stored' | 'duplicate' | null> {
  const [row] = await sql<{ state: 'stored' | 'duplicate' }[]>`
    SELECT 'stored' AS state FROM news_articles WHERE url_hash = ${urlHash}
    UNION ALL
    SELECT 'duplicate' FROM news_article_extractions WHERE url_hash = ${urlHash} AND mode = 'live' AND status = 'duplicate'
    LIMIT 1`;
  return row?.state ?? null;
}

export async function extractInline(sourceId: string, engine: Engine, urlHash: string, item: {
  url: string; title: string; description: string | null; publishedAt: string | null; language: string | null; contentHtml: string | null;
}): Promise<InlineOutcome> {
  if (engine.mode === 'off') return { blocked: true };
  return guardedExtraction<InlineOutcome>(sourceId, engine.mode, { blocked: true }, async () => {
  const [previous] = await sql<{ http_status: number | null; error_kind: string | null }[]>`
    SELECT http_status, error_kind FROM news_article_extractions WHERE url_hash = ${urlHash}
    AND (http_status = 403 OR error_kind = 'forbidden') LIMIT 1`;
  if (previous) return { blocked: true };
  const cid = newCorrelationId();
  let result: ExtractResult;
  try {
    result = await callExtractor({ url: item.url, language: item.language, rssTitle: item.title, rssSummary: item.description,
      rssContentHtml: item.contentHtml, rssPublishedAt: item.publishedAt, allowDynamic: engine.allowDynamic }, cid);
  } catch (error) {
    if (error instanceof ExtractorUnavailable) {
      log.warn({ cid, sourceId, err: error.message }, 'news extractor unavailable; article stored without extraction');
      return { unavailable: true };
    }
    throw error;
  }
  if (engine.mode === 'live' && (result.status === 'complete' || result.status === 'partial')) {
    const dup = await findDuplicate(sourceId, urlHash, result);
    if (dup) {
      await saveResult({ mode: 'live', sourceId, articleId: null, url: item.url, urlHash }, result, { status: 'duplicate', duplicateOf: dup });
      log.info({ cid, sourceId, duplicateOf: dup }, 'news article skipped as duplicate');
      return { duplicateOf: dup, result };
    }
  }
  await saveResult({ mode: engine.mode as ExtractionMode, sourceId, articleId: null, url: item.url, urlHash }, result,
    retryAllowed(result) ? { nextAttemptAt: new Date(Date.now() + backoffMs(1)) } : {});
  return { result };
  });
}

/** After the article row exists: record the inline result, or queue it if there was none. */
export async function afterInsert(sourceId: string, articleId: string, url: string, urlHash: string, outcome: InlineOutcome | null,
  input: { title: string; summary: string | null; publishedAt: string | null; language: string | null; contentHtml?: string | null }, mode: 'live' | 'shadow') {
  const row = { mode, sourceId, articleId, url, urlHash };
  if (outcome?.result) {
    // Inline already persisted its outcome under the source lock. Only attach
    // the newly inserted article; do not replay an older result after a retry.
    await sql`UPDATE news_article_extractions SET article_id = COALESCE(article_id, ${articleId}::uuid)
      WHERE url_hash = ${urlHash} AND mode = ${mode}`;
    return;
  }
  await queueExtraction(row, input);
}

// ── Queue pass (retries, shadow, overflow) ─────────────────────────────────
interface Claimed { id: string; mode: 'live' | 'shadow'; source_id: string; article_id: string | null; url: string; url_hash: string;
  attempts: number; metadata: { input?: { title?: string; summary?: string | null; published_at?: string | null; language?: string | null; rss_content_html?: string | null } };
  extraction_mode: string; source_language: string | null; is_active: boolean; created_at: string }

export async function processExtractionQueue(limit = config.NEWS_EXTRACTION_QUEUE_BATCH): Promise<{ processed: number }> {
  if (!engineConfigured() || limit <= 0) return { processed: 0 };
  await sql`
    UPDATE news_article_extractions SET status = 'dead', reason = 'expired', next_attempt_at = NULL, updated_at = now()
    WHERE status = 'pending' AND created_at < now() - ${EXPIRE_PENDING_DAYS} * interval '1 day'`;
  // Select candidates only. Each source/mode is checked under its lock BEFORE
  // the atomic row claim, so a failed outcome cannot disappear from the breaker.
  const candidates = await sql<Claimed[]>`
    SELECT * FROM (
      SELECT e.*, s.extraction_mode, s.language AS source_language, s.is_active,
        row_number() OVER (PARTITION BY e.source_id, e.mode ORDER BY e.next_attempt_at NULLS FIRST, e.id) AS source_position
      FROM news_article_extractions e JOIN news_sources s ON s.id = e.source_id
      WHERE ((e.status IN ('pending','failed') AND e.next_attempt_at <= now())
         OR (e.status = 'running' AND e.locked_until < now()))
        AND e.http_status IS DISTINCT FROM 403 AND e.error_kind IS DISTINCT FROM 'forbidden'
    ) due ORDER BY source_position, next_attempt_at NULLS FIRST LIMIT ${limit}`;
  let processed = 0;
  const work = async (candidate: Claimed) => guardedExtraction(candidate.source_id, candidate.mode, undefined, async () => {
    const engine = engineFor(candidate.extraction_mode);
    if (!candidate.is_active || engine.mode === 'off' || engine.mode !== candidate.mode) return;
    const [forbidden] = await sql`SELECT http_status, error_kind FROM news_article_extractions
      WHERE url_hash = ${candidate.url_hash} AND (http_status = 403 OR error_kind = 'forbidden') LIMIT 1`;
    if (forbidden) return;
    const [row] = await sql<Claimed[]>`
      UPDATE news_article_extractions SET status = 'running', attempts = attempts + 1, updated_at = now(),
        locked_until = now() + ${LEASE_MINUTES} * interval '1 minute',
        metadata = CASE WHEN metadata ? 'breaker_events' THEN metadata
          WHEN status IN ('failed') THEN metadata || jsonb_build_object('breaker_events',
            jsonb_build_array(jsonb_build_object('status', status, 'at', updated_at, 'cid', correlation_id)))
          ELSE metadata END
      WHERE id = ${candidate.id}::uuid AND
        ((status IN ('pending','failed') AND next_attempt_at <= now()) OR (status = 'running' AND locked_until < now()))
        AND http_status IS DISTINCT FROM 403 AND error_kind IS DISTINCT FROM 'forbidden'
        AND EXISTS (SELECT 1 FROM news_sources s WHERE s.id = news_article_extractions.source_id
          AND s.is_active AND s.extraction_mode = ${candidate.extraction_mode})
      RETURNING *`;
    if (!row) return;
    Object.assign(row, { source_language: candidate.source_language, extraction_mode: candidate.extraction_mode });
    const input = row.metadata?.input ?? {};
    let r: ExtractResult;
    try {
      r = await callExtractor({ url: row.url, language: input.language ?? row.source_language, rssTitle: input.title ?? null,
        rssSummary: input.summary ?? null, rssContentHtml: input.rss_content_html ?? null, rssPublishedAt: input.published_at ?? null, allowDynamic: engine.allowDynamic });
    } catch (error) {
      // Extractor down: hand the row back untouched (attempt not counted) and try again shortly.
      await sql`UPDATE news_article_extractions SET status = 'pending', attempts = GREATEST(attempts - 1, 0), locked_until = NULL,
        next_attempt_at = now() + interval '2 minutes', updated_at = now() WHERE id = ${row.id}::uuid`;
      log.warn({ sourceId: row.source_id, mode: row.mode }, 'news extractor unavailable during queue pass');
      return;
    }
    const base = { mode: row.mode, sourceId: row.source_id, articleId: row.article_id, url: row.url, urlHash: row.url_hash };
    if (r.status === 'failed') {
      const dead = !retryAllowed(r) || row.attempts >= config.NEWS_EXTRACTION_MAX_ATTEMPTS;
      await saveResult(base, r, {
        status: dead && retryAllowed(r) ? 'dead' : 'failed', attempts: row.attempts,
        nextAttemptAt: dead ? null : new Date(Date.now() + backoffMs(row.attempts)),
      });
    } else {
      const dup = row.mode === 'live' && (r.status === 'complete' || r.status === 'partial') ? await findDuplicate(row.source_id, row.url_hash, r) : null;
      // A queued live article is already stored: a duplicate is flagged for review, never deleted or merged.
      await saveResult(base, r, { attempts: row.attempts, ...(dup ? { status: 'duplicate', duplicateOf: dup } : {}) });

    }
    processed++;
  });

  // Small worker pool; per-domain pacing is enforced again inside the extractor.
  const queue = [...candidates];
  await Promise.all(Array.from({ length: Math.min(config.NEWS_EXTRACTION_CONCURRENCY, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      try { await work(next); } catch (error) {
        log.error({ id: next.id, mode: next.mode }, 'news extraction queue item failed');
      }
    }
  }));
  return { processed };
}

// ── Manual re-extraction ───────────────────────────────────────────────────
/** Re-extract one stored article now. Never changes its classification or deletes anything. */
export async function reextractArticle(articleId: string) {
  const [a] = await sql<{ id: string; url: string; url_hash: string; source_id: string; title: string; description: string | null;
    published_at: string | null; language: string | null; extraction_mode: string; source_language: string | null; is_active: boolean }[]>`
    SELECT a.id, a.url, a.url_hash, a.source_id, a.title, a.description, a.published_at, a.language,
           s.extraction_mode, s.language AS source_language, s.is_active
    FROM news_articles a JOIN news_sources s ON s.id = a.source_id WHERE a.id = ${articleId}::uuid`;
  if (!a) return null;
  const engine = engineFor(a.extraction_mode);
  if (engine.mode === 'off' || !a.is_active) return { mode: engine.mode, status: 'skipped', reason: 'source_disabled' };
  const mode = engine.mode;
  return guardedExtraction(a.source_id, mode, { mode, status: 'skipped', reason: 'circuit_open_or_busy' }, async () => {
  const [previous] = await sql<{ http_status: number | null; error_kind: string | null }[]>`
    SELECT http_status, error_kind FROM news_article_extractions WHERE url_hash = ${a.url_hash}
    AND (http_status = 403 OR error_kind = 'forbidden') LIMIT 1`;
  if (previous?.http_status === 403 || previous?.error_kind === 'forbidden')
    return { mode, status: 'skipped', reason: 'forbidden_not_retried' };
  const r = await callExtractor({ url: a.url, language: a.language ?? a.source_language, rssTitle: a.title, rssSummary: a.description,
    rssPublishedAt: a.published_at ? new Date(a.published_at).toISOString() : null,
    allowDynamic: a.extraction_mode === 'dynamic' && config.NEWS_SCRAPLING_DYNAMIC_ENABLED });
  await saveResult({ mode, sourceId: a.source_id, articleId: a.id, url: a.url, urlHash: a.url_hash }, r,
    { metadata: { reextracted_at: new Date().toISOString() } });

  return { mode, status: r.status, method: r.method, reason: r.reason, charCount: r.char_count, correlationId: r.correlation_id };
  });
}

export async function getExtraction(articleId: string) {
  return sql`
    SELECT mode, status, method, reason, error_kind, http_status, attempts, canonical_url, title, content, char_count, word_count,
           language, published_at, modified_at, authors, image_url, categories, tags, duplicate_of, fetch_ms, extract_ms,
           dynamic_used, correlation_id, extractor_version, metadata, updated_at
    FROM news_article_extractions WHERE article_id = ${articleId}::uuid ORDER BY mode`;
}
