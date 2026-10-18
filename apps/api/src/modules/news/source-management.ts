import { sql } from '@mip/db';
/** Batched reads only. Last collection success excludes manual homepage probes. */
export async function sourceManagement() {
  const until = new Date().toISOString();
  const since = new Date(Date.parse(until) - 24 * 3_600_000).toISOString();
  const items = await sql`
    WITH articles AS (
      SELECT source_id, count(*)::int AS articles_total,
        count(*) FILTER (WHERE discovered_at >= ${since}::timestamptz AND discovered_at <= ${until}::timestamptz)::int AS articles_24h
      FROM news_articles GROUP BY source_id
    ), jobs AS (
      SELECT source_id, max(started_at) AS collection_attempt_at,
        max(finished_at) FILTER (WHERE status = 'success') AS collection_success_at,
        COALESCE(sum(items_discovered),0)::int AS discovered_total,
        COALESCE(sum(items_discovered) FILTER (WHERE started_at >= ${since}::timestamptz AND started_at <= ${until}::timestamptz),0)::int AS discovered_24h
      FROM news_fetch_jobs GROUP BY source_id
    ), latest AS (
      SELECT DISTINCT ON (source_id) source_id, status AS collection_status, error AS collection_error
      FROM news_fetch_jobs ORDER BY source_id, started_at DESC, id DESC
    ), last_failure AS (
      SELECT DISTINCT ON (source_id) source_id, started_at AS last_collection_error_at, error AS last_collection_error
      FROM news_fetch_jobs WHERE status = 'failed' AND error IS NOT NULL ORDER BY source_id, started_at DESC, id DESC
    )
    SELECT s.id, s.program_id, p.name_ar AS program_name, s.name_ar, s.name_en, s.base_url,
      s.country, s.language, s.source_type, s.connector_type, s.rss_url, s.sitemap_url, s.api_url,
      s.source_weight, s.check_interval_minutes, s.is_active, s.crawl_allowed, s.extraction_mode,
      s.last_checked_at, h.state AS health_state, h.total_fetches, h.total_errors,
      j.collection_attempt_at, j.collection_success_at, l.collection_status, l.collection_error,
      f.last_collection_error_at, f.last_collection_error,
      COALESCE(a.articles_total,0)::int AS articles_total, COALESCE(a.articles_24h,0)::int AS articles_24h,
      COALESCE(j.discovered_total,0)::int AS discovered_total, COALESCE(j.discovered_24h,0)::int AS discovered_24h
    FROM news_sources s LEFT JOIN programs p ON p.id = s.program_id
      LEFT JOIN news_source_health h ON h.source_id = s.id LEFT JOIN articles a ON a.source_id = s.id
      LEFT JOIN jobs j ON j.source_id = s.id LEFT JOIN latest l ON l.source_id = s.id
      LEFT JOIN last_failure f ON f.source_id = s.id
    ORDER BY s.name_ar, s.id`;
  const attempts = await sql`
    SELECT s.id AS source_id, j.status, j.connector_used, j.started_at, j.finished_at, j.items_discovered, j.items_new, j.error
    FROM news_sources s CROSS JOIN LATERAL (
      SELECT status, connector_used, started_at, finished_at, items_discovered, items_new, error
      FROM news_fetch_jobs WHERE source_id = s.id ORDER BY started_at DESC, id DESC LIMIT 5
    ) j ORDER BY s.id, j.started_at DESC`;
  const clean = (value: unknown) => typeof value === 'string' ? value
    .replace(/https?:\/\/[^\s]+/gi, '[رابط محجوب]')
    .replace(/(?:bearer\s+\S+|(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+)/gi, '[محجوب]').slice(0, 500) : null;
  const grouped = new Map<string, Array<typeof attempts[number]>>();
  for (const row of attempts) { const list = grouped.get(row.source_id) ?? []; list.push({ ...row, error: clean(row.error) }); grouped.set(row.source_id, list); }
  return { since, until, windowHours: 24, items: items.map(s => ({ ...s, collection_error: clean(s.collection_error),
    last_collection_error: clean(s.last_collection_error), attempts: grouped.get(s.id) ?? [] })) };
}
