-- Revalidate legacy embedding links against the new high-precision threshold
-- and top-1/top-2 margin. Topic centroids changed when humans approved
-- multi-post suggestions, so old scores cannot be trusted unchanged.
WITH ranked AS (
  SELECT c.post_id, c.posted_at, t.id AS topic_id,
         1 - (pe.embedding <=> t.centroid) AS similarity,
         row_number() OVER (
           PARTITION BY c.post_id, c.posted_at
           ORDER BY pe.embedding <=> t.centroid
         ) AS rank
  FROM post_classifications c
  JOIN post_embeddings pe ON pe.post_id = c.post_id AND pe.posted_at = c.posted_at
  JOIN topics t ON t.program_id = c.program_id AND t.is_active AND t.centroid IS NOT NULL
  WHERE c.stage = 2 AND c.topic_id IS NOT NULL
), scores AS (
  SELECT post_id, posted_at,
         max(similarity) FILTER (WHERE rank = 1) AS best_score,
         max(similarity) FILTER (WHERE rank = 2) AS runner_up_score,
         max(topic_id::text) FILTER (WHERE rank = 1) AS best_topic_id
  FROM ranked
  GROUP BY post_id, posted_at
)
UPDATE post_classifications c
SET topic_id = NULL
FROM scores s
WHERE c.post_id = s.post_id AND c.posted_at = s.posted_at
  AND (
    s.best_score < 0.84
    OR s.best_score - coalesce(s.runner_up_score, 0) < 0.05
    OR c.topic_id::text <> s.best_topic_id
  );

