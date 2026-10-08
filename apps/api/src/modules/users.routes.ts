/**
 * User management. Three separate permissions:
 *   users:read          list users and roles
 *   users:write         create, edit name/email, enable/disable, reset password
 *   users:assign_roles  change a role or a per-user permission (critical)
 *
 * Escalation guards apply on top of the permission checks:
 *   - nobody acts on their own role, status or password through these routes
 *   - nobody grants, or acts on a user holding, a permission they lack themselves
 *   - the last active admin can be neither demoted nor disabled
 * There is no hard delete: an account is disabled, never removed.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sql } from '@mip/db';
import { ALL_PERMISSIONS, PERMISSIONS } from '@mip/shared';
import { hashPassword } from '../plugins/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { generateTemporaryPassword, passwordChangeInstant, revokeUserSessions } from '../lib/sessions.js';

const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email('البريد الإلكتروني غير صالح'),
  fullName: z.string().trim().min(2, 'الاسم قصير جداً').max(120),
  roleId: z.string().uuid('الدور غير صالح'),
}).strict();

const updateUserSchema = z.object({
  fullName: z.string().trim().min(2, 'الاسم قصير جداً').max(120).optional(),
  email: z.string().trim().toLowerCase().email('البريد الإلكتروني غير صالح').optional(),
}).strict();

const roleSchema = z.object({ roleId: z.string().uuid('الدور غير صالح') }).strict();

interface Target {
  id: string; email: string; full_name: string; is_active: boolean;
  role_id: string; role_key: string; role_name: string; permissions: string[];
}

async function loadTarget(id: string): Promise<Target> {
  if (!z.string().uuid().safeParse(id).success) throw notFound('المستخدم غير موجود');
  const [row] = await sql<Target[]>`
    SELECT u.id, u.email, u.full_name, u.is_active, u.role_id,
           r.key AS role_key, r.name_ar AS role_name,
           ARRAY(SELECT permission_key FROM role_permissions WHERE role_id = r.id
                 UNION SELECT permission_key FROM user_permissions WHERE user_id = u.id) AS permissions
    FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.id = ${id}::uuid AND u.deleted_at IS NULL`;
  if (!row) throw notFound('المستخدم غير موجود');
  return row;
}

async function loadRole(roleId: string) {
  const [role] = await sql<{ id: string; key: string; name_ar: string; permissions: string[] }[]>`
    SELECT r.id, r.key, r.name_ar,
           ARRAY(SELECT permission_key FROM role_permissions WHERE role_id = r.id) AS permissions
    FROM roles r WHERE r.id = ${roleId}::uuid`;
  if (!role) throw badRequest('الدور غير موجود');
  return role;
}

/** Refuses when `perms` contains anything the acting user does not hold. */
function assertActorHolds(req: FastifyRequest, perms: readonly string[], what: string) {
  const missing = perms.filter((p) => !req.user.permissions.includes(p));
  if (missing.length) throw forbidden(`لا يمكنك ${what} لأنه يتضمن صلاحيات لا تملكها`);
}

function assertNotSelf(req: FastifyRequest, id: string, what: string) {
  if (id === req.user.id) throw forbidden(`لا يمكنك ${what} لحسابك الخاص`);
}

