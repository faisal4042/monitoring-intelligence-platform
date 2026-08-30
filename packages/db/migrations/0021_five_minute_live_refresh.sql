-- Keep every active X query and news/web source on the requested five-minute live cadence.
ALTER TABLE queries ALTER COLUMN poll_interval_minutes SET DEFAULT 5;
UPDATE queries
SET poll_interval_minutes = 5,
    next_run_at = LEAST(COALESCE(next_run_at, now()), now() + interval '5 minutes'),
    updated_at = now()
WHERE status = 'active' AND NOT is_paused AND deleted_at IS NULL;

ALTER TABLE news_sources ALTER COLUMN check_interval_minutes SET DEFAULT 5;
UPDATE news_sources
SET check_interval_minutes = 5,
    next_run_at = LEAST(COALESCE(next_run_at, now()), now() + interval '5 minutes'),
    updated_at = now()
WHERE is_active;
