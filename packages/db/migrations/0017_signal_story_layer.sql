BEGIN;

CREATE TABLE IF NOT EXISTS signal_stories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  topic_id uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  title_ar text NOT NULL,
  summary_ar text,
  why_ar text NOT NULL,
  centroid vector(1024) NOT NULL,
  state text NOT NULL DEFAULT 'candidate'
    CHECK (state IN ('candidate','new','rising','steady','fading')),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  post_count integer NOT NULL DEFAULT 0,
  family_count integer NOT NULL DEFAULT 0,
  author_count integer NOT NULL DEFAULT 0,
  influencer_count integer NOT NULL DEFAULT 0,
  engagement_total integer NOT NULL DEFAULT 0,
  posts_added_15m integer NOT NULL DEFAULT 0,
  posts_added_1h integer NOT NULL DEFAULT 0,
  live_score numeric(12,4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signal_stories_program_score
  ON signal_stories (program_id, live_score DESC, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_signal_stories_topic_recent
  ON signal_stories (topic_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_signal_stories_centroid_hnsw
  ON signal_stories USING hnsw (centroid vector_cosine_ops);

CREATE TABLE IF NOT EXISTS signal_story_members (
  story_id uuid NOT NULL REFERENCES signal_stories(id) ON DELETE CASCADE,
  post_id uuid NOT NULL,
  posted_at timestamptz NOT NULL,
  family_key text NOT NULL,
  source_role text NOT NULL DEFAULT 'customer'
    CHECK (source_role IN ('customer','influencer')),
  similarity numeric(6,5),
  is_representative boolean NOT NULL DEFAULT false,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, post_id, posted_at),
  UNIQUE (post_id, posted_at)
);

CREATE INDEX IF NOT EXISTS idx_signal_members_story_family
  ON signal_story_members (story_id, family_key);

CREATE TABLE IF NOT EXISTS signal_story_snapshots (
  story_id uuid NOT NULL REFERENCES signal_stories(id) ON DELETE CASCADE,
  sampled_at timestamptz NOT NULL DEFAULT now(),
  post_count integer NOT NULL,
  family_count integer NOT NULL,
  live_score numeric(12,4) NOT NULL,
  state text NOT NULL,
  rank integer,
  PRIMARY KEY (story_id, sampled_at)
);

CREATE INDEX IF NOT EXISTS idx_signal_snapshots_story_time
  ON signal_story_snapshots (story_id, sampled_at DESC);

INSERT INTO audit_log (
  user_id, user_email, action, entity_type, entity_label,
  reason, severity
) VALUES (
  (SELECT id FROM users WHERE email = 'admin@mip.local' LIMIT 1),
  'admin@mip.local', 'signals.create_story_layer', 'platform',
  'Dynamic stories and source-family noise filtering',
  'Collapse repeated interactions into ranked, evidence-backed signals',
  'info'
);

COMMIT;
