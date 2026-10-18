-- 0052 Unified tickets: one card per ticket. When two older post cards belong to the same X conversation ticket,
-- the extra card is merged into the ticket's card (merged_into_id), as story merges already do.
-- Pending migration: applied ONLY to the isolated unified clone (scripts/prepare-unified-tickets.mts).
BEGIN;
ALTER TABLE queue_items DROP CONSTRAINT queue_items_shape;
ALTER TABLE queue_items ADD CONSTRAINT queue_items_shape CHECK (
  (interaction_type = 'post' AND post_id IS NOT NULL AND post_posted_at IS NOT NULL AND story_id IS NULL AND story_snapshot IS NULL
    AND (section = 'story') = (story_item_id IS NOT NULL) AND source_ref IS NULL)
  OR (interaction_type = 'story' AND post_id IS NULL AND post_posted_at IS NULL AND story_id IS NOT NULL AND story_snapshot IS NOT NULL
    AND story_item_id IS NULL AND section = 'story' AND source_ref IS NULL)
  OR (interaction_type IN ('news','youtube_video','youtube_comment') AND post_id IS NULL AND post_posted_at IS NULL AND story_id IS NULL
    AND story_snapshot IS NULL AND story_item_id IS NULL AND merged_into_id IS NULL AND section = 'general'
    AND source_ref IS NOT NULL AND source_snapshot IS NOT NULL));
ALTER TABLE queue_events DROP CONSTRAINT queue_events_event_type_check;
ALTER TABLE queue_events ADD CONSTRAINT queue_events_event_type_check CHECK (event_type IN
  ('created','assigned','reassigned','unassigned','started','escalated','deescalated','completed','reopened','note_added',
   'section_changed','section_review','story_merged','transferred','priority_changed','ticket_merged'));
-- Moving a ticket to another card keeps it in step with that card.
CREATE TRIGGER queue_ticket_relink_sync AFTER UPDATE OF queue_item_id ON queue_item_tickets
  FOR EACH ROW EXECUTE FUNCTION mip_queue_ticket_sync_link();
COMMIT;
