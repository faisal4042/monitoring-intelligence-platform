-- High-precision topic workflow: models may suggest, but only a human-approved
-- topic is allowed into the production taxonomy. A suggestion needs several
-- supporting interactions before it is eligible for approval.

CREATE TABLE IF NOT EXISTS topic_suggestions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id      uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  service_id      uuid REFERENCES services(id) ON DELETE SET NULL,
  name_ar         text NOT NULL,
  description     text,
  centroid        vector(1024) NOT NULL,
  support_count   integer NOT NULL DEFAULT 1 CHECK (support_count >= 1),
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','merged','rejected')),
  source_model    text,
  legacy_topic_id uuid UNIQUE REFERENCES topics(id) ON DELETE SET NULL,
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz,
  review_note     text,
  approved_topic_id uuid REFERENCES topics(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS topic_suggestion_members (
  suggestion_id uuid NOT NULL REFERENCES topic_suggestions(id) ON DELETE CASCADE,
  post_id       uuid NOT NULL,
  posted_at     timestamptz NOT NULL,
  similarity    numeric(5,4),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (suggestion_id, post_id, posted_at)
);

CREATE INDEX IF NOT EXISTS idx_topic_suggestions_status
  ON topic_suggestions (status, program_id, support_count DESC);
CREATE INDEX IF NOT EXISTS idx_topic_suggestions_centroid_hnsw
  ON topic_suggestions USING hnsw (centroid vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_topic_suggestion_members_post
  ON topic_suggestion_members (post_id, posted_at);

-- Preserve legacy auto-created topics as reviewable suggestions. Nothing is
-- deleted: the old topic row remains archived and can still be audited.
INSERT INTO topic_suggestions (
  program_id, service_id, name_ar, description, centroid, support_count,
  status, source_model, legacy_topic_id, created_at, updated_at
)
SELECT t.program_id, t.service_id, t.name_ar, t.description, t.centroid,
       greatest(1, count(c.post_id)::int), 'pending', 'legacy_llm_auto', t.id,
       t.created_at, now()
FROM topics t
LEFT JOIN post_classifications c ON c.topic_id = t.id
WHERE t.source = 'llm_auto' AND t.centroid IS NOT NULL
GROUP BY t.id
ON CONFLICT (legacy_topic_id) DO NOTHING;

INSERT INTO topic_suggestion_members (suggestion_id, post_id, posted_at, similarity)
SELECT s.id, c.post_id, c.posted_at,
       CASE WHEN pe.embedding IS NULL THEN NULL
            ELSE 1 - (pe.embedding <=> s.centroid) END
FROM topic_suggestions s
JOIN post_classifications c ON c.topic_id = s.legacy_topic_id
LEFT JOIN post_embeddings pe ON pe.post_id = c.post_id AND pe.posted_at = c.posted_at
WHERE s.legacy_topic_id IS NOT NULL
ON CONFLICT DO NOTHING;

UPDATE post_classifications c
SET topic_id = NULL
FROM topics t
WHERE c.topic_id = t.id AND t.source = 'llm_auto';

UPDATE topics
SET is_active = false, updated_at = now()
WHERE source = 'llm_auto' AND is_active;

