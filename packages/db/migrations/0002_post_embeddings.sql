-- Stage 2 (docs/AI_PIPELINE.md §4, §7.4): per-post embedding vectors and the
-- similarity index that lets a new post be matched to a known topic centroid
-- with a single pgvector query instead of an LLM call.

CREATE TABLE IF NOT EXISTS post_embeddings (
  post_id    uuid NOT NULL,
  posted_at  timestamptz NOT NULL,
  embedding  vector(1024) NOT NULL,
  model      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, posted_at)
);

CREATE INDEX IF NOT EXISTS idx_post_embeddings_hnsw
  ON post_embeddings USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_topics_centroid_hnsw
  ON topics USING hnsw (centroid vector_cosine_ops)
  WHERE centroid IS NOT NULL;
