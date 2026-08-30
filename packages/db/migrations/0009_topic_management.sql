-- Professional topic administration: aliases/routing terms and reversible
-- merge history. Topics themselves remain soft-deleted through is_active.

CREATE TABLE IF NOT EXISTS topic_keywords (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id   uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  term       text NOT NULL,
  kind       text NOT NULL DEFAULT 'alias'
             CHECK (kind IN ('alias','include','exclude')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_topic_keywords_normalized
  ON topic_keywords (topic_id, lower(btrim(term)));
CREATE INDEX IF NOT EXISTS idx_topic_keywords_topic
  ON topic_keywords (topic_id, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS topic_merge_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_topic_id uuid NOT NULL REFERENCES topics(id),
  target_topic_id uuid NOT NULL REFERENCES topics(id),
  moved_posts     integer NOT NULL DEFAULT 0,
  moved_children  integer NOT NULL DEFAULT 0,
  merged_by       uuid REFERENCES users(id),
  merged_at       timestamptz NOT NULL DEFAULT now(),
  note            text,
  CHECK (source_topic_id <> target_topic_id)
);

CREATE INDEX IF NOT EXISTS idx_topic_merge_history_topics
  ON topic_merge_history (source_topic_id, target_topic_id, merged_at DESC);

