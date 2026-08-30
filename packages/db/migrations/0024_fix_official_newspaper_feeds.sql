-- Prefer the publishers' official economy feeds over homepage crawling.
-- The previous migration's generic crawler fallback also caught Al Jazirah;
-- these explicit rules must run after that fallback.
UPDATE news_sources
SET connector_type = 'rss',
    rss_url = 'https://www.al-jazirah.com/rss/ec.xml',
    sitemap_url = NULL,
    crawl_allowed = true,
    next_run_at = now(),
    updated_at = now()
WHERE name_ar = 'صحيفة الجزيرة';

UPDATE news_sources
SET connector_type = 'rss',
    rss_url = 'https://www.alriyadh.com/section.news.econ.xml',
    sitemap_url = NULL,
    crawl_allowed = true,
    next_run_at = now(),
    updated_at = now()
WHERE name_ar = 'صحيفة الرياض';

UPDATE news_source_health h
SET state = 'degraded', consecutive_failures = 0, updated_at = now()
FROM news_sources s
WHERE h.source_id = s.id
  AND s.name_ar IN ('صحيفة الجزيرة', 'صحيفة الرياض');
