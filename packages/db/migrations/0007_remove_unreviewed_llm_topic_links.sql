-- A language-model verdict is a suggestion, not published truth. Keep its
-- audit/model fields, but remove any legacy topic link that was never human
-- confirmed so it returns to the review/unclassified queue.
UPDATE post_classifications
SET topic_id = NULL
WHERE stage = 3
  AND NOT human_corrected
  AND topic_id IS NOT NULL
  AND coalesce(model, '') NOT IN ('human_approved', 'human_merged', 'human_feedback');

