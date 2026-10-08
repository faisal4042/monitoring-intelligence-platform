-- Unified monitoring queue: three sections, stories as work units, in-app alerts.
--
-- Additive. No existing row is updated or deleted here: every current item
-- keeps its id, status, assignee, history and gets section 'general' until
-- the intake worker's reconciliation moves it (with a section_changed event).
-- Two constraints are widened, never narrowed:
--   queue_items.interaction_type  'post'            -> 'post' | 'story'
--   queue_events.event_type       ten event types   -> + section_changed,
--                                                      section_review, story_merged
-- and post_id/post_posted_at become nullable for story units only (enforced
-- by queue_items_shape below: a post item still always has both).

-- ── Sections ──
-- Exactly one section per item, decided in SQL by the intake worker:
-- story (member of an approved story) > influencer (tracked account) > general.
ALTER TABLE queue_items ADD COLUMN IF NOT EXISTS section text NOT NULL DEFAULT 'general';
DO $$ BEGIN
  ALTER TABLE queue_items ADD CONSTRAINT queue_items_section_check
    CHECK (section IN ('general','influencer','story'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A move the worker refused to make silently (the target story belongs to
-- another team). Shown to supervisors; cleared once the move is possible.
ALTER TABLE queue_items ADD COLUMN IF NOT EXISTS section_hold text;
DO $$ BEGIN
  ALTER TABLE queue_items ADD CONSTRAINT queue_items_section_hold_check
    CHECK (section_hold IS NULL OR section_hold IN ('general','influencer','story'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Story units ──
-- A story is one work unit (interaction_type 'story'), worked with the same
-- state machine, events, notes and scope as any item. signal_stories rows are
-- merged and deleted by the clustering job, so there is deliberately no FK:
-- story_snapshot keeps the card readable, and merges are followed by the worker.
ALTER TABLE queue_items ADD COLUMN IF NOT EXISTS story_id uuid;
ALTER TABLE queue_items ADD COLUMN IF NOT EXISTS story_snapshot jsonb;
-- Post items inside a story point at the story's unit; they are listed inside
-- the story, never as separate cards.
ALTER TABLE queue_items ADD COLUMN IF NOT EXISTS story_item_id uuid REFERENCES queue_items(id);
-- A unit whose story was merged into another story's unit.
ALTER TABLE queue_items ADD COLUMN IF NOT EXISTS merged_into_id uuid REFERENCES queue_items(id);

ALTER TABLE queue_items DROP CONSTRAINT IF EXISTS queue_items_interaction_type_check;
DO $$ BEGIN
  ALTER TABLE queue_items ADD CONSTRAINT queue_items_interaction_type_check
    CHECK (interaction_type IN ('post','story'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE queue_items ALTER COLUMN post_id DROP NOT NULL;
ALTER TABLE queue_items ALTER COLUMN post_posted_at DROP NOT NULL;
DO $$ BEGIN
  ALTER TABLE queue_items ADD CONSTRAINT queue_items_shape CHECK (
    -- A post is in the story section exactly when it belongs to a story unit.
    (interaction_type = 'post' AND post_id IS NOT NULL AND post_posted_at IS NOT NULL
       AND story_id IS NULL AND story_snapshot IS NULL AND merged_into_id IS NULL
       AND (section = 'story') = (story_item_id IS NOT NULL))
    OR
    (interaction_type = 'story' AND post_id IS NULL AND post_posted_at IS NULL
       AND story_id IS NOT NULL AND story_snapshot IS NOT NULL
       AND story_item_id IS NULL AND section = 'story')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One unit per story, ever (the partial unique index on post_id stays).
CREATE UNIQUE INDEX IF NOT EXISTS queue_items_story_unique ON queue_items(story_id) WHERE interaction_type = 'story';
CREATE INDEX IF NOT EXISTS queue_items_section_status ON queue_items(section, status, entered_at, id)
  WHERE story_item_id IS NULL AND merged_into_id IS NULL;
CREATE INDEX IF NOT EXISTS queue_items_story_members ON queue_items(story_item_id) WHERE story_item_id IS NOT NULL;

ALTER TABLE queue_events DROP CONSTRAINT IF EXISTS queue_events_event_type_check;
DO $$ BEGIN
  ALTER TABLE queue_events ADD CONSTRAINT queue_events_event_type_check CHECK (event_type IN (
    'created','assigned','reassigned','unassigned','started','escalated','deescalated',
    'completed','reopened','note_added','section_changed','section_review','story_merged'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── In-app alerts (influencer and story sections only) ──
-- One alert per queue event that deserves one; recipients are resolved once,
-- when the alert is created, from the queue scope of each user (never wider).
CREATE TABLE IF NOT EXISTS queue_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('influencer','story','assigned')),
  queue_item_id uuid NOT NULL REFERENCES queue_items(id),
  queue_event_id uuid NOT NULL REFERENCES queue_events(id),
  section text NOT NULL CHECK (section IN ('influencer','story')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (queue_event_id)
);
-- An item announces its arrival in a section once, whatever moves follow.
CREATE UNIQUE INDEX IF NOT EXISTS queue_alerts_arrival_once ON queue_alerts(queue_item_id, kind)
  WHERE kind IN ('influencer','story');
CREATE INDEX IF NOT EXISTS queue_alerts_created ON queue_alerts(created_at);

-- Read and "sound already played" state per user, not per item.
CREATE TABLE IF NOT EXISTS queue_alert_recipients (
  alert_id uuid NOT NULL REFERENCES queue_alerts(id),
  user_id uuid NOT NULL REFERENCES users(id),
  read_at timestamptz,
  announced_at timestamptz,
  PRIMARY KEY (alert_id, user_id)
);
CREATE INDEX IF NOT EXISTS queue_alert_recipients_unread ON queue_alert_recipients(user_id, alert_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS queue_alert_recipients_unannounced ON queue_alert_recipients(user_id) WHERE announced_at IS NULL;

CREATE TABLE IF NOT EXISTS queue_alert_prefs (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  sound_enabled boolean NOT NULL DEFAULT true,
  -- Pop-up toasts; the bell keeps every alert either way.
  toasts_enabled boolean NOT NULL DEFAULT true,
  volume numeric(3,2) NOT NULL DEFAULT 0.6 CHECK (volume BETWEEN 0 AND 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);
