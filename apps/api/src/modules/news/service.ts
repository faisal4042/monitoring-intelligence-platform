import {insertCompatibleArticle} from './compatible-insert.js';
/**
 * News source registry (Phase 1) + article ingestion (Phase 2).
 */
import { sql, normalizeArabic } from '@mip/db';
import {encodeCursor, type BrowsingCursor, type CursorContext} from '../../lib/browsing-cursor.js';
import {HttpError} from '../../lib/errors.js';
import { conflict, notFound } from '../../lib/errors.js';
import { discoverSource, type DiscoveryResult } from './lib/discovery.js';
import { canonicalizeUrl, hashUrl } from './lib/url-canonicalize.js';
import { checkRelevance, clearRelevanceCache } from './lib/relevance-filter.js';
import type { RawArticle } from './connectors/types.js';
import { afterInsert, engineFor, extractInline, urlState, type InlineOutcome } from './extraction/service.js';
import { config } from '@mip/config';
import { newsLogger as log } from '@mip/logger';

export interface NewsSourceInput {
  programId?: string | null;
  nameAr: string;
  nameEn?: string | null;
  baseUrl: string;
  logoUrl?: string | null;
  country?: string | null;
  language?: string;
  sourceType: string;
  connectorType: string;
  rssUrl?: string | null;
  sitemapUrl?: string | null;
  apiUrl?: string | null;
  sourceWeight?: number;
  checkIntervalMinutes?: number;
}

export async function listSources(programId?: string) {
  return sql`
    SELECT s.*, h.state AS health_state, h.consecutive_failures, h.total_fetches,
           h.total_errors, h.avg_response_ms, h.last_check_at AS health_last_check_at,
           p.name_ar AS program_name
    FROM news_sources s
    LEFT JOIN news_source_health h ON h.source_id = s.id
    LEFT JOIN programs p ON p.id = s.program_id
    WHERE (${programId ?? null}::uuid IS NULL OR s.program_id = ${programId ?? null}::uuid)
    ORDER BY s.is_active DESC, s.name_ar`;
}

export async function createSource(input: NewsSourceInput, createdBy: string) {
  const [existing] = await sql<{ id: string }[]>`
    SELECT id FROM news_sources WHERE lower(base_url) = lower(${input.baseUrl})`;
  if (existing) throw conflict('يوجد مصدر مسجّل بهذا الرابط بالفعل');

  const [row] = await sql`
    INSERT INTO news_sources (
      program_id, name_ar, name_en, base_url, logo_url, country, language,
      source_type, connector_type, rss_url, sitemap_url, api_url,
      source_weight, check_interval_minutes, created_by
    ) VALUES (
      ${input.programId ?? null}::uuid, ${input.nameAr}, ${input.nameEn ?? null}, ${input.baseUrl},
      ${input.logoUrl ?? null}, ${input.country ?? null}, ${input.language ?? 'ar'},
      ${input.sourceType}, ${input.connectorType}, ${input.rssUrl ?? null}, ${input.sitemapUrl ?? null},
      ${input.apiUrl ?? null}, ${input.sourceWeight ?? 50}, ${input.checkIntervalMinutes ?? 5},
      ${createdBy}::uuid
    ) RETURNING *`;

  await sql`INSERT INTO news_source_health (source_id) VALUES (${row.id}::uuid)`;
  return row;
}

