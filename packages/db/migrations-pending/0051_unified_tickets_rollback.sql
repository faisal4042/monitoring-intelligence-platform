-- Rollback of 0051. Safe only before tickets/cards of the new kinds exist; otherwise restore the pre-0051 backup
-- (%LOCALAPPDATA%\MIPUnifiedIsolated\backups\pre-0051-unified-tickets-20261017.dump).
BEGIN;
DROP TRIGGER IF EXISTS queue_ticket_link_sync ON queue_item_tickets;
DROP TRIGGER IF EXISTS queue_ticket_sync ON queue_items;
DROP FUNCTION IF EXISTS mip_queue_ticket_sync_link();
DROP FUNCTION IF EXISTS mip_queue_ticket_sync_item();
DROP FUNCTION IF EXISTS mip_queue_ticket_sync(uuid);
DROP TABLE IF EXISTS queue_item_tickets;
DROP INDEX IF EXISTS queue_items_source_unique;
ALTER TABLE queue_items DROP CONSTRAINT queue_items_shape;
ALTER TABLE queue_items ADD CONSTRAINT queue_items_shape CHECK (
  (interaction_type = 'post' AND post_id IS NOT NULL AND post_posted_at IS NOT NULL AND story_id IS NULL AND story_snapshot IS NULL
    AND merged_into_id IS NULL AND (section = 'story') = (story_item_id IS NOT NULL))
  OR (interaction_type = 'story' AND post_id IS NULL AND post_posted_at IS NULL AND story_id IS NOT NULL AND story_snapshot IS NOT NULL
    AND story_item_id IS NULL AND section = 'story'));
ALTER TABLE queue_items DROP CONSTRAINT queue_items_interaction_type_check;
ALTER TABLE queue_items ADD CONSTRAINT queue_items_interaction_type_check CHECK (interaction_type IN ('post','story'));
ALTER TABLE queue_items DROP COLUMN source_ref, DROP COLUMN source_snapshot;
ALTER TABLE ticket_events DROP CONSTRAINT ticket_events_event_type_check;
ALTER TABLE ticket_events ADD CONSTRAINT ticket_events_event_type_check CHECK (event_type IN
  ('created','message_attached','late_message','assigned','reassigned','unassigned','started','replied','on_hold','resumed',
   'escalated','deescalated','resolved','closed','admin_correction','priority_changed','review_flagged','review_cleared'));
ALTER TABLE customer_identities DROP CONSTRAINT customer_identities_provider_check;
ALTER TABLE customer_identities ADD CONSTRAINT customer_identities_provider_check CHECK (provider IN ('x','facebook','telegram','youtube','email','other'));
ALTER TABLE conversations DROP CONSTRAINT conversations_channel_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_channel_check CHECK (channel IN
  ('x_mention','x_reply','x_dm','facebook_comment','facebook_inbox','telegram','youtube_comment','email','other'));
ALTER TABLE tickets DROP CONSTRAINT tickets_ticket_number_check;
UPDATE tickets SET ticket_number = 'MIP-' || to_char(opened_at AT TIME ZONE 'Asia/Riyadh', 'YYYY') || '-' || lpad(ticket_number, 6, '0');
ALTER TABLE tickets ADD CONSTRAINT tickets_ticket_number_check CHECK (ticket_number ~ '^MIP-[0-9]{4}-[0-9]{6,}$');
COMMIT;
