-- Closing a card whose AI classification is "not relevant" with «التصنيفات صحيحة»
-- (outcome 'confirmed', relevant = false) is allowed by the API (reviews.ts and
-- its tests) but 0038 required outcome = 'irrelevant' <=> NOT relevant, so the
-- insert failed and the close returned a 500. Ticket cards reach the queue
-- whatever the AI relevance, so this happens in production.
-- New rule: 'irrelevant' still means not relevant; a not-relevant review is
-- either 'irrelevant' (reviewer's decision) or 'confirmed' (AI value approved).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'queue_reviews'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) = 'CHECK (((outcome = ''irrelevant''::text) = (NOT relevant)))'
  LOOP
    EXECUTE format('ALTER TABLE queue_reviews DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE queue_reviews DROP CONSTRAINT IF EXISTS queue_reviews_relevance_outcome_check;
ALTER TABLE queue_reviews ADD CONSTRAINT queue_reviews_relevance_outcome_check
  CHECK ((outcome <> 'irrelevant' OR NOT relevant) AND (relevant OR outcome IN ('irrelevant', 'confirmed')));
COMMIT;