export async function updateSource(id: string, patch: Partial<NewsSourceInput> & { isActive?: boolean; extractionMode?: 'off' | 'shadow' | 'static' | 'dynamic' }) {
  const [before] = await sql`SELECT * FROM news_sources WHERE id = ${id}::uuid`;
  if (!before) throw notFound('المصدر غير موجود');

  const [after] = await sql`
    UPDATE news_sources SET
      name_ar = COALESCE(${patch.nameAr ?? null}, name_ar),
      name_en = COALESCE(${patch.nameEn ?? null}, name_en),
      logo_url = COALESCE(${patch.logoUrl ?? null}, logo_url),
      country = COALESCE(${patch.country ?? null}, country),
      language = COALESCE(${patch.language ?? null}, language),
      source_type = COALESCE(${patch.sourceType ?? null}, source_type),
      connector_type = COALESCE(${patch.connectorType ?? null}, connector_type),
      rss_url = COALESCE(${patch.rssUrl ?? null}, rss_url),
      sitemap_url = COALESCE(${patch.sitemapUrl ?? null}, sitemap_url),
      api_url = COALESCE(${patch.apiUrl ?? null}, api_url),
      source_weight = COALESCE(${patch.sourceWeight ?? null}, source_weight),
      check_interval_minutes = COALESCE(${patch.checkIntervalMinutes ?? null}, check_interval_minutes),
      is_active = COALESCE(${patch.isActive ?? null}, is_active),
      updated_at = now()
    WHERE id = ${id}::uuid RETURNING *`;

  // Separate statement, run only when asked: editing any other field never
  // touches extraction_mode, so it keeps working whether or not 0042 is applied.
  if (patch.extractionMode) {
    const [withMode] = await sql`
      UPDATE news_sources SET extraction_mode = ${patch.extractionMode}, updated_at = now()
      WHERE id = ${id}::uuid RETURNING *`;
    return { before, after: withMode };
  }

  return { before, after };
}

/** Soft-disable only — Phase 1 never hard-deletes a registered source. */
export async function disableSource(id: string) {
  const [row] = await sql`
    UPDATE news_sources SET is_active = false, updated_at = now()
    WHERE id = ${id}::uuid RETURNING *`;
  if (!row) throw notFound('المصدر غير موجود');
  return row;
}

/** Ad-hoc probe of a URL that isn't a saved source yet (the "add source" form) — nothing to persist to. */
export async function testConnection(baseUrl: string): Promise<DiscoveryResult> {
  return discoverSource(baseUrl);
}

/**
 * Same discovery, but for an already-saved source: the result is recorded
 * on the row and its health counters, so "آخر فحص" and the health badge
 * reflect the last real check instead of staying "لم يُفحص بعد" forever
 * regardless of how many times an admin has actually tested it.
 */
export async function testSourceConnection(id: string): Promise<DiscoveryResult> {
  const [source] = await sql<{ base_url: string; rss_url: string | null; sitemap_url: string | null }[]>`
    SELECT base_url, rss_url, sitemap_url FROM news_sources WHERE id = ${id}::uuid`;
  if (!source) throw notFound('المصدر غير موجود');

  const result = await discoverSource(source.base_url);
  const discoveredRss = result.detectedRssUrl;
  const discoveredSitemap = result.detectedSitemapUrl ?? result.detectedNewsSitemapUrl;

  await sql`
    UPDATE news_sources SET
      last_checked_at = now(),
      last_success_at = CASE WHEN ${result.connectionOk} THEN now() ELSE last_success_at END,
      robots_checked_at = now(),
      robots_status = ${result.robotsStatus},
      crawl_allowed = ${result.crawlAllowed},
      rss_url = COALESCE(rss_url, ${discoveredRss}),
      sitemap_url = COALESCE(sitemap_url, ${discoveredSitemap}),
      updated_at = now()
    WHERE id = ${id}::uuid`;

  await recordHealthCheck(id, result.connectionOk, result.responseMs);
  return result;
}

/**
 * Three consecutive failures before calling it "failed" outright — one bad
 * check (a transient timeout, a momentary 500) shouldn't flip a working
 * source's badge red; "degraded" covers that middle ground. Shared by the
 * manual Test Connection button and every scheduled worker tick so both
 * report health identically.
 */
export async function recordHealthCheck(sourceId: string, ok: boolean, responseMs: number | null) {
  await sql`
    UPDATE news_source_health SET
      state = CASE
        WHEN ${ok} THEN 'healthy'
        WHEN consecutive_failures + 1 >= 3 THEN 'failed'
        ELSE 'degraded'
      END,
      consecutive_failures = CASE WHEN ${ok} THEN 0 ELSE consecutive_failures + 1 END,
      last_check_at = now(),
      last_success_at = CASE WHEN ${ok} THEN now() ELSE last_success_at END,
      total_fetches = total_fetches + 1,
      total_errors = total_errors + CASE WHEN ${ok} THEN 0 ELSE 1 END,
      avg_response_ms = CASE
        WHEN ${responseMs}::int IS NULL THEN avg_response_ms
        WHEN avg_response_ms IS NULL THEN ${responseMs}
        ELSE ((avg_response_ms * total_fetches) + ${responseMs}) / (total_fetches + 1)
      END,
      updated_at = now()
    WHERE source_id = ${sourceId}::uuid`;
}

