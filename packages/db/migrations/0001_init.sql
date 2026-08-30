-- ═══════════════════════════════════════════════════════════════════
-- Monitoring Intelligence Platform — initial schema (Phase 0 + Phase 1)
-- Mirrors docs/DATABASE_SCHEMA.md. Raw SQL rather than generated DDL
-- because we need partitioning, pgvector and partial indexes.
-- ═══════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "ltree";

CREATE SCHEMA IF NOT EXISTS internal;

-- ─── 1. Identity & RBAC ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  name_ar     text NOT NULL,
  name_en     text NOT NULL,
  description text,
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS permissions (
  key            text PRIMARY KEY,
  domain         text NOT NULL,
  description_ar text NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id        uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  full_name     text NOT NULL,
  password_hash text NOT NULL,
  role_id       uuid NOT NULL REFERENCES roles(id),
  is_active     boolean NOT NULL DEFAULT true,
  locale        text NOT NULL DEFAULT 'ar',
  theme         text NOT NULL DEFAULT 'system',
  last_login_at timestamptz,
  failed_login_attempts integer NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE TABLE IF NOT EXISTS user_permissions (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  granted_by     uuid REFERENCES users(id),
  granted_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission_key)
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  user_agent text,
  ip_address inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_active ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- ─── 2. Programs, Services, Taxonomy ───────────────────────────────

CREATE TABLE IF NOT EXISTS programs (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key      text NOT NULL UNIQUE,
  name_ar  text NOT NULL,
  name_en  text NOT NULL,
  description text,
  color    text,
  official_accounts text[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  budget_share_pct numeric(5,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS services (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  key        text NOT NULL,
  name_ar    text NOT NULL,
  name_en    text,
  description text,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, key)
);

CREATE TABLE IF NOT EXISTS topics (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  service_id uuid REFERENCES services(id) ON DELETE SET NULL,
  parent_id  uuid REFERENCES topics(id) ON DELETE CASCADE,
  level      smallint NOT NULL,
  name_ar    text NOT NULL,
  name_en    text,
  description text,
  path       ltree,
  centroid   vector(1024),
  source     text NOT NULL DEFAULT 'manual',
  source_ref uuid,
  is_active  boolean NOT NULL DEFAULT true,
  post_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_topics_path ON topics USING gist (path);
CREATE INDEX IF NOT EXISTS idx_topics_program ON topics (program_id, level) WHERE is_active;

-- ─── 3. Keyword Intelligence ───────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE keyword_type AS ENUM ('primary','service','related','negative','sensitive');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS keyword_groups (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id uuid REFERENCES programs(id) ON DELETE CASCADE,
  key        text NOT NULL,
  name_ar    text NOT NULL,
  type       keyword_type NOT NULL,
  description text,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, key)
);

CREATE TABLE IF NOT EXISTS keywords (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id   uuid NOT NULL REFERENCES keyword_groups(id) ON DELETE CASCADE,
  program_id uuid REFERENCES programs(id) ON DELETE CASCADE,
  service_id uuid REFERENCES services(id) ON DELETE SET NULL,
  term            text NOT NULL,
  term_normalized text NOT NULL,
  type       keyword_type NOT NULL,
  match_mode text NOT NULL DEFAULT 'term',
  language   text NOT NULL DEFAULT 'ar',
  weight     numeric(4,2) NOT NULL DEFAULT 1.0,
  source     text NOT NULL DEFAULT 'manual',
  source_ref uuid,
  match_count      integer NOT NULL DEFAULT 0,
  relevant_count   integer NOT NULL DEFAULT 0,
  irrelevant_count integer NOT NULL DEFAULT 0,
  noise_rate numeric(5,4),
  is_active  boolean NOT NULL DEFAULT true,
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  UNIQUE (group_id, term_normalized)
);
CREATE INDEX IF NOT EXISTS idx_keywords_program ON keywords (program_id, type) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_keywords_trgm ON keywords USING gin (term_normalized gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_keywords_noise ON keywords (noise_rate DESC NULLS LAST) WHERE is_active;

CREATE TABLE IF NOT EXISTS keyword_aliases (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword_id uuid NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  alias            text NOT NULL,
  alias_normalized text NOT NULL,
  alias_type text NOT NULL,
  confidence numeric(4,3),
  source     text NOT NULL DEFAULT 'manual',
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (keyword_id, alias_normalized)
);

-- ─── 4. Queries & Versioning ───────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE query_status AS ENUM ('draft','tested','approved','active','paused','archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE polling_tier AS ENUM ('hot','warm','cold','manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS queries (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  service_id uuid REFERENCES services(id) ON DELETE SET NULL,
  name        text NOT NULL,
  description text,
  status      query_status NOT NULL DEFAULT 'draft',
  current_version_id uuid,
  polling_tier          polling_tier NOT NULL DEFAULT 'warm',
  poll_interval_minutes integer NOT NULL DEFAULT 30,
  max_results_per_call  integer NOT NULL DEFAULT 50,
  max_pages_per_run     integer NOT NULL DEFAULT 1,
  daily_unit_cap        integer,
  since_id        text,
  last_run_at     timestamptz,
  last_success_at timestamptz,
  next_run_at     timestamptz,
  total_requests   bigint NOT NULL DEFAULT 0,
  total_units      bigint NOT NULL DEFAULT 0,
  total_relevant   bigint NOT NULL DEFAULT 0,
  total_irrelevant bigint NOT NULL DEFAULT 0,
  precision_rate   numeric(5,4),
  is_paused    boolean NOT NULL DEFAULT false,
  pause_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_queries_sched ON queries (status, next_run_at)
  WHERE status = 'active' AND NOT is_paused;
CREATE INDEX IF NOT EXISTS idx_queries_program ON queries (program_id);

CREATE TABLE IF NOT EXISTS query_versions (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id uuid NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
  version  integer NOT NULL,
  ast      jsonb NOT NULL,
  compiled text NOT NULL,
  compiled_length integer NOT NULL,
  breadth_score           numeric(5,2),
  noise_risk_score        numeric(5,2),
  estimated_units_per_run integer,
  actual_precision numeric(5,4),
  actual_units     bigint NOT NULL DEFAULT 0,
  change_summary   text,
  diff       jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  UNIQUE (query_id, version)
);

-- ─── 5. Query Sandbox ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS query_tests (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id uuid NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
  query_version_id uuid NOT NULL REFERENCES query_versions(id) ON DELETE CASCADE,
  sample_size    integer NOT NULL,
  posts_returned integer NOT NULL DEFAULT 0,
  count_relevant      integer NOT NULL DEFAULT 0,
  count_irrelevant    integer NOT NULL DEFAULT 0,
  count_advertisement integer NOT NULL DEFAULT 0,
  count_spam          integer NOT NULL DEFAULT 0,
  count_unknown       integer NOT NULL DEFAULT 0,
  precision_score numeric(5,4),
  noise_rate      numeric(5,4),
  units_consumed  integer NOT NULL DEFAULT 0,
  cost_estimate   numeric(12,6),
  recommendations      jsonb,
  keyword_contribution jsonb,
  passed         boolean,
  human_reviewed boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'running',
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_query_tests ON query_tests (query_id, created_at DESC);

CREATE TABLE IF NOT EXISTS query_test_posts (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id uuid NOT NULL REFERENCES query_tests(id) ON DELETE CASCADE,
  x_post_id text NOT NULL,
  text      text NOT NULL,
  author_username text,
  ai_label      text NOT NULL,
  ai_confidence numeric(4,3),
  ai_reason_ar  text,
  human_label   text,
  matched_terms text[],
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ─── 6. Authors & Posts ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS authors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  x_author_id text NOT NULL UNIQUE,
  username     text,
  display_name text,
  description  text,
  profile_image_url text,
  location     text,
  followers_count integer,
  following_count integer,
  tweet_count     integer,
  listed_count    integer,
  is_verified   boolean,
  verified_type text,
  account_created_at timestamptz,
  cache_tier         text NOT NULL DEFAULT 'normal',
  profile_fetched_at timestamptz,
  next_refresh_at    timestamptz,
  fetch_count        integer NOT NULL DEFAULT 0,
  fetch_failed_count integer NOT NULL DEFAULT 0,
  influence_score     numeric(5,2),
  relevant_post_count integer NOT NULL DEFAULT 0,
  total_post_count    integer NOT NULL DEFAULT 0,
  avg_engagement      numeric(12,2),
  negative_ratio      numeric(5,4),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  is_flagged    boolean NOT NULL DEFAULT false,
  notes         text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_authors_refresh ON authors (next_refresh_at) WHERE next_refresh_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_authors_influence ON authors (influence_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_authors_followers ON authors (followers_count DESC NULLS LAST);

DO $$ BEGIN
  CREATE TYPE post_status AS ENUM ('ingested','filtered_out','classified','duplicate','error');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Partitioned by month: retention becomes DROP PARTITION, not a slow DELETE.
CREATE TABLE IF NOT EXISTS posts (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  x_post_id   text NOT NULL,
  author_id   uuid REFERENCES authors(id),
  x_author_id text NOT NULL,
  text            text NOT NULL,
  text_normalized text NOT NULL,
  lang      text,
  posted_at timestamptz NOT NULL,
  url       text,
  conversation_id     text,
  in_reply_to_post_id text,
  referenced_post_id  text,
  reference_type text,
  is_reply  boolean NOT NULL DEFAULT false,
  is_quote  boolean NOT NULL DEFAULT false,
  is_repost boolean NOT NULL DEFAULT false,
  hashtags  text[],
  mentions  text[],
  urls      text[],
  has_media boolean NOT NULL DEFAULT false,
  source           text NOT NULL DEFAULT 'x',
  query_id         uuid REFERENCES queries(id) ON DELETE SET NULL,
  query_version_id uuid REFERENCES query_versions(id) ON DELETE SET NULL,
  matched_keywords    text[],
  matched_keyword_ids uuid[],
  content_hash    bytea NOT NULL,
  simhash         bigint,
  duplicate_of_id uuid,
  duplicate_type  text,
  status        post_status NOT NULL DEFAULT 'ingested',
  filter_reason text,
  risk_score    smallint,
  risk_factors  jsonb,
  collected_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  is_redacted boolean NOT NULL DEFAULT false,
  redacted_at timestamptz,
  PRIMARY KEY (id, posted_at),
  UNIQUE (x_post_id, posted_at)
) PARTITION BY RANGE (posted_at);

CREATE INDEX IF NOT EXISTS idx_posts_time    ON posts (posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_query   ON posts (query_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_author  ON posts (author_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_status  ON posts (status, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_hash    ON posts (content_hash);
CREATE INDEX IF NOT EXISTS idx_posts_risk    ON posts (risk_score DESC) WHERE risk_score >= 70;
CREATE INDEX IF NOT EXISTS idx_posts_trgm    ON posts USING gin (text_normalized gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_posts_hashtag ON posts USING gin (hashtags);

-- Classification (partitioned alongside posts)
DO $$ BEGIN
  CREATE TYPE relevance_label AS ENUM ('relevant','irrelevant','advertisement','spam','unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE intent_label AS ENUM ('complaint','inquiry','suggestion','praise','news','experience','warning','issue','request','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE sentiment_label AS ENUM ('very_positive','positive','neutral','negative','very_negative');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS post_classifications (
  post_id   uuid NOT NULL,
  posted_at timestamptz NOT NULL,
  relevance relevance_label NOT NULL,
  relevance_confidence numeric(4,3),
  intent    intent_label,
  intent_confidence numeric(4,3),
  program_id  uuid REFERENCES programs(id),
  service_id  uuid REFERENCES services(id),
  topic_id    uuid REFERENCES topics(id),
  subtopic_id uuid REFERENCES topics(id),
  issue_id    uuid REFERENCES topics(id),
  stage smallint NOT NULL,
  model text,
  llm_tokens_in  integer,
  llm_tokens_out integer,
  llm_cost numeric(12,8),
  reason_ar text,
  human_corrected boolean NOT NULL DEFAULT false,
  corrected_by uuid REFERENCES users(id),
  corrected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, posted_at)
) PARTITION BY RANGE (posted_at);
CREATE INDEX IF NOT EXISTS idx_class_rel  ON post_classifications (relevance, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_class_prog ON post_classifications (program_id, posted_at DESC);

CREATE TABLE IF NOT EXISTS post_sentiments (
  post_id   uuid NOT NULL,
  posted_at timestamptz NOT NULL,
  label      sentiment_label NOT NULL,
  score      numeric(5,4),
  confidence numeric(4,3),
  stage smallint NOT NULL,
  model text,
  human_corrected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, posted_at)
) PARTITION BY RANGE (posted_at);

CREATE TABLE IF NOT EXISTS post_metrics (
  post_id   uuid NOT NULL,
  posted_at timestamptz NOT NULL,
  like_count   integer NOT NULL DEFAULT 0,
  repost_count integer NOT NULL DEFAULT 0,
  reply_count  integer NOT NULL DEFAULT 0,
  quote_count  integer NOT NULL DEFAULT 0,
  bookmark_count   integer,
  impression_count integer,
  engagement_total integer GENERATED ALWAYS AS
    (like_count + repost_count + reply_count + quote_count) STORED,
  velocity_per_hour numeric(10,2),
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, posted_at, captured_at)
) PARTITION BY RANGE (posted_at);

-- ─── 7. Rollups ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mention_metrics_hourly (
  bucket     timestamptz NOT NULL,
  program_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  service_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  topic_id   uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  total_posts      integer NOT NULL DEFAULT 0,
  relevant_posts   integer NOT NULL DEFAULT 0,
  irrelevant_posts integer NOT NULL DEFAULT 0,
  ad_posts         integer NOT NULL DEFAULT 0,
  spam_posts       integer NOT NULL DEFAULT 0,
  positive_count   integer NOT NULL DEFAULT 0,
  neutral_count    integer NOT NULL DEFAULT 0,
  negative_count   integer NOT NULL DEFAULT 0,
  complaint_count  integer NOT NULL DEFAULT 0,
  inquiry_count    integer NOT NULL DEFAULT 0,
  unique_authors   integer NOT NULL DEFAULT 0,
  influencer_posts integer NOT NULL DEFAULT 0,
  total_engagement bigint  NOT NULL DEFAULT 0,
  max_risk_score   smallint,
  avg_risk_score   numeric(5,2),
  PRIMARY KEY (bucket, program_id, service_id, topic_id)
);

-- ─── 8. Cost & Budget ──────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE api_purpose AS ENUM ('collection','test','author_refresh','manual','backfill');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE budget_scope AS ENUM ('global','program','query','purpose');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE budget_period AS ENUM ('hour','day','month');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS api_usage (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  provider text NOT NULL DEFAULT 'x',
  endpoint text NOT NULL,
  purpose  api_purpose NOT NULL,
  query_id   uuid,
  query_version_id uuid,
  program_id uuid,
  test_id    uuid,
  requests_count  integer NOT NULL DEFAULT 1,
  units_consumed  integer NOT NULL DEFAULT 0,
  posts_new       integer NOT NULL DEFAULT 0,
  posts_duplicate integer NOT NULL DEFAULT 0,
  unit_price    numeric(12,8) NOT NULL,
  cost_estimate numeric(14,8) NOT NULL DEFAULT 0,
  http_status integer,
  error_code    text,
  error_message text,
  latency_ms    integer,
  rate_limit_remaining integer,
  rate_limit_reset_at  timestamptz,
  mode text NOT NULL DEFAULT 'live',
  triggered_by uuid REFERENCES users(id),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX IF NOT EXISTS idx_usage_query   ON api_usage (query_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_program ON api_usage (program_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_purpose ON api_usage (purpose, occurred_at DESC);

CREATE TABLE IF NOT EXISTS api_denials (
  id          bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  query_id   uuid,
  program_id uuid,
  purpose api_purpose NOT NULL,
  reason  text NOT NULL,
  scope   text,
  current_usage numeric(14,4),
  limit_value   numeric(14,4),
  requested_units integer
);
CREATE INDEX IF NOT EXISTS idx_denials_time ON api_denials (occurred_at DESC);

CREATE TABLE IF NOT EXISTS api_budgets (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope    budget_scope NOT NULL,
  scope_id uuid,
  period   budget_period NOT NULL,
  unit_limit    integer,
  cost_limit    numeric(12,4),
  is_hard_limit boolean NOT NULL DEFAULT true,
  alert_thresholds smallint[] NOT NULL DEFAULT '{50,70,80,90,100}',
  is_active      boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to   timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_unique ON api_budgets
  (scope, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid), period)
  WHERE is_active;

CREATE TABLE IF NOT EXISTS budget_counters (
  scope    budget_scope NOT NULL,
  scope_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  period   budget_period NOT NULL,
  period_start timestamptz NOT NULL,
  units_used    integer NOT NULL DEFAULT 0,
  cost_used     numeric(14,6) NOT NULL DEFAULT 0,
  requests_used integer NOT NULL DEFAULT 0,
  last_threshold_alerted smallint,
  reconciled_at timestamptz,
  PRIMARY KEY (scope, scope_id, period, period_start)
);

CREATE TABLE IF NOT EXISTS kill_switches (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope  text NOT NULL,
  target_id uuid,
  is_active boolean NOT NULL DEFAULT true,
  reason    text NOT NULL,
  activated_by uuid NOT NULL REFERENCES users(id),
  activated_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  deactivated_by uuid REFERENCES users(id),
  deactivated_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_killswitch_active ON kill_switches
  (scope, COALESCE(target_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_active;

CREATE TABLE IF NOT EXISTS cost_recommendations (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type     text NOT NULL,
  severity text NOT NULL,
  query_id   uuid REFERENCES queries(id) ON DELETE CASCADE,
  program_id uuid REFERENCES programs(id) ON DELETE CASCADE,
  title_ar  text NOT NULL,
  detail_ar text NOT NULL,
  evidence  jsonb NOT NULL,
  suggested_action jsonb,
  estimated_saving_units integer,
  estimated_saving_cost  numeric(12,4),
  status     text NOT NULL DEFAULT 'pending',
  applied_by uuid REFERENCES users(id),
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ─── 9. Feedback ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_feedback (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id   uuid,
  posted_at timestamptz,
  test_post_id uuid,
  feedback_type text NOT NULL,
  ai_value      text NOT NULL,
  ai_confidence numeric(4,3),
  ai_stage      smallint,
  human_value text NOT NULL,
  reason      text,
  post_text_snapshot text,
  embedding vector(1024),
  used_in_training  boolean NOT NULL DEFAULT false,
  training_batch_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_feedback_type ON ai_feedback (feedback_type, used_in_training);

CREATE TABLE IF NOT EXISTS keyword_feedback (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id   uuid,
  posted_at timestamptz,
  query_id  uuid REFERENCES queries(id) ON DELETE SET NULL,
  matched_keyword_id uuid REFERENCES keywords(id) ON DELETE SET NULL,
  matched_term text,
  action  text NOT NULL,
  applied boolean NOT NULL DEFAULT false,
  resulting_keyword_id uuid REFERENCES keywords(id),
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES users(id)
);

-- ─── 10. Settings, Audit, Retention ────────────────────────────────

CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL,
  value_type text NOT NULL,
  category   text NOT NULL,
  description_ar text,
  is_sensitive boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS settings_history (
  id  bigserial PRIMARY KEY,
  key text NOT NULL,
  old_value jsonb,
  new_value jsonb NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by uuid REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  user_id    uuid REFERENCES users(id),
  user_email text,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id    uuid,
  entity_label text,
  old_value jsonb,
  new_value jsonb,
  reason    text,
  ip_address inet,
  user_agent text,
  request_id uuid,
  severity   text NOT NULL DEFAULT 'info'
);
CREATE INDEX IF NOT EXISTS idx_audit_time   ON audit_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user   ON audit_log (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action, occurred_at DESC);

CREATE TABLE IF NOT EXISTS retention_policies (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity text NOT NULL UNIQUE,
  retention_days integer,
  action text NOT NULL,
  legal_basis text,
  is_active   boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  last_deleted_count bigint,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ─── 11. Partition bootstrap ───────────────────────────────────────
-- Creates the current month plus the next two for every partitioned table.
-- A missing partition is a silent insert failure, so we always run ahead.

CREATE OR REPLACE FUNCTION ensure_monthly_partitions(months_ahead integer DEFAULT 2)
RETURNS void AS $$
DECLARE
  tbl  text;
  i    integer;
  s    date;
  e    date;
  part text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['posts','post_classifications','post_sentiments','post_metrics','api_usage']
  LOOP
    FOR i IN 0..months_ahead LOOP
      s := date_trunc('month', now())::date + (i || ' month')::interval;
      e := s + interval '1 month';
      part := format('%s_%s', tbl, to_char(s, 'YYYY_MM'));
      IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part) THEN
        EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)', part, tbl, s, e);
      END IF;
    END LOOP;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

SELECT ensure_monthly_partitions(2);
