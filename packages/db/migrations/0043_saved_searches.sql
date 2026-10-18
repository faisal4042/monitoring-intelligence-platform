-- Advanced search: saved search definitions (2026-10-10).
--
-- Additive only: one new table, no change to existing tables or rows. Stores
-- the *definition* of a search (query text, tab, period, sort) — never copies
-- of posts or articles. Running a saved search re-applies the runner's own
-- permissions, so sharing a search never shares access to data.
--
-- The alert_* columns prepare the later "new results" alerts. Nothing reads
-- them yet: no worker, schedule or notification is added by this migration.

CREATE TABLE IF NOT EXISTS saved_searches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES users(id),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  query         text NOT NULL CHECK (char_length(query) <= 500),
  tab           text NOT NULL CHECK (tab IN ('posts','news','accounts','tickets')),
  -- {"range":"30d"} or {"from":"2026-10-01","to":"2026-10-10"}; {} = all periods.
  period        jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort          text,
  visibility    text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','shared')),
  last_run_at   timestamptz,
  run_count     integer NOT NULL DEFAULT 0,
  alert_enabled boolean NOT NULL DEFAULT false,
  alert_watermark timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_saved_searches_owner ON saved_searches (owner_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_saved_searches_shared ON saved_searches (updated_at DESC) WHERE deleted_at IS NULL AND visibility = 'shared';
