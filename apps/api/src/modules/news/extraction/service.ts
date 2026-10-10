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
import { sql } from '@mip/db';
import { config } from '@mip/config';
import { newsLogger as log } from '@mip/logger';
import { canonicalizeUrl, hashUrl } from '../lib/url-canonicalize.js';
import { callExtractor, ExtractorUnavailable, newCorrelationId, type ExtractResult } from './client.js';

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
export async function breakerOpen(sourceId: string): Promise<boolean> {
  const n = config.NEWS_EXTRACTION_BREAKER_FAILURES;
  const rows = await sql<{ status: string; updated_at: string }[]>`
    SELECT status, updated_at FROM news_article_extractions
    WHERE source_id = ${sourceId}::uuid AND status IN ('complete', 'partial', 'empty', 'failed', 'dead')
    ORDER BY updated_at DESC LIMIT ${n}`;
  if (rows.length < n || !rows.every((r) => r.status === 'failed' || r.status === 'dead' || r.status === 'empty')) return false;
  return Date.now() - new Date(rows[0].updated_at).getTime() < config.NEWS_EXTRACTION_BREAKER_COOLDOWN_MINUTES * 60_000;
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
    publisher: r.publisher, final_url: r.final_url };
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
      canonical_url = EXCLUDED.canonical_url, canonical_hash = EXCLUDED.canonical_hash, status = EXCLUDED.status,
      method = EXCLUDED.method, reason = EXCLUDED.reason, error_kind = EXCLUDED.error_kind, http_status = EXCLUDED.http_status,
      attempts = EXCLUDED.attempts, next_attempt_at = EXCLUDED.next_attempt_at, locked_until = NULL,
      title = EXCLUDED.title, summary = EXCLUDED.summary,
      -- A failed retry never erases text that an earlier attempt extracted.
      content = COALESCE(EXCLUDED.content, news_article_extractions.content),
      content_hash = COALESCE(EXCLUDED.content_hash, news_article_extractions.content_hash),
      simhash = COALESCE(EXCLUDED.simhash, news_article_extractions.simhash),
      char_count = GREATEST(EXCLUDED.char_count, CASE WHEN EXCLUDED.content IS NULL THEN news_article_extractions.char_count ELSE 0 END),
      word_count = GREATEST(EXCLUDED.word_count, CASE WHEN EXCLUDED.content IS NULL THEN news_article_extractions.word_count ELSE 0 END),
      language = EXCLUDED.language, published_at = EXCLUDED.published_at, modified_at = EXCLUDED.modified_at,
      authors = EXCLUDED.authors, image_url = EXCLUDED.image_url, categories = EXCLUDED.categories, tags = EXCLUDED.tags,
      metadata = news_article_extractions.metadata || EXCLUDED.metadata
        || jsonb_build_object('previous_content_hash', news_article_extractions.content_hash),
      duplicate_of = EXCLUDED.duplicate_of, fetch_ms = EXCLUDED.fetch_ms, extract_ms = EXCLUDED.extract_ms,
      dynamic_used = EXCLUDED.dynamic_used, correlation_id = EXCLUDED.correlation_id,
      extractor_version = EXCLUDED.extractor_version, updated_at = now()`;
}

/** Fill only what the article is missing; classification fields are never touched. */
export async function fillArticle(articleId: string, r: ExtractResult) {
  if (r.status !== 'complete' && r.status !== 'partial') return;
  await sql`
    UPDATE news_articles SET
      published_at = COALESCE(published_at, ${r.published_at}::timestamptz),
      author = COALESCE(author, ${r.authors[0] ?? null}),
      image_url = COALESCE(image_url, ${r.image_url}),
      language = COALESCE(language, ${r.language}),
      updated_at = CASE WHEN (published_at IS NULL AND ${r.published_at}::timestamptz IS NOT NULL)
                          OR (author IS NULL AND ${r.authors[0] ?? null}::text IS NOT NULL)
                          OR (image_url IS NULL AND ${r.image_url}::text IS NOT NULL)
                          OR (language IS NULL AND ${r.language}::text IS NOT NULL) THEN now() ELSE updated_at END
    WHERE id = ${articleId}::uuid`;
}

/** Queue an article for extraction later (shadow, over the per-run budget, or extractor down). */
export async function queueExtraction(row: Row, input: { title: string; summary: string | null; publishedAt: string | null; language: string | null }) {
  await sql`
    INSERT INTO news_article_extractions (mode, source_id, article_id, url, url_hash, status, next_attempt_at, metadata)
    VALUES (${row.mode}, ${row.sourceId}::uuid, ${row.articleId}::uuid, ${row.url}, ${row.urlHash}, 'pending', now(),
            ${JSON.stringify({ input: { title: input.title, summary: input.summary?.slice(0, 2000) ?? null,
              published_at: input.publishedAt, language: input.language } })}::jsonb)
    ON CONFLICT (url_hash, mode) DO NOTHING`;
}

// ── Inline (live) path used by ingestArticles ──────────────────────────────
export interface InlineOutcome { duplicateOf?: string; result?: ExtractResult; unavailable?: boolean }

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
  if (result.status === 'complete' || result.status === 'partial') {
    const dup = await findDuplicate(sourceId, urlHash, result);
    if (dup) {
      await saveResult({ mode: 'live', sourceId, articleId: null, url: item.url, urlHash }, result, { status: 'duplicate', duplicateOf: dup });
      log.info({ cid, sourceId, duplicateOf: dup }, 'news article skipped as duplicate');
      return { duplicateOf: dup, result };
    }
  }
  return { result };
}

/** After the article row exists: record the inline result, or queue it if there was none. */
export async function afterInsert(sourceId: string, articleId: string, url: string, urlHash: string, outcome: InlineOutcome | null,
  input: { title: string; summary: string | null; publishedAt: string | null; language: string | null }, mode: 'live' | 'shadow') {
  const row = { mode, sourceId, articleId, url, urlHash };
  if (outcome?.result) {
    const r = outcome.result;
    const retry = r.status === 'failed' && r.retryable;
    await saveResult(row, r, retry ? { nextAttemptAt: new Date(Date.now() + backoffMs(1)) } : {});
    if (mode === 'live') await fillArticle(articleId, r);
    return;
  }
  await queueExtraction(row, input);
}

// ── Queue pass (retries, shadow, overflow) ─────────────────────────────────
interface Claimed { id: string; mode: 'live' | 'shadow'; source_id: string; article_id: string | null; url: string; url_hash: string;
  attempts: number; metadata: { input?: { title?: string; summary?: string | null; published_at?: string | null; language?: string | null } };
  extraction_mode: string; source_language: string | null; is_active: boolean; created_at: string }

export async function processExtractionQueue(limit = config.NEWS_EXTRACTION_QUEUE_BATCH): Promise<{ processed: number }> {
  if (!engineConfigured() || limit <= 0) return { processed: 0 };
  await sql`
    UPDATE news_article_extractions SET status = 'dead', reason = 'expired', next_attempt_at = NULL, updated_at = now()
    WHERE status = 'pending' AND created_at < now() - ${EXPIRE_PENDING_DAYS} * interval '1 day'`;
  const claimed = await sql<Claimed[]>`
    WITH picked AS (
      SELECT e.id FROM news_article_extractions e
      WHERE (e.status IN ('pending', 'failed') AND e.next_attempt_at <= now())
         OR (e.status = 'running' AND e.locked_until < now())
      ORDER BY e.next_attempt_at NULLS FIRST
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE news_article_extractions e SET status = 'running', attempts = e.attempts + 1,
      locked_until = now() + ${LEASE_MINUTES} * interval '1 minute', updated_at = now()
    FROM picked, news_sources s
    WHERE e.id = picked.id AND s.id = e.source_id
    RETURNING e.id, e.mode, e.source_id, e.article_id, e.url, e.url_hash, e.attempts, e.metadata, e.created_at,
              s.extraction_mode, s.language AS source_language, s.is_active`;

  const breakers = new Map<string, boolean>();
  let processed = 0;
  const work = async (row: Claimed) => {
    const engine = engineFor(row.extraction_mode);
    if (!row.is_active || engine.mode === 'off') {
      await sql`UPDATE news_article_extractions SET status = 'skipped', reason = 'source_disabled', locked_until = NULL,
        next_attempt_at = NULL, updated_at = now() WHERE id = ${row.id}::uuid`;
      return;
    }
    if (!breakers.has(row.source_id)) breakers.set(row.source_id, await breakerOpen(row.source_id));
    if (breakers.get(row.source_id)) {
      await sql`UPDATE news_article_extractions SET status = 'pending', attempts = attempts - 1, locked_until = NULL,
        next_attempt_at = now() + ${config.NEWS_EXTRACTION_BREAKER_COOLDOWN_MINUTES} * interval '1 minute', updated_at = now()
        WHERE id = ${row.id}::uuid`;
      return;
    }
    const input = row.metadata?.input ?? {};
    let r: ExtractResult;
    try {
      r = await callExtractor({ url: row.url, language: input.language ?? row.source_language, rssTitle: input.title ?? null,
        rssSummary: input.summary ?? null, rssPublishedAt: input.published_at ?? null, allowDynamic: engine.allowDynamic });
    } catch (error) {
      // Extractor down: hand the row back untouched (attempt not counted) and try again shortly.
      await sql`UPDATE news_article_extractions SET status = 'pending', attempts = GREATEST(attempts - 1, 0), locked_until = NULL,
        next_attempt_at = now() + interval '2 minutes', updated_at = now() WHERE id = ${row.id}::uuid`;
      log.warn({ err: error instanceof Error ? error.message : String(error) }, 'news extractor unavailable during queue pass');
      return;
    }
    const base = { mode: row.mode, sourceId: row.source_id, articleId: row.article_id, url: row.url, urlHash: row.url_hash };
    if (r.status === 'failed') {
      const dead = !r.retryable || row.attempts >= config.NEWS_EXTRACTION_MAX_ATTEMPTS;
      await saveResult(base, r, {
        status: dead && r.retryable ? 'dead' : 'failed', attempts: row.attempts,
        nextAttemptAt: dead ? null : new Date(Date.now() + backoffMs(row.attempts)),
      });
    } else {
      const dup = row.mode === 'live' && (r.status === 'complete' || r.status === 'partial') ? await findDuplicate(row.source_id, row.url_hash, r) : null;
      // A queued live article is already stored: a duplicate is flagged for review, never deleted or merged.
      await saveResult(base, r, { attempts: row.attempts, ...(dup ? { status: 'duplicate', duplicateOf: dup } : {}) });
      if (row.mode === 'live' && row.article_id && !dup) await fillArticle(row.article_id, r);
    }
    processed++;
  };

  // Small worker pool; per-domain pacing is enforced again inside the extractor.
  const queue = [...claimed];
  await Promise.all(Array.from({ length: Math.min(config.NEWS_EXTRACTION_CONCURRENCY, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      try { await work(next); } catch (error) {
        log.error({ err: error instanceof Error ? error.message : String(error), id: next.id }, 'news extraction queue item failed');
      }
    }
  }));
  return { processed };
}

// ── Manual re-extraction ───────────────────────────────────────────────────
/** Re-extract one stored article now. Never changes its classification or deletes anything. */
export async function reextractArticle(articleId: string) {
  const [a] = await sql<{ id: string; url: string; url_hash: string; source_id: string; title: string; description: string | null;
    published_at: string | null; language: string | null; extraction_mode: string; source_language: string | null }[]>`
    SELECT a.id, a.url, a.url_hash, a.source_id, a.title, a.description, a.published_at, a.language,
           s.extraction_mode, s.language AS source_language
    FROM news_articles a JOIN news_sources s ON s.id = a.source_id WHERE a.id = ${articleId}::uuid`;
  if (!a) return null;
  const mode: 'live' | 'shadow' = config.NEWS_SCRAPLING_ENABLED && !config.NEWS_SCRAPLING_SHADOW_MODE ? 'live' : 'shadow';
  const r = await callExtractor({ url: a.url, language: a.language ?? a.source_language, rssTitle: a.title, rssSummary: a.description,
    rssPublishedAt: a.published_at ? new Date(a.published_at).toISOString() : null,
    allowDynamic: a.extraction_mode === 'dynamic' && config.NEWS_SCRAPLING_DYNAMIC_ENABLED });
  await saveResult({ mode, sourceId: a.source_id, articleId: a.id, url: a.url, urlHash: a.url_hash }, r,
    { metadata: { reextracted_at: new Date().toISOString() } });
  if (mode === 'live') await fillArticle(a.id, r);
  return { mode, status: r.status, method: r.method, reason: r.reason, charCount: r.char_count, correlationId: r.correlation_id };
}

export async function getExtraction(articleId: string) {
  return sql`
    SELECT mode, status, method, reason, error_kind, http_status, attempts, canonical_url, title, content, char_count, word_count,
           language, published_at, modified_at, authors, image_url, categories, tags, duplicate_of, fetch_ms, extract_ms,
           dynamic_used, correlation_id, extractor_version, metadata, updated_at
    FROM news_article_extractions WHERE article_id = ${articleId}::uuid ORDER BY mode`;
}
