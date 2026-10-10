-- News article extraction (Scrapling engine).
--
-- Additive only. No existing row is updated: the new news_sources column
-- defaults to 'off', which keeps every source on today's feed-only pipeline
-- until an administrator opts it in. Extracted text lives in its own table so
-- news_articles (and everything classified from it) is never rewritten by an
-- extraction or a re-extraction.
--
--   mode = 'live'   : the engine runs for this article; missing published_at /
--                     author / image / language on the article may be filled
--                     from the page (never overwritten).
--   mode = 'shadow' : measured side by side with the current pipeline; nothing
--                     is written to news_articles.

ALTER TABLE news_sources ADD COLUMN IF NOT EXISTS extraction_mode text NOT NULL DEFAULT 'off';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'news_sources_extraction_mode_check') THEN
    ALTER TABLE news_sources ADD CONSTRAINT news_sources_extraction_mode_check
      CHECK (extraction_mode IN ('off', 'shadow', 'static', 'dynamic'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS news_article_extractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode text NOT NULL CHECK (mode IN ('live', 'shadow')),
  source_id uuid NOT NULL REFERENCES news_sources(id) ON DELETE CASCADE,
  article_id uuid REFERENCES news_articles(id) ON DELETE SET NULL,
  -- Same key as news_articles.url_hash (hash of the canonicalised discovery URL).
  url text NOT NULL,
  url_hash text NOT NULL,
  canonical_url text,
  canonical_hash text,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'partial', 'empty', 'failed', 'skipped', 'duplicate', 'dead')),
  method text CHECK (method IN ('rss', 'static', 'dynamic', 'none')),
  reason text,
  error_kind text,
  http_status integer,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  locked_until timestamptz,
  title text,
  summary text,
  content text,
  content_hash text,
  simhash bigint,
  char_count integer NOT NULL DEFAULT 0 CHECK (char_count >= 0),
  word_count integer NOT NULL DEFAULT 0 CHECK (word_count >= 0),
  language text,
  published_at timestamptz,
  modified_at timestamptz,
  authors text[] NOT NULL DEFAULT '{}',
  image_url text,
  categories text[] NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  duplicate_of uuid REFERENCES news_articles(id) ON DELETE SET NULL,
  fetch_ms integer,
  extract_ms integer,
  dynamic_used boolean NOT NULL DEFAULT false,
  correlation_id text,
  extractor_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One live and one shadow record per article URL: re-discovery, retries and
-- concurrent workers upsert the same row instead of adding another.
CREATE UNIQUE INDEX IF NOT EXISTS news_article_extractions_url_mode ON news_article_extractions(url_hash, mode);
CREATE INDEX IF NOT EXISTS news_article_extractions_queue ON news_article_extractions(next_attempt_at)
  WHERE status IN ('pending', 'failed', 'running');
CREATE INDEX IF NOT EXISTS news_article_extractions_source_time ON news_article_extractions(source_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS news_article_extractions_canonical ON news_article_extractions(canonical_hash) WHERE canonical_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS news_article_extractions_content ON news_article_extractions(content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS news_article_extractions_article ON news_article_extractions(article_id) WHERE article_id IS NOT NULL;
