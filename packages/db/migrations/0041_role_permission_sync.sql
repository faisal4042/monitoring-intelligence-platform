-- Role and permission sync for the RBAC + queue + workforce release, as SQL
-- instead of a seed run. Production never runs db:seed on start any more, and
-- the seed would also rewrite programs, keywords and settings; this file only
-- adds what the new code needs.
--
-- Additive only: INSERT ... ON CONFLICT DO NOTHING. No row is updated or
-- deleted, so a grant an administrator added by hand is never removed.
-- It brings role_permissions to the release's ROLE_PERMISSIONS
-- (packages/shared/src/permissions.ts) with one exception left for an explicit
-- decision: viewer:cost:read, granted by the previous code and dropped by the
-- new code, is not revoked here.

INSERT INTO permissions(key,domain,description_ar) VALUES
 ('queue:work','queue','العمل على التفاعلات المسندة'),
 ('queue:supervise','queue','الإشراف على طابور الفريق'),
 ('queue:view_all','queue','عرض طوابير جميع الفرق'),
 ('workforce:correct','queue','تصحيح سجلات حالات وساعات موظفي الرصد'),
 ('customers:read','customers','عرض سجل تفاعلات العميل'),
 ('users:read','admin','عرض المستخدمين'),
 ('users:assign_roles','admin','تعيين أدوار وصلاحيات المستخدمين — صلاحية حرجة')
ON CONFLICT (key) DO NOTHING;

INSERT INTO roles(key,name_ar,name_en,is_system)
VALUES ('agent','موظف رصد','Monitoring Agent',true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions(role_id,permission_key)
SELECT r.id,v.permission_key
FROM (VALUES
  ('admin','customers:read'),('admin','queue:supervise'),('admin','queue:view_all'),('admin','queue:work'),
  ('admin','users:assign_roles'),('admin','users:read'),('admin','workforce:correct'),
  ('agent','customers:read'),('agent','feedback:write'),('agent','news:read'),('agent','posts:read'),
  ('agent','programs:read'),('agent','queue:work'),('agent','topics:read'),
  ('analyst','customers:read'),
  ('supervisor','customers:read'),('supervisor','queue:supervise'),('supervisor','queue:work'),('supervisor','users:read')
) AS v(role_key,permission_key)
JOIN roles r ON r.key=v.role_key
ON CONFLICT DO NOTHING;
