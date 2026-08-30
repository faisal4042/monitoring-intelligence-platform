-- Tracked influential accounts (docs/PROJECT_PLAN.md scope extension 2026-08-28):
-- collection stays keyword-gated even for these accounts — being on this list
-- never bypasses relevance filtering, it only adds `from:` to the query.

CREATE TABLE IF NOT EXISTS tracked_influencers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username   text NOT NULL UNIQUE,
  x_user_id  text,
  notes      text,
  is_active  boolean NOT NULL DEFAULT true,
  added_by   uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tracked_influencers_active ON tracked_influencers (is_active);
