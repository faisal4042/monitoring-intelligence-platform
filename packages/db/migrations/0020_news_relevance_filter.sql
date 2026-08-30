-- News & Web Monitoring — relevance filter (reuses the existing X keyword
-- dictionary rather than a parallel news_keywords table, since the same
-- programs/keywords already define what "relevant" means on this platform).

BEGIN;

ALTER TABLE news_articles
  ADD COLUMN IF NOT EXISTS is_relevant boolean,
  ADD COLUMN IF NOT EXISTS matched_keyword text;

CREATE INDEX IF NOT EXISTS idx_news_articles_relevant ON news_articles (is_relevant, discovered_at DESC);

INSERT INTO audit_log (
  user_id, user_email, action, entity_type, entity_label,
  reason, severity
) VALUES (
  (SELECT id FROM users WHERE email = 'admin@mip.local' LIMIT 1),
  'admin@mip.local', 'news.add_relevance_filter', 'platform',
  'News & Web Monitoring — relevance filter against existing program keywords',
  'Only articles matching a primary/service keyword from إيجار/الهيئة العامة للعقار/البناء المستدام/ملاك show by default',
  'info'
);

COMMIT;
