-- Queue work cycles: in-progress reassignment and reopen.
--
-- Additive only — three columns, no existing row is updated or deleted.
--
-- started_at       when the CURRENT work cycle began (start, or reopen). It is
--                  cleared when the item is reassigned or unassigned, so the
--                  next assignee's handling time starts from their own Start
--                  and never inherits the previous assignee's time.
--                  first_started_at keeps the first start of the item's life.
-- reopen_count,    a reopened item is open again: completed_at, completed_by
-- last_reopened_at and resolution are cleared on reopen, so a past close is
--                  never read as the current one. Every past close stays in
--                  queue_events (event_type 'completed': actor, resolution,
--                  created_at), which is the source for per-cycle metrics.

ALTER TABLE queue_items ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE queue_items ADD COLUMN IF NOT EXISTS reopen_count integer NOT NULL DEFAULT 0;
ALTER TABLE queue_items ADD COLUMN IF NOT EXISTS last_reopened_at timestamptz;

DO $$ BEGIN
  ALTER TABLE queue_items ADD CONSTRAINT queue_items_reopen_count_nonneg CHECK (reopen_count >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
