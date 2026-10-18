-- Rollback of 0047 — ONLY while the new tables hold no data. NOT APPLIED TO mip.
-- Refuses (raises) if any ticket, message, event, template, export or schedule exists: data is never dropped silently.
-- Run through apply-pending-migration.ts --rollback (fenced; removes the ledger row in the same transaction).
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT (SELECT count(*) FROM tickets) + (SELECT count(*) FROM ticket_messages) + (SELECT count(*) FROM ticket_events)
       + (SELECT count(*) FROM conversations) + (SELECT count(*) FROM customer_identities)
       + (SELECT count(*) FROM report_templates) + (SELECT count(*) FROM report_exports) + (SELECT count(*) FROM report_schedules)
    INTO n;
  IF n > 0 THEN RAISE EXCEPTION '0047 rollback refused: % rows exist in ticket/report tables', n; END IF;
END $$;
DELETE FROM role_permissions WHERE permission_key IN ('tickets:read','tickets:read_all','tickets:work','tickets:assign','tickets:manage','reports:export','reports:manage_templates');
DELETE FROM user_permissions WHERE permission_key IN ('tickets:read','tickets:read_all','tickets:work','tickets:assign','tickets:manage','reports:export','reports:manage_templates');
DELETE FROM permissions WHERE key IN ('tickets:read','tickets:read_all','tickets:work','tickets:assign','tickets:manage','reports:export','reports:manage_templates');
DROP TABLE report_schedule_runs, report_schedules, report_export_downloads, report_exports, report_template_versions, report_templates;
DROP TABLE ticket_events, ticket_messages, tickets, conversations, customer_identities;
DROP FUNCTION ticket_reject_history_change();
DROP SEQUENCE ticket_number_seq;
COMMIT;