/** The last active admin must stay an active admin. */
async function assertNotLastAdmin(target: Target, what: string) {
  if (target.role_key !== 'admin' || !target.is_active) return;
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM users u JOIN roles r ON r.id = u.role_id
    WHERE r.key = 'admin' AND u.is_active AND u.deleted_at IS NULL AND u.id <> ${target.id}::uuid`;
  if ((row?.n ?? 0) === 0) throw conflict(`لا يمكن ${what} آخر مدير نظام نشط`);
}

const noStore = { 'cache-control': 'no-store' };

export default async function userRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  const canRead = app.requirePermission(PERMISSIONS.USERS_READ);
  const canWrite = app.requirePermission(PERMISSIONS.USERS_WRITE);
  const canAssign = app.requirePermission(PERMISSIONS.USERS_ASSIGN_ROLES);

  app.get('/users', { preHandler: [canRead] }, async () => ({
    items: await sql`
      SELECT u.id, u.email, u.full_name, u.is_active, u.last_login_at, u.created_at,
             u.must_change_password, u.disabled_at,
             (u.locked_until IS NOT NULL AND u.locked_until > now()) AS is_locked,
             r.id AS role_id, r.key AS role_key, r.name_ar AS role_name,
             ARRAY(SELECT permission_key FROM user_permissions WHERE user_id = u.id ORDER BY 1) AS extra_permissions
      FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.deleted_at IS NULL ORDER BY u.created_at`,
  }));

  app.get('/roles', { preHandler: [canRead] }, async () => ({
    items: await sql`
      SELECT r.id, r.key, r.name_ar, r.name_en, r.description, r.is_system,
             ARRAY(SELECT permission_key FROM role_permissions WHERE role_id = r.id ORDER BY 1) AS permissions
      FROM roles r ORDER BY r.key`,
  }));

  /** Creates an account with a one-time temporary password, returned once and never stored in clear. */
  app.post('/users', { preHandler: [canWrite, canAssign] }, async (req, reply) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const { email, fullName, roleId } = parsed.data;

    const role = await loadRole(roleId);
    assertActorHolds(req, role.permissions, 'منح هذا الدور');

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    try {
      const [created] = await sql<{ id: string; email: string; full_name: string; is_active: boolean; created_at: Date }[]>`
        INSERT INTO users (email, full_name, password_hash, role_id, must_change_password, created_by)
        VALUES (${email}, ${fullName}, ${passwordHash}, ${role.id}::uuid, true, ${req.user.id}::uuid)
        RETURNING id, email, full_name, is_active, created_at`;

      await audit(req, {
        action: 'user.create', entityType: 'user', entityId: created.id,
        entityLabel: `${created.email} — ${role.name_ar}`,
        newValue: { email: created.email, fullName: created.full_name, role: role.key, mustChangePassword: true },
        severity: 'critical',
      });
      reply.headers(noStore);
      return { user: { ...created, role_key: role.key, must_change_password: true }, temporaryPassword };
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw conflict('البريد الإلكتروني مستخدم بالفعل');
      throw error;
    }
  });

  /** Name and email only — role, status and password each have their own guarded route. */
  app.patch('/users/:id', { preHandler: [canWrite] }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const body = parsed.data;
    const target = await loadTarget(id);
    if (id !== req.user.id) assertActorHolds(req, target.permissions, 'تعديل هذا المستخدم');

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (body.fullName !== undefined && body.fullName !== target.full_name) changes.fullName = { from: target.full_name, to: body.fullName };
    if (body.email !== undefined && body.email !== target.email) changes.email = { from: target.email, to: body.email };
    if (!Object.keys(changes).length) return { ok: true, changed: false };

    try {
      await sql`
        UPDATE users SET
          full_name = COALESCE(${body.fullName ?? null}, full_name),
          email = COALESCE(${body.email ?? null}, email),
          updated_at = now()
        WHERE id = ${id}::uuid`;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw conflict('البريد الإلكتروني مستخدم بالفعل');
      throw error;
    }
    await audit(req, {
      action: 'user.update', entityType: 'user', entityId: id, entityLabel: body.email ?? target.email,
      oldValue: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.from])),
      newValue: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.to])),
      severity: 'warning',
    });
    return { ok: true, changed: true };
  });

  app.put('/users/:id/role', { preHandler: [canAssign] }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    assertNotSelf(req, id, 'تغيير الدور');

    const target = await loadTarget(id);
    const role = await loadRole(parsed.data.roleId);
    assertActorHolds(req, target.permissions, 'تغيير دور هذا المستخدم');
    assertActorHolds(req, role.permissions, 'منح هذا الدور');
    if (role.id === target.role_id) return { ok: true, changed: false };
    if (role.key !== 'admin') await assertNotLastAdmin(target, 'تغيير دور');

    await sql.begin(async tx => {
      // Serialize with team membership changes; a role change must not leave
      // an agent supervising several teams through historical membership kinds.
      await tx`SELECT id FROM users WHERE id = ${id}::uuid FOR UPDATE`;
      const memberships = await tx`SELECT kind FROM team_members
        WHERE user_id = ${id}::uuid AND left_at IS NULL`;
      if (memberships.some(member => member.kind !== role.key)) {
        throw conflict('أغلق عضويات الفرق الحالية قبل تغيير دور المستخدم؛ سيبقى تاريخها محفوظاً');
      }
      await tx`UPDATE users SET role_id = ${role.id}::uuid, updated_at = now() WHERE id = ${id}::uuid`;
    });
    await audit(req, {
      action: 'user.role_change', entityType: 'user', entityId: id, entityLabel: target.email,
      oldValue: { role: target.role_key }, newValue: { role: role.key }, severity: 'critical',
    });
    return { ok: true, changed: true };
  });

  app.post('/users/:id/disable', { preHandler: [canWrite] }, async (req) => {
    const { id } = req.params as { id: string };
    assertNotSelf(req, id, 'تعطيل');
    const target = await loadTarget(id);
    assertActorHolds(req, target.permissions, 'تعطيل هذا المستخدم');
    if (!target.is_active) return { ok: true, changed: false };
    await assertNotLastAdmin(target, 'تعطيل');

    await sql`
      UPDATE users SET is_active = false, disabled_at = now(), disabled_by = ${req.user.id}::uuid, updated_at = now()
      WHERE id = ${id}::uuid`;
    const revoked = await revokeUserSessions(id);
    await audit(req, { action: 'user.disable', entityType: 'user', entityId: id, entityLabel: target.email, severity: 'critical' });
    if (revoked > 0) {
      await audit(req, {
        action: 'auth.sessions_revoked', entityType: 'user', entityId: id, entityLabel: target.email,
        newValue: { count: revoked, cause: 'disable' }, severity: 'warning',
      });
    }
    return { ok: true, changed: true };
  });

  app.post('/users/:id/enable', { preHandler: [canWrite] }, async (req) => {
    const { id } = req.params as { id: string };
    assertNotSelf(req, id, 'تفعيل');
    const target = await loadTarget(id);
    assertActorHolds(req, target.permissions, 'تفعيل هذا المستخدم');
    if (target.is_active) return { ok: true, changed: false };

    await sql`
      UPDATE users SET is_active = true, disabled_at = NULL, disabled_by = NULL,
                       failed_login_attempts = 0, locked_until = NULL, updated_at = now()
      WHERE id = ${id}::uuid`;
    await audit(req, { action: 'user.enable', entityType: 'user', entityId: id, entityLabel: target.email, severity: 'warning' });
    return { ok: true, changed: true };
  });

  /**
   * Issues a new temporary password (returned once), forces a change at next
   * login, revokes every session and voids every access token issued before now.
   */
  app.post('/users/:id/reset-password', { preHandler: [canWrite] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    assertNotSelf(req, id, 'إعادة تعيين كلمة المرور');
    const target = await loadTarget(id);
    assertActorHolds(req, target.permissions, 'إعادة تعيين كلمة مرور هذا المستخدم');

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    await sql`
      UPDATE users SET password_hash = ${passwordHash}, must_change_password = true,
                       password_changed_at = ${passwordChangeInstant()}::timestamptz,
                       failed_login_attempts = 0, locked_until = NULL, updated_at = now()
      WHERE id = ${id}::uuid`;
    const revoked = await revokeUserSessions(id);

    await audit(req, { action: 'user.reset_password', entityType: 'user', entityId: id, entityLabel: target.email, severity: 'critical' });
    await audit(req, {
      action: 'auth.sessions_revoked', entityType: 'user', entityId: id, entityLabel: target.email,
      newValue: { count: revoked, cause: 'password_reset' }, severity: 'warning',
    });
    reply.headers(noStore);
    return { ok: true, temporaryPassword };
  });

  /** Per-user permission exceptions on top of the role (e.g. budget:write). */
  app.put('/users/:id/permissions/:permission', { preHandler: [canAssign] }, async (req) => {
    const { id, permission } = req.params as { id: string; permission: string };
    if (!(ALL_PERMISSIONS as string[]).includes(permission)) throw badRequest('صلاحية غير معروفة');
    assertNotSelf(req, id, 'تعديل الصلاحيات');
    const target = await loadTarget(id);
    assertActorHolds(req, [...target.permissions, permission], 'منح هذه الصلاحية');

    const rows = await sql`
      INSERT INTO user_permissions (user_id, permission_key, granted_by)
      VALUES (${id}::uuid, ${permission}, ${req.user.id}::uuid)
      ON CONFLICT DO NOTHING RETURNING user_id`;
    if (rows.length) {
      await audit(req, {
        action: 'user.permission_grant', entityType: 'user', entityId: id, entityLabel: target.email,
        newValue: { permission }, severity: 'critical',
      });
    }
    return { ok: true, changed: rows.length > 0 };
  });

  app.delete('/users/:id/permissions/:permission', { preHandler: [canAssign] }, async (req) => {
    const { id, permission } = req.params as { id: string; permission: string };
    assertNotSelf(req, id, 'تعديل الصلاحيات');
    const target = await loadTarget(id);
    assertActorHolds(req, target.permissions, 'تعديل صلاحيات هذا المستخدم');

    const rows = await sql`
      DELETE FROM user_permissions WHERE user_id = ${id}::uuid AND permission_key = ${permission}
      RETURNING user_id`;
    if (rows.length) {
      await audit(req, {
        action: 'user.permission_revoke', entityType: 'user', entityId: id, entityLabel: target.email,
        oldValue: { permission }, severity: 'critical',
      });
    }
    return { ok: true, changed: rows.length > 0 };
  });
}
