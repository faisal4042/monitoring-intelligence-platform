BEGIN;

-- Per-query daily and monthly limits are intentionally disabled. Cost controls
-- remain available at the platform and program levels only.
UPDATE queries
SET daily_unit_cap = NULL,
    updated_at = now()
WHERE daily_unit_cap IS NOT NULL;

UPDATE api_budgets
SET is_active = false,
    updated_at = now()
WHERE scope = 'query'
  AND is_active = true;

INSERT INTO audit_log (
  user_id, user_email, action, entity_type, entity_label,
  new_value, reason, severity
) VALUES (
  (SELECT id FROM users WHERE email = 'admin@mip.local' LIMIT 1),
  'admin@mip.local', 'budget.remove_query_limits', 'query',
  'Remove daily and monthly per-query limits',
  jsonb_build_object('dailyUnitCap', NULL, 'queryBudgetsActive', false),
  'Operator requested that queries must not have daily or monthly limits',
  'warning'
);

COMMIT;
