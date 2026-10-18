-- 0051 Unified tickets: every monitored item (X post, story, news article, YouTube video, YouTube comment)
-- becomes a numbered ticket, and every open ticket is worked as exactly one queue card.
-- Pending migration: applied ONLY to the isolated unified clone by scripts/prepare-unified-tickets.mts.
-- Rollback: 0051_unified_tickets_rollback.sql (only before tickets/cards of the new kinds exist).
BEGIN;

-- ── Ticket numbers: a plain running number starting at 1 ────────────────────────────────
ALTER TABLE tickets DROP CONSTRAINT tickets_ticket_number_check;
UPDATE tickets SET ticket_number = regexp_replace(ticket_number, '^MIP-[0-9]{4}-0*', '') WHERE ticket_number LIKE 'MIP-%';
ALTER TABLE tickets ADD CONSTRAINT tickets_ticket_number_check CHECK (ticket_number ~ '^[1-9][0-9]*$');

-- ── New channels and the news provider ──────────────────────────────────────────────────
ALTER TABLE conversations DROP CONSTRAINT conversations_channel_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_channel_check CHECK (channel IN
  ('x_mention','x_reply','x_dm','x_story','facebook_comment','facebook_inbox','telegram','youtube_comment','youtube_video','news_article','email','other'));
ALTER TABLE customer_identities DROP CONSTRAINT customer_identities_provider_check;
ALTER TABLE customer_identities ADD CONSTRAINT customer_identities_provider_check CHECK (provider IN
  ('x','facebook','telegram','youtube','news','email','other'));
ALTER TABLE ticket_events DROP CONSTRAINT ticket_events_event_type_check;
ALTER TABLE ticket_events ADD CONSTRAINT ticket_events_event_type_check CHECK (event_type IN
  ('created','message_attached','late_message','assigned','reassigned','unassigned','started','replied','on_hold','resumed',
   'escalated','deescalated','resolved','closed','admin_correction','priority_changed','review_flagged','review_cleared','reopened'));

-- ── Queue cards for news and YouTube ────────────────────────────────────────────────────
-- source_ref: the item's own id (news article id, YouTube video row id, YouTube comment id).
-- source_snapshot: what the card shows (title, link, source…), kept even if retention removes the source.
ALTER TABLE queue_items ADD COLUMN source_ref text, ADD COLUMN source_snapshot jsonb;
ALTER TABLE queue_items DROP CONSTRAINT queue_items_interaction_type_check;
ALTER TABLE queue_items ADD CONSTRAINT queue_items_interaction_type_check CHECK (interaction_type IN ('post','story','news','youtube_video','youtube_comment'));
ALTER TABLE queue_items DROP CONSTRAINT queue_items_shape;
ALTER TABLE queue_items ADD CONSTRAINT queue_items_shape CHECK (
  (interaction_type = 'post' AND post_id IS NOT NULL AND post_posted_at IS NOT NULL AND story_id IS NULL AND story_snapshot IS NULL
    AND merged_into_id IS NULL AND (section = 'story') = (story_item_id IS NOT NULL) AND source_ref IS NULL)
  OR (interaction_type = 'story' AND post_id IS NULL AND post_posted_at IS NULL AND story_id IS NOT NULL AND story_snapshot IS NOT NULL
    AND story_item_id IS NULL AND section = 'story' AND source_ref IS NULL)
  OR (interaction_type IN ('news','youtube_video','youtube_comment') AND post_id IS NULL AND post_posted_at IS NULL AND story_id IS NULL
    AND story_snapshot IS NULL AND story_item_id IS NULL AND merged_into_id IS NULL AND section = 'general'
    AND source_ref IS NOT NULL AND source_snapshot IS NOT NULL));
CREATE UNIQUE INDEX queue_items_source_unique ON queue_items (interaction_type, source_ref) WHERE source_ref IS NOT NULL;

