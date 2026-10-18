-- Isolated unified review proposal. Never automatically applied on startup or to an operational database.
BEGIN;
-- YouTube monitoring MVP schema. Applied ONLY to the isolated test database (mip_youtube_test) by
-- `youtube/server.ts --init`, after the identity guard. Never in packages/db/migrations: db:push must not pick it up.
-- Production shape is docs/integrations/youtube-monitoring-architecture.md §6 (proposed 0048); the MVP drops the
-- program/user foreign keys (no MIP tables here) and the AI tables (no classification in the MVP).

CREATE TABLE IF NOT EXISTS youtube_channels (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  youtube_channel_id     text NOT NULL UNIQUE CHECK (youtube_channel_id ~ '^UC[0-9A-Za-z_-]{22}$'),
  title                  text,
  uploads_playlist_id    text,
  program_key            text,
  is_active              boolean NOT NULL DEFAULT true,
  last_seen_published_at timestamptz,
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active','not_found','purged')),
  consecutive_failures   integer NOT NULL DEFAULT 0,
  last_success_at        timestamptz,
  api_refreshed_at       timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT youtube_channels_purged CHECK (status <> 'purged' OR title IS NULL)
);

CREATE TABLE IF NOT EXISTS youtube_search_queries (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_key               text NOT NULL,
  name                      text NOT NULL UNIQUE,
  q                         text NOT NULL CHECK (char_length(q) BETWEEN 2 AND 500),
  region_code               text NOT NULL DEFAULT 'SA',
  relevance_language        text NOT NULL DEFAULT 'ar',
  video_duration            text NOT NULL DEFAULT 'any' CHECK (video_duration IN ('any','short','medium','long')),
  is_active                 boolean NOT NULL DEFAULT true,
  max_pages_per_run         smallint NOT NULL DEFAULT 1 CHECK (max_pages_per_run BETWEEN 1 AND 3),
  published_after_watermark timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS youtube_videos (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  youtube_video_id             text NOT NULL UNIQUE CHECK (youtube_video_id ~ '^[0-9A-Za-z_-]{11}$'),
  youtube_channel_id           text NOT NULL,
  channel_title                text,
  title                        text,
  description                  text,
  published_at                 timestamptz NOT NULL,
  duration_seconds             integer,
  short_candidate              boolean NOT NULL DEFAULT false,
  live_state                   text CHECK (live_state IN ('none','upcoming','live','completed')),
  discovered_via               text[] NOT NULL DEFAULT '{}',
  first_search_query_id        uuid REFERENCES youtube_search_queries(id) ON DELETE SET NULL,
  status                       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','unavailable','purged')),
  comments_state               text NOT NULL DEFAULT 'untracked' CHECK (comments_state IN ('untracked','tracking','disabled')),
  comments_newest_published_at timestamptz,
  collected_at                 timestamptz NOT NULL DEFAULT now(),
  api_refreshed_at             timestamptz NOT NULL DEFAULT now(),
  purged_at                    timestamptz,
  CONSTRAINT youtube_videos_purged CHECK (status <> 'purged' OR (title IS NULL AND description IS NULL AND channel_title IS NULL))
);
CREATE INDEX IF NOT EXISTS youtube_videos_channel_pub ON youtube_videos (youtube_channel_id, published_at DESC);
CREATE INDEX IF NOT EXISTS youtube_videos_refresh_due ON youtube_videos (api_refreshed_at) WHERE status = 'active';

-- Original YouTube statistics only (no derived metrics). Deleted after the retention window.
CREATE TABLE IF NOT EXISTS youtube_video_stats (
  video_id      uuid NOT NULL REFERENCES youtube_videos(id) ON DELETE CASCADE,
  captured_at   timestamptz NOT NULL DEFAULT now(),
  view_count    bigint,
  like_count    bigint,
  comment_count bigint,
  PRIMARY KEY (video_id, captured_at)
);

CREATE TABLE IF NOT EXISTS youtube_comments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  youtube_comment_id  text NOT NULL UNIQUE CHECK (char_length(youtube_comment_id) BETWEEN 1 AND 200),
  video_id            uuid NOT NULL REFERENCES youtube_videos(id) ON DELETE CASCADE,
  thread_id           text NOT NULL,
  parent_comment_id   text,
  is_reply            boolean GENERATED ALWAYS AS (parent_comment_id IS NOT NULL) STORED,
  author_channel_id   text,
  author_display_name text,
  text_display        text,
  like_count          bigint,
  total_reply_count   integer,
  published_at        timestamptz NOT NULL,
  yt_updated_at       timestamptz,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','unavailable','purged')),
  collected_at        timestamptz NOT NULL DEFAULT now(),
  api_refreshed_at    timestamptz NOT NULL DEFAULT now(),
  purged_at           timestamptz,
  CONSTRAINT youtube_comments_purged CHECK (status <> 'purged' OR (text_display IS NULL AND author_display_name IS NULL))
);
CREATE INDEX IF NOT EXISTS youtube_comments_video_pub ON youtube_comments (video_id, published_at DESC);
CREATE INDEX IF NOT EXISTS youtube_comments_thread ON youtube_comments (thread_id, published_at);
CREATE INDEX IF NOT EXISTS youtube_comments_refresh_due ON youtube_comments (api_refreshed_at) WHERE status = 'active';

