ALTER TABLE news_articles
  ADD COLUMN IF NOT EXISTS publisher_name text,
  ADD COLUMN IF NOT EXISTS publisher_url text;

-- General newspaper feeds are shallow and quickly push niche program news
-- out of their latest-items window. This targeted press feed continuously
-- discovers Ejar coverage, while article rows retain the original publisher.
WITH ejar_program AS (
  SELECT id FROM programs WHERE key = 'ejar' LIMIT 1
), inserted AS (
  INSERT INTO news_sources (
    program_id, name_ar, name_en, base_url, country, language, source_type,
    connector_type, rss_url, source_weight, check_interval_minutes,
    next_run_at, crawl_allowed, is_active
  )
  SELECT
    id,
    'الرصد الصحفي المخصص — إيجار',
    'Targeted press coverage — Ejar',
    'https://news.google.com/rss/search?q=(%22%D9%85%D9%86%D8%B5%D8%A9%20%D8%A5%D9%8A%D8%AC%D8%A7%D8%B1%22%20OR%20%22%D8%B4%D8%A8%D9%83%D8%A9%20%D8%A5%D9%8A%D8%AC%D8%A7%D8%B1%22%20OR%20%22%D8%A5%D9%8A%D8%AC%D8%A7%D8%B1%20%D8%AA%D9%88%D8%B6%D8%AD%22%20OR%20%22%D8%A5%D9%8A%D8%AC%D8%A7%D8%B1%20%D8%A8%D9%84%D8%B3%22)%20when%3A180d&hl=ar&gl=SA&ceid=SA%3Aar',
    'SA', 'ar', 'news_site', 'rss',
    'https://news.google.com/rss/search?q=(%22%D9%85%D9%86%D8%B5%D8%A9%20%D8%A5%D9%8A%D8%AC%D8%A7%D8%B1%22%20OR%20%22%D8%B4%D8%A8%D9%83%D8%A9%20%D8%A5%D9%8A%D8%AC%D8%A7%D8%B1%22%20OR%20%22%D8%A5%D9%8A%D8%AC%D8%A7%D8%B1%20%D8%AA%D9%88%D8%B6%D8%AD%22%20OR%20%22%D8%A5%D9%8A%D8%AC%D8%A7%D8%B1%20%D8%A8%D9%84%D8%B3%22)%20when%3A180d&hl=ar&gl=SA&ceid=SA%3Aar',
    90, 5, now(), true, true
  FROM ejar_program
  ON CONFLICT DO NOTHING
  RETURNING id
)
INSERT INTO news_source_health (source_id)
SELECT id FROM inserted
ON CONFLICT (source_id) DO NOTHING;

INSERT INTO audit_log (action, entity_type, entity_label, new_value, reason)
VALUES (
  'news.add_targeted_ejar_coverage', 'news_source', 'الرصد الصحفي المخصص — إيجار',
  jsonb_build_object('lookbackDays', 180, 'pollMinutes', 5, 'preserveOriginalPublisher', true),
  'Recover Ejar coverage that rolls out of shallow general newspaper feeds and continue targeted discovery'
);
