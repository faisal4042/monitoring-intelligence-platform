-- Monitoring review: the record an agent leaves when closing a queue item.
--
-- Closing means "monitoring review completed", not "customer inquiry
-- resolved": the outcome describes the review, never the customer's case.
--
-- Additive. The AI prediction in post_classifications / post_sentiments is
-- never changed by a review: each review stores a snapshot of what the AI
-- said at that moment next to what the reviewer approved, so model quality
-- can be measured later. One row per completed review cycle (an item reopened
-- and closed again has several rows); rows are append-only like queue events.

CREATE TABLE IF NOT EXISTS queue_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_item_id uuid NOT NULL REFERENCES queue_items(id),
  -- The 'completed' event this review closed with.
  queue_event_id uuid NOT NULL UNIQUE REFERENCES queue_events(id),
  cycle integer NOT NULL CHECK (cycle > 0),
  reviewer_id uuid NOT NULL REFERENCES users(id),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL CHECK (outcome IN ('confirmed','corrected','irrelevant','no_action')),
  -- What the AI said when the review was saved (program, intent, sentiment,
  -- relevance, topics, confidences, model; or the story's own fields).
  ai jsonb NOT NULL,
  -- What the reviewer approved. NULL means "not available" (the AI had no
  -- value and the reviewer supplied none), never an invented value.
  program_id uuid REFERENCES programs(id),
  intent text,
  sentiment text,
  relevant boolean NOT NULL,
  topic_id uuid REFERENCES topics(id),
  subtopic_id uuid REFERENCES topics(id),
  links_confirmed boolean,
  -- Fields whose approved value differs from the AI value; empty = AI confirmed.
  corrected_fields text[] NOT NULL DEFAULT '{}',
  reason text,
  -- Timings of the cycle, copied from the item at closure (server clock).
  entered_at timestamptz NOT NULL,
  assigned_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz NOT NULL,
  UNIQUE (queue_item_id, cycle),
  CHECK (intent IS NULL OR intent IN ('complaint','inquiry','suggestion','praise','news','experience','warning','issue','request','other')),
  CHECK (sentiment IS NULL OR sentiment IN ('very_positive','positive','neutral','negative','very_negative')),
  CHECK (subtopic_id IS NULL OR topic_id IS NOT NULL),
  -- A correction or an exclusion must say why; the outcome must match the values.
  CHECK ((cardinality(corrected_fields) = 0 AND outcome <> 'irrelevant') OR length(trim(coalesce(reason,''))) > 0),
  CHECK (outcome <> 'confirmed' OR cardinality(corrected_fields) = 0),
  CHECK (outcome <> 'corrected' OR cardinality(corrected_fields) > 0),
  CHECK ((outcome = 'irrelevant') = (NOT relevant))
);
CREATE INDEX IF NOT EXISTS queue_reviews_reviewer_time ON queue_reviews(reviewer_id, reviewed_at);
CREATE INDEX IF NOT EXISTS queue_reviews_time ON queue_reviews(reviewed_at);
CREATE INDEX IF NOT EXISTS queue_reviews_item ON queue_reviews(queue_item_id, cycle);

DROP TRIGGER IF EXISTS queue_reviews_append_only ON queue_reviews;
CREATE TRIGGER queue_reviews_append_only BEFORE UPDATE OR DELETE ON queue_reviews
FOR EACH ROW EXECUTE FUNCTION queue_reject_history_change();

-- A reopened influencer/story item handed back to someone is its own alert
-- kind — never a second "arrival".
ALTER TABLE queue_alerts DROP CONSTRAINT IF EXISTS queue_alerts_kind_check;
DO $$ BEGIN
  ALTER TABLE queue_alerts ADD CONSTRAINT queue_alerts_kind_check CHECK (kind IN ('influencer','story','assigned','reopened'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Off by default: agents may take unassigned items of their own team only
-- once an administrator enables it. The waiting-time colour is a visual cue,
-- not an SLA.
INSERT INTO settings(key,value,value_type,category,description_ar) VALUES
 ('queue.self_claim_enabled','false'::jsonb,'boolean','queue','السماح لموظف الرصد باستلام العناصر غير المسندة في فريقه'),
 ('queue.wait_warning_minutes','60'::jsonb,'number','queue','تلوين مؤقت الانتظار بعد هذا العدد من الدقائق (تنبيه بصري وليس اتفاقية مستوى خدمة)')
ON CONFLICT (key) DO NOTHING;
