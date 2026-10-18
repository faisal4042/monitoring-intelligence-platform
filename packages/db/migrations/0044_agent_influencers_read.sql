-- Monitoring agents may read the tracked influencers (2026-10-10).
--
-- Grants influencers:read to the agent role, matching ROLE_PERMISSIONS in
-- packages/shared/src/permissions.ts. Read only: influencers:write is not
-- granted. Additive and idempotent (ON CONFLICT DO NOTHING); no other role,
-- user or permission row is touched, and a database that has already been
-- seeded with the new code is left unchanged.
--
-- To undo:
--   DELETE FROM role_permissions
--   WHERE permission_key = 'influencers:read'
--     AND role_id = (SELECT id FROM roles WHERE key = 'agent');

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'influencers:read'
FROM roles r
JOIN permissions p ON p.key = 'influencers:read'
WHERE r.key = 'agent'
ON CONFLICT DO NOTHING;