/**
 * Canonicalizes + hashes each raw item and upserts on the exact-dedup key —
 * a source re-polled every few minutes must never insert the same article
 * twice just because it's still in the feed. Returns how many were
 * genuinely new (the worker uses this for its job record and to compute
 * backoff — zero new items is treated the same as a quiet source, not a
 * failure).
 */
export async function ingestArticles(sourceId: string, items: RawArticle[], options: { deferExtraction?: boolean } = {}): Promise<number> {
  let inserted = 0;
  const [source] = await sql<{ program_id: string | null; name_ar: string; extraction_mode: string; language: string | null }[]>`
    SELECT program_id, name_ar, language,
           -- Read through to_jsonb so this query also works before migration 0042 adds the column (→ null → engine off).
           to_jsonb(news_sources) ->> 'extraction_mode' AS extraction_mode
    FROM news_sources WHERE id = ${sourceId}::uuid`;
  // Article extraction (off unless enabled globally and for this source). Live
  // extraction runs inline for up to NEWS_EXTRACTION_MAX_PER_RUN new articles;
  // anything beyond that is stored as today and queued, never dropped.
  const engine = engineFor(source?.extraction_mode);
  let inlineBudget = engine.mode === 'live' && !options.deferExtraction ? config.NEWS_EXTRACTION_MAX_PER_RUN : 0;
  for (const item of items) {
    if (source?.program_id) {
      const publisherName = item.publisherName ?? '';
      let publisherHost = '';
      try { publisherHost = item.publisherUrl ? new URL(item.publisherUrl).hostname : ''; } catch { /* rejected below */ }
      const knownSaudiPublisher = /(السعود|الهيئه العامه للعقار|عكاظ|الويام|المواطن|عاجل|سبق|املاك|اخبار 24|الرياض|مكه|المدينه|البلاد|صراحه|تواصل|المرصد|صحيفه مال|ارقام|الاقتصاديه|الاخباريه|صحيفه اليوم السعوديه)/u
        .test(normalizeArabic(publisherName));
      if (!publisherHost.endsWith('.sa') && !knownSaudiPublisher) continue;
    }
    let canonical: string;
    try {
      canonical = canonicalizeUrl(item.url);
    } catch {
      continue; // an unparseable URL from a malformed feed entry — skip, don't fail the whole batch
    }
    const hash = hashUrl(canonical);
    // postgres.js wants a string (or nothing) for a timestamptz parameter,
    // not a native Date object — pass the validated ISO string and let the
    // ::timestamptz cast parse it, same pattern used for X post timestamps
    // elsewhere in this codebase (collection.service.ts).
    const publishedAtDate = item.publishedAt ? new Date(item.publishedAt) : null;
    const publishedAtIso = publishedAtDate && !Number.isNaN(publishedAtDate.getTime()) ? publishedAtDate.toISOString() : null;
    const relevance = await checkRelevance(item.title, item.description ?? null);
    // A program-targeted discovery feed is a precision layer, not a general
    // archive. Never store search-result noise or a hit for another program.
    if (source?.program_id && (!relevance.isRelevant || relevance.programId !== source.program_id)) continue;
    let outcome: InlineOutcome | null = null;
    const contentHtml = item.contentHtml ?? (typeof item.raw?.['content:encoded'] === 'string' ? item.raw['content:encoded'] as string : null);
    const extractionInput = { title: item.title, summary: item.description ?? null, publishedAt: publishedAtIso, language: item.language ?? source?.language ?? null, contentHtml };
    const state = engine.mode === 'live' ? await urlState(hash) : null;
    // Rediscovered link already identified as a copy of a stored article: never inserted.
    if (state === 'duplicate') continue;
    if (inlineBudget > 0 && state === null) {
      inlineBudget--;
      try { outcome = await extractInline(sourceId, engine, hash, { url: item.url, title: item.title, description: item.description ?? null,
        publishedAt: publishedAtIso, language: extractionInput.language, contentHtml }); } catch { outcome = { unavailable: true }; log.warn({ sourceId }, 'extraction failed; preserve discovery'); }
      // The page's own canonical URL or body matches an article we already have.
      if (outcome.duplicateOf) continue;
    }
    const page = outcome?.result && (outcome.result.status === 'complete' || outcome.result.status === 'partial') ? outcome.result : null;
    const [row] = await insertCompatibleArticle({
      source_id:sourceId, url:item.url, canonical_url:canonical, url_hash:hash, title:item.title,
      description:item.description ?? null, author:item.author ?? page?.authors[0] ?? null,
      language:extractionInput.language ?? page?.language ?? null, image_url:item.imageUrl ?? page?.image_url ?? null,
      publisher_name:item.publisherName ?? null, publisher_url:item.publisherUrl ?? null,
      published_at:publishedAtIso ?? page?.published_at ?? null, raw_metadata:JSON.stringify(item.raw),
      is_relevant:relevance.isRelevant, matched_keyword:relevance.matchedKeyword,
      program_id:relevance.programId, topic_id:relevance.topicId, relevance_score:relevance.score,
    });
    if (row) {
      inserted++;
      if (engine.mode !== 'off') {
        try { await afterInsert(sourceId, row.id, item.url, hash, engine.mode === 'live' ? outcome : null, extractionInput, engine.mode); } catch { log.warn({ sourceId, articleId: row.id }, 'extraction queue unavailable; discovery preserved'); }
      }
    }
  }
  return inserted;
}

