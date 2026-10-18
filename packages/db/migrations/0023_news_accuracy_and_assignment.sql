ALTER TABLE news_articles
  ADD COLUMN IF NOT EXISTS program_id uuid REFERENCES programs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS topic_id uuid REFERENCES topics(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS relevance_score integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_news_articles_program_date
  ON news_articles (program_id, published_at DESC) WHERE is_relevant IS TRUE;
CREATE INDEX IF NOT EXISTS idx_news_articles_topic_date
  ON news_articles (topic_id, published_at DESC) WHERE is_relevant IS TRUE;

-- The newspaper publishes official feeds by section; اقتصاد is the section
-- most likely to carry property and housing coverage.
UPDATE news_sources
SET connector_type = 'rss',
    rss_url = 'https://www.al-jazirah.com/rss/ec.xml',
    sitemap_url = NULL,
    next_run_at = now(),
    updated_at = now()
WHERE name_ar = 'صحيفة الجزيرة';

-- Sources with no usable RSS/sitemap should use the standards-compliant
-- homepage crawler. It only follows public, same-domain article links.
UPDATE news_sources s
SET connector_type = 'crawler',
    rss_url = NULL,
    sitemap_url = NULL,
    next_run_at = now(),
    updated_at = now()
FROM news_source_health h
WHERE h.source_id = s.id
  AND h.state = 'failed'
  AND s.source_type IN ('newspaper', 'news_site')
  AND s.name_ar <> 'صحيفة الجزيرة';

INSERT INTO audit_log (action, entity_type, entity_label, new_value, reason)
VALUES (
  'news.accuracy_pipeline', 'platform', 'News accuracy and program assignment',
  jsonb_build_object('programAssignment', true, 'topicAssignment', true, 'freshnessWindowDays', 30, 'crawlerFallback', true),
  'Repair Arabic matching, classify existing news, sort by publication date, and recover known newspapers without a feed'
);