-- ── Ticket ↔ card: a ticket is worked on exactly one card ───────────────────────────────
CREATE TABLE queue_item_tickets (
  ticket_id     uuid PRIMARY KEY REFERENCES tickets(id),
  queue_item_id uuid NOT NULL REFERENCES queue_items(id),
  linked_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX queue_item_tickets_item ON queue_item_tickets (queue_item_id);

-- ── The card drives the ticket ──────────────────────────────────────────────────────────
-- Whatever changes a card (agent action, supervisor, automatic assignment, reopen), its tickets follow in the
-- same transaction: new → open, assigned/in_progress/escalated → same with the card's assignee, completed → closed.
CREATE FUNCTION mip_queue_ticket_sync(p_item uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  q queue_items;
  t tickets;
  target text;
  ev text;
BEGIN
  SELECT * INTO q FROM queue_items WHERE id = p_item;
  IF NOT FOUND THEN RETURN; END IF;
  target := CASE q.status WHEN 'new' THEN 'open' WHEN 'assigned' THEN 'assigned' WHEN 'in_progress' THEN 'in_progress'
                          WHEN 'escalated' THEN 'escalated' ELSE 'closed' END;
  FOR t IN SELECT tk.* FROM queue_item_tickets l JOIN tickets tk ON tk.id = l.ticket_id
           WHERE l.queue_item_id = p_item ORDER BY tk.opened_at FOR UPDATE OF tk LOOP
    IF t.status = target AND t.assignee_id IS NOT DISTINCT FROM (CASE WHEN target = 'open' THEN NULL ELSE q.assignee_id END)
       AND (target <> 'closed' OR t.closed_at IS NOT NULL) THEN
      CONTINUE;
    END IF;
    -- Reopening a closed ticket whose conversation already has another active ticket would break
    -- "one active ticket per conversation": flag it for review instead of guessing.
    IF t.status = 'closed' AND target <> 'closed' AND EXISTS (
         SELECT 1 FROM tickets o WHERE o.conversation_id = t.conversation_id AND o.status <> 'closed' AND o.id <> t.id) THEN
      UPDATE tickets SET needs_review = true, review_reason = 'queue_reopen_conflict', version = version + 1 WHERE id = t.id;
      INSERT INTO ticket_events (ticket_id, version, event_type, from_status, to_status, actor_kind, correlation_id, payload)
      VALUES (t.id, t.version + 1, 'review_flagged', t.status, t.status, 'system', 'queue:' || q.id,
              jsonb_build_object('source', 'queue', 'queueItemId', q.id, 'reason', 'queue_reopen_conflict'));
      CONTINUE;
    END IF;
    ev := CASE WHEN target = 'closed' THEN 'closed'
               WHEN t.status = 'closed' THEN 'reopened'
               WHEN target = 'open' THEN 'unassigned'
               WHEN target = 'escalated' THEN 'escalated'
               WHEN t.assignee_id IS NULL THEN 'assigned'
               WHEN t.assignee_id IS DISTINCT FROM q.assignee_id THEN 'reassigned'
               ELSE 'started' END;
    UPDATE tickets SET
      status = target,
      assignee_id = CASE WHEN target = 'open' THEN NULL ELSE q.assignee_id END,
      version = version + 1,
      first_assigned_at = CASE WHEN target <> 'open' AND q.assignee_id IS NOT NULL THEN coalesce(first_assigned_at, now()) ELSE first_assigned_at END,
      last_assigned_at = CASE WHEN q.assignee_id IS NOT NULL AND q.assignee_id IS DISTINCT FROM t.assignee_id THEN now() ELSE last_assigned_at END,
      reassignment_count = reassignment_count + CASE WHEN ev = 'reassigned' THEN 1 ELSE 0 END,
      escalation_count = escalation_count + CASE WHEN ev = 'escalated' THEN 1 ELSE 0 END,
      resolved_at = CASE WHEN target = 'closed' THEN coalesce(resolved_at, q.completed_at, now()) ELSE NULL END,
      closed_at = CASE WHEN target = 'closed' THEN coalesce(q.completed_at, now()) ELSE NULL END,
      closed_by = CASE WHEN target = 'closed' THEN q.completed_by ELSE NULL END,
      close_reason = CASE WHEN target = 'closed' THEN q.resolution ELSE NULL END,
      last_activity_at = greatest(last_activity_at, now())
    WHERE id = t.id;
    INSERT INTO ticket_events (ticket_id, version, event_type, from_status, to_status, actor_kind, assignee_id, reason, correlation_id, payload)
    VALUES (t.id, t.version + 1, ev, t.status, target, 'system', q.assignee_id,
            CASE WHEN ev = 'escalated' THEN 'تصعيد من طابور الرصد' END, 'queue:' || q.id,
            jsonb_build_object('source', 'queue', 'queueItemId', q.id, 'queueStatus', q.status,
                               'completedBy', q.completed_by, 'resolution', q.resolution));
  END LOOP;
END $$;

CREATE FUNCTION mip_queue_ticket_sync_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM mip_queue_ticket_sync(NEW.id); RETURN NULL; END $$;
CREATE FUNCTION mip_queue_ticket_sync_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM mip_queue_ticket_sync(NEW.queue_item_id); RETURN NULL; END $$;

CREATE TRIGGER queue_ticket_sync AFTER UPDATE OF status, assignee_id ON queue_items
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.assignee_id IS DISTINCT FROM NEW.assignee_id)
  EXECUTE FUNCTION mip_queue_ticket_sync_item();
CREATE TRIGGER queue_ticket_link_sync AFTER INSERT ON queue_item_tickets
  FOR EACH ROW EXECUTE FUNCTION mip_queue_ticket_sync_link();

COMMIT;
