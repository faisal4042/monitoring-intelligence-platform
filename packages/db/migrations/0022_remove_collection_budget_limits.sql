-- The operator requested continuous collection without hourly, daily, monthly,
-- program, or query limits. Keep historical budgets for audit, but deactivate
-- them so reporting remains available without blocking collection.
UPDATE api_budgets
SET is_active = false, updated_at = now()
WHERE is_active;

INSERT INTO audit_log (action, entity_type, entity_label, new_value, reason)
VALUES (
  'budget.collection_limits_removed',
  'api_budget',
  'All collection budgets',
  jsonb_build_object('hardLimitsActive', false, 'usageTrackingActive', true),
  'Operator requested live collection without hourly, daily, monthly, program, or per-query limits'
);
