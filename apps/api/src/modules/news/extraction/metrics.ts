/**
 * Collection and extraction metrics for the news-sources page. Every figure is
 * a count over stored rows (news_fetch_jobs, news_article_extractions,
 * news_source_health); nothing is estimated.
 */
import { sql } from '@mip/db';
import { config } from '@mip/config';
import { normalizeArabic } from '@mip/db';
import { breakerOpen, engineFor } from './service.js';
import { extractorHealth } from './client.js';

export async function extractionMetrics(hours = 24) {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();

  const [collection] = await sql<{ jobs: number; failed_jobs: number; discovered: number; saved: number; last_success: string | null }[]>`
    SELECT count(*)::int AS jobs, count(*) FILTER (WHERE status = 'failed')::int AS failed_jobs,
           COALESCE(sum(items_discovered), 0)::int AS discovered, COALESCE(sum(items_new), 0)::int AS saved,
           max(finished_at) FILTER (WHERE status = 'success') AS last_success
    FROM news_fetch_jobs WHERE started_at >= ${since}::timestamptz`;

  const [sources] = await sql<{ active: number; failed: number; degraded: number; opted_in: number; last_success: string | null }[]>`
    SELECT count(*) FILTER (WHERE s.is_active)::int AS active,
           count(*) FILTER (WHERE s.is_active AND h.state = 'failed')::int AS failed,
           count(*) FILTER (WHERE s.is_active AND h.state = 'degraded')::int AS degraded,
           count(*) FILTER (WHERE s.is_active AND s.extraction_mode <> 'off')::int AS opted_in,
           max(s.last_success_at) AS last_success
    FROM news_sources s LEFT JOIN news_source_health h ON h.source_id = s.id`;

  const byStatus = await sql<{ mode: string; status: string; n: number; avg_fetch_ms: number | null; avg_extract_ms: number | null;
    retries: number; dynamic: number }[]>`
    SELECT mode, status, count(*)::int AS n, round(avg(fetch_ms))::int AS avg_fetch_ms, round(avg(extract_ms))::int AS avg_extract_ms,
           COALESCE(sum(GREATEST(attempts - 1, 0)), 0)::int AS retries, count(*) FILTER (WHERE dynamic_used)::int AS dynamic
    FROM news_article_extractions WHERE updated_at >= ${since}::timestamptz GROUP BY mode, status`;

  const [queue] = await sql<{ pending: number; retrying: number; dead: number; oldest_pending: string | null }[]>`
    SELECT count(*) FILTER (WHERE status IN ('pending', 'running'))::int AS pending,
           count(*) FILTER (WHERE status = 'failed' AND next_attempt_at IS NOT NULL)::int AS retrying,
           count(*) FILTER (WHERE status = 'dead')::int AS dead,
           min(created_at) FILTER (WHERE status = 'pending') AS oldest_pending
    FROM news_article_extractions`;

  const perSource = await sql<{ id: string; name_ar: string; extraction_mode: string; is_active: boolean; health: string | null;
    last_success_at: string | null; total: number; complete: number; partial: number; empty: number; failed: number;
    duplicate: number; dynamic: number; avg_fetch_ms: number | null; last_extracted_at: string | null; last_error: string | null }[]>`
    SELECT s.id, s.name_ar, s.extraction_mode, s.is_active, h.state AS health, s.last_success_at,
           count(e.id)::int AS total,
           count(e.id) FILTER (WHERE e.status = 'complete')::int AS complete,
           count(e.id) FILTER (WHERE e.status = 'partial')::int AS partial,
           count(e.id) FILTER (WHERE e.status = 'empty')::int AS empty,
           count(e.id) FILTER (WHERE e.status IN ('failed', 'dead'))::int AS failed,
           count(e.id) FILTER (WHERE e.status = 'duplicate')::int AS duplicate,
           count(e.id) FILTER (WHERE e.dynamic_used)::int AS dynamic,
           round(avg(e.fetch_ms))::int AS avg_fetch_ms,
           max(e.updated_at) FILTER (WHERE e.status IN ('complete', 'partial')) AS last_extracted_at,
           (SELECT x.reason FROM news_article_extractions x WHERE x.source_id = s.id AND x.status IN ('failed', 'dead', 'empty')
             ORDER BY x.updated_at DESC LIMIT 1) AS last_error
    FROM news_sources s
    LEFT JOIN news_source_health h ON h.source_id = s.id
    LEFT JOIN news_article_extractions e ON e.source_id = s.id AND e.updated_at >= ${since}::timestamptz
    WHERE s.extraction_mode <> 'off' OR e.id IS NOT NULL
    GROUP BY s.id, h.state
    ORDER BY s.name_ar`;

  // Shadow vs the current pipeline, on the same articles.
  const shadowRows = await sql<{ article_title: string; title: string | null; article_published: string | null; published_at: string | null;
    status: string; char_count: number }[]>`
    SELECT a.title AS article_title, e.title, a.published_at AS article_published, e.published_at, e.status, e.char_count
    FROM news_article_extractions e JOIN news_articles a ON a.id = e.article_id
    WHERE e.mode = 'shadow' AND e.updated_at >= ${since}::timestamptz AND e.status IN ('complete', 'partial', 'empty')`;
  const shadow = {
    compared: shadowRows.length,
    titleMatches: shadowRows.filter((r) => r.title && normalizeArabic(r.title) === normalizeArabic(r.article_title)).length,
    datesOnlyFromPage: shadowRows.filter((r) => !r.article_published && r.published_at).length,
    datesBoth: shadowRows.filter((r) => r.article_published && r.published_at).length,
    fullText: shadowRows.filter((r) => r.status === 'complete').length,
    avgChars: shadowRows.length ? Math.round(shadowRows.reduce((n, r) => n + r.char_count, 0) / shadowRows.length) : null,
  };

  const breakers = await Promise.all(perSource.filter((s) => s.extraction_mode !== 'off').map(async (s) => [s.id, await breakerOpen(s.id)] as const));
  const open = new Map(breakers);
  const sum = (status: string[], mode?: string) => byStatus.filter((r) => status.includes(r.status) && (!mode || r.mode === mode)).reduce((n, r) => n + r.n, 0);
  const finished = sum(['complete', 'partial', 'empty', 'failed', 'dead']);

  return {
    windowHours: hours,
    flags: { enabled: config.NEWS_SCRAPLING_ENABLED, shadow: config.NEWS_SCRAPLING_SHADOW_MODE, dynamic: config.NEWS_SCRAPLING_DYNAMIC_ENABLED },
    extractor: await extractorHealth(),
    collection: { ...collection, ...sources, lastSuccess: sources.last_success },
    extraction: {
      finished,
      complete: sum(['complete']), partial: sum(['partial']), empty: sum(['empty']), failed: sum(['failed', 'dead']),
      duplicate: sum(['duplicate']), skipped: sum(['skipped']),
      successRate: finished ? sum(['complete', 'partial']) / finished : null,
      emptyRate: finished ? sum(['empty']) / finished : null,
      duplicateRate: finished + sum(['duplicate']) ? sum(['duplicate']) / (finished + sum(['duplicate'])) : null,
      dynamicRenders: byStatus.reduce((n, r) => n + r.dynamic, 0),
      retries: byStatus.reduce((n, r) => n + r.retries, 0),
      avgFetchMs: weighted(byStatus, 'avg_fetch_ms'), avgExtractMs: weighted(byStatus, 'avg_extract_ms'),
      byMode: byStatus,
    },
    queue,
    shadow,
    sources: perSource.map((s) => ({ ...s, engine: engineFor(s.extraction_mode).mode, breakerOpen: open.get(s.id) ?? false,
      successRate: s.complete + s.partial + s.empty + s.failed ? (s.complete + s.partial) / (s.complete + s.partial + s.empty + s.failed) : null })),
  };
}

function weighted(rows: Array<{ n: number } & Record<string, number | null | string>>, key: string): number | null {
  const valid = rows.filter((r) => typeof r[key] === 'number');
  const n = valid.reduce((s, r) => s + r.n, 0);
  return n ? Math.round(valid.reduce((s, r) => s + (r[key] as number) * r.n, 0) / n) : null;
}
