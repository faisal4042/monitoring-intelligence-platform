BEGIN;

ALTER TABLE queries
  DROP COLUMN IF EXISTS daily_unit_cap;

INSERT INTO audit_log (
  user_id, user_email, action, entity_type, entity_label,
  reason, severity
) VALUES (
  (SELECT id FROM users WHERE email = 'admin@mip.local' LIMIT 1),
  'admin@mip.local', 'schema.drop_query_limit', 'query',
  'Drop per-query daily limit field',
  'Per-query limits are disabled by operator policy',
  'info'
);

COMMIT;
