BEGIN;

-- Reworded questions from the same author should inherit a topic when they are
-- both semantically and lexically close to a human-reviewed interaction.
CREATE TEMP TABLE inherited_topics ON COMMIT DROP AS
SELECT c.post_id, c.posted_at, nearest.topic_id,
       nearest.semantic_similarity, nearest.lexical_similarity
FROM post_classifications c
JOIN posts p ON p.id = c.post_id AND p.posted_at = c.posted_at
JOIN post_embeddings pe ON pe.post_id = p.id AND pe.posted_at = p.posted_at
CROSS JOIN LATERAL (
  SELECT c2.topic_id,
         1 - (pe.embedding <=> pe2.embedding) AS semantic_similarity,
         similarity(p.text_normalized, p2.text_normalized) AS lexical_similarity
  FROM post_classifications c2
  JOIN posts p2 ON p2.id = c2.post_id AND p2.posted_at = c2.posted_at
  JOIN post_embeddings pe2 ON pe2.post_id = p2.id AND pe2.posted_at = p2.posted_at
  JOIN topics t ON t.id = c2.topic_id AND t.is_active
  WHERE c2.human_corrected
    AND c2.relevance = 'relevant'
    AND c2.topic_id IS NOT NULL
    AND c2.program_id = c.program_id
    AND p2.x_author_id = p.x_author_id
    AND p2.id <> p.id
    AND 1 - (pe.embedding <=> pe2.embedding) >= 0.72
    AND similarity(p.text_normalized, p2.text_normalized) >= 0.45
  ORDER BY pe.embedding <=> pe2.embedding
  LIMIT 1
) nearest
WHERE c.relevance = 'relevant'
  AND c.topic_id IS NULL;

UPDATE post_classifications c
SET topic_id = i.topic_id,
    stage = 2,
    model = 'human_reviewed_near_duplicate'
FROM inherited_topics i
WHERE c.post_id = i.post_id AND c.posted_at = i.posted_at;

INSERT INTO audit_log (
  user_id, user_email, action, entity_type, entity_label,
  new_value, reason, severity
) VALUES (
  (SELECT id FROM users WHERE email = 'admin@mip.local' LIMIT 1),
  'admin@mip.local', 'classification.inherit_reviewed_topic', 'post_classification',
  'Human-reviewed near-duplicate topic inheritance',
  jsonb_build_object('postsLinked', (SELECT count(*) FROM inherited_topics)),
  'Link reworded interactions without lowering the global semantic threshold',
  'info'
);

COMMIT;
