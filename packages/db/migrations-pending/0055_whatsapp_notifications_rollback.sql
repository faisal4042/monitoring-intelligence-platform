-- Rollback of 0055 WhatsApp notification channel. PROPOSAL FOR REVIEW — NOT APPLIED ANYWHERE.
-- Apply only through apps/api/src/operator/apply-pending-migration.ts --rollback, after approval.
-- Refuses (and changes nothing) once any message or recipient exists, or once any role or user holds one of
-- the new permissions: rolling back must never destroy delivery history or silently revoke a grant.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM whatsapp_messages) OR EXISTS (SELECT 1 FROM whatsapp_recipients) THEN
    RAISE EXCEPTION '0055 rollback refused: WhatsApp messages or recipients exist' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM role_permissions WHERE permission_key LIKE 'whatsapp:%')
     OR EXISTS (SELECT 1 FROM user_permissions WHERE permission_key LIKE 'whatsapp:%') THEN
    RAISE EXCEPTION '0055 rollback refused: a WhatsApp permission is granted' USING ERRCODE = '55000';
  END IF;
END $$;

DROP TABLE whatsapp_source_cursors;
DROP TABLE whatsapp_status_events;
DROP TABLE whatsapp_message_attempts;
DROP TABLE whatsapp_messages;
DROP TABLE whatsapp_events;
DROP TABLE whatsapp_routes;
DROP TABLE whatsapp_recipient_subscriptions;
DROP TABLE whatsapp_recipients;
DROP TABLE whatsapp_event_settings;
DROP TABLE whatsapp_templates;
DROP TABLE whatsapp_settings;
DELETE FROM permissions WHERE key LIKE 'whatsapp:%';

COMMIT;
