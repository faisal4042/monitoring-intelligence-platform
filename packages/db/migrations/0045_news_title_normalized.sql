-- Cursor safety: prepare exact normalizeArabic group identity (after migration 0044).
-- Nullable until an independently approved backfill is complete.
-- No index, NOT NULL constraint, or change to normalization rules.
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS title_normalized text COLLATE "C";