-- Quota ledger per bucket, per YouTube quota day (America/Los_Angeles) and per mode, so mock/dry-run never
-- consume or hide live quota.
CREATE TABLE IF NOT EXISTS youtube_quota_ledger (
  bucket         text NOT NULL CHECK (bucket IN ('default','search','batch_stats')),
  quota_day      date NOT NULL,
  mode           text NOT NULL CHECK (mode IN ('mock','dry_run','live')),
  hard_limit     integer NOT NULL CHECK (hard_limit >= 0),
  reserved       integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  used           integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  exhausted_at   timestamptz,
  PRIMARY KEY (bucket, quota_day, mode)
);

CREATE TABLE IF NOT EXISTS youtube_collection_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lane            text NOT NULL CHECK (lane IN ('discovery','channels','comments','stats','retention')),
  target          text,
  mode            text NOT NULL CHECK (mode IN ('mock','dry_run','live')),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  status          text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','partial','failed','denied')),
  calls           integer NOT NULL DEFAULT 0,
  units           integer NOT NULL DEFAULT 0,
  items_new       integer NOT NULL DEFAULT 0,
  items_updated   integer NOT NULL DEFAULT 0,
  error_code      text,
  error_message   text
);

-- One row per attempted call. Never the key, never content.
CREATE TABLE IF NOT EXISTS youtube_api_calls (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id       uuid REFERENCES youtube_collection_runs(id) ON DELETE SET NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  endpoint     text NOT NULL,
  bucket       text NOT NULL,
  units        integer NOT NULL,
  mode         text NOT NULL,
  outcome      text NOT NULL CHECK (outcome IN ('ok','denied','error','dry_run','mock')),
  http_status  integer,
  error_reason text,
  latency_ms   integer,
  attempt      smallint NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS youtube_api_calls_time ON youtube_api_calls (occurred_at DESC);

-- YouTube-only kill switch. Starts PAUSED; MIP's X kill switch table is never touched.
CREATE TABLE IF NOT EXISTS youtube_collector_controls (
  singleton            boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  paused               boolean NOT NULL DEFAULT true,
  reason               text NOT NULL DEFAULT 'initial state: paused until explicitly resumed',
  consecutive_failures integer NOT NULL DEFAULT 0,
  changed_at           timestamptz NOT NULL DEFAULT now()
);
INSERT INTO youtube_collector_controls (singleton) VALUES (true) ON CONFLICT DO NOTHING;

COMMIT;
