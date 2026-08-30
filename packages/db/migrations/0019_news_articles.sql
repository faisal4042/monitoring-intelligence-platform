-- News & Web Monitoring — Phase 2: RSS/Sitemap connectors + real scheduler.
-- Articles start landing here now. Deduplication is exact-URL only
-- (url_hash unique) — near-duplicate/cross-source dedup is Phase 3.

BEGIN;

CREATE TABLE IF NOT EXISTS news_articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES news_sources(id) ON DELETE CASCADE,
  url text NOT NULL,
  canonical_url text NOT NULL,
  -- sha256 of canonical_url — the exact-dedup key so a source re-polled
  -- every few minutes doesn't insert the same article again and again.
  url_hash text NOT NULL,
  title text NOT NULL,
  description text,
  author text,
  language text,
  image_url text,
  published_at timestamptz,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  -- Full RSS item / sitemap <url> entry, kept so a later phase (metadata
  -- extraction, AI analysis) never needs to re-visit the source for
  -- information the feed already handed over once.
  raw_metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_news_articles_url_hash ON news_articles (url_hash);
CREATE INDEX IF NOT EXISTS idx_news_articles_source_discovered ON news_articles (source_id, discovered_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_articles_published ON news_articles (published_at DESC);

CREATE TABLE IF NOT EXISTS news_fetch_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES news_sources(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('running','success','failed')),
  connector_used text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  items_discovered integer NOT NULL DEFAULT 0,
  items_new integer NOT NULL DEFAULT 0,
  error text,
  triggered_by text NOT NULL DEFAULT 'scheduler' CHECK (triggered_by IN ('scheduler','manual'))
);

CREATE INDEX IF NOT EXISTS idx_news_fetch_jobs_source_time ON news_fetch_jobs (source_id, started_at DESC);

INSERT INTO audit_log (
  user_id, user_email, action, entity_type, entity_label,
  reason, severity
) VALUES (
  (SELECT id FROM users WHERE email = 'admin@mip.local' LIMIT 1),
  'admin@mip.local', 'news.create_articles_layer', 'platform',
  'News & Web Monitoring — Phase 2 (articles + fetch scheduler)',
  'RSS/Sitemap connectors and a real per-source polling worker, isolated from X collection',
  'info'
);

COMMIT;
