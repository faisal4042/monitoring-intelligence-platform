/** Counts describe current records in one window, not an immutable request ledger. */
import { sql, normalizeArabic } from '@mip/db';
import { config } from '@mip/config';
import { breakerOpen, engineFor } from './service.js';
import { extractorHealth } from './client.js';
import { summarizeMetrics, titleForComparison, type MetricGroup } from './metrics-policy.js';

export async function extractionMetrics(hours = 24) {
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const until = new Date().toISOString();
  const [collection] = await sql`
    SELECT count(*)::int AS jobs, count(*) FILTER (WHERE status = 'failed')::int AS failed_jobs,
      COALESCE(sum(items_discovered),0)::int AS discovered, COALESCE(sum(items_new),0)::int AS saved,
      max(finished_at) FILTER (WHERE status = 'success') AS last_success
    FROM news_fetch_jobs WHERE started_at >= ${since}::timestamptz AND started_at <= ${until}::timestamptz`;
  const [sources] = await sql`
    SELECT count(*) FILTER (WHERE s.is_active)::int AS active,
      count(*) FILTER (WHERE s.is_active AND h.state = 'failed')::int AS failed,
      count(*) FILTER (WHERE s.is_active AND h.state = 'degraded')::int AS degraded,
      count(*) FILTER (WHERE s.is_active AND s.extraction_mode <> 'off')::int AS opted_in
    FROM news_sources s LEFT JOIN news_source_health h ON h.source_id = s.id`;
  const groups = await sql<MetricGroup[]>`
    SELECT mode, status, count(*)::int AS n,
      COALESCE(sum(fetch_ms),0)::float8 AS fetch_sum, count(fetch_ms)::int AS fetch_n,
      COALESCE(sum(extract_ms),0)::float8 AS extract_sum, count(extract_ms)::int AS extract_n,
      COALESCE(sum(GREATEST(attempts-1,0)),0)::int AS retries,
      count(*) FILTER (WHERE dynamic_used)::int AS dynamic,
      count(*) FILTER (WHERE NULLIF(btrim(title),'') IS NOT NULL)::int AS title_n,
      count(*) FILTER (WHERE published_at IS NOT NULL)::int AS date_n,
      count(*) FILTER (WHERE NULLIF(btrim(content),'') IS NOT NULL)::int AS body_n
    FROM news_article_extractions WHERE updated_at >= ${since}::timestamptz AND updated_at <= ${until}::timestamptz
    GROUP BY mode, status`;
  const queue = await sql`
    SELECT mode, count(*) FILTER (WHERE status = 'pending')::int AS pending,
      count(*) FILTER (WHERE status = 'running')::int AS running,
      count(*) FILTER (WHERE status = 'failed' AND next_attempt_at IS NOT NULL)::int AS retrying,
      count(*) FILTER (WHERE status = 'dead')::int AS dead,
      min(created_at) FILTER (WHERE status = 'pending') AS oldest_pending
    FROM news_article_extractions WHERE updated_at >= ${since}::timestamptz AND updated_at <= ${until}::timestamptz GROUP BY mode`;
  const perSource = await sql`
    SELECT s.id, s.name_ar, s.extraction_mode, s.is_active, h.state AS health, e.mode,
      count(e.id)::int AS total,
      count(e.id) FILTER (WHERE e.status = 'pending')::int AS pending,
      count(e.id) FILTER (WHERE e.status = 'running')::int AS running,
      count(e.id) FILTER (WHERE e.status = 'complete')::int AS complete,
      count(e.id) FILTER (WHERE e.status = 'partial')::int AS partial,
      count(e.id) FILTER (WHERE e.status = 'empty')::int AS empty,
      count(e.id) FILTER (WHERE e.status IN ('failed','dead'))::int AS failed,
      count(e.id) FILTER (WHERE e.status = 'duplicate')::int AS duplicate,
      count(e.id) FILTER (WHERE e.status = 'skipped')::int AS skipped,
      count(e.id) FILTER (WHERE e.dynamic_used)::int AS dynamic,
      round(avg(e.fetch_ms))::int AS avg_fetch_ms,
      max(e.updated_at) FILTER (WHERE e.status NOT IN ('pending','running')) AS last_extracted_at,
      max(e.updated_at) FILTER (WHERE e.status IN ('complete','partial')) AS last_accepted_at,
      max(e.updated_at) FILTER (WHERE e.status IN ('failed','dead','empty')) AS last_error_at,
      (array_agg(e.reason ORDER BY e.updated_at DESC) FILTER (WHERE e.status IN ('failed','dead','empty')))[1] AS last_error,
      count(e.id) FILTER (WHERE e.status IN ('complete','partial','empty','failed','dead','duplicate'))::int AS quality_denominator,
      count(e.id) FILTER (WHERE e.status IN ('complete','partial','empty','failed','dead','duplicate') AND NULLIF(btrim(e.title),'') IS NOT NULL)::int AS title_n,
      count(e.id) FILTER (WHERE e.status IN ('complete','partial','empty','failed','dead','duplicate') AND e.published_at IS NOT NULL)::int AS date_n,
      count(e.id) FILTER (WHERE e.status IN ('complete','partial','empty','failed','dead','duplicate') AND NULLIF(btrim(e.content),'') IS NOT NULL)::int AS body_n
    FROM news_sources s LEFT JOIN news_source_health h ON h.source_id = s.id
    LEFT JOIN news_article_extractions e ON e.source_id = s.id
      AND e.updated_at >= ${since}::timestamptz AND e.updated_at <= ${until}::timestamptz
    WHERE s.extraction_mode <> 'off' OR e.id IS NOT NULL
    GROUP BY s.id, h.state, e.mode ORDER BY s.name_ar, e.mode`;
  const shadowRows = await sql`
    SELECT a.title AS article_title, e.title, a.published_at AS article_published, e.published_at, e.status, e.char_count,
      s.name_ar, s.name_en, e.metadata->>'publisher' AS publisher
    FROM news_article_extractions e JOIN news_articles a ON a.id = e.article_id JOIN news_sources s ON s.id = e.source_id
    WHERE e.mode = 'shadow' AND e.updated_at >= ${since}::timestamptz AND e.updated_at <= ${until}::timestamptz
      AND e.status IN ('complete','partial','empty')`;
  const compareTitle = (r: typeof shadowRows[number], title: string) => titleForComparison(title,
    [r.name_ar, r.name_en, r.publisher].filter((p): p is string => typeof p === 'string' && p.length > 0), normalizeArabic);
  const summaries = Object.fromEntries(['shadow','live'].map((mode) => [mode, summarizeMetrics(groups.filter((r) => r.mode === mode))]));
  return {
    windowHours: hours, since, until, measurement: 'current_records_by_updated_at', healthScope: 'current',
    flags: { enabled: config.NEWS_SCRAPLING_ENABLED, shadow: config.NEWS_SCRAPLING_SHADOW_MODE, dynamic: config.NEWS_SCRAPLING_DYNAMIC_ENABLED },
    extractor: await extractorHealth(), collection: { ...collection, ...sources, lastSuccess: collection.last_success },
    extraction: { ...summarizeMetrics(groups), byMode: groups, modes: summaries },
    queue: { modes: Object.fromEntries(queue.map((q) => [q.mode, q])) },
    shadow: {
      compared: shadowRows.length,
      titleMatches: shadowRows.filter((r) => r.title && compareTitle(r, r.title) === compareTitle(r, r.article_title)).length,
      datesOnlyFromPage: shadowRows.filter((r) => !r.article_published && r.published_at).length,
      datesBoth: shadowRows.filter((r) => r.article_published && r.published_at).length,
      fullText: shadowRows.filter((r) => r.status === 'complete').length,
      avgChars: shadowRows.length ? Math.round(shadowRows.reduce((n, r) => n + r.char_count, 0) / shadowRows.length) : null,
    },
    sources: await Promise.all(perSource.map(async (s) => {
      const mode = s.mode ?? (engineFor(s.extraction_mode).mode === 'live' ? 'live' : 'shadow');
      const finished = s.complete + s.partial + s.empty + s.failed;
      return { ...s, mode, engine: engineFor(s.extraction_mode).mode, breakerOpen: await breakerOpen(s.id, mode),
        successRate: finished ? (s.complete + s.partial) / finished : null,
        titleCompleteness: s.quality_denominator ? s.title_n / s.quality_denominator : null,
        dateCompleteness: s.quality_denominator ? s.date_n / s.quality_denominator : null,
        bodyCompleteness: s.quality_denominator ? s.body_n / s.quality_denominator : null,
        errorRecovered: !!s.last_error_at && !!s.last_accepted_at && Date.parse(s.last_accepted_at) > Date.parse(s.last_error_at),
      };
    })),
  };
}