export async function reclassifyArticles(): Promise<{ processed: number; relevant: number; assigned: number }> {
  clearRelevanceCache();
  const rows = await sql<{ id: string; title: string; description: string | null }[]>`
    SELECT id, title, description FROM news_articles ORDER BY discovered_at DESC`;
  let relevant = 0;
  let assigned = 0;
  for (const row of rows) {
    const result = await checkRelevance(row.title, row.description);
    if (result.isRelevant) relevant++;
    if (result.programId) assigned++;
    await sql`
      UPDATE news_articles SET
        is_relevant = ${result.isRelevant}, matched_keyword = ${result.matchedKeyword},
        program_id = ${result.programId}::uuid, topic_id = ${result.topicId}::uuid,
        relevance_score = ${result.score}, updated_at = now()
      WHERE id = ${row.id}::uuid`;
  }
  return { processed: rows.length, relevant, assigned };
}

/**
 * An article's date is when the outlet published it, falling back to when we
 * discovered it for feeds that carry no date. `from`/`to` are timestamptz
 * literals (see lib/date-range.ts); without them the legacy `days` window applies.
 */
export interface NewsPageOptions {
  sourceId: string | null; programId: string | null; includeIrrelevant: boolean;
  limit: number; context: CursorContext; cursor: Extract<BrowsingCursor, {kind: 'news'}> | null;
}

