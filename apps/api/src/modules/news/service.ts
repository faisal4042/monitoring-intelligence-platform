/**
 * News source registry (Phase 1) + article ingestion (Phase 2).
 */
import { sql, normalizeArabic } from '@mip/db';
import { conflict, notFound } from '../../lib/errors.js';
import { discoverSource, type DiscoveryResult } from './lib/discovery.js';
import { canonicalizeUrl, hashUrl } from './lib/url-canonicalize.js';
import { checkRelevance, clearRelevanceCache } from './lib/relevance-filter.js';
import type { RawArticle } from './connectors/types.js';

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
      ${input.apiUrl ?? null}, ${input.sourceWeight ?? 50}, 5,
      ${createdBy}::uuid
    ) RETURNING *`;

  await sql`INSERT INTO news_source_health (source_id) VALUES (${row.id}::uuid)`;
  return row;
}

export async function updateSource(id: string, patch: Partial<NewsSourceInput> & { isActive?: boolean }) {
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
      check_interval_minutes = 5,
      is_active = COALESCE(${patch.isActive ?? null}, is_active),
      updated_at = now()
    WHERE id = ${id}::uuid RETURNING *`;

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
export async function ingestArticles(sourceId: string, items: RawArticle[]): Promise<number> {
  let inserted = 0;
  const [source] = await sql<{ program_id: string | null; name_ar: string }[]>`
    SELECT program_id, name_ar FROM news_sources WHERE id = ${sourceId}::uuid`;
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
    const [row] = await sql`
      INSERT INTO news_articles (
        source_id, url, canonical_url, url_hash, title, description,
        author, language, image_url, publisher_name, publisher_url, published_at, raw_metadata,
        is_relevant, matched_keyword, program_id, topic_id, relevance_score
      ) VALUES (
        ${sourceId}::uuid, ${item.url}, ${canonical}, ${hash}, ${item.title}, ${item.description ?? null},
        ${item.author ?? null}, ${item.language ?? null}, ${item.imageUrl ?? null},
        ${item.publisherName ?? null}, ${item.publisherUrl ?? null},
        ${publishedAtIso}::timestamptz, ${JSON.stringify(item.raw)}::jsonb,
        ${relevance.isRelevant}, ${relevance.matchedKeyword}, ${relevance.programId}::uuid,
        ${relevance.topicId}::uuid, ${relevance.score}
      )
      ON CONFLICT (url_hash) DO NOTHING
      RETURNING id`;
    if (row) inserted++;
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

export async function listArticles(opts: { sourceId?: string; programId?: string; limit?: number; cursor?: string; includeIrrelevant?: boolean; days?: number }) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const days = Math.min(Math.max(opts.days ?? 30, 1), 3650);
  const fetchLimit = Math.min(limit * 2, 400);
  const rows = await sql<Record<string, any>[]>`
    SELECT a.*, COALESCE(a.publisher_name, s.name_ar) AS source_name,
           s.name_ar AS registry_source_name, s.name_en AS source_name_en, s.logo_url AS source_logo_url,
           s.source_type, COALESCE(a.publisher_url, s.base_url) AS source_base_url, s.source_weight,
           p.name_ar AS program_name, p.color AS program_color,
           t.name_ar AS topic_name,
           COALESCE(a.published_at, a.discovered_at) AS effective_at
    FROM news_articles a
    JOIN news_sources s ON s.id = a.source_id
    LEFT JOIN programs p ON p.id = a.program_id
    LEFT JOIN topics t ON t.id = a.topic_id
    WHERE (${opts.sourceId ?? null}::uuid IS NULL OR a.source_id = ${opts.sourceId ?? null}::uuid)
      AND (${opts.programId ?? null}::uuid IS NULL OR a.program_id = ${opts.programId ?? null}::uuid)
      AND (${opts.cursor ?? null}::timestamptz IS NULL OR COALESCE(a.published_at, a.discovered_at) < ${opts.cursor ?? null}::timestamptz)
      AND (${opts.includeIrrelevant ?? false} OR (a.is_relevant IS TRUE AND a.relevance_score >= 90))
      AND COALESCE(a.published_at, a.discovered_at) >= now() - ${days} * interval '1 day'
      AND COALESCE(a.published_at, a.discovered_at) <= now() + interval '1 day'
    ORDER BY COALESCE(a.published_at, a.discovered_at) DESC, s.source_weight DESC, a.discovered_at DESC
    LIMIT ${fetchLimit}`;

  // The same press release is often syndicated by several newspapers.
  // Collapse exact normalized headlines for display while retaining the
  // source count/names so duplicate coverage becomes evidence, not noise.
  const grouped = new Map<string, Record<string, any>>();
  for (const row of rows) {
    const key = normalizeArabic(String(row.title));
    const existing = grouped.get(key);
    if (existing) {
      const names = existing.related_source_names as string[];
      if (!names.includes(String(row.source_name))) names.push(String(row.source_name));
      existing.related_source_count = names.length;
      continue;
    }
    grouped.set(key, {
      ...row,
      related_source_count: 1,
      related_source_names: [String(row.source_name)],
    });
  }
  return [...grouped.values()].slice(0, limit);
}
