-- News & Web Monitoring — Phase 1: source registry only.
-- No fetching, no articles, no AI, no clustering yet — sources are
-- registered and test-connected here, nothing else touches them until
-- Phase 2 adds a scheduler.

BEGIN;

CREATE TABLE IF NOT EXISTS news_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id uuid REFERENCES programs(id) ON DELETE SET NULL,
  name_ar text NOT NULL,
  name_en text,
  base_url text NOT NULL,
  logo_url text,
  country text,
  language text NOT NULL DEFAULT 'ar',
  source_type text NOT NULL DEFAULT 'news_site'
    CHECK (source_type IN ('newspaper','news_site','government','real_estate','blog','magazine','other')),
  connector_type text NOT NULL DEFAULT 'auto'
    CHECK (connector_type IN ('auto','rss','atom','api','sitemap','crawler','manual')),
  rss_url text,
  sitemap_url text,
  api_url text,
  source_weight smallint NOT NULL DEFAULT 50 CHECK (source_weight BETWEEN 1 AND 100),
  check_interval_minutes integer NOT NULL DEFAULT 15 CHECK (check_interval_minutes >= 5),
  -- Left NULL through Phase 1 on purpose: no scheduler reads this column
  -- until Phase 2's worker exists, so a populated value here would be a
  -- promise the platform doesn't keep yet.
  next_run_at timestamptz,
  last_checked_at timestamptz,
  last_success_at timestamptz,
  etag text,
  last_modified text,
  robots_checked_at timestamptz,
  robots_status text,
  crawl_allowed boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_news_sources_active ON news_sources (is_active);
CREATE INDEX IF NOT EXISTS idx_news_sources_program ON news_sources (program_id) WHERE program_id IS NOT NULL;
-- Guards against registering the same outlet twice by accident — the admin
-- UI surfaces this as a normal validation error, not a hard DB failure.
CREATE UNIQUE INDEX IF NOT EXISTS idx_news_sources_base_url ON news_sources (lower(base_url));

CREATE TABLE IF NOT EXISTS news_source_health (
  source_id uuid PRIMARY KEY REFERENCES news_sources(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'healthy' CHECK (state IN ('healthy','degraded','failed')),
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_check_at timestamptz,
  last_success_at timestamptz,
  total_fetches bigint NOT NULL DEFAULT 0,
  total_errors bigint NOT NULL DEFAULT 0,
  avg_response_ms integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO audit_log (
  user_id, user_email, action, entity_type, entity_label,
  reason, severity
) VALUES (
  (SELECT id FROM users WHERE email = 'admin@mip.local' LIMIT 1),
  'admin@mip.local', 'news.create_source_registry', 'platform',
  'News & Web Monitoring — Phase 1 (source registry)',
  'Independent module for RSS/Sitemap/API/crawler news sources, isolated from X monitoring',
  'info'
);

COMMIT;