/** All eligible group members are considered before any group limit. */
export function newsPageQuery(opts: NewsPageOptions) {
  const last = opts.cursor?.last;
  return sql<Record<string, any>[]>`
    WITH eligible AS MATERIALIZED (
      SELECT a.*, COALESCE(a.publisher_name, s.name_ar) AS source_name,
             s.name_ar AS registry_source_name, s.name_en AS source_name_en, s.logo_url AS source_logo_url,
             s.source_type, COALESCE(a.publisher_url, s.base_url) AS source_base_url, s.source_weight,
             p.name_ar AS program_name, p.color AS program_color, t.name_ar AS topic_name,
             COALESCE(a.published_at, a.discovered_at) AS effective_at
      FROM news_articles a
      JOIN news_sources s ON s.id = a.source_id
      LEFT JOIN programs p ON p.id = a.program_id
      LEFT JOIN topics t ON t.id = a.topic_id
      WHERE (${opts.sourceId}::uuid IS NULL OR a.source_id = ${opts.sourceId}::uuid)
        AND (${opts.programId}::uuid IS NULL OR a.program_id = ${opts.programId}::uuid)
        AND (${opts.includeIrrelevant} OR (a.is_relevant IS TRUE AND a.relevance_score >= 90))
        AND COALESCE(a.published_at, a.discovered_at) >= ${opts.context.window.from}::timestamptz
        AND COALESCE(a.published_at, a.discovered_at) < ${opts.context.window.to}::timestamptz
        AND COALESCE(a.published_at, a.discovered_at) <= COALESCE(${opts.cursor?.futureMax ?? null}::timestamptz, now() + interval '1 day')
    ), members AS (
      SELECT title_normalized COLLATE "C" AS group_key,
             array_agg(DISTINCT source_name ORDER BY source_name) AS names
      FROM eligible GROUP BY title_normalized COLLATE "C"
    ), ranked AS (
      SELECT eligible.*, row_number() OVER (
        PARTITION BY title_normalized COLLATE "C"
        ORDER BY effective_at DESC, source_weight DESC, discovered_at DESC, id DESC
      ) AS _rank FROM eligible
    ), page AS (
    SELECT r.*, cardinality(m.names)::integer AS related_source_count,
           array_prepend(r.source_name, array_remove(m.names, r.source_name)) AS related_source_names,
           to_char(r.effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS _cursor_effective,
           to_char(r.discovered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS _cursor_discovered,
           to_char(COALESCE(${opts.cursor?.futureMax ?? null}::timestamptz, now() + interval '1 day') AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS _cursor_future_max
    FROM ranked r JOIN members m ON m.group_key = r.title_normalized COLLATE "C"
    WHERE r._rank = 1
      AND (${last?.effective ?? null}::timestamptz IS NULL OR
           (r.effective_at, r.source_weight, r.discovered_at, r.id) <
           (${last?.effective ?? null}::timestamptz, ${last?.weight ?? null}::smallint,
            ${last?.discovered ?? null}::timestamptz, ${last?.id ?? null}::uuid))
    ORDER BY r.effective_at DESC, r.source_weight DESC, r.discovered_at DESC, r.id DESC
    LIMIT ${opts.limit + 1}
    ) SELECT page.*, EXISTS(SELECT 1 FROM news_articles WHERE title_normalized IS NULL) AS _unready
      FROM (SELECT 1) anchor LEFT JOIN page ON true
      ORDER BY page.effective_at DESC, page.source_weight DESC, page.discovered_at DESC, page.id DESC`;
}

export async function listArticles(opts: NewsPageOptions) {
  let rawRows: Record<string, any>[];
  try { rawRows = await newsPageQuery(opts); }
  catch (error) {
    if ((error as {code?: string}).code === '42703') throw new HttpError(503, 'News title migration is required before browsing.', 'NEWS_GROUPS_NOT_READY');
    throw error;
  }
  const rows = rawRows.filter(row => row.id !== null);
  if (rawRows.some(row => row._unready)) throw new HttpError(503, 'News titles require an approved backfill before browsing.', 'NEWS_GROUPS_NOT_READY');
  const hasMore = rows.length > opts.limit;
  const page = rows.slice(0, opts.limit), last = page.at(-1);
  const nextCursor = hasMore && last ? encodeCursor({...opts.context, kind: 'news', order: 'effective_weight_discovered_id_desc_v1',
    futureMax: last._cursor_future_max,
    last: {effective: last._cursor_effective, discovered: last._cursor_discovered, weight: last.source_weight, id: last.id}}, config.JWT_SECRET) : null;
  if (nextCursor && nextCursor === (opts.cursor ? encodeCursor(opts.cursor, config.JWT_SECRET) : null)) throw new HttpError(500, 'Cursor did not advance', 'CURSOR_NOT_ADVANCING');
  const items = page.map(({title_normalized, _rank, _unready, _cursor_effective, _cursor_discovered, _cursor_future_max, ...item}) => item);
  return {items, nextCursor, hasMore};
}
