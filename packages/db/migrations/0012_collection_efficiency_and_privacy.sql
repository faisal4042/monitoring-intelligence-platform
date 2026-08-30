BEGIN;

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS contains_pii boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_posts_contains_pii
  ON posts (contains_pii)
  WHERE contains_pii = true;

-- Flag historical content that may contain common Saudi personal identifiers.
-- Display and external-AI paths perform the actual masking in the application.
UPDATE posts
SET contains_pii = true
WHERE text ~* '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}'
   OR text ~* '(\+?966|00966|0)[ -]?5[0-9][ -]?[0-9]{3}[ -]?[0-9]{4}'
   OR text ~* '\m[12][0-9]{9}\M'
   OR text ~* '\mSA[0-9]{2}[A-Z0-9]{18}\M';

-- Give every active query a firm daily ceiling. Automatic dictionary queries
-- use the lower ceiling and a slower baseline because empty polling is costly.
UPDATE queries
SET daily_unit_cap = 25,
    updated_at = now()
WHERE status = 'active'
  AND daily_unit_cap IS NULL;

UPDATE queries
SET daily_unit_cap = 15,
    poll_interval_minutes = GREATEST(poll_interval_minutes, 30),
    next_run_at = GREATEST(
      COALESCE(next_run_at, now()),
      now() + interval '30 minutes'
    ),
    updated_at = now()
WHERE description LIKE '[system:auto-%';

INSERT INTO audit_log (
  user_id, user_email, action, entity_type, entity_label,
  new_value, reason, severity
) VALUES (
  (SELECT id FROM users WHERE email = 'admin@mip.local' LIMIT 1),
  'admin@mip.local', 'platform.collection_efficiency_privacy', 'platform',
  'Collection efficiency and privacy safeguards',
  jsonb_build_object(
    'automaticQueryDailyCap', 15,
    'automaticQueryMinimumIntervalMinutes', 30,
    'historicalPostsFlaggedForPii', (SELECT count(*) FROM posts WHERE contains_pii)
  ),
  'Reduce unnecessary X API usage and prevent personal data exposure in display and external AI paths',
  'info'
);

COMMIT;
