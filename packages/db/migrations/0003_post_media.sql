-- Post media (docs/X_API_STRATEGY.md §7.3 revisited 2026-08-28): X's photo/video
-- URL for a post arrives free within the same search response via
-- expansions=attachments.media_keys — no separate X request per image, ever.
-- Stored once at collection time; the UI reads this table, never X, when a
-- card is opened.

CREATE TABLE IF NOT EXISTS post_media (
  media_key         text NOT NULL,
  post_id           uuid NOT NULL,
  posted_at         timestamptz NOT NULL,
  type              text NOT NULL,
  url               text,
  preview_image_url text,
  width             integer,
  height            integer,
  fetched_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (media_key, post_id, posted_at)
);

CREATE INDEX IF NOT EXISTS idx_post_media_post ON post_media (post_id, posted_at);
