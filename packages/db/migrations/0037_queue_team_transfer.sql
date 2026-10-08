-- Cross-team transfer of a queue item (supervisor/admin action).
--
-- Additive: the event-type CHECK is widened by one value, 'transferred'.
-- The transfer itself is an UPDATE of team/assignee plus one event whose
-- metadata keeps the source and target teams; from_assignee/to_assignee
-- keep the previous and new assignee. No existing row is touched here.

ALTER TABLE queue_events DROP CONSTRAINT IF EXISTS queue_events_event_type_check;
DO $$ BEGIN
  ALTER TABLE queue_events ADD CONSTRAINT queue_events_event_type_check CHECK (event_type IN (
    'created','assigned','reassigned','unassigned','started','escalated','deescalated',
    'completed','reopened','note_added','section_changed','section_review','story_merged','transferred'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
