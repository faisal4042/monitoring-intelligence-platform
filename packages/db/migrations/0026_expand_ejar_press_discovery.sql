-- After the initial six-month phrase backfill, keep a broad 30-day Ejar
-- discovery window. Program-targeted ingestion rejects non-Ejar results.
UPDATE news_sources
SET base_url = 'https://news.google.com/rss/search?q=%D8%A5%D9%8A%D8%AC%D8%A7%D8%B1%20when%3A30d&hl=ar&gl=SA&ceid=SA%3Aar',
    rss_url = 'https://news.google.com/rss/search?q=%D8%A5%D9%8A%D8%AC%D8%A7%D8%B1%20when%3A30d&hl=ar&gl=SA&ceid=SA%3Aar',
    etag = NULL,
    last_modified = NULL,
    next_run_at = now(),
    updated_at = now()
WHERE name_ar = 'الرصد الصحفي المخصص — إيجار';

-- Amlak is a specialist Saudi real-estate newspaper and exposes a healthy
-- first-party RSS feed; it was missing from the source registry entirely.
WITH inserted AS (
  INSERT INTO news_sources (
    name_ar, name_en, base_url, country, language, source_type,
    connector_type, rss_url, source_weight, check_interval_minutes,
    next_run_at, crawl_allowed, is_active
  ) VALUES (
    'صحيفة أملاك', 'Amlak Newspaper', 'https://amlak.net.sa', 'SA', 'ar', 'newspaper',
    'rss', 'https://amlak.net.sa/feed/', 90, 5, now(), true, true
  )
  ON CONFLICT DO NOTHING
  RETURNING id
)
INSERT INTO news_source_health (source_id)
SELECT id FROM inserted
ON CONFLICT (source_id) DO NOTHING;

-- These rows came only from the regenerable targeted search feed and failed
-- classification. Removing them prevents search noise from accumulating.
DELETE FROM news_articles a
USING news_sources s
WHERE a.source_id = s.id
  AND s.name_ar = 'الرصد الصحفي المخصص — إيجار'
  AND a.is_relevant IS NOT TRUE;

INSERT INTO audit_log (action, entity_type, entity_label, new_value, reason)
VALUES (
  'news.expand_ejar_discovery', 'news_source', 'إيجار + صحيفة أملاك',
  jsonb_build_object('liveLookbackDays', 30, 'pollMinutes', 5, 'amlakOfficialRss', true, 'targetedNoiseStored', false),
  'Capture broad current Ejar press mentions without retaining unrelated search results'
);
