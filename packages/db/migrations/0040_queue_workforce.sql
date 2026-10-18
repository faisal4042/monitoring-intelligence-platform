-- Queue workforce: agent availability, time records, per-agent queue settings
-- and automatic assignment.
--
-- Additive only. No existing queue item, event, review, note or user row is
-- updated or deleted here. Historical 'in_progress' items and 'started' events
-- stay as they are; the application treats an in_progress item like an
-- assigned one (the "start" step is no longer required).

-- ── Availability periods ──
-- One row per continuous period in one status. The open period (ended_at
-- NULL) is the agent's current status; "no open period" means offline.
-- Times are server clock, stored UTC (timestamptz); reports split periods by
-- Asia/Riyadh day, so a period across midnight is never lost or doubled.
CREATE TABLE IF NOT EXISTS agent_status_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('available','break','away','meeting','training','offline')),
  previous_status text CHECK (previous_status IS NULL OR previous_status IN ('available','break','away','meeting','training','offline')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  -- Who opened this period and who ended it: the agent, a supervisor, or the system.
  source text NOT NULL CHECK (source IN ('agent','supervisor','system')),
  actor_id uuid REFERENCES users(id),
  reason text,
  end_source text CHECK (end_source IS NULL OR end_source IN ('agent','supervisor','system')),
  end_reason text,
  duration_seconds numeric GENERATED ALWAYS AS (extract(epoch FROM (ended_at - started_at))) STORED,
  -- Number of supervisor corrections applied to this row (each one is in agent_status_corrections).
  corrected_count integer NOT NULL DEFAULT 0 CHECK (corrected_count >= 0),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK ((ended_at IS NULL) = (end_source IS NULL)),
  -- A supervisor's or the system's change always says why.
  CHECK (source = 'agent' OR length(trim(coalesce(reason,''))) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_status_periods_one_open ON agent_status_periods(user_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS agent_status_periods_user_time ON agent_status_periods(user_id, started_at);
CREATE INDEX IF NOT EXISTS agent_status_periods_time ON agent_status_periods(started_at, ended_at);

-- Last sign of life from an agent's open session. Not evidence that a shift
-- started (only an explicit status choice is); its absence ends a shift.
CREATE TABLE IF NOT EXISTS agent_presence (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  last_heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Supervisor corrections: the before/after of every corrected period. The
-- period rows themselves can only be changed through a correction (see trigger).
CREATE TABLE IF NOT EXISTS agent_status_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id uuid NOT NULL REFERENCES agent_status_periods(id),
  corrected_by uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  old_value jsonb NOT NULL,
  new_value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS agent_status_corrections_period ON agent_status_corrections(period_id, created_at);
DROP TRIGGER IF EXISTS agent_status_corrections_append_only ON agent_status_corrections;
CREATE TRIGGER agent_status_corrections_append_only BEFORE UPDATE OR DELETE ON agent_status_corrections
FOR EACH ROW EXECUTE FUNCTION queue_reject_history_change();

-- Periods are history: never deleted. An open period may be closed once
-- (ended_at, end_source, end_reason set from NULL); anything else needs the
-- correction path, which sets mip.status_correction for its transaction only.
CREATE OR REPLACE FUNCTION agent_status_periods_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Agent status history is append-only' USING ERRCODE='23514';
  END IF;
  IF coalesce(current_setting('mip.status_correction', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL
     AND NEW.user_id = OLD.user_id AND NEW.status = OLD.status AND NEW.started_at = OLD.started_at
     AND NEW.source = OLD.source AND NEW.actor_id IS NOT DISTINCT FROM OLD.actor_id
     AND NEW.reason IS NOT DISTINCT FROM OLD.reason
     AND NEW.previous_status IS NOT DISTINCT FROM OLD.previous_status
     AND NEW.corrected_count = OLD.corrected_count THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Agent status history can only be changed through a supervisor correction' USING ERRCODE='23514';
END;
$$;
DROP TRIGGER IF EXISTS agent_status_periods_guard ON agent_status_periods;
CREATE TRIGGER agent_status_periods_guard BEFORE UPDATE OR DELETE ON agent_status_periods
FOR EACH ROW EXECUTE FUNCTION agent_status_periods_guard();

-- ── Queue settings: team defaults, per-agent overrides ──
-- NULL means "inherit": agent → team default → system default. An empty
-- array is a real value ("none allowed"), never the same as NULL.
CREATE TABLE IF NOT EXISTS team_queue_defaults (
  team_id uuid PRIMARY KEY REFERENCES teams(id),
  program_ids uuid[],
  intents text[],
  sections text[],
  max_open integer CHECK (max_open IS NULL OR max_open BETWEEN 0 AND 200),
  auto_assign boolean,
  accepts_high_priority boolean,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id),
  CHECK (sections IS NULL OR sections <@ ARRAY['general','influencer','story']::text[])
);
CREATE TABLE IF NOT EXISTS agent_queue_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  program_ids uuid[],
  intents text[],
  sections text[],
  max_open integer CHECK (max_open IS NULL OR max_open BETWEEN 0 AND 200),
  auto_assign boolean,
  accepts_high_priority boolean,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id),
  CHECK (sections IS NULL OR sections <@ ARRAY['general','influencer','story']::text[])
);

-- ── Item priority ──
-- 'high' is set only by a supervisor (event 'priority_changed', with reason).
ALTER TABLE queue_items ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal';
DO $$ BEGIN
  ALTER TABLE queue_items ADD CONSTRAINT queue_items_priority_check CHECK (priority IN ('normal','high'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Candidate lookup for automatic assignment: unassigned top-level work per team.
CREATE INDEX IF NOT EXISTS queue_items_assignable ON queue_items(team_id, entered_at, id)
  WHERE status = 'new' AND merged_into_id IS NULL AND story_item_id IS NULL;

ALTER TABLE queue_events DROP CONSTRAINT IF EXISTS queue_events_event_type_check;
DO $$ BEGIN
  ALTER TABLE queue_events ADD CONSTRAINT queue_events_event_type_check CHECK (event_type IN (
    'created','assigned','reassigned','unassigned','started','escalated','deescalated',
    'completed','reopened','note_added','section_changed','section_review','story_merged','transferred',
    'priority_changed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Correction permission (granted to admin; per user for anyone else) ──
INSERT INTO permissions(key,domain,description_ar)
VALUES ('workforce:correct','queue','تصحيح سجلات حالات وساعات موظفي الرصد')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions(role_id,permission_key)
SELECT id,'workforce:correct' FROM roles WHERE key='admin'
ON CONFLICT DO NOTHING;

-- ── Settings ──
-- Automatic assignment is OFF until an administrator enables it: turning it
-- on starts distributing items that are already waiting.
INSERT INTO settings(key,value,value_type,category,description_ar) VALUES
 ('queue.auto_assign_enabled','false'::jsonb,'boolean','queue','الإسناد التلقائي لتفاعلات الطابور'),
 ('queue.lane_order','["story","influencer","general"]'::jsonb,'json','queue','ترتيب أولوية المسارات في الإسناد التلقائي'),
 ('queue.starvation_minutes','45'::jsonb,'number','queue','بعد هذا الانتظار (بالدقائق) يتقدّم العنصر على أولوية المسارات لمنع التجويع'),
 ('queue.default_max_open','5'::jsonb,'number','queue','الحد الافتراضي للتفاعلات المفتوحة في صندوق الموظف'),
 ('workforce.heartbeat_timeout_minutes','10'::jsonb,'number','queue','انقطاع الجلسة: بعد هذه المدة دون إشارة من المتصفح تتحول الحالة إلى غير متصل'),
 ('workforce.max_status_hours','12'::jsonb,'number','queue','الحد الأقصى لمدة حالة واحدة قبل أن يُنهيها النظام (نهاية الدوام المنسية)'),
 ('workforce.operational_statuses','["available"]'::jsonb,'json','queue','الحالات المحسوبة ضمن وقت العمل التشغيلي')
ON CONFLICT (key) DO NOTHING;
