-- Additive operational layer. No source/user mutations or historical intake.
CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id),
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('agent','supervisor')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  CHECK (left_at IS NULL OR left_at >= joined_at)
);
CREATE UNIQUE INDEX team_members_one_agent_team ON team_members(user_id) WHERE left_at IS NULL AND kind='agent';
CREATE UNIQUE INDEX team_members_active_unique ON team_members(team_id,user_id) WHERE left_at IS NULL;
-- A program has exactly one intake destination; supervisors may cover many.
CREATE TABLE team_programs (
  team_id uuid NOT NULL REFERENCES teams(id),
  program_id uuid NOT NULL REFERENCES programs(id),
  PRIMARY KEY (team_id,program_id),
  UNIQUE (program_id)
);
CREATE TABLE queue_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interaction_type text NOT NULL DEFAULT 'post' CHECK (interaction_type='post'),
  post_id uuid NOT NULL,
  post_posted_at timestamptz NOT NULL,
  -- Deliberately no FK to partitioned, independently retained posts.
  program_id uuid NOT NULL REFERENCES programs(id),
  program_snapshot jsonb NOT NULL,
  team_id uuid NOT NULL REFERENCES teams(id),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','assigned','in_progress','escalated','completed')),
  assignee_id uuid REFERENCES users(id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  entered_at timestamptz NOT NULL DEFAULT now(),
  first_assigned_at timestamptz,
  assigned_at timestamptz,
  first_started_at timestamptz,
  completed_at timestamptz,
  completed_by uuid REFERENCES users(id),
  last_escalated_at timestamptz,
  resolution text CHECK (resolution IN ('handled','no_action_needed','not_actionable')),
  reassignment_count integer NOT NULL DEFAULT 0 CHECK (reassignment_count >= 0),
  escalation_count integer NOT NULL DEFAULT 0 CHECK (escalation_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status='new' AND assignee_id IS NULL) OR (status<>'new' AND assignee_id IS NOT NULL)),
  CHECK (status<>'completed' OR (resolution IS NOT NULL AND completed_at IS NOT NULL AND completed_by IS NOT NULL))
);
CREATE UNIQUE INDEX queue_items_post_unique ON queue_items(post_id) WHERE interaction_type='post';
CREATE INDEX queue_items_assignee_open ON queue_items(assignee_id,status) WHERE status<>'completed';
CREATE INDEX queue_items_team_status_entered ON queue_items(team_id,status,entered_at,id);
CREATE INDEX queue_items_entered ON queue_items(entered_at,id);
CREATE INDEX queue_items_completed ON queue_items(completed_at) WHERE status='completed';
CREATE TABLE queue_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_item_id uuid NOT NULL REFERENCES queue_items(id),
  event_type text NOT NULL CHECK (event_type IN ('created','assigned','reassigned','unassigned','started','escalated','deescalated','completed','reopened','note_added')),
  actor_id uuid REFERENCES users(id),
  from_status text,
  to_status text NOT NULL,
  from_assignee uuid REFERENCES users(id),
  to_assignee uuid REFERENCES users(id),
  reason text,
  resolution text,
  version integer NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (queue_item_id,version),
  CHECK (event_type<>'escalated' OR length(trim(reason))>0)
);
CREATE INDEX queue_events_item_time ON queue_events(queue_item_id,created_at);
CREATE INDEX queue_events_actor_time ON queue_events(actor_id,created_at);
CREATE TABLE queue_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_item_id uuid NOT NULL REFERENCES queue_items(id),
  author_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX queue_notes_item_time ON queue_notes(queue_item_id,created_at);
CREATE FUNCTION queue_reject_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Queue history is append-only' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER queue_events_append_only BEFORE UPDATE OR DELETE ON queue_events
FOR EACH ROW EXECUTE FUNCTION queue_reject_history_change();
CREATE TRIGGER queue_notes_append_only BEFORE UPDATE OR DELETE ON queue_notes
FOR EACH ROW EXECUTE FUNCTION queue_reject_history_change();
INSERT INTO settings(key,value,value_type,category,description_ar) VALUES
 ('queue.intake_enabled','false'::jsonb,'boolean','queue','تفعيل استقبال طابور الرصد'),
 ('queue.intake_starts_at','null'::jsonb,'string','queue','بداية استقبال المنشورات الجديدة')
ON CONFLICT (key) DO NOTHING;
