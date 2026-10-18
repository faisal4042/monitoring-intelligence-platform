-- Rollback of 0048 Influencer card templates. PROPOSAL FOR REVIEW — NOT APPLIED ANYWHERE.
-- Apply only through apps/api/src/operator/apply-pending-migration.ts --rollback, after approval.
-- Refuses (and changes nothing) once any template, version, asset, export request or export event exists, or once any role or user
-- holds one of the new permissions: rolling back must never destroy work or silently revoke a grant.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM influencer_card_templates) OR EXISTS (SELECT 1 FROM influencer_card_template_versions)
     OR EXISTS (SELECT 1 FROM influencer_card_assets) OR EXISTS (SELECT 1 FROM influencer_card_exports)
     OR EXISTS (SELECT 1 FROM influencer_card_export_events) THEN
    RAISE EXCEPTION '0048 rollback refused: influencer card data exists' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM role_permissions WHERE permission_key LIKE 'influencer_card%')
     OR EXISTS (SELECT 1 FROM user_permissions WHERE permission_key LIKE 'influencer_card%') THEN
    RAISE EXCEPTION '0048 rollback refused: an influencer card permission is granted' USING ERRCODE = '55000';
  END IF;
END $$;

DROP TABLE influencer_card_export_events;
DROP TABLE influencer_card_exports;
ALTER TABLE influencer_card_templates DROP CONSTRAINT influencer_card_templates_published_fk;
DROP TABLE influencer_card_template_versions;
DROP TABLE influencer_card_templates;
DROP TABLE influencer_card_assets;
DROP FUNCTION influencer_card_export_event_check();
DROP FUNCTION influencer_card_version_sequence();
DROP FUNCTION influencer_card_reject_change();
DELETE FROM permissions WHERE key IN ('influencer_cards:export', 'influencer_card_templates:read', 'influencer_card_templates:manage');

COMMIT;
