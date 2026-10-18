-- The general Amlak feed exposes only ten latest stories and can push Ejar
-- coverage out within a day. Its first-party WordPress search feed keeps the
-- source direct while targeting the monitored program.
UPDATE news_sources
SET rss_url = 'https://amlak.net.sa/?s=%D8%A5%D9%8A%D8%AC%D8%A7%D8%B1&feed=rss2',
    etag = NULL,
    last_modified = NULL,
    next_run_at = now(),
    updated_at = now()
WHERE name_ar = 'صحيفة أملاك';

INSERT INTO audit_log (action, entity_type, entity_label, new_value, reason)
VALUES (
  'news.target_amlak_ejar_feed', 'news_source', 'صحيفة أملاك',
  jsonb_build_object('firstPartySearchFeed', true, 'pollMinutes', 5),
  'The general ten-item feed was too shallow to retain current Ejar coverage'
);
