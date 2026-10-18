-- Broad, publisher-agnostic press discovery for every monitored program.
-- Official feeds remain first-party sources; these sharded Google News RSS
-- searches fill the gaps left by shallow feeds, changed CMS URLs and outlets
-- that block machine access. ingestArticles still applies the platform's
-- strict program/relevance filter before anything reaches the news screen.

-- A separate broad real-estate shard captures relevant stories whose title
-- mentions the sector rather than a product brand. The normal classifier
-- assigns each accepted article to the correct program/topic.
WITH inserted AS (
  INSERT INTO news_sources (
    name_ar, name_en, base_url, country, language, source_type,
    connector_type, rss_url, source_weight, check_interval_minutes,
    next_run_at, crawl_allowed, is_active
  ) VALUES (
    'الرصد الصحفي الشامل — القطاع العقاري', 'Comprehensive press — Saudi real estate',
    'https://news.google.com/rss/search?q=%28%22%D8%A7%D9%84%D8%B9%D9%82%D8%A7%D8%B1%20%D8%A7%D9%84%D8%B3%D8%B9%D9%88%D8%AF%D9%8A%22%20OR%20%22%D8%A7%D9%84%D8%B3%D9%88%D9%82%20%D8%A7%D9%84%D8%B9%D9%82%D8%A7%D8%B1%D9%8A%22%20OR%20%22%D8%A7%D9%84%D8%AA%D8%B7%D9%88%D9%8A%D8%B1%20%D8%A7%D9%84%D8%B9%D9%82%D8%A7%D8%B1%D9%8A%22%20OR%20%22%D8%A7%D9%84%D8%A8%D9%8A%D8%B9%20%D8%B9%D9%84%D9%89%20%D8%A7%D9%84%D8%AE%D8%A7%D8%B1%D8%B7%D8%A9%22%29%20when%3A7d&hl=ar&gl=SA&ceid=SA%3Aar',
    'SA', 'ar', 'news_site', 'rss',
    'https://news.google.com/rss/search?q=%28%22%D8%A7%D9%84%D8%B9%D9%82%D8%A7%D8%B1%20%D8%A7%D9%84%D8%B3%D8%B9%D9%88%D8%AF%D9%8A%22%20OR%20%22%D8%A7%D9%84%D8%B3%D9%88%D9%82%20%D8%A7%D9%84%D8%B9%D9%82%D8%A7%D8%B1%D9%8A%22%20OR%20%22%D8%A7%D9%84%D8%AA%D8%B7%D9%88%D9%8A%D8%B1%20%D8%A7%D9%84%D8%B9%D9%82%D8%A7%D8%B1%D9%8A%22%20OR%20%22%D8%A7%D9%84%D8%A8%D9%8A%D8%B9%20%D8%B9%D9%84%D9%89%20%D8%A7%D9%84%D8%AE%D8%A7%D8%B1%D8%B7%D8%A9%22%29%20when%3A7d&hl=ar&gl=SA&ceid=SA%3Aar',
    92, 5, now(), true, true
  )
  ON CONFLICT DO NOTHING
  RETURNING id
)
INSERT INTO news_source_health (source_id)
SELECT id FROM inserted ON CONFLICT (source_id) DO NOTHING;

UPDATE news_sources
SET check_interval_minutes = 5,
    next_run_at = LEAST(COALESCE(next_run_at, now()), now()),
    updated_at = now()
WHERE is_active;

INSERT INTO audit_log (action, entity_type, entity_label, new_value, reason)
VALUES (
  'news.expand_comprehensive_coverage', 'platform', 'Comprehensive Saudi press coverage',
  jsonb_build_object('programShards', 4, 'sectorShards', 1, 'pollMinutes', 5, 'fallbackCrawler', true),
  'Fill gaps from shallow or blocked publisher feeds while retaining relevance and program assignment controls'
);
