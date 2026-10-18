-- Preserve historical accounts while reserving emails only for visible accounts.
-- Authentication and user administration already exclude deleted_at IS NOT NULL.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE UNIQUE INDEX IF NOT EXISTS users_visible_email_key
  ON users (email) WHERE deleted_at IS NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
COMMIT;
