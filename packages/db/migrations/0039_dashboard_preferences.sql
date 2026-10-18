-- Dashboard customisation: one saved layout per user and scope.
--
-- Additive only. A scope is either the all-programs view (program_id NULL)
-- or one program. The layout is presentation only (which sections show, in
-- what order, KPI order, default period); it never widens what a user may
-- see — every figure is still scoped by the API from the user's permissions.

CREATE TABLE IF NOT EXISTS dashboard_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  program_id uuid REFERENCES programs(id) ON DELETE CASCADE,
  layout jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(layout) = 'object'),
  CHECK (pg_column_size(layout) <= 16384)
);
CREATE UNIQUE INDEX IF NOT EXISTS dashboard_preferences_user_all
  ON dashboard_preferences(user_id) WHERE program_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS dashboard_preferences_user_program
  ON dashboard_preferences(user_id, program_id) WHERE program_id IS NOT NULL;
