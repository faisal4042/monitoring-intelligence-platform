-- User management foundation (RBAC phase).
--
-- Additive only: five nullable/defaulted columns on users. No existing row is
-- updated — every current user keeps its id, role, status and password, and
-- gets must_change_password = false. ADD COLUMN with a constant default is a
-- catalogue-only change in PostgreSQL 11+, so the table is not rewritten.
--
-- The new role (agent) and permissions (customers:read, users:read,
-- users:assign_roles) are definitions, inserted by the seed like every
-- other role and permission.

ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
-- Access tokens issued before this instant are rejected (see plugins/auth.ts).
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_by uuid REFERENCES users(id);
